'use strict';
// What the windows are allowed to send the main process, and the repair of
// settings already on disk. Pure functions with no Electron import, so the
// tests can run them; main.js only calls them.
//
// A value that does not fit is dropped, never coerced into something else, so
// "aliases: 5" can never be saved and later break every transcript result.

const { isTailscaleOrLoopback } = require('./network-detect');

const REJECT = Symbol('reject');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- value rules. Each takes (value, ctx, repairing) and returns the value to
// keep, or REJECT. `ctx` carries the lists that live elsewhere in the app:
// { autoModes, sttProviders, llmProviders, personalityIds }.
const str = (max, { min = 0 } = {}) => (v) => (typeof v === 'string' && v.length >= min && v.length <= max ? v : REJECT);
const bool = (v) => (typeof v === 'boolean' ? v : REJECT);
const num = (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : REJECT);
const ip = (v) => (typeof v === 'string' && v.length <= 45 && (v === '' || isTailscaleOrLoopback(v)) ? v : REJECT);
const port = (v) => (Number.isInteger(v) ? num(1024, 65535)(v) : REJECT);
const oneOf = (listOf) => (v, ctx) => {
  const list = listOf(ctx);
  return typeof v === 'string' && (!list || list.includes(v)) ? v : REJECT;
};
// A list of short strings. A patch with one bad entry is refused as a whole;
// a file already on disk keeps its good entries instead (`repairing`).
const strList = (maxCount, maxLen) => (v, ctx, repairing) => {
  if (!Array.isArray(v)) return REJECT;
  const good = (x) => typeof x === 'string' && x.length >= 1 && x.length <= maxLen;
  if (repairing) return v.filter(good).slice(0, maxCount);
  return v.length <= maxCount && v.every(good) ? v : REJECT;
};
// The id of a personality that exists. On load only the type is checked: the
// folder of personalities could be unreadable for a moment, and a style that
// has since been deleted is already handled where it is used.
const personality = (v, ctx, repairing) => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 80) return REJECT;
  if (repairing || !ctx || typeof ctx.personalityIds !== 'function') return v;
  return ctx.personalityIds().includes(v) ? v : REJECT;
};

// ---- shortcuts. An accelerator is modifiers and then exactly one key, joined with "+":
//   Ctrl+Alt+F9, Alt+Shift+A, Control+Space, Alt+Plus. The key "+" itself is written "Plus".
const MODIFIERS = { control: 'ctrl', ctrl: 'ctrl', commandorcontrol: 'ctrl', cmdorctrl: 'ctrl', alt: 'alt', altgr: 'altgr', shift: 'shift', super: 'super', meta: 'super', command: 'cmd', cmd: 'cmd' };
const NAMED_KEYS = {
  space: 'space', enter: 'enter', return: 'enter', tab: 'tab', up: 'up', down: 'down', left: 'left', right: 'right', backspace: 'backspace', delete: 'delete', insert: 'insert',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', escape: 'escape', esc: 'escape', plus: 'plus', capslock: 'capslock', numlock: 'numlock', scrolllock: 'scrolllock',
  printscreen: 'printscreen', volumeup: 'volumeup', volumedown: 'volumedown', volumemute: 'volumemute', medianexttrack: 'medianexttrack', mediaprevioustrack: 'mediaprevioustrack',
  mediastop: 'mediastop', mediaplaypause: 'mediaplaypause', numdec: 'numdec', numadd: 'numadd', numsub: 'numsub', nummult: 'nummult', numdiv: 'numdiv',
};
const PUNCTUATION = '`~!@#$%^&*()_-=[]{}\\|;:\'",.<>/?';
// { mods: [sorted modifier names], key } for a valid accelerator, null for anything else.
function parseAccel(v) {
  if (typeof v !== 'string' || !v || v.length > 40 || /\s/.test(v)) return null;
  const parts = v.split('+');
  if (parts.some((p) => !p)) return null;
  const k = parts.pop();
  const low = k.toLowerCase();
  const key = /^[a-z0-9]$/.test(low) ? low : /^f([1-9]|1\d|2[0-4])$/.test(low) ? low : /^num[0-9]$/.test(low) ? low
    : Object.hasOwn(NAMED_KEYS, low) ? NAMED_KEYS[low] : (k.length === 1 && PUNCTUATION.includes(k) ? k : '');
  if (!key) return null;
  const mods = [];
  for (const p of parts) {
    const m = Object.hasOwn(MODIFIERS, p.toLowerCase()) ? MODIFIERS[p.toLowerCase()] : '';
    if (!m || mods.includes(m)) return null;
    mods.push(m);
  }
  // A bare letter, digit or punctuation key would be taken from every program, so only the F keys and the media
  // keys may stand alone.
  if (!mods.length && !/^f\d+$/.test(key) && !/^(media|volume)/.test(key)) return null;
  return { mods: mods.sort(), key };
}
const accelId = (v) => { const a = parseAccel(v); return a ? [...a.mods, a.key].join('+') : ''; };

// The names the Shortcuts tab gives the actions, for the message when one combination is asked for twice.
const SHORTCUT_NAMES = { answer: 'What to say', screen: 'Read screen', take: 'My take', catchup: 'Catch up', pause: 'Pause or resume', toggleOverlay: 'Show or hide overlay' };
const BAD_SHORTCUT = 'That is not a shortcut Understudy can use. Hold Ctrl or Alt and press one key.';

// Which shortcuts of a patch may not be set because another action already has that combination. The check is
// on the set that would result, not on one key at a time, so a patch that swaps two combinations is fine. When
// two keys of the patch ask for the same combination the later one is refused. Returns { key: name of the other action }.
function shortcutClashes(patch, current) {
  const cur = isPlain(current) ? current : {};
  const keys = Object.keys(SHORTCUT_NAMES);
  const result = {};
  for (const k of keys) result[k] = own(patch, k) ? patch[k] : cur[k];
  const refused = {};
  for (;;) {
    let again = false;
    for (const k of Object.keys(patch).reverse()) {
      const id = accelId(result[k]);
      if (!keys.includes(k) || !id || id === accelId(cur[k]) || refused[k]) continue;
      const other = keys.find((o) => o !== k && accelId(result[o]) === id);
      if (!other) continue;
      refused[k] = SHORTCUT_NAMES[other];
      result[k] = cur[k];
      again = true;
      break;
    }
    if (!again) return refused;
  }
}

const llmRole = { provider: oneOf((c) => c && c.llmProviders), model: str(120, { min: 1 }) };
// A shortcut: '' clears it, anything else must be an Electron accelerator (see parseAccel).
const accel = (v) => (v === '' || parseAccel(v) ? v : REJECT);
const names = {
  me: { name: str(80), aliases: strList(20, 60), role: str(120) },
  llm: { live: llmRole, notes: llmRole, webSearch: bool },
  stt: {
    provider: oneOf((c) => c && c.sttProviders), language: str(20), skipSilence: bool, identifySpeakers: bool, suggestNames: bool,
    keyterms: strList(100, 60),
    models: null, // one model string per known provider, filled in by specFor()
  },
  audio: { micDeviceId: str(200), captureMic: bool, captureSystem: bool, echoFilter: bool },
  remote: { enabled: bool, host: ip, port, listen: oneOf(() => ['room', 'computer']), micFrom: oneOf(() => ['main', 'recorder']) },
  copilot: { autoMode: oneOf((c) => c && c.autoModes), personality, proactiveEverySec: num(20, 300), autoStopMinutes: num(0, 240) },
  overlay: { opacity: num(0.4, 1), hideFromCapture: bool },
  appearance: { theme: oneOf(() => ['system', 'dark', 'light']) },
  shortcuts: { answer: accel, screen: accel, take: accel, catchup: accel, toggleOverlay: accel, pause: accel },
  library: { includeMeetings: bool, readImages: bool },
  sync: { liveCopy: bool },
};
// Not settable from a window, so not here: llm.baseUrls, library.folders,
// overlay.bounds, meetingsDir and notesDir are only ever set by the main process.

function specFor(ctx) {
  const spec = {};
  // `ctx.settable` ({ group: [keys] }) is the app's allow-list: a rule only applies to a key on it.
  const allowed = (g, k) => !ctx || !ctx.settable || (ctx.settable[g] || []).includes(k);
  for (const [g, keys] of Object.entries(names)) spec[g] = Object.fromEntries(Object.entries(keys).filter(([k]) => allowed(g, k)));
  if ('models' in spec.stt) spec.stt.models = Object.fromEntries(((ctx && ctx.sttProviders) || []).map((p) => [p, str(120, { min: 1 })]));
  return spec;
}

// Walks `value` against `spec` and returns what fits, or REJECT when nothing does.
function clean(spec, value, ctx, path, rejected, repairing) {
  if (typeof spec === 'function') {
    const r = spec(value, ctx, repairing);
    if (r === REJECT) rejected.push(path);
    return r;
  }
  if (!isPlain(value)) { rejected.push(path); return REJECT; }
  const out = {};
  for (const k of Object.keys(spec)) {
    if (!own(value, k)) continue;
    const r = clean(spec[k], value[k], ctx, `${path}.${k}`, rejected, repairing);
    if (r !== REJECT) out[k] = r;
  }
  return Object.keys(out).length ? out : REJECT;
}

// settings:set. Returns { patch, rejected } where `patch` holds only what fits
// and `rejected` names (as "group.key") every known setting that was refused.
function sanitiseSettingsPatch(raw, ctx) {
  const patch = {}, rejected = [], refused = {};
  if (!isPlain(raw)) return { patch, rejected: raw === undefined ? [] : ['settings'] };
  const spec = specFor(ctx);
  for (const g of Object.keys(spec)) {
    if (!own(raw, g)) continue;
    const r = clean(spec[g], raw[g], ctx, g, rejected, false);
    if (r !== REJECT) patch[g] = r;
  }
  // Shortcuts get a sentence of their own for each refusal (`refused`, by path), because the window that asked
  // shows it where the person is: a combination that is not one, or one that another action already has.
  for (const p of rejected) if (p.startsWith('shortcuts.')) refused[p] = BAD_SHORTCUT;
  if (patch.shortcuts) {
    const current = ctx && (typeof ctx.currentShortcuts === 'function' ? ctx.currentShortcuts() : ctx.currentShortcuts);
    for (const [k, name] of Object.entries(shortcutClashes(patch.shortcuts, current))) {
      delete patch.shortcuts[k];
      rejected.push(`shortcuts.${k}`);
      refused[`shortcuts.${k}`] = `That shortcut is already used for ${name}.`;
    }
    if (!Object.keys(patch.shortcuts).length) delete patch.shortcuts;
  }
  // `refused` is there only when a shortcut was refused.
  return Object.keys(refused).length ? { patch, rejected, refused } : { patch, rejected };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function put(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
  o[parts[parts.length - 1]] = value;
}

// Settings read from disk. Returns { patch, fixed }: `patch` puts the default
// back for every setting whose stored value is of the wrong type (and trims a
// list that has some bad entries), `fixed` names them. Settings the windows
// cannot set, and keys nobody knows, are left exactly as they are.
function repairSettings(data, defaults, ctx) {
  const patch = {}, fixed = [];
  const spec = specFor(ctx);
  const walk = (s, v, d, path) => {
    if (v === undefined) return; // missing: the defaults already fill it in
    if (typeof s === 'function') {
      const r = s(v, ctx, true);
      if (r === REJECT) { put(patch, path, clone(d)); fixed.push(path); }
      else if (Array.isArray(r) && r.length !== v.length) { put(patch, path, r); fixed.push(path); }
      return;
    }
    if (!isPlain(v)) { put(patch, path, clone(d)); fixed.push(path); return; }
    for (const k of Object.keys(s)) walk(s[k], own(v, k) ? v[k] : undefined, d && own(d, k) ? d[k] : undefined, `${path}.${k}`);
  };
  for (const g of Object.keys(spec)) walk(spec[g], data && own(data, g) ? data[g] : undefined, defaults && defaults[g], g);
  return { patch, fixed };
}

// meeting:action. The action must be one of the app's own, and only the
// fields the actions read are passed on, each as the right kind of value.
function cleanActionCall(action, params, actions) {
  if (typeof action !== 'string' || !own(actions, action)) throw new Error('That is not an action Understudy knows.');
  const p = isPlain(params) ? params : {};
  const out = {};
  const text = (k, max) => { if (own(p, k) && typeof p[k] === 'string' && p[k].trim()) out[k] = p[k].slice(0, max); };
  text('typed', 2000); text('ask', 1000); text('speaker', 80); text('addressee', 80);
  if (own(p, 'target') && ['you', 'room', 'other'].includes(p.target)) out.target = p.target;
  if (own(p, 'minutes') && typeof p.minutes === 'number' && Number.isFinite(p.minutes) && p.minutes >= 1 && p.minutes <= 60) out.minutes = Math.round(p.minutes);
  return { action, params: out };
}

// meeting:set. Anything that does not name a real mode or style is ignored.
function cleanMeetingSet(arg, ctx) {
  const a = isPlain(arg) ? arg : {};
  const out = {};
  if (own(a, 'autoMode') && typeof a.autoMode === 'string' && ctx.autoModes.includes(a.autoMode)) out.autoMode = a.autoMode;
  if (own(a, 'personality') && personality(a.personality, ctx, false) !== REJECT) out.personality = a.personality;
  return out;
}

// The refused settings, for the notice shown to the person ("copilot.autoMode").
function describeRejected(paths) { return [...new Set(paths)].join(', '); }

// ---- the notes bridge. Each function takes what a window sent and returns what
// the main process may use, or throws an ArgError whose text is written for the person.
class ArgError extends Error {
  constructor(message) { super(message); this.name = 'ArgError'; this.userFacing = true; }
}

// Remote commands, including remote:test and remote:testCancel, take no data from a window, including extra positional arguments.
function cleanRemoteArgs(...args) {
  if (args.length) throw new ArgError('That request was not understood.');
}

const MAX_NOTE_TEXT = 1000000;               // characters, as in notes-inbox.js
const MAX_NOTE_TITLE = 1000;                 // the folder keeps 120 of them; this only stops a silly size
const MAX_NOTE_IMAGE = 15 * 1024 * 1024;     // bytes
const MAX_ITEM_TEXT = 4000;                  // one action item's text
const MAX_UPDATE_TEXT = 2000;                // one follow-up line, as in the meeting store
const MEETING_ID = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_MEETING_TITLE = 200;               // characters (code points), as the title of a new meeting
const IMAGE_PREFIX = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// "data:image/png;base64,...." -> { mime, bytes }. The label and the size are checked before anything is decoded,
// and the alphabet before the decoder sees it. (Whether the bytes really are that kind of image is checked where the file is saved.)
function parseImageDataUrl(url, maxBytes = MAX_NOTE_IMAGE) {
  if (typeof url !== 'string' || !url) throw new ArgError('There is no image to save.');
  const m = IMAGE_PREFIX.exec(url.slice(0, 40));
  if (!m) throw new ArgError('Only PNG, JPEG, WebP and GIF images can be saved.');
  const b64 = url.slice(m[0].length);
  if (b64.length > Math.ceil(maxBytes / 3) * 4) throw new ArgError('That image is too large (over 15 MB).');
  if (!b64.length || b64.length % 4 !== 0 || !B64.test(b64)) throw new ArgError('That image could not be read.');
  const size = (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (size > maxBytes) throw new ArgError('That image is too large (over 15 MB).');
  const kind = m[1].toLowerCase();
  return { mime: kind === 'jpg' ? 'image/jpeg' : `image/${kind}`, bytes: Buffer.from(b64, 'base64') };
}

const optText = (v, max, what, tooLong) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new ArgError(`${what} must be text.`);
  if (v.length > max) throw new ArgError(tooLong);
  return v;
};

// notes:add { title, text }
function cleanNoteAdd(arg) {
  if (!isPlain(arg)) throw new ArgError('Write something to save first.');
  const title = optText(arg.title, MAX_NOTE_TITLE, 'The title', 'That title is too long.');
  if (typeof arg.text !== 'string') throw new ArgError('Write something to save first.');
  if (arg.text.length > MAX_NOTE_TEXT) throw new ArgError('That note is too long to save (over 1 MB).');
  return { title, text: arg.text };
}

// notes:addImage { dataUrl, title, note }
function cleanNoteImage(arg) {
  if (!isPlain(arg)) throw new ArgError('There is no image to save.');
  const { mime, bytes } = parseImageDataUrl(arg.dataUrl);
  const title = optText(arg.title, MAX_NOTE_TITLE, 'The title', 'That title is too long.');
  const note = optText(arg.note, MAX_NOTE_TEXT, 'The note', 'That note is too long to save (over 1 MB).');
  return { mime, bytes, title, note };
}

// notes:list { limit } (or nothing, or a bare number)
function cleanNotesList(arg) {
  const raw = isPlain(arg) ? arg.limit : arg;
  if (raw == null) return { limit: 50 };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ArgError('That is not a number of notes to list.');
  return { limit: Math.max(1, Math.min(500, Math.floor(raw))) };
}

// library:pinFolder { dir, on }. Only a folder the person has already added can be marked; the path is matched exactly.
function cleanPinFolder(arg, folders) {
  if (!isPlain(arg) || typeof arg.dir !== 'string' || typeof arg.on !== 'boolean') throw new ArgError('That request was not understood.');
  if (!Array.isArray(folders) || !folders.includes(arg.dir)) throw new ArgError('That folder is not in your library.');
  return { dir: arg.dir, on: arg.on };
}

// shared:apply { copy }. The renderer never supplies a folder: the chosen one is held in the main process.
function cleanSharedApply(arg) {
  if (arg == null) return { copy: false };
  if (!isPlain(arg) || (arg.copy !== undefined && typeof arg.copy !== 'boolean')) throw new ArgError('That request was not understood.');
  return { copy: arg.copy === true };
}

const meetingId = (id) => {
  if (typeof id !== 'string' || !MEETING_ID.test(id)) throw new ArgError('That meeting file no longer exists.');
  return id;
};

// meetings:setActionItem (id, index, text, done)
function cleanActionItemCall(id, index, text, done) {
  meetingId(id);
  if (!Number.isInteger(index) || index < 0 || index > 100000) throw new ArgError('That is not an action item in these notes.');
  if (typeof text !== 'string' || !text.length || text.length > MAX_ITEM_TEXT) throw new ArgError('That is not an action item in these notes.');
  if (typeof done !== 'boolean') throw new ArgError('Say whether the action item is done.');
  return { id, index, text, done };
}

// meetings:addUpdate (id, text)
function cleanUpdateCall(id, text) {
  meetingId(id);
  if (typeof text !== 'string' || !text.trim()) throw new ArgError('Write the update first.');
  if (text.length > MAX_UPDATE_TEXT) throw new ArgError('An update can be at most 2,000 characters.');
  return { id, text: text.trim() };
}

// A meeting title as typed by the person: line breaks, tabs and runs of spaces become one space, control and
// invisible format characters (including the ones that reorder text) are dropped, and it is cut to 200
// characters without splitting an emoji. Throws a sentence for the person when nothing is left.
const NO_TITLE = 'Type a title for this meeting.';
function cleanMeetingTitle(title) {
  if (typeof title !== 'string') throw new ArgError(NO_TITLE);
  const s = title.slice(0, 20000).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/\s+/g, ' ').trim();
  const out = [...s].slice(0, MAX_MEETING_TITLE).join('').trim();
  if (!out) throw new ArgError(NO_TITLE);
  return out;
}

// meetings:rename (id, title)
function cleanRenameCall(id, title) {
  meetingId(id);
  return { id, title: cleanMeetingTitle(title) };
}

// personalities:save { id, name, description, text }. A style needs a name (or an id) and the text; the caps keep a
// window from filling the data folder. The id is turned into a file name by the main process.
const MAX_STYLE_TEXT = 20000;
function cleanPersonalitySave(arg) {
  if (!isPlain(arg)) throw new ArgError('That style could not be saved.');
  const field = (k, max, what) => {
    if (arg[k] == null) return '';
    if (typeof arg[k] !== 'string') throw new ArgError(`${what} must be text.`);
    if (arg[k].length > max) throw new ArgError(`${what} is too long (over ${max.toLocaleString('en-GB')} characters).`);
    return arg[k];
  };
  const id = field('id', 80, 'The style id');
  const name = field('name', 80, 'The style name');
  const description = field('description', 500, 'The description');
  const text = field('text', MAX_STYLE_TEXT, 'The style');
  if ((!name.trim() && !id.trim()) || !text.trim()) throw new ArgError('A style needs a name and a description of how to answer.');
  return { id, name, description, text };
}

// personalities:delete (id)
function cleanPersonalityDelete(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 80) throw new ArgError('That style could not be found.');
  return id;
}

// secrets:set (name, value). The name is checked by the caller against the app's own list. The key is trimmed;
// an empty one removes the saved key. A key is one line of ordinary characters and is never long.
const MAX_SECRET = 500;
function cleanSecretValue(value) {
  if (typeof value !== 'string') throw new ArgError('A key must be text.');
  const v = value.trim();
  if (v.length > MAX_SECRET) throw new ArgError(`That key is too long (over ${MAX_SECRET} characters).`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v)) throw new ArgError('A key cannot contain line breaks or other control or invisible characters.');
  return v;
}

// meetings:renameSpeaker (id, from, to, merge). `merge` is true only when the person has confirmed joining two speakers.
function cleanRenameSpeakerCall(id, from, to, merge) {
  meetingId(id);
  if (typeof from !== 'string' || !from.trim() || from.length > 200) throw new ArgError('That speaker is not in this meeting.');
  if (typeof to !== 'string' || to.length > 2000) throw new ArgError('Type a name for this speaker.');
  if (merge !== undefined && merge !== null && typeof merge !== 'boolean') throw new ArgError('Say whether to join the two speakers.');
  return { id, from, to, merge: merge === true };
}

// What the person is told when the settings or keys file was damaged (settings.js sets loadProblem and
// loadProblems on the instance and keeps a copy of the file). Returns one message for everything that went wrong
// (or '') and forgets it, so that it is shown once. Settings without those properties have nothing to report.
const SETTINGS_DAMAGED = 'Your settings file could not be read, so Understudy started with its defaults.';
const SECRETS_DAMAGED = 'Your saved API keys could not be read. Please add them again.';
const COPY_KEPT = 'A copy of the damaged file was kept next to it.';
function takeLoadNotice(settings) {
  if (!settings || typeof settings !== 'object') return '';
  const found = Array.isArray(settings.loadProblems) && settings.loadProblems.length ? settings.loadProblems : (settings.loadProblem ? [settings.loadProblem] : []);
  settings.loadProblem = null;
  settings.loadProblems = [];
  const out = [];
  for (const p of found) {
    if (!p || (p.file !== 'settings.json' && p.file !== 'secrets.json')) continue;
    out.push(`${p.file === 'secrets.json' ? SECRETS_DAMAGED : SETTINGS_DAMAGED}${p.backup ? ` ${COPY_KEPT}` : ''}`);
  }
  return out.join(' ');
}

// What the person is told when something fails. `strict` (the notes folder): only a message written for the
// person is shown. Otherwise (the meeting store) a plain message is passed on too, but one that carries a
// disk path or a system error code is replaced, so no path ever reaches a window or a screenshot of it.
const PATHISH = /[A-Za-z]:[\\/]|\\\\|\b(?:E[A-Z]{3,}|errno)\b|(?:^|[\s("'])\/[\w.-]+\/|\.(?:md|png|jpe?g|webp|gif|json|tmp)\b/;
function userMessage(e, fallback, { strict = false } = {}) {
  const m = e && typeof e.message === 'string' ? e.message.trim() : '';
  if (e && e.userFacing === true && m && m.length <= 400) return m;
  if (strict || !m || m.length > 300 || PATHISH.test(m)) return fallback;
  return m;
}

// app:show, with nothing or { page, tab }. Only the app's own pages and the Settings tabs count (the lists are
// the ones in app.js); anything else is ignored, so a window can bring the main window forward and nothing more.
// A tab only goes with the Settings page. Returns {} or { page } or { page: 'settings', tab }.
const APP_PAGES = ['home', 'meetings', 'knowledge', 'styles', 'settings'];
const SETTINGS_TABS = ['you', 'keys', 'ai', 'speech', 'remote', 'behaviour', 'shortcuts', 'claude'];
function cleanAppShow(arg) {
  const a = isPlain(arg) ? arg : {};
  const out = {};
  if (own(a, 'page') && typeof a.page === 'string' && APP_PAGES.includes(a.page)) out.page = a.page;
  if (out.page === 'settings' && own(a, 'tab') && typeof a.tab === 'string' && SETTINGS_TABS.includes(a.tab)) out.tab = a.tab;
  return out;
}

// ---- the Issues folder (src/main/issues.js)
const NO_REPORT_NOTE = 'Write a short note first.';
const MAX_REPORT_NOTE = 1000;                // characters, after cleaning
const ISSUE_WINDOWS = ['app', 'overlay'];

// issues:report { note }. The note is one line: line breaks, tabs and runs of spaces become one space, control and
// invisible format characters are dropped. Empty is refused ("Write a short note first."), so is more than 1,000 characters.
function cleanIssueReport(arg) {
  if (!isPlain(arg) || typeof arg.note !== 'string') throw new ArgError(NO_REPORT_NOTE);
  const s = arg.note.slice(0, 20000).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!s) throw new ArgError(NO_REPORT_NOTE);
  if ([...s].length > MAX_REPORT_NOTE) throw new ArgError('That note is too long. Keep it under 1,000 characters.');
  return { note: s };
}

// issues:rendererError { where: 'app' | 'overlay', name, message, stack }. Wrong types are refused; the text is cut to
// 100, 600 and 6,000 characters (an error report is worth having even when it is long).
function cleanRendererError(arg) {
  if (!isPlain(arg) || typeof arg.where !== 'string' || !ISSUE_WINDOWS.includes(arg.where)) throw new ArgError('That report was not understood.');
  const text = (v, max, what) => {
    if (v == null) return '';
    if (typeof v !== 'string') throw new ArgError(`${what} must be text.`);
    return v.slice(0, max);
  };
  const message = text(arg.message, 600, 'The message');
  const name = text(arg.name, 100, 'The name');
  const stack = text(arg.stack, 6000, 'The stack');
  if (!message && !name) throw new ArgError('That report was not understood.');
  return { where: arg.where, name, message, stack };
}

const MAX_PROFILE_TEXT = 50000;
const MAX_COPY_TEXT = 500000;
const MAX_AUDIO_CHUNK_BYTES = 640000;
const CAPTURE_STATES = new Set(['off', 'starting', 'on', 'lost', 'error']);

function cleanExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[\p{Cc}\p{Cf}\s]/u.test(raw)) {
    throw new ArgError('That link cannot be opened.');
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new ArgError('That link cannot be opened.'); }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || parsed.username || parsed.password) {
    throw new ArgError('Only web links (http or https) can be opened.');
  }
  return parsed.toString();
}

function cleanProfileSave(text) {
  if (typeof text !== 'string') throw new ArgError('Your profile must be text.');
  if (text.length > MAX_PROFILE_TEXT) throw new ArgError('Your profile is too long (over 50,000 characters).');
  return text;
}

function cleanCopyText(text) {
  if (typeof text !== 'string') throw new ArgError('Nothing to copy.');
  if (text.length > MAX_COPY_TEXT) throw new ArgError('That text is too long to copy (over 500,000 characters).');
  return text;
}

function cleanLibrarySearch(query) {
  return typeof query === 'string' ? query.slice(0, 500) : '';
}

function cleanProviderTest(kind, id, sttProviders) {
  if (kind === 'llm') {
    if (id !== undefined && id !== 'live' && id !== 'notes') throw new ArgError('Unknown AI role.');
    return { kind: 'llm', role: id === 'notes' ? 'notes' : 'live' };
  }
  if (kind === 'stt' || kind == null) {
    if (typeof id !== 'string' || !id || (sttProviders && !own(sttProviders, id))) throw new ArgError('Unknown speech-to-text provider.');
    return { kind: 'stt', id };
  }
  throw new ArgError('Unknown provider kind.');
}

function cleanAudioChunk(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  if (!u8 || !u8.byteLength || u8.byteLength > MAX_AUDIO_CHUNK_BYTES) return null;
  return u8;
}

function cleanCaptureStatus(status) {
  if (!isPlain(status)) return null;
  if (isPlain(status.levels)) {
    const lv = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
    return { levels: { me: lv(status.levels.me), them: lv(status.levels.them) } };
  }
  if (typeof status.hint === 'string' && status.hint) return { hint: status.hint.slice(0, 500) };
  if (!isPlain(status.channels)) return null;
  const channels = {};
  for (const ch of ['me', 'them']) {
    if (own(status.channels, ch) && CAPTURE_STATES.has(status.channels[ch])) channels[ch] = status.channels[ch];
  }
  const message = typeof status.message === 'string' ? status.message.slice(0, 500) : '';
  if (!Object.keys(channels).length && !message) return null;
  return { channels, message };
}

module.exports = {
  cleanIssueReport, cleanRendererError, cleanRemoteArgs,
  APP_PAGES, SETTINGS_TABS, cleanAppShow, sanitiseSettingsPatch, repairSettings, cleanActionCall, cleanMeetingSet, describeRejected, specFor,
  parseAccel, accelId, shortcutClashes, SHORTCUT_NAMES, cleanPersonalitySave, cleanPersonalityDelete, cleanSecretValue, takeLoadNotice, cleanRenameSpeakerCall,
  ArgError, parseImageDataUrl, cleanNoteAdd, cleanNoteImage, cleanNotesList, cleanPinFolder, cleanActionItemCall, cleanSharedApply, cleanUpdateCall, cleanMeetingTitle, cleanRenameCall, userMessage,
  meetingId, cleanExternalUrl, cleanProfileSave, cleanCopyText, cleanLibrarySearch, cleanProviderTest, cleanAudioChunk, cleanCaptureStatus,
};
