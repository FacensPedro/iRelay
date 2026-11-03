'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('irelay', {
  state: () => ipcRenderer.invoke('state'),
  onState: (callback) => ipcRenderer.on('state', (_, state) => callback(state)),
  refresh: () => ipcRenderer.invoke('refresh'),
  openSteam: () => ipcRenderer.invoke('openSteam'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  steamDLC: (appId) => ipcRenderer.invoke('steamDLC', appId),
  install: (request) => ipcRenderer.invoke('install', request),
  send: (request) => ipcRenderer.invoke('send', request),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  selectDevice: (udid) => ipcRenderer.invoke('selectDevice', udid),
  irelayBugs: () => ipcRenderer.invoke('irelayBugs'),
  ideckBugs: () => ipcRenderer.invoke('ideckBugs'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  setToken: (token) => ipcRenderer.invoke('setToken', token),
  clearCache: () => ipcRenderer.invoke('clearCache'),
});
