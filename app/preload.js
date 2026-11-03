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
  ideckBugs: () => ipcRenderer.invoke('ideckBugs'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  setToken: (token) => ipcRenderer.invoke('setToken', token),
});
