'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the windows and the main process. Renderers get no
// Node access; they can call the named operations below and nothing else.
const INVOKE = new Set([
  'settings:get', 'settings:set', 'secrets:set', 'models:list', 'models:speedTest', 'models:speedTestCancel', 'models:speedTestLast', 'provider:test',
  'library:addFolder', 'library:removeFolder', 'library:pinFolder', 'library:reindex', 'library:stats', 'library:search',
  'profile:get', 'profile:save', 'profile:preview', 'profile:build',
  'personalities:list', 'personalities:save', 'personalities:delete',
  'meeting:start', 'meeting:stop', 'meeting:pause', 'meeting:resume', 'meeting:state', 'meeting:action', 'meeting:cancelCard', 'meeting:set', 'meeting:renameSpeaker', 'meeting:suggestion', 'meeting:answerPassed',
  'meetings:list', 'meetings:get', 'meetings:search', 'meetings:regenerate', 'meetings:renameSpeaker', 'meetings:reveal', 'meetings:openFolder', 'meetings:chooseFolder',
  'meetings:setActionItem', 'meetings:addUpdate', 'meetings:rename',
  'notes:add', 'notes:addImage', 'notes:list', 'notes:info', 'notes:chooseFolder', 'notes:openFolder',
  'shared:choose', 'shared:apply', 'shared:info', 'shared:open',
  'remote:info', 'remote:detect', 'remote:newToken', 'remote:copySettings', 'remote:test', 'remote:testCancel',
  'claude:info', 'claude:install',
  'issues:report', 'issues:info', 'issues:open', 'issues:rendererError',
  'keys:test', 'keys:link',
  'overlay:toggle', 'overlay:opacity', 'app:show', 'app:openExternal', 'app:copy', 'app:info',
]);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (handler) => {
    const fn = (_e, msg) => handler(msg);
    ipcRenderer.on('evt', fn);
    return () => ipcRenderer.removeListener('evt', fn);
  },
  // Used only by the hidden audio-capture window.
  sendAudio: (channel, bytes) => ipcRenderer.send('audio', channel, bytes),
  captureStatus: (status) => ipcRenderer.send('capture:status', status),
});
