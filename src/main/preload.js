const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('getState'),
  info: () => ipcRenderer.invoke('info'),
  action: (type, payload) => ipcRenderer.invoke('action', type, payload),
  exportCsv: (opts) => ipcRenderer.invoke('exportCsv', opts),
  openDataFolder: () => ipcRenderer.invoke('openDataFolder'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusSearch: (cb) => ipcRenderer.on('focusSearch', () => cb()),
  onShowDay: (cb) => ipcRenderer.on('showDay', () => cb()),
});
