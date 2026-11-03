'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('irelay', {
  state: () => ipcRenderer.invoke('state'),
  onState: (callback) => ipcRenderer.on('state', (_, state) => callback(state)),
  refresh: () => ipcRenderer.invoke('refresh'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  steamDLC: (appId) => ipcRenderer.invoke('steamDLC', appId),
  install: (request) => ipcRenderer.invoke('install', request),
  selectDevice: (udid) => ipcRenderer.invoke('selectDevice', udid),
  irelayBugs: () => ipcRenderer.invoke('irelayBugs'),
  clearIrelayBugs: () => ipcRenderer.invoke('clearIrelayBugs'),
  clearIdeckBugs: () => ipcRenderer.invoke('clearIdeckBugs'),
  ideckBugs: () => ipcRenderer.invoke('ideckBugs'),
  openFolder: (which) => ipcRenderer.invoke('openFolder', which),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
});
