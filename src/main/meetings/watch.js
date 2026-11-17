'use strict';
// Tells the app when a meeting file appears, changes or goes in the Meetings folder, so the Meetings page can keep up
// with meetings made on another PC and with edits made by other programs (Claude through the connector, a sync client).
// No Electron imports. The folder is asked for again every few seconds, because the app changes it in place (Settings,
// the shared-folder setup): the watcher follows without being told.
//
//   const w = watchMeetings(() => store.dir, () => ..., { debounceMs: 1500, recheckMs: 5000 });
//   w.stop();
//
// A burst of changes (a sync client writing a day's files) gives one call, debounceMs after the last of them, and never
// later than four times that after the first. Nothing here throws into the caller or into a file system callback.

const fs = require('node:fs');
const path = require('node:path');
const { isJunk } = require('../knowledge/library');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Whether a change reported inside the folder can matter to the list: a meeting file (not a "_" digest, not a sync
// client's scratch file, not inside a dot-folder such as Drive's temporary ones), or a day folder itself coming or going
// (a 'rename' event: a 'change' of the folder is only its modification time moving because a file in it did).
function worthALook(name, event = 'rename') {
  if (typeof name !== 'string' || !name) return false;
  const parts = name.split(/[\\/]/);
  const leaf = parts.pop();
  if (!leaf || parts.some((p) => p.startsWith('.'))) return false;
  if (DAY.test(leaf)) return event === 'rename';
  return /\.md$/i.test(leaf) && !leaf.startsWith('_') && !isJunk(leaf);
}

const keyOf = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function watchMeetings(getDir, onChange, { debounceMs = 1500, recheckMs = 5000 } = {}) {
  let stopped = false;
  let watcher = null;        // the fs.FSWatcher, or null while there is no folder to watch
  let watchedKey = '';       // the folder it is watching
  let timer = null;          // the debounce
  let firstAt = 0;           // when the burst now waiting began

  const dirNow = () => { try { const d = getDir(); return d ? String(d) : ''; } catch { return ''; } };

  function fire() {
    timer = null;
    if (stopped) return;
    try { onChange(); } catch { /* the caller's problem must not stop the watcher */ }
  }
  function poke() {
    if (stopped) return;
    const now = Date.now();
    if (!timer) firstAt = now;
    clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, firstAt + 4 * debounceMs - now)));
    if (timer.unref) timer.unref();
  }

  function close() {
    const w = watcher;
    watcher = null; watchedKey = '';
    if (w) { try { w.close(); } catch { /* already closed */ } }
  }

  // Watch the folder as it is now, or wait (the next check tries again) when it is not there.
  function arm(initial = false) {
    close();
    const dir = dirNow();
    if (!dir || !isDir(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, name) => {
        try { if (worthALook(name == null ? '' : String(name), _event)) poke(); } catch { /* never throws out of the callback */ }
      });
      w.on('error', () => { if (watcher === w) close(); }); // the folder went away: the next check arms again
      if (w.unref) w.unref();
      watcher = w;
      watchedKey = keyOf(dir);
      if (!initial) poke(); // a different folder, or one that was missing: what the list shows may be out of date
    } catch { /* cannot watch it (yet): the next check tries again */ }
  }

  function check() {
    if (stopped) return;
    try {
      const dir = dirNow();
      if (watcher && (!dir || keyOf(dir) !== watchedKey)) { arm(); return; }
      if (watcher && !isDir(dir)) { close(); poke(); return; } // the folder was removed
      if (!watcher) arm();
    } catch { /* tried again at the next check */ }
  }

  arm(true);
  const poll = setInterval(check, Math.max(50, recheckMs));
  if (poll.unref) poll.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      clearTimeout(timer); timer = null;
      close();
    },
  };
}

module.exports = { watchMeetings, worthALook };
