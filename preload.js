const { contextBridge, ipcRenderer } = require('electron');

// The only surface the page gets from the desktop shell. Nothing else from Node or Electron is exposed.
contextBridge.exposeInMainWorld('watchroom', {
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke('app:info'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  prepareShare: (sourceId, audio) => ipcRenderer.invoke('share:prepare', { sourceId, audio }),
  cancelShare: () => ipcRenderer.invoke('share:cancel'),
  screenAccess: () => ipcRenderer.invoke('system:screen-access'),
  openScreenSettings: () => ipcRenderer.invoke('system:open-screen-settings'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdate: (url) => ipcRenderer.invoke('updates:open', url),
  pendingInvite: () => ipcRenderer.invoke('invite:pending'),
  turnServers: () => ipcRenderer.invoke('config:turn'),
  onInvite: (callback) => ipcRenderer.on('invite', (_event, code) => callback(code)),
});
