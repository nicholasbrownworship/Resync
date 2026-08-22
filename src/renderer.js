// ReSync renderer
// ----------------
// Everything here runs in the Chromium renderer process. Device access
// (getUserMedia), previews, metering, and MediaRecorder all happen here;
// actual disk writes are delegated to the main process via the
// `resync` bridge exposed in preload.js, so long recordings stream to
// disk instead of piling up in renderer memory.

const state = {
  sources: [],       // { id, kind, label, deviceId, stream, recordStream, recorder, fileId, filename, analyser, meterEl, channelIndex }
  sessionDir: null,
  baseDir: null,
  recording: false,
  recordStartWallClock: null,
  timerInterval: null
};

const el = {
  chooseFolderBtn: document.getElementById('chooseFolderBtn'),
  folderLabel: document.getElementById('folderLabel'),
  sessionName: document.getElementById('sessionName'),
  videoDeviceSelect: document.getElementById('videoDeviceSelect'),
  audioDeviceSelect: document.getElementById('audioDeviceSelect'),
  addVideoBtn: document.getElementById('addVideoBtn'),
  addAudioBtn: document.getElementById('addAudioBtn'),
  addAudioChannelsBtn: document.getElementById('addAudioChannelsBtn'),
  channelInfo: document.getElementById('channelInfo'),
  refreshDevicesBtn: document.getElementById('refreshDevicesBtn'),
  sourceGrid: document.getElementById('sourceGrid'),
  armBtn: document.getElementById('armBtn'),
  stopBtn: document.getElementById('stopBtn'),
  statusLabel: document.getElementById('statusLabel'),
  timerLabel: document.getElementById('timerLabel'),
  countdownOverlay: document.getElementById('countdownOverlay'),
  countdownNumber: document.getElementById('countdownNumber')
};

let idCounter = 0;
const nextId = () => `src_${++idCounter}`;

// --------------------------------------------------------------------
// Device enumeration
// --------------------------------------------------------------------

async function unlockDeviceLabels() {
  // Device labels are blank until a permission has been granted at least
  // once. Grab a throwaway audio+video stream just to unlock labels,
  // then immediately stop it.
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('Could not pre-unlock device labels (permission denied?)', err);
  }
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();

  el.videoDeviceSelect.innerHTML = '';
  el.audioDeviceSelect.innerHTML = '';

  devices
    .filter((d) => d.kind === 'videoinput')
    .forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      el.videoDeviceSelect.appendChild(opt);
    });

  devices
    .filter((d) => d.kind === 'audioinput')
    .forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Audio Input ${i + 1}`;
      el.audioDeviceSelect.appendChild(opt);
    });

  el.addAudioChannelsBtn.disabled = el.audioDeviceSelect.options.length === 0;
  el.channelInfo.textContent = el.audioDeviceSelect.options.length
    ? 'Unknown until you add channels — click the button below'
    : '–';
}

// --------------------------------------------------------------------
// Tile UI
// --------------------------------------------------------------------

function makeTile(source) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.draggable = true;
  tile.dataset.id = source.id;

  const header = document.createElement('div');
  header.className = 'tile-header';

  const nameInput = document.createElement('input');
  nameInput.value = source.label;
  nameInput.addEventListener('change', () => {
    source.label = nameInput.value.trim() || source.label;
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'tile-remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => removeSource(source.id));

  header.appendChild(nameInput);
  header.appendChild(removeBtn);
  tile.appendChild(header);

  if (source.kind === 'video') {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = source.stream;
    tile.appendChild(video);
  } else {
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    meter.appendChild(fill);
    tile.appendChild(meter);
    source.meterEl = fill;
  }

  const footer = document.createElement('div');
  footer.className = 'tile-footer';
  footer.innerHTML = `<span>${source.kind === 'video' ? 'Camera' : 'Audio'}</span><span class="rec-dot"></span>`;
  tile.appendChild(footer);

  // Drag-to-reorder (visual/organizational only — doesn't affect files)
  tile.addEventListener('dragstart', () => tile.classList.add('dragging'));
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));

  source.tileEl = tile;
  el.sourceGrid.appendChild(tile);
}

el.sourceGrid.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = el.sourceGrid.querySelector('.dragging');
  if (!dragging) return;
  const after = [...el.sourceGrid.querySelectorAll('.tile:not(.dragging)')].find((tile) => {
    const box = tile.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });
  if (after == null) el.sourceGrid.appendChild(dragging);
  else el.sourceGrid.insertBefore(dragging, after);
});

function removeSource(id) {
  if (state.recording) {
    alert('Stop recording before removing a source.');
    return;
  }
  const idx = state.sources.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [source] = state.sources.splice(idx, 1);
  if (source.stream) source.stream.getTracks().forEach((t) => t.stop());
  if (source.audioCtx) source.audioCtx.close();
  source.tileEl.remove();
}

// --------------------------------------------------------------------
// Metering (audio sources only)
// --------------------------------------------------------------------

function attachMeter(source, streamForMeter) {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(streamForMeter);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  source.audioCtx = ctx;

  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    if (!source.meterEl) return; // tile removed
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    source.meterEl.style.width = `${Math.min(100, peak * 140)}%`;
    requestAnimationFrame(tick);
  }
  tick();
}

// --------------------------------------------------------------------
// Adding sources
// --------------------------------------------------------------------

async function addVideoSource() {
  const deviceId = el.videoDeviceSelect.value;
  if (!deviceId) return;
  const label = el.videoDeviceSelect.options[el.videoDeviceSelect.selectedIndex].textContent;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false
  });

  const source = {
    id: nextId(),
    kind: 'video',
    label,
    deviceId,
    stream
  };
  state.sources.push(source);
  makeTile(source);
}

async function addAudioSource(deviceId, label) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });

  const source = {
    id: nextId(),
    kind: 'audio',
    label,
    deviceId,
    stream
  };
  state.sources.push(source);
  makeTile(source);
  attachMeter(source, stream);
}

async function addAudioSourceFromDropdown() {
  const deviceId = el.audioDeviceSelect.value;
  if (!deviceId) return;
  const label = el.audioDeviceSelect.options[el.audioDeviceSelect.selectedIndex].textContent;
  await addAudioSource(deviceId, label);
}

// Experimental: split a multi-channel interface into one mono source per
// channel using the Web Audio API. Whether this actually sees more than
// 2 channels depends on how Chromium + your Windows audio driver expose
// the device — see the README for the caveat.
async function addAudioChannelsSeparately() {
  const deviceId = el.audioDeviceSelect.value;
  const baseLabel = el.audioDeviceSelect.options[el.audioDeviceSelect.selectedIndex].textContent;
  if (!deviceId) return;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      channelCount: { ideal: 8 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });

  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  const channelCount = settings.channelCount || 1;
  el.channelInfo.textContent = `Detected ${channelCount} channel(s) on "${baseLabel}"`;

  if (channelCount <= 1) {
    alert(
      `This device only exposed ${channelCount} channel to the app, so there's nothing to split. ` +
      `Adding it as a single source instead.`
    );
    const source = { id: nextId(), kind: 'audio', label: baseLabel, deviceId, stream };
    state.sources.push(source);
    makeTile(source);
    attachMeter(source, stream);
    return;
  }

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const splitter = ctx.createChannelSplitter(channelCount);
  src.connect(splitter);

  for (let ch = 0; ch < channelCount; ch++) {
    const dest = ctx.createMediaStreamDestination();
    splitter.connect(dest, ch, 0);

    const source = {
      id: nextId(),
      kind: 'audio',
      label: `${baseLabel} — Ch ${ch + 1}`,
      deviceId,
      stream: dest.stream,
      channelIndex: ch,
      audioCtx: null // shared ctx closed once, on the last channel below
    };
    state.sources.push(source);
    makeTile(source);
    attachMeter(source, dest.stream);
  }

  // Keep the shared context + original stream alive as long as any
  // channel tile exists; tag it onto the first channel source so
  // removeSource's ctx.close() call cleans it up eventually. For
  // simplicity we don't auto-close mid-session — closing while other
  // channel tiles still reference it would kill their audio too.
}

// --------------------------------------------------------------------
// Recording
// --------------------------------------------------------------------

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_') || 'source';
}

function pickMimeType(kind) {
  const candidates = kind === 'video'
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || candidates[candidates.length - 1];
}

async function beginSession() {
  if (!state.baseDir) {
    alert('Choose a save folder first.');
    return false;
  }
  if (state.sources.length === 0) {
    alert('Add at least one source first.');
    return false;
  }
  const name = el.sessionName.value.trim() || `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  state.sessionDir = await window.resync.makeSessionFolder(state.baseDir, name);
  return true;
}

async function armAndRecord() {
  const ready = await beginSession();
  if (!ready) return;

  el.armBtn.disabled = true;
  el.statusLabel.textContent = 'ARMING';
  el.statusLabel.className = 'status arming';

  await runCountdown(3);

  // Prepare a MediaRecorder + open file for every source first, so the
  // only thing left to do in the sync loop below is call .start() —
  // keeps the gap between the first and last source's actual start as
  // small as possible.
  const prepared = [];
  for (const source of state.sources) {
    const mimeType = pickMimeType(source.kind);
    const ext = source.kind === 'video' ? 'webm' : 'webm';
    const filename = `${sanitizeFilename(source.label)}.${ext}`;
    const fileId = await window.resync.openFile(state.sessionDir, filename);

    const recStream = source.kind === 'video'
      ? new MediaStream(source.stream.getVideoTracks())
      : source.stream;

    const recorder = new MediaRecorder(recStream, { mimeType });
    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        const buf = await e.data.arrayBuffer();
        window.resync.writeChunk(fileId, buf);
      }
    };

    source.fileId = fileId;
    source.filename = filename;
    source.recorder = recorder;
    prepared.push(source);
  }

  const syncLog = { sessionStartedAt: Date.now(), sources: [] };

  // Fire every recorder's start() back-to-back in the same synchronous
  // pass. This is "software sync" — expect drift on the order of a few
  // milliseconds to a couple dozen ms depending on device/driver
  // latency, not frame-accurate hardware sync. That's what the
  // countdown click is for: use it as the true alignment point when
  // editing.
  const t0 = performance.now();
  for (const source of prepared) {
    source.recorder.start(1000); // 1s timeslice: chunks stream to disk as they're captured
    source.tileEl.classList.add('recording');
    syncLog.sources.push({
      label: source.label,
      kind: source.kind,
      filename: source.filename,
      startedAtMsAfterArm: Math.round(performance.now() - t0)
    });
  }

  await window.resync.writeJson(state.sessionDir, 'sync-log.json', syncLog);

  state.recording = true;
  state.recordStartWallClock = Date.now();
  el.statusLabel.textContent = 'RECORDING';
  el.statusLabel.className = 'status recording';
  el.stopBtn.disabled = false;
  startTimer();
}

async function stopRecording() {
  if (!state.recording) return;
  el.stopBtn.disabled = true;

  const closes = state.sources.map((source) => new Promise((resolve) => {
    if (!source.recorder || source.recorder.state === 'inactive') {
      resolve();
      return;
    }
    source.recorder.onstop = async () => {
      await window.resync.closeFile(source.fileId);
      source.tileEl.classList.remove('recording');
      resolve();
    };
    source.recorder.stop();
  }));

  await Promise.all(closes);

  state.recording = false;
  stopTimer();
  el.statusLabel.textContent = 'IDLE';
  el.statusLabel.className = 'status idle';
  el.armBtn.disabled = false;

  alert(`Saved to:\n${state.sessionDir}`);
}

// --------------------------------------------------------------------
// Countdown / sync click
// --------------------------------------------------------------------

function beep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 1000;
  gain.gain.setValueAtTime(0.4, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.12);
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    el.countdownOverlay.classList.remove('hidden');
    let n = seconds;
    el.countdownNumber.textContent = n;

    const tick = () => {
      if (n === 0) {
        el.countdownNumber.textContent = 'GO';
        document.body.classList.add('flash');
        beep(); // this is the acoustic/visual sync reference point
        setTimeout(() => {
          document.body.classList.remove('flash');
          el.countdownOverlay.classList.add('hidden');
          resolve();
        }, 200);
        return;
      }
      el.countdownNumber.textContent = n;
      n -= 1;
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  });
}

// --------------------------------------------------------------------
// Timer
// --------------------------------------------------------------------

function startTimer() {
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - state.recordStartWallClock;
    const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
    el.timerLabel.textContent = `${h}:${m}:${s}`;
  }, 250);
}
function stopTimer() {
  clearInterval(state.timerInterval);
}

// --------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------

el.chooseFolderBtn.addEventListener('click', async () => {
  const dir = await window.resync.chooseFolder();
  if (dir) {
    state.baseDir = dir;
    el.folderLabel.textContent = dir;
  }
});

el.addVideoBtn.addEventListener('click', () => addVideoSource().catch((e) => alert(e.message)));
el.addAudioBtn.addEventListener('click', () => addAudioSourceFromDropdown().catch((e) => alert(e.message)));
el.addAudioChannelsBtn.addEventListener('click', () => addAudioChannelsSeparately().catch((e) => alert(e.message)));
el.refreshDevicesBtn.addEventListener('click', () => refreshDevices());
el.armBtn.addEventListener('click', () => armAndRecord());
el.stopBtn.addEventListener('click', () => stopRecording());

navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

(async function init() {
  await unlockDeviceLabels();
  await refreshDevices();
})();
