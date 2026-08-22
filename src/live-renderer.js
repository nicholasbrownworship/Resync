// ReSync Live Mode (experimental)
// --------------------------------
// A scene-based switcher modeled on OBS. Each scene now holds a list of
// source "items" — a camera plus a position/size within the scene's
// canvas, layered bottom-to-top by array order (like OBS's source
// list). Preview shows whichever scene is selected and is also the
// live editing surface: drag a source directly on it to move it, drag
// its corner to resize. Program shows whatever's live, untouched by
// editing.
//
// Known Phase 2 limitations, called out in the UI banner too:
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
  scenes: [],          // { id, name, items: [{id, deviceId, label, stream, videoEl, x, y, w, h}] }
  previewSceneId: null,
  programSceneId: null,
  transition: null,    // { fromId, toId, startedAt, duration } while a Fade is running
  baseDir: null,
  recording: false,
  recorder: null,
  fileId: null,
  recordStartWallClock: null,
  timerInterval: null
};

let liveIdCounter = 0;
const nextLiveId = (prefix) => `${prefix}_${++liveIdCounter}`;

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
  const [scene] = liveState.scenes.splice(idx, 1);
  scene.items.forEach(teardownItem);
  if (liveState.previewSceneId === id) liveState.previewSceneId = liveState.scenes[0]?.id || null;
  if (liveState.programSceneId === id) liveState.programSceneId = null;
  refreshLiveUI();
}

function teardownItem(item) {
  if (item.stream) item.stream.getTracks().forEach((t) => t.stop());
  if (item.videoEl) item.videoEl.remove();
}

// ---------------------------------------------------------------------
// Scene items (sources within a scene)
// ---------------------------------------------------------------------

async function addSceneItem(scene, deviceId, label) {
  if (!deviceId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false
    });
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    liveEl.offscreenVideos.appendChild(video);

    // First source in a scene defaults to full-frame; later ones default
    // to a staggered PiP box so they don't land exactly on top of each
    // other and are easy to grab and reposition.
    const n = scene.items.length;
    const rect = n === 0
      ? { x: 0, y: 0, w: 1, h: 1 }
      : { x: 0.55 - 0.03 * n, y: 0.55 - 0.03 * n, w: 0.4, h: 0.4 };

    scene.items.push({
      id: nextLiveId('item'),
      deviceId,
      label,
      stream,
      videoEl: video,
      ...rect
    });
    refreshLiveUI();
  } catch (err) {
    alert(`Couldn't open that camera: ${err.message}`);
  }
}

function removeSceneItem(scene, itemId) {
  const idx = scene.items.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  const [item] = scene.items.splice(idx, 1);
  teardownItem(item);
  refreshLiveUI();
}

function moveSceneItem(scene, itemId, direction) {
  const idx = scene.items.findIndex((i) => i.id === itemId);
  if (idx === -1) return;
  const swapWith = direction === 'up' ? idx + 1 : idx - 1;
  if (swapWith < 0 || swapWith >= scene.items.length) return;
  [scene.items[idx], scene.items[swapWith]] = [scene.items[swapWith], scene.items[idx]];
  refreshLiveUI();
}

// ---------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------

function refreshLiveUI() {
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
    const row = document.createElement('div');
    row.className = 'scene-item-row';

    const label = document.createElement('span');
    label.className = 'scene-item-row-label';
    label.textContent = sceneItem.label;
    row.appendChild(label);

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

    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    liveEl.sceneItemsList.appendChild(row);
  });
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
    const box = document.createElement('div');
    box.className = 'source-box';
    positionBoxEl(box, sceneItem);

    const label = document.createElement('div');
    label.className = 'source-box-label';
    label.textContent = sceneItem.label;
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
// Canvas compositor — draws every item in a scene, bottom-to-top, with
// a "cover" fit within its own box so a source doesn't stretch when its
// box has a different aspect ratio than the camera.
// ---------------------------------------------------------------------

function drawItemCover(ctx, item, canvasW, canvasH) {
  if (!item.videoEl || item.videoEl.readyState < 2) return;
  const vw = item.videoEl.videoWidth;
  const vh = item.videoEl.videoHeight;
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
  ctx.drawImage(item.videoEl, dx, dy, dw, dh);
  ctx.restore();
}

function drawSceneComposite(ctx, scene, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!scene) return;
  scene.items.forEach((item) => drawItemCover(ctx, item, w, h));
}

function renderLoop() {
  const pvwCtx = liveEl.previewCanvas.getContext('2d');
  const pgmCtx = liveEl.programCanvas.getContext('2d');
  const w = liveEl.programCanvas.width;
  const h = liveEl.programCanvas.height;

  drawSceneComposite(pvwCtx, sceneById(liveState.previewSceneId), w, h);

  if (liveState.transition) {
    const { fromId, toId, startedAt, duration } = liveState.transition;
    const t = Math.min(1, (performance.now() - startedAt) / duration);

    drawSceneComposite(pgmCtx, sceneById(fromId), w, h);
    pgmCtx.save();
    pgmCtx.globalAlpha = t;
    drawSceneComposite(pgmCtx, sceneById(toId), w, h);
    pgmCtx.restore();

    if (t >= 1) {
      liveState.programSceneId = toId;
      liveState.transition = null;
      renderSceneList();
    }
  } else {
    drawSceneComposite(pgmCtx, sceneById(liveState.programSceneId), w, h);
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// ---------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------

liveEl.cutBtn.addEventListener('click', () => {
  if (!liveState.previewSceneId) return;
  const prevProgram = liveState.programSceneId;
  liveState.programSceneId = liveState.previewSceneId;
  liveState.previewSceneId = prevProgram;
  liveState.transition = null;
  refreshLiveUI();
});

liveEl.fadeBtn.addEventListener('click', () => {
  if (!liveState.previewSceneId || liveState.previewSceneId === liveState.programSceneId) return;
  const toId = liveState.previewSceneId;
  const fromId = liveState.programSceneId;
  liveState.previewSceneId = fromId; // old program becomes the new preview once the fade lands
  liveState.transition = { fromId, toId, startedAt: performance.now(), duration: 500 };
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
