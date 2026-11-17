'use strict';
// "Sync between PCs": one folder, chosen once, holds both the Meetings folder and the Notes folder, so a synced
// drive (Google Drive for desktop in Mirror mode, OneDrive, Dropbox) carries everything between computers.
//
// Pure Node, no Electron: main.js owns the dialog and passes in what only it knows (the current folders, the
// app's own data folder, whether a meeting is running, and what "switch" means). Everything here that touches
// files works in small batches and yields to the event loop, because the main process also runs live meetings.
//
// Nothing is applied until apply() is called, which acts on the choice held here (never on a path from a window).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { isJunk } = require('./knowledge/library');

const WIN = process.platform === 'win32';
const TTL_MS = 10 * 60 * 1000;
const BATCH = 16;           // files copied at the same time
const SLICE_MS = 8;         // the longest the loop runs before it gives the event loop a turn

// An Error whose message is already fit to show. Anything else that escapes is replaced by a generic sentence.
class PlainError extends Error { constructor(m) { super(m); this.name = 'PlainError'; this.plain = true; } }
const plainFail = (m) => new PlainError(m);

// ---------------------------------------------------------------- paths
const key = (p) => { const r = path.resolve(String(p)); return WIN ? r.toLowerCase() : r; };
const samePath = (a, b) => key(a) === key(b);
const within = (parent, child) => {
  const r = path.relative(key(parent), key(child));
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};
const related = (a, b) => within(a, b) || within(b, a);
const isRoot = (p) => { const r = path.resolve(String(p)); return path.parse(r).root === r; };

// The subfolders of a folder, by name (an unreadable or missing folder has none).
function subfolders(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

// From the folder the person chose: which two folders the app will use.
//  - a folder called Understudy, or one that already holds a Meetings or a Notes folder, is used as it is;
//  - any other folder gets an Understudy folder made inside it.
// On a second PC the same Drive folder therefore lands on the same two folders.
function decide(chosen) {
  const x = path.resolve(String(chosen));
  const names = subfolders(x);
  const find = (want) => names.find((n) => n.toLowerCase() === want);
  const m = find('meetings'), n = find('notes');
  let parent = x;
  if (path.basename(x).toLowerCase() !== 'understudy' && !m && !n) parent = path.join(x, find('understudy') || 'Understudy');
  const inner = parent === x ? { m, n } : { m: undefined, n: undefined };
  return { parent, meetingsDir: path.join(parent, inner.m || 'Meetings'), notesDir: path.join(parent, inner.n || 'Notes') };
}

// The places that are never a good home for the two folders. Returns a plain sentence, or '' when the folder is fine.
function systemDirs(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const e = (k) => env[k] || env[k.toLowerCase()] || '';
    return [e('SystemRoot') || e('windir') || 'C:\\Windows', e('ProgramFiles') || 'C:\\Program Files', e('ProgramFiles(x86)') || 'C:\\Program Files (x86)', e('ProgramW6432'), e('ProgramData') || 'C:\\ProgramData'].filter(Boolean);
  }
  return ['/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/sbin', '/sys', '/usr', '/System'];
}

function refusal(chosen, { home = os.homedir(), appData = '', system = systemDirs() } = {}) {
  const p = String(chosen || '');
  if (!p) return 'That folder could not be found.';
  if (isRoot(p)) return 'That is a whole drive. Choose a folder inside it, such as one in Google Drive.';
  if (home && samePath(p, home)) return 'That is your user folder itself. Choose a folder inside it.';
  if (system.some((s) => within(s, p))) return 'That is a system folder. Choose a folder in Google Drive, OneDrive or Dropbox.';
  if (appData && within(appData, p)) return "That is Understudy's own data folder. Choose another folder.";
  let st;
  try { st = fs.statSync(p); } catch { return 'That folder could not be found.'; }
  if (!st.isDirectory()) return 'That is a file, not a folder. Choose a folder.';
  let real;
  try { real = fs.realpathSync(p); } catch { return 'That folder could not be found.'; }
  const realOrSelf = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
  if (isRoot(real)) return 'That is a whole drive. Choose a folder inside it, such as one in Google Drive.';
  if (home && (samePath(real, home) || samePath(real, realOrSelf(home)))) return 'That is your user folder itself. Choose a folder inside it.';
  if (system.some((s) => within(s, real) || within(realOrSelf(s), real))) return 'That is a system folder. Choose a folder in Google Drive, OneDrive or Dropbox.';
  if (appData && (within(appData, real) || within(realOrSelf(appData), real))) return "That is Understudy's own data folder. Choose another folder.";
  return '';
}

// A plain sentence for a file system error, with no code and no path in it.
function plainReason(e) {
  const c = e && e.code;
  if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS') return 'Understudy is not allowed to write there. Choose another folder.';
  if (c === 'ENOSPC' || c === 'EDQUOT') return 'There is no space left on that drive.';
  if (c === 'ENOENT' || c === 'ENODEV' || c === 'ENXIO' || c === 'EIO' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'ENETDOWN' || c === 'ENOTCONN' || c === 'EBUSY') return 'That drive or folder is not available right now.';
  if (c === 'ENOTDIR' || c === 'EEXIST') return 'A file is in the way, so the folders could not be made there.';
  return 'The folders could not be made there. Choose another folder.';
}

function ensureDirs(dirs) {
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { throw plainFail(plainReason(e)); }
  }
}

// ---------------------------------------------------------------- walking and counting
const tick = () => { let last = performance.now(); return async () => { if (performance.now() - last >= SLICE_MS) { await new Promise((r) => setImmediate(r)); last = performance.now(); } }; };

// Every file worth copying under `root`, as { rel, abs }, depth first. Not copied: files starting with "_"
// (generated daily digests), folders starting with "." (.versions, a sync service's own), and a sync service's
// leftovers (the same list the library ignores). Symbolic links are not followed. A folder that cannot be read
// is reported to `onError` and walking goes on.
async function* walk(root, { fs: f = fsp, onError = () => {}, pause = tick() } = {}, rel = '') {
  let entries;
  try { entries = await f.readdir(path.join(root, rel), { withFileTypes: true }); } catch (e) { if (rel) onError(e, rel); return; }
  for (const e of entries) {
    await pause();
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      yield* walk(root, { fs: f, onError, pause }, path.join(rel, e.name));
    } else if (e.isFile()) {
      if (e.name.startsWith('_') || isJunk(e.name)) continue;
      yield { rel: path.join(rel, e.name), abs: path.join(root, rel, e.name) };
    }
  }
}

async function* batches(iter, size) {
  let b = [];
  for await (const x of iter) { b.push(x); if (b.length >= size) { yield b; b = []; } }
  if (b.length) yield b;
}

const exists = (f, p) => f.lstat(p).then(() => true, () => false);

// How many files in `from` are not yet in `to`.
async function countNew(from, to, { fs: f = fsp } = {}) {
  if (samePath(from, to)) return 0;
  let n = 0;
  for await (const batch of batches(walk(from, { fs: f }), 64)) {
    const found = await Promise.all(batch.map((x) => exists(f, path.join(to, x.rel))));
    n += found.filter((y) => !y).length;
  }
  return n;
}

// ---------------------------------------------------------------- copying
// Errors that mean the destination itself is gone or full: going on would only fail the same way for every file.
const FATAL = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'ENODEV', 'ENXIO', 'EIO', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTCONN']);
const STOPPED = (code) => (code === 'ENOSPC' || code === 'EDQUOT' ? 'the drive is full' : code === 'EROFS' ? 'the folder is read-only' : 'the drive stopped answering');

class CopyStopped extends PlainError {
  constructor(code, partial) { super(`Copying stopped because ${STOPPED(code)}.`); this.partial = partial; this.code = code; }
}

// Copies every file of `from` into `to`, keeping its place in the folder tree and its modification time. A file
// that is already there is never touched (COPYFILE_EXCL) and is counted as skipped. A file that fails is counted
// and the rest go on. Returns { copied, skipped, failed }; throws CopyStopped (with the counts so far) when the
// destination itself gives out.
async function copyTree(from, to, { fs: f = fsp, constants = fs.constants, onFile } = {}) {
  const r = { copied: 0, skipped: 0, failed: 0 };
  if (samePath(from, to)) return r;
  const made = new Set();
  const onError = () => { r.failed += 1; };
  let stop = null;
  const one = async (x) => {
    if (stop) return;
    const dest = path.join(to, x.rel), dir = path.dirname(dest);
    try {
      if (!made.has(dir)) { await f.mkdir(dir, { recursive: true }); made.add(dir); }
    } catch (e) {
      if (FATAL.has(e && e.code) || (e && e.code) === 'ENOENT') { stop = stop || e.code; return; }
      r.failed += 1; return;
    }
    let st = null;
    try { st = await f.stat(x.abs); } catch { /* copyFile reports it */ }
    try {
      await f.copyFile(x.abs, dest, constants.COPYFILE_EXCL);
    } catch (e) {
      const c = e && e.code;
      if (c === 'EEXIST') { r.skipped += 1; return; }
      if (FATAL.has(c)) { stop = stop || c; return; }
      r.failed += 1; return;
    }
    r.copied += 1;
    if (onFile) onFile(x);
    if (st) { try { await f.utimes(dest, st.atime, st.mtime); } catch { /* the copy is good; only its date is off */ } }
  };
  for await (const batch of batches(walk(from, { fs: f, onError }), BATCH)) {
    await Promise.all(batch.map(one));
    if (stop) throw new CopyStopped(stop, { ...r });
  }
  return r;
}

// ---------------------------------------------------------------- the choice, held in the main process
function createPending({ now = Date.now, ttlMs = TTL_MS } = {}) {
  let held = null;
  return {
    set(choice) { held = { choice, at: now() }; },
    get() { if (!held) return null; if (now() - held.at > ttlMs) { held = null; return null; } return held.choice; },
    clear() { held = null; },
  };
}

// Two of the person's current folders and the two new ones: are any of them the same place, or one inside another?
// "Same" for a folder and its own replacement is not an overlap (nothing to copy there); anything else related is.
function relate(cur, next) {
  const same = samePath(cur.meetingsDir, next.meetingsDir) && samePath(cur.notesDir, next.notesDir);
  let overlap = false;
  const olds = [cur.meetingsDir, cur.notesDir], news = [next.meetingsDir, next.notesDir];
  for (let i = 0; i < 2; i += 1) for (let j = 0; j < 2; j += 1) {
    if (related(olds[i], news[j]) && !(i === j && samePath(olds[i], news[j]))) overlap = true;
  }
  return { same, overlap };
}

// ---------------------------------------------------------------- the whole thing, without Electron
// current()       -> { meetingsDir, notesDir }              the folders in use now
// defaults()      -> { meetingsDir, notesDir }              where they are when nothing was chosen
// guards()        -> { home, appData, system? }             what a chosen folder must not be
// meetingActive() -> boolean
// commit(next)    -> void                                   writes the settings and everything that follows from them
function createSharedFolder({ current, defaults, guards = () => ({}), meetingActive = () => false, commit, now = Date.now, ttlMs = TTL_MS, fs: f = fsp, mkdirs = ensureDirs } = {}) {
  const pending = createPending({ now, ttlMs });
  let busy = false;

  const assertIdle = () => { if (meetingActive()) throw plainFail('Finish the meeting first.'); };
  const safely = async (fn, fallback) => {
    try { return await fn(); } catch (e) { if (e && e.plain) throw e; throw plainFail(fallback); }
  };

  function info() {
    const c = current(), d = defaults();
    const isDefault = samePath(c.meetingsDir, d.meetingsDir) && samePath(c.notesDir, d.notesDir);
    const siblings = samePath(path.dirname(c.meetingsDir), path.dirname(c.notesDir));
    const shared = siblings && !samePath(path.dirname(c.meetingsDir), path.dirname(d.meetingsDir));
    return { meetingsDir: c.meetingsDir, notesDir: c.notesDir, isDefault, shared, parent: shared ? path.dirname(c.meetingsDir) : null };
  }

  // The folder the person picked (from the dialog, or the test hook). Remembered as the pending choice.
  function choose(picked) {
    return safely(async () => {
      assertIdle();
      const why = refusal(picked, guards());
      if (why) throw plainFail(why);
      const next = decide(picked), cur = current();
      const rel = relate(cur, next);
      const existing = { meetings: 0, notes: 0 };
      if (!rel.overlap) {
        existing.meetings = await countNew(cur.meetingsDir, next.meetingsDir, { fs: f });
        existing.notes = await countNew(cur.notesDir, next.notesDir, { fs: f });
      }
      pending.set({ ...next, chosen: path.resolve(String(picked)) });
      return { meetingsDir: next.meetingsDir, notesDir: next.notesDir, parent: next.parent, existing, overlap: rel.overlap, same: rel.same };
    }, 'That folder could not be used. Choose another one.');
  }

  // Acts on the pending choice only. Copies first (when asked), then writes the settings, so a copy that fails
  // leaves everything as it was.
  function apply({ copy = false } = {}) {
    return safely(async () => {
      assertIdle();
      if (busy) throw plainFail('Folders are already being switched. Wait a moment.');
      const next = pending.get();
      if (!next) throw plainFail('Choose the folder again.');
      busy = true;
      try {
        const why = refusal(next.chosen, guards()); // the folder may have been removed or changed since it was chosen
        if (why) throw plainFail(why);
        const cur = current();
        const rel = relate(cur, next);
        mkdirs([next.meetingsDir, next.notesDir]);
        const copied = { meetings: 0, notes: 0, skipped: 0, failed: 0 };
        if (copy && !rel.overlap) {
          let meetingsCopied = 0;
          try {
            const m = await copyTree(cur.meetingsDir, next.meetingsDir, { fs: f });
            meetingsCopied = m.copied;
            const n = await copyTree(cur.notesDir, next.notesDir, { fs: f });
            Object.assign(copied, { meetings: m.copied, notes: n.copied, skipped: m.skipped + n.skipped, failed: m.failed + n.failed });
          } catch (e) {
            if (e instanceof CopyStopped) {
              const have = meetingsCopied + (e.partial ? e.partial.copied : 0);
              throw plainFail(`${e.message} ${have === 1 ? '1 file was' : `${have} files were`} copied before that, and nothing was switched. Your originals are untouched.`);
            }
            throw e;
          }
        }
        assertIdle(); // a meeting may have started while files were copying: it would write to the old folder
        try { commit({ meetingsDir: next.meetingsDir, notesDir: next.notesDir, parent: next.parent }); } catch { throw plainFail('The new folders could not be saved, so nothing was switched. Try again.'); }
        pending.clear();
        return { meetingsDir: next.meetingsDir, notesDir: next.notesDir, copied };
      } finally { busy = false; }
    }, 'The folders could not be switched. Nothing was changed.');
  }

  return { info, choose, apply, assertIdle, pending };
}

module.exports = {
  createSharedFolder, createPending, decide, refusal, systemDirs, plainReason, ensureDirs, relate,
  walk, countNew, copyTree, samePath, within, isRoot, PlainError, CopyStopped, TTL_MS,
};
