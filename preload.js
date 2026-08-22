const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resync', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  makeSessionFolder: (baseDir, sessionName) =>
    ipcRenderer.invoke('make-session-folder', baseDir, sessionName),

  openFile: (sessionDir, filename) =>
    ipcRenderer.invoke('recording:open', sessionDir, filename),
  writeChunk: (id, arrayBuffer) =>
    ipcRenderer.invoke('recording:chunk', id, arrayBuffer),
  closeFile: (id) => ipcRenderer.invoke('recording:close', id),

  writeJson: (sessionDir, filename, data) =>
    ipcRenderer.invoke('write-json', sessionDir, filename, data)
});
