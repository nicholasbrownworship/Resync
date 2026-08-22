const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Holds open write streams for in-progress recordings, keyed by an id
// the renderer generates per source per session.
const openStreams = new Map();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Multi-channel audio capture (see renderer) needs this off so
      // Chromium doesn't silently downmix requested channel counts.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  // Auto-grant camera/mic permission requests from our own renderer.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') callback(true);
    else callback(false);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- Folder picking ----

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a folder for this session\'s recordings'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('make-session-folder', async (_event, baseDir, sessionName) => {
  const full = path.join(baseDir, sessionName);
  fs.mkdirSync(full, { recursive: true });
  return full;
});

// ---- Streaming per-source file writes ----
// The renderer sends chunks as they arrive from MediaRecorder rather than
// buffering a whole session in memory, so multi-hour sessions don't risk
// running out of RAM or losing everything if something crashes near the end.

ipcMain.handle('recording:open', async (_event, sessionDir, filename) => {
  const filePath = path.join(sessionDir, filename);
  const stream = fs.createWriteStream(filePath);
  const id = `${filename}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  openStreams.set(id, stream);
  return id;
});

ipcMain.handle('recording:chunk', async (_event, id, buffer) => {
  const stream = openStreams.get(id);
  if (!stream) return false;
  return new Promise((resolve) => {
    stream.write(Buffer.from(buffer), (err) => resolve(!err));
  });
});

ipcMain.handle('recording:close', async (_event, id) => {
  const stream = openStreams.get(id);
  if (!stream) return false;
  return new Promise((resolve) => {
    stream.end(() => {
      openStreams.delete(id);
      resolve(true);
    });
  });
});

ipcMain.handle('write-json', async (_event, sessionDir, filename, data) => {
  const filePath = path.join(sessionDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
});
