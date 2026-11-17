'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  me: { name: '', aliases: [], role: '' },
  llm: {
    live: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    notes: { provider: 'anthropic', model: 'claude-opus-5-5' },
    webSearch: true,
    baseUrls: {},
  },
  stt: {
    provider: 'deepgram',
    language: 'en',
    skipSilence: true,
    identifySpeakers: true,
    suggestNames: true,
    keyterms: [],
    models: { deepgram: 'nova-3', assemblyai: 'universal-streaming-english', openai: 'gpt-transcribe', groq: 'whisper-large-v3-turbo' },
  },
  audio: { micDeviceId: 'default', captureMic: true, captureSystem: true, echoFilter: true },
  // A room microphone hears everybody; micFrom only applies to separate computer audio.
  remote: { enabled: false, host: '', port: 47615, listen: 'room', micFrom: 'recorder' }, // host is the main PC's Tailscale (or LAN) address that the listener binds to
  copilot: { autoMode: 'questions', personality: 'default', proactiveEverySec: 45, autoStopMinutes: 20 },
  overlay: { opacity: 0.94, bounds: null, hideFromCapture: true },
  appWindow: { bounds: null, maximized: false }, // the main window's last size and place; the main process only, never settings:set
  appearance: { theme: 'system' },
  shortcuts: {
    // Alt+Shift, not Ctrl+Alt: on many keyboard layouts Ctrl+Alt is AltGr,
    // which people use to type letters.
    answer: 'Alt+Shift+A',
    screen: 'Alt+Shift+S',
    take: 'Alt+Shift+T',
    catchup: 'Alt+Shift+C',
    toggleOverlay: 'Alt+Shift+H',
    pause: 'Alt+Shift+P',
  },
  library: { folders: [], pinned: [], includeMeetings: true, readImages: false }, // pinned: folders (from `folders`) whose files go into every answer in full
  sync: { liveCopy: true }, // while a meeting runs, _live-<PC>.md in the Meetings folder holds the transcript so far (live-copy.js)
  meetingsDir: '',
  notesDir: '', // '' means Documents\Understudy\Notes
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

let tmpSeq = 0;

function notLink(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  if (st.isSymbolicLink()) throw Object.assign(new Error('Refusing to write through a symbolic link.'), { code: 'ELOOP' });
}

// Writes via a temporary file and a rename. On Windows a virus scanner or a
// sync client can hold the target for a moment, so the rename is retried, and
// as a last resort the file is written in place.
function writeAtomic(file, text, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  notLink(file);
  const tmp = (opts && opts.tmp) || `${file}.${process.pid}.${++tmpSeq}.tmp`;
  notLink(tmp);
  const writeOpts = opts && opts.mode ? { mode: opts.mode } : undefined;
  let moved = false;
  try {
    fs.writeFileSync(tmp, text, writeOpts);
    for (let attempt = 0; ; attempt++) {
      try { notLink(file); fs.renameSync(tmp, file); moved = true; return; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e;
        if (attempt >= 6) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
      }
    }
    notLink(file);
    fs.writeFileSync(file, text, writeOpts);
  } finally {
    if (!moved) { try { fs.unlinkSync(tmp); } catch { /* left for the next write to replace */ } }
  }
}

const KEEP_CORRUPT = 3;
const two = (n) => String(n).padStart(2, '0');

// Copies an unreadable settings file to <name>.corrupt-<yyyymmdd-hhmmss>.json next to it and keeps
// only the newest KEEP_CORRUPT such copies. Returns the copy's path, or '' when it could not be made.
function backUpCorrupt(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, '.json');
  const d = new Date();
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  let backup = '';
  try {
    // A second copy in the same second takes the next number. It counts from the highest one there, not from the
    // first free one: older copies are removed below, and a freed name must never make a new copy look old.
    let top = 0;
    for (const f of fs.readdirSync(dir)) { const m = new RegExp(`^${stem}\\.corrupt-${stamp}(?:-(\\d+))?\\.json$`).exec(f); if (m) top = Math.max(top, Number(m[1] || 1)); }
    for (let n = top ? top + 1 : 1; n < top + 100 && !backup; n++) {
      const target = path.join(dir, `${stem}.corrupt-${stamp}${n > 1 ? `-${n}` : ''}.json`);
      try { fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); backup = target; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  } catch { return ''; }
  try {
    const mine = new RegExp(`^${stem}\\.corrupt-\\d{8}-\\d{6}(-\\d+)?\\.json$`); // stem is 'settings' or 'secrets'
    // Oldest first: by the date and time in the name, then by the number added when several came in one second.
    const order = (f) => { const m = /corrupt-(\d{8}-\d{6})(?:-(\d+))?\.json$/.exec(f); return `${m[1]}-${String(m[2] || 1).padStart(6, '0')}`; };
    const old = fs.readdirSync(dir).filter((f) => mine.test(f)).sort((x, y) => (order(x) < order(y) ? -1 : 1));
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* left for next time */ } }
  } catch { /* the copy itself is made */ }
  return backup;
}

// `crypto` is { available(), encrypt(str) -> Buffer, decrypt(Buffer) -> str }.
// In the app it is Electron's safeStorage (DPAPI on Windows), so API keys are
// never written to disk in the clear.
class Settings {
  constructor(dir, crypto, { requireEncryption = false } = {}) {
    this.file = path.join(dir, 'settings.json');
    this.secretFile = path.join(dir, 'secrets.json');
    this.crypto = crypto;
    this.requireEncryption = Boolean(requireEncryption);
    this.data = DEFAULTS;
    this.secrets = {};
    // What went wrong on loading, for the app to tell the person: null when nothing, otherwise
    // { file: 'settings.json' | 'secrets.json', backup: <path of the saved copy, '' when it could not be made> }.
    // loadProblems lists every such file (both can be unreadable at once); loadProblem is the first.
    this.loadProblem = null;
    this.loadProblems = [];
    this.load();
  }

  load() {
    this.data = merge(DEFAULTS, this._readJson(this.file, 'settings.json') || {});
    const secrets = this._readJson(this.secretFile, 'secrets.json');
    this.secrets = secrets || {};
  }

  // Parses a settings file. A missing or empty file is "nothing saved yet". A file that cannot be
  // read as a JSON object is copied aside (settings.corrupt-<date>-<time>.json) before anything can
  // overwrite it, and the problem is recorded; the caller then starts from defaults.
  _readJson(file, name) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return null; }
    let text = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8'); // Notepad's "Unicode"
    text = text.replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    try {
      const v = JSON.parse(text);
      if (isObj(v)) return v;
    } catch { /* corrupt: kept below */ }
    const backup = backUpCorrupt(file);
    const problem = { file: name, backup };
    this.loadProblems.push(problem);
    if (!this.loadProblem) this.loadProblem = problem;
    return null;
  }

  get() { return this.data; }

  set(patch) {
    this.data = merge(this.data, patch);
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    return this.data;
  }

  setSecret(name, value) {
    const v = String(value || '').trim();
    if (!v) delete this.secrets[name];
    else if (this.crypto && this.crypto.available()) this.secrets[name] = { enc: this.crypto.encrypt(v).toString('base64') };
    else if (this.requireEncryption) throw new Error('Secret encryption is not available, so the key was not saved.');
    else this.secrets[name] = { plain: v };
    writeAtomic(this.secretFile, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
  }

  getSecret(name) {
    const s = this.secrets[name];
    if (!s) return '';
    if (s.plain) return s.plain;
    try { return this.crypto.decrypt(Buffer.from(s.enc, 'base64')); } catch { return ''; }
  }

  secretsPresent() {
    const out = {};
    for (const k of Object.keys(this.secrets)) out[k] = true;
    return out;
  }

  secretsEncrypted() { return Boolean(this.crypto && this.crypto.available()); }
}

module.exports = { Settings, DEFAULTS, merge, writeAtomic };
