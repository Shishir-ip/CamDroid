const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camdroid', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onDevices: (cb) => {
    const listener = (_e, list) => cb(list);
    ipcRenderer.on('devices', listener);
    return () => ipcRenderer.removeListener('devices', listener);
  },
  refreshDevices: () => ipcRenderer.invoke('devices:refresh'),
  adbStatus: () => ipcRenderer.invoke('adb:status'),
  vcamStatus: () => ipcRenderer.invoke('vcam:status'),
  vcamEnable: (opts) => ipcRenderer.invoke('vcam:enable', opts),
  vcamDisable: () => ipcRenderer.invoke('vcam:disable'),
  vcamFrame: (payload) => ipcRenderer.send('vcam:frame', payload),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('win:alwaysOnTop', on),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  setAutoStart: (on) => ipcRenderer.invoke('app:autoStart', on),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  version: () => ipcRenderer.invoke('app:version')
});