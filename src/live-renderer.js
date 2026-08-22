// ReSync Live Mode (experimental)
// --------------------------------
// A scene-based switcher modeled on OBS: each scene holds one full-frame
// video source (multi-source layouts are a later phase). Preview shows
// the scene you're about to cut to; Program shows what's live. This is
// intentionally separate from the Record Mode code in renderer.js —
// different mental model, different state, and keeping them apart means
// Record Mode (the default, everyday path) can't be destabilized by
// changes here.
//
// Known Phase 1 limitations, called out in the UI banner too:
//  - Video only. No audio bus yet (Phase 3) and no streaming out yet
//    (Phase 4) — "Start Recording" captures the Program canvas to a
//    single video-only file.
//  - One source per scene, full-frame only. Layouts/PiP are Phase 2.
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
  programCanvas: document.getElementById('programCanvas'),
  cutBtn: document.getElementById('cutBtn'),
  fadeBtn: document.getElementById('fadeBtn'),

  liveChooseFolderBtn: document.getElementById('liveChooseFolderBtn'),
  liveFolderLabel: document.getElementById('liveFolderLabel'),
  liveStatusLabel: document.getElementById('liveStatusLabel'),
  liveTimerLabel: document.getElementById('liveTimerLabel'),
  startProgramRecBtn: document.getElementById('startProgramRecBtn'),
  stopProgramRecBtn: document.getElementById('stopProgramRecBtn'),

  offscreenVideos: document.getElementById('offscreenVideos')
};

const liveState = {
  scenes: [],          // { id, name, deviceId, stream, videoEl, selectEl }
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
const nextLiveId = () => `scene_${++liveIdCounter}`;

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

// ---------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------

async function addScene() {
  const scene = {
    id: nextLiveId(),
    name: `Scene ${liveState.scenes.length + 1}`,
    deviceId: null,
    stream: null,
    videoEl: null
  };
  liveState.scenes.push(scene);
  renderSceneList();
  if (liveState.previewSceneId === null) {
    liveState.previewSceneId = scene.id;
    renderSceneList();
  }
}

function removeScene(id) {
  const idx = liveState.scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [scene] = liveState.scenes.splice(idx, 1);
  if (scene.stream) scene.stream.getTracks().forEach((t) => t.stop());
  if (scene.videoEl) scene.videoEl.remove();
  if (liveState.previewSceneId === id) liveState.previewSceneId = null;
  if (liveState.programSceneId === id) liveState.programSceneId = null;
  renderSceneList();
}

async function assignSceneDevice(scene, deviceId) {
  if (scene.stream) scene.stream.getTracks().forEach((t) => t.stop());
  if (scene.videoEl) scene.videoEl.remove();

  if (!deviceId) {
    scene.deviceId = null;
    scene.stream = null;
    scene.videoEl = null;
    return;
  }

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

    scene.deviceId = deviceId;
    scene.stream = stream;
    scene.videoEl = video;
  } catch (err) {
    alert(`Couldn't open that camera for this scene: ${err.message}`);
  }
}

async function renderSceneList() {
  liveEl.sceneList.innerHTML = '';
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === 'videoinput');

  liveState.scenes.forEach((scene) => {
    const item = document.createElement('div');
    item.className = 'scene-item';
    if (scene.id === liveState.previewSceneId) item.classList.add('previewing');
    if (scene.id === liveState.programSceneId) item.classList.add('live');
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      liveState.previewSceneId = scene.id;
      renderSceneList();
    });

    const nameInput = document.createElement('input');
    nameInput.className = 'scene-name';
    nameInput.value = scene.name;
    nameInput.addEventListener('change', () => {
      scene.name = nameInput.value.trim() || scene.name;
    });

    const select = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'No camera assigned';
    select.appendChild(noneOpt);
    videoDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === scene.deviceId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => assignSceneDevice(scene, select.value));

    const footer = document.createElement('div');
    footer.className = 'scene-item-footer';
    const statusText = document.createElement('span');
    statusText.textContent = scene.id === liveState.programSceneId
      ? 'LIVE'
      : scene.id === liveState.previewSceneId ? 'Preview' : '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'scene-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeScene(scene.id));

    footer.appendChild(statusText);
    footer.appendChild(removeBtn);

    item.appendChild(nameInput);
    item.appendChild(select);
    item.appendChild(footer);
    liveEl.sceneList.appendChild(item);
  });
}

liveEl.addSceneBtn.addEventListener('click', addScene);

// ---------------------------------------------------------------------
// Canvas compositor — draws Preview and Program every frame, with a
// "cover" fit (like CSS object-fit: cover) so sources of different
// aspect ratios don't stretch.
// ---------------------------------------------------------------------

function drawSceneCover(ctx, scene, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!scene || !scene.videoEl || scene.videoEl.readyState < 2) return;
  const video = scene.videoEl;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
}

function sceneById(id) {
  return liveState.scenes.find((s) => s.id === id) || null;
}

function renderLoop() {
  const pvwCtx = liveEl.previewCanvas.getContext('2d');
  const pgmCtx = liveEl.programCanvas.getContext('2d');
  const w = liveEl.programCanvas.width;
  const h = liveEl.programCanvas.height;

  drawSceneCover(pvwCtx, sceneById(liveState.previewSceneId), w, h);

  if (liveState.transition) {
    const { fromId, toId, startedAt, duration } = liveState.transition;
    const t = Math.min(1, (performance.now() - startedAt) / duration);

    // Draw the outgoing scene, then the incoming scene on top at
    // rising opacity — a straightforward crossfade.
    drawSceneCover(pgmCtx, sceneById(fromId), w, h);
    pgmCtx.save();
    pgmCtx.globalAlpha = t;
    drawSceneCover(pgmCtx, sceneById(toId), w, h);
    pgmCtx.restore();

    if (t >= 1) {
      liveState.programSceneId = toId;
      liveState.transition = null;
      renderSceneList();
    }
  } else {
    drawSceneCover(pgmCtx, sceneById(liveState.programSceneId), w, h);
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
  renderSceneList();
});

liveEl.fadeBtn.addEventListener('click', () => {
  if (!liveState.previewSceneId || liveState.previewSceneId === liveState.programSceneId) return;
  const toId = liveState.previewSceneId;
  const fromId = liveState.programSceneId;
  liveState.previewSceneId = fromId; // old program becomes the new preview once the fade lands
  liveState.transition = { fromId, toId, startedAt: performance.now(), duration: 500 };
  renderSceneList();
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
