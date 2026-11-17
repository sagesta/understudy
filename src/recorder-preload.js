'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Each method fixes its channel and shape. Clipboard text and saved settings stay in main.
contextBridge.exposeInMainWorld('recorder', {
  pasteFromClipboard: () => ipcRenderer.invoke('recorder:paste'),
  connect: (text) => typeof text === 'string' && text.length <= 2000
    ? ipcRenderer.invoke('recorder:connect', text) : Promise.reject(new Error('Use settings text of at most 2,000 characters.')),
  getState: () => ipcRenderer.invoke('recorder:state'),
  onState: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('A state callback is required.');
    const fn = (_e, state) => cb(state);
    ipcRenderer.on('recorder:state', fn);
    return () => ipcRenderer.removeListener('recorder:state', fn);
  },
  setAutoStart: (flag) => typeof flag === 'boolean'
    ? ipcRenderer.invoke('recorder:autoStart', flag) : Promise.reject(new Error('Choose whether to start with Windows.'))
});
