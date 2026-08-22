// ReSync Live Mode (experimental)
// --------------------------------
// A scene-based switcher modeled on OBS.
//
// Preview vs. Program — the actual model:
// Preview always shows live video for whatever scene is selected, and
// is the editing surface — drag/resize/reorder/add/remove sources and
// see it immediately. Program shows live video too, but its ARRANGEMENT
// (which sources, at what position/size) only updates when you hit Cut
// or Fade. Editing Preview must never freeze or interrupt what's
// already live on Program.
//
// How that's implemented: a camera device isn't owned by a scene item
// directly. Opening a camera creates a "connection" (stream + video
// element) in a shared registry, keyed by an id. A scene item is just
// layout data — {connId, x, y, w, h} — pointing at one of those
// connections. Program's pushed arrangement is a plain array of the
// same {connId, x, y, w, h} shape, cloned at Cut/Fade time. Because
// both Preview's scene and Program's arrangement reference connections
// by id rather than owning the stream directly, a connection keeps
// playing live video for whichever side still needs it. A connection
// is only torn down once a garbage-collection pass finds NOTHING
// referencing its id anymore — not the editable scenes, not Program,
// not an in-flight transition. That's what lets you freely edit,
// remove, or change the resolution of a source in a scene that's
// currently live: Program keeps playing the old connection, live,
// until you Cut/Fade again — at which point the old connection is
// dropped automatically because nothing points at it anymore.
// (RESOLUTION_PRESETS is defined in renderer.js, loaded first — reused
// here rather than duplicated, since classic <script> tags share scope.)
//
// Known limitations, called out in the UI banner too:
//  - Video only. No audio bus yet (Phase 3) and no streaming out yet
//    (Phase 4) — "Start Recording" captures the Program canvas to a
//    single video-only file.
//  - Resize is free-form (no aspect-ratio lock yet).
//  - Cameras opened here are independent getUserMedia calls from Record
//    Mode's — most cameras only allow one active consumer, so using the
//    same physical camera in both modes at once may fail or hand the
//    device to whichever mode asked last.

const liveEl = {
  modeRecordBtn: document.getElementById('modeRecordBtn'),
  modeLiveBtn: document.getElementById('modeLiveBtn'),
  recordModeRoot: document.getElementById('recordModeRoot'),
  liveModeRoot: document.getElementById('liveModeRoot'),

  sceneList: document.getElementById('sceneList'),
  addSceneBtn: document.getElementById('addSceneBtn'),
  previewCanvas: document.getElementById('previewCanvas'),
  previewOverlay: document.getElementById('previewOverlay'),
  programCanvas: document.getElementById('programCanvas'),
  cutBtn: document.getElementById('cutBtn'),
  fadeBtn: document.getElementById('fadeBtn'),

  sceneItemsList: document.getElementById('sceneItemsList'),
  sceneItemDeviceSelect: document.getElementById('sceneItemDeviceSelect'),
  addSceneItemBtn: document.getElementById('addSceneItemBtn'),

  liveChooseFolderBtn: document.getElementById('liveChooseFolderBtn'),
  liveFolderLabel: document.getElementById('liveFolderLabel'),
  liveStatusLabel: document.getElementById('liveStatusLabel'),
  liveTimerLabel: document.getElementById('liveTimerLabel'),
  startProgramRecBtn: document.getElementById('startProgramRecBtn'),
  stopProgramRecBtn: document.getElementById('stopProgramRecBtn'),

  offscreenVideos: document.getElementById('offscreenVideos')
};

const liveState = {
  scenes: [],           // { id, name, items: [{id, connId, x, y, w, h}] }
  previewSceneId: null,
  programSceneId: null,  // which scene is "live", for labeling only
  programItems: [],      // the pushed arrangement Program actually renders
  connections: new Map(), // connId -> { deviceId, label, stream, videoEl, resolutionPreset }
  transition: null,      // { fromItems, toItems, toSceneId, startedAt, duration } while a Fade is running
  baseDir: null,
  recording: false,
  recorder: null,
  fileId: null,
  recordStartWallClock: null,
  timerInterval: null
};

let liveIdCounter = 0;
const nextLiveId = (prefix) => `${prefix}_${++liveIdCounter}`;
let expandedSettingsItemId = null;

// ---------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------

liveEl.modeRecordBtn.addEventListener('click', () => setMode('record'));
liveEl.modeLiveBtn.addEventListener('click', () => setMode('live'));

function setMode(mode) {
  const goingLive = mode === 'live';
  liveEl.recordModeRoot.classList.toggle('hidden', goingLive);
  liveEl.liveModeRoot.classList.toggle('hidden', !goingLive);
  liveEl.modeRecordBtn.classList.toggle('active', !goingLive);
  liveEl.modeLiveBtn.classList.toggle('active', goingLive);
}

function sceneById(id) {
  return liveState.scenes.find((s) => s.id === id) || null;
}

function cloneItems(scene) {
  return scene ? scene.items.map((item) => ({ ...item })) : [];
}

// ---------------------------------------------------------------------
// Camera connections — see file header for the model.
// ---------------------------------------------------------------------

async function createConnection(deviceId, label, resolutionPreset) {
  const preset = RESOLUTION_PRESETS[resolutionPreset];
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...preset.constraints },
    audio: false
  });
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  liveEl.offscreenVideos.appendChild(video);

  const connId = nextLiveId('conn');
  liveState.connections.set(connId, { deviceId, label, stream, videoEl: video, resolutionPreset });
  return connId;
}

function teardownConnection(connId) {
  const conn = liveState.connections.get(connId);
  if (!conn) return;
  conn.stream.getTracks().forEach((t) => t.stop());
  conn.videoEl.remove();
  liveState.connections.delete(connId);
}

// Tears down any connection nothing references anymore — not an
// editable scene, not Program's pushed arrangement, not an in-flight
// transition. This is what lets Program keep playing a connection
// live even after you've edited or removed it from the scene it
// originally came from.
function gcConnections() {
  const used = new Set();
  liveState.scenes.forEach((scene) => scene.items.forEach((item) => used.add(item.connId)));
  liveState.programItems.forEach((item) => used.add(item.connId));
  if (liveState.transition) {
    liveState.transition.fromItems.forEach((item) => used.add(item.connId));
    liveState.transition.toItems.forEach((item) => used.add(item.connId));
  }
  for (const connId of [...liveState.connections.keys()]) {
    if (!used.has(connId)) teardownConnection(connId);
  }
}

// ---------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------

function addScene() {
  const scene = { id: nextLiveId('scene'), name: `Scene ${liveState.scenes.length + 1}`, items: [] };
  liveState.scenes.push(scene);
  if (liveState.previewSceneId === null) liveState.previewSceneId = scene.id;
  refreshLiveUI();
}

function removeScene(id) {
  const idx = liveState.scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  liveState.scenes.splice(idx, 1);
  if (liveState.previewSceneId === id) liveState.previewSceneId = liveState.scenes[0]?.id || null;
  if (liveState.programSceneId === id) liveState.programSceneId = null;
  refreshLiveUI(); // gcConnections inside here tears down anything now unused
}

// ---------------------------------------------------------------------
// Scene items (sources within a scene)
// ---------------------------------------------------------------------

async function addSceneItem(scene, deviceId, label) {
  if (!deviceId) return;
  try {
    const connId = await createConnection(deviceId, label, 'device-default');
    const n = scene.items.length;
    const rect = n === 0
      ? { x: 0, y: 0, w: 1, h: 1 }
      : { x: 0.55 - 0.03 * n, y: 0.55 - 0.03 * n, w: 0.4, h: 0.4 };
    scene.items.push({ id: nextLiveId('item'), connId, ...rect });
    refreshLiveUI();
  } catch (err) {
    alert(`Couldn't open that camera: ${err.message}`);
  }
}

function removeSceneItem(scene, itemId) {
  const idx = scene.items.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  scene.items.splice(idx, 1);
  if (expandedSettingsItemId === itemId) expandedSettingsItemId = null;
  refreshLiveUI(); // connection stays alive if Program still references it
}

function moveSceneItem(scene, itemId, direction) {
  const idx = scene.items.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  const swapWith = direction === 'up' ? idx + 1 : idx - 1;
  if (swapWith < 0 || swapWith >= scene.items.length) return;
  [scene.items[idx], scene.items[swapWith]] = [scene.items[swapWith], scene.items[idx]];
  refreshLiveUI();
}

// Opens a NEW connection at the new resolution and repoints this item
// at it. The OLD connection isn't touched here — if Program's pushed
// arrangement still references it, gcConnections() (via refreshLiveUI)
// leaves it alone and Program keeps playing it live, unchanged, until
// you Cut/Fade again.
async function applySceneItemResolution(item, presetKey) {
  const conn = liveState.connections.get(item.connId);
  const deviceId = conn?.deviceId;
  const label = conn?.label || 'Camera';
  if (!deviceId) return;

  try {
    const newConnId = await createConnection(deviceId, label, presetKey);
    item.connId = newConnId;
    refreshLiveUI();
  } catch (err) {
    alert(`Couldn't switch resolution: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------

function refreshLiveUI() {
  gcConnections();
  renderSceneList();
  renderSceneItemsPanel();
  populateSceneItemDeviceSelect();
  syncOverlay();
}

function renderSceneList() {
  liveEl.sceneList.innerHTML = '';
  liveState.scenes.forEach((scene) => {
    const item = document.createElement('div');
    item.className = 'scene-item';
    if (scene.id === liveState.previewSceneId) item.classList.add('previewing');
    if (scene.id === liveState.programSceneId) item.classList.add('live');
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      liveState.previewSceneId = scene.id;
      refreshLiveUI();
    });

    const nameInput = document.createElement('input');
    nameInput.className = 'scene-name';
    nameInput.value = scene.name;
    nameInput.addEventListener('change', () => {
      scene.name = nameInput.value.trim() || scene.name;
    });

    const footer = document.createElement('div');
    footer.className = 'scene-item-footer';
    const statusText = document.createElement('span');
    const parts = [];
    if (scene.id === liveState.programSceneId) parts.push('LIVE');
    else if (scene.id === liveState.previewSceneId) parts.push('Preview');
    parts.push(`${scene.items.length} source${scene.items.length === 1 ? '' : 's'}`);
    statusText.textContent = parts.join(' · ');

    const removeBtn = document.createElement('button');
    removeBtn.className = 'scene-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeScene(scene.id));

    footer.appendChild(statusText);
    footer.appendChild(removeBtn);
    item.appendChild(nameInput);
    item.appendChild(footer);
    liveEl.sceneList.appendChild(item);
  });
}

function renderSceneItemsPanel() {
  liveEl.sceneItemsList.innerHTML = '';
  const scene = sceneById(liveState.previewSceneId);
  if (!scene) return;

  // Render top-of-stack first so the list visually matches layering.
  [...scene.items].reverse().forEach((sceneItem) => {
    const conn = liveState.connections.get(sceneItem.connId);
    const row = document.createElement('div');
    row.className = 'scene-item-row';

    const label = document.createElement('span');
    label.className = 'scene-item-row-label';
    label.textContent = conn ? conn.label : '(disconnected)';
    row.appendChild(label);

    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.title = 'Source settings';
    settingsBtn.addEventListener('click', () => {
      expandedSettingsItemId = expandedSettingsItemId === sceneItem.id ? null : sceneItem.id;
      renderSceneItemsPanel();
    });

    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.title = 'Bring forward';
    upBtn.addEventListener('click', () => moveSceneItem(scene, sceneItem.id, 'up'));

    const downBtn = document.createElement('button');
    downBtn.textContent = '↓';
    downBtn.title = 'Send backward';
    downBtn.addEventListener('click', () => moveSceneItem(scene, sceneItem.id, 'down'));

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from scene';
    removeBtn.addEventListener('click', () => removeSceneItem(scene, sceneItem.id));

    row.appendChild(settingsBtn);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    liveEl.sceneItemsList.appendChild(row);

    if (expandedSettingsItemId === sceneItem.id && conn) {
      liveEl.sceneItemsList.appendChild(buildItemSettingsPanel(sceneItem, conn));
    }
  });
}

function buildItemSettingsPanel(sceneItem, conn) {
  const panel = document.createElement('div');
  panel.className = 'quality-controls item-settings-panel';

  const resRow = document.createElement('div');
  resRow.className = 'quality-row';
  const resLabel = document.createElement('label');
  resLabel.textContent = 'Resolution';
  const resSelect = document.createElement('select');
  Object.entries(RESOLUTION_PRESETS).forEach(([key, { label }]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    if (key === conn.resolutionPreset) opt.selected = true;
    resSelect.appendChild(opt);
  });
  resSelect.addEventListener('change', () => applySceneItemResolution(sceneItem, resSelect.value));
  resRow.appendChild(resLabel);
  resRow.appendChild(resSelect);

  const actual = document.createElement('div');
  actual.className = 'quality-actual';
  const track = conn.stream.getVideoTracks()[0];
  if (track) {
    const { width, height, frameRate } = track.getSettings();
    actual.textContent = width && height
      ? `Actual: ${width}×${height}${frameRate ? ` @ ${Math.round(frameRate)}fps` : ''}`
      : 'Actual resolution unknown';
  }

  panel.appendChild(resRow);
  panel.appendChild(actual);
  return panel;
}

async function populateSceneItemDeviceSelect() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === 'videoinput');
  const prevValue = liveEl.sceneItemDeviceSelect.value;
  liveEl.sceneItemDeviceSelect.innerHTML = '';
  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    liveEl.sceneItemDeviceSelect.appendChild(opt);
  });
  if (prevValue) liveEl.sceneItemDeviceSelect.value = prevValue;
}

liveEl.addSceneBtn.addEventListener('click', addScene);
liveEl.addSceneItemBtn.addEventListener('click', () => {
  const scene = sceneById(liveState.previewSceneId);
  if (!scene) {
    alert('Select or add a scene first.');
    return;
  }
  const select = liveEl.sceneItemDeviceSelect;
  const deviceId = select.value;
  const label = select.options[select.selectedIndex]?.textContent || 'Camera';
  addSceneItem(scene, deviceId, label);
});

// ---------------------------------------------------------------------
// Drag-to-arrange overlay on the Preview monitor
// ---------------------------------------------------------------------

function syncOverlay() {
  liveEl.previewOverlay.innerHTML = '';
  const scene = sceneById(liveState.previewSceneId);
  if (!scene) return;

  scene.items.forEach((sceneItem) => {
    const conn = liveState.connections.get(sceneItem.connId);
    const box = document.createElement('div');
    box.className = 'source-box';
    positionBoxEl(box, sceneItem);

    const label = document.createElement('div');
    label.className = 'source-box-label';
    label.textContent = conn ? conn.label : '(disconnected)';
    box.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    box.appendChild(handle);

    box.addEventListener('pointerdown', (e) => {
      if (e.target === handle) return;
      startDrag(e, sceneItem, box, 'move');
    });
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startDrag(e, sceneItem, box, 'resize');
    });

    liveEl.previewOverlay.appendChild(box);
  });
}

function positionBoxEl(box, sceneItem) {
  box.style.left = `${sceneItem.x * 100}%`;
  box.style.top = `${sceneItem.y * 100}%`;
  box.style.width = `${sceneItem.w * 100}%`;
  box.style.height = `${sceneItem.h * 100}%`;
}

function startDrag(e, sceneItem, box, mode) {
  e.preventDefault();
  const canvasRect = liveEl.previewCanvas.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { x: sceneItem.x, y: sceneItem.y, w: sceneItem.w, h: sceneItem.h };
  const MIN = 0.05;

  function onMove(ev) {
    const dxFrac = (ev.clientX - startX) / canvasRect.width;
    const dyFrac = (ev.clientY - startY) / canvasRect.height;

    if (mode === 'move') {
      sceneItem.x = clamp(orig.x + dxFrac, 0, 1 - sceneItem.w);
      sceneItem.y = clamp(orig.y + dyFrac, 0, 1 - sceneItem.h);
    } else {
      sceneItem.w = clamp(orig.w + dxFrac, MIN, 1 - sceneItem.x);
      sceneItem.h = clamp(orig.h + dyFrac, MIN, 1 - sceneItem.y);
    }
    positionBoxEl(box, sceneItem);
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------
// Canvas compositor — reads connections by id every frame, so both
// Preview and Program show continuously live video regardless of what
// editing has happened elsewhere.
// ---------------------------------------------------------------------

function drawItemCover(ctx, item, canvasW, canvasH) {
  const conn = liveState.connections.get(item.connId);
  if (!conn || !conn.videoEl || conn.videoEl.readyState < 2) return;
  const vw = conn.videoEl.videoWidth;
  const vh = conn.videoEl.videoHeight;
  if (!vw || !vh) return;

  const boxX = item.x * canvasW;
  const boxY = item.y * canvasH;
  const boxW = item.w * canvasW;
  const boxH = item.h * canvasH;

  const scale = Math.max(boxW / vw, boxH / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = boxX + (boxW - dw) / 2;
  const dy = boxY + (boxH - dh) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX, boxY, boxW, boxH);
  ctx.clip();
  ctx.drawImage(conn.videoEl, dx, dy, dw, dh);
  ctx.restore();
}

function drawItemsComposite(ctx, items, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  items.forEach((item) => drawItemCover(ctx, item, w, h));
}

function renderLoop() {
  const pvwCtx = liveEl.previewCanvas.getContext('2d');
  const pgmCtx = liveEl.programCanvas.getContext('2d');
  const w = liveEl.programCanvas.width;
  const h = liveEl.programCanvas.height;

  const previewScene = sceneById(liveState.previewSceneId);
  drawItemsComposite(pvwCtx, previewScene ? previewScene.items : [], w, h);

  if (liveState.transition) {
    const { fromItems, toItems, toSceneId, startedAt, duration } = liveState.transition;
    const t = Math.min(1, (performance.now() - startedAt) / duration);

    drawItemsComposite(pgmCtx, fromItems, w, h);
    pgmCtx.save();
    pgmCtx.globalAlpha = t;
    drawItemsComposite(pgmCtx, toItems, w, h);
    pgmCtx.restore();

    if (t >= 1) {
      liveState.programItems = toItems;
      liveState.programSceneId = toSceneId;
      liveState.transition = null;
      gcConnections();
      renderSceneList();
    }
  } else {
    drawItemsComposite(pgmCtx, liveState.programItems, w, h);
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ---------------------------------------------------------------------
// Transitions — push a cloned arrangement to Program. Connections keep
// playing live throughout; only which ones are "pushed" changes.
// ---------------------------------------------------------------------

liveEl.cutBtn.addEventListener('click', () => {
  if (!liveState.previewSceneId) return;
  const toId = liveState.previewSceneId;
  const toScene = sceneById(toId);
  const prevProgramSceneId = liveState.programSceneId;

  liveState.programItems = cloneItems(toScene);
  liveState.programSceneId = toId;
  liveState.previewSceneId = prevProgramSceneId || toId;
  liveState.transition = null;
  refreshLiveUI();
});

liveEl.fadeBtn.addEventListener('click', () => {
  if (!liveState.previewSceneId || liveState.previewSceneId === liveState.programSceneId) return;
  const toId = liveState.previewSceneId;
  const toScene = sceneById(toId);
  const fromSceneId = liveState.programSceneId;

  liveState.previewSceneId = fromSceneId || toId; // old program becomes the new preview once the fade lands
  liveState.transition = {
    fromItems: liveState.programItems,
    toItems: cloneItems(toScene),
    toSceneId: toId,
    startedAt: performance.now(),
    duration: 500
  };
  refreshLiveUI();
});

// ---------------------------------------------------------------------
// Program recording (video only — see file header)
// ---------------------------------------------------------------------

liveEl.liveChooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.resync.chooseFolder();
  if (dir) {
    liveState.baseDir = dir;
    liveEl.liveFolderLabel.textContent = dir;
  }
});

liveEl.startProgramRecBtn.addEventListener('click', async () => {
  if (!liveState.baseDir) {
    alert('Choose a save folder first.');
    return;
  }
  liveEl.startProgramRecBtn.disabled = true;

  const filename = `program-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
  const fileId = await window.resync.openFile(liveState.baseDir, filename);

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';

  const stream = liveEl.programCanvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      const buf = await e.data.arrayBuffer();
      window.resync.writeChunk(fileId, buf);
    }
  };
  recorder.start(1000);

  liveState.recorder = recorder;
  liveState.fileId = fileId;
  liveState.recording = true;
  liveState.recordStartWallClock = Date.now();
  liveEl.liveStatusLabel.textContent = 'RECORDING';
  liveEl.liveStatusLabel.className = 'status recording';
  liveEl.stopProgramRecBtn.disabled = false;
  startLiveTimer();
});

liveEl.stopProgramRecBtn.addEventListener('click', async () => {
  if (!liveState.recording) return;
  liveEl.stopProgramRecBtn.disabled = true;

  await new Promise((resolve) => {
    liveState.recorder.onstop = resolve;
    liveState.recorder.stop();
  });
  await window.resync.closeFile(liveState.fileId);

  liveState.recording = false;
  stopLiveTimer();
  liveEl.liveStatusLabel.textContent = 'IDLE';
  liveEl.liveStatusLabel.className = 'status idle';
  liveEl.startProgramRecBtn.disabled = false;

  alert(`Program recording saved to:\n${liveState.baseDir}`);
});

function startLiveTimer() {
  liveState.timerInterval = setInterval(() => {
    const elapsed = Date.now() - liveState.recordStartWallClock;
    const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
    liveEl.liveTimerLabel.textContent = `${h}:${m}:${s}`;
  }, 250);
}
function stopLiveTimer() {
  clearInterval(liveState.timerInterval);
}

populateSceneItemDeviceSelect();
navigator.mediaDevices.addEventListener('devicechange', populateSceneItemDeviceSelect);
