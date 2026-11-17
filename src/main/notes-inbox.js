'use strict';
// The Notes folder: ordinary Markdown files (and images) that Claude, the
// "Add a note" box or the user put there. Pure Node, no Electron: the Claude
// connector (a separate process) requires this file too.
//
// This is the one place where text that did not come from the user's own hand
// is written to their disk, so everything here is confined to `dir`, takes a
// title (never a path) for a new note, changes an existing note only through
// updateNote (which keeps the last versions), and caps sizes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { writeAtomic } = require('./settings');

const MAX_TEXT = 1000000;           // characters per note
const MAX_TITLE = 120;
const MAX_IMAGE = 15 * 1024 * 1024; // bytes
const MAX_READ = 200000;            // characters returned by readNote
const MAX_READ_BYTES = 1024 * 1024; // never pull a huge dropped file into memory
const MAX_SLUG = 60;
const MAX_SAME_NAME = 10000;
const MAX_WALK_FILES = 20000;

// Errors whose message is written for the person (or for Claude) and is safe to show.
class NoteError extends Error {
  constructor(message) { super(message); this.name = 'NoteError'; this.userFacing = true; }
}

const IMAGE_TYPES = {
  png: { ext: '.png', mime: 'image/png' },
  jpeg: { ext: '.jpg', mime: 'image/jpeg' },
  webp: { ext: '.webp', mime: 'image/webp' },
  gif: { ext: '.gif', mime: 'image/gif' },
};

function defaultNotesDir(documentsDir) { return path.join(documentsDir, 'Understudy', 'Notes'); }

// ---- names ----

// Characters that could hide, reorder or break a name: C0/C1 controls, zero-width and bidi marks, BOM.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

// One line of text, no invisible characters, single spaces.
function oneLine(s) { return String(s == null ? '' : s).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim(); }

function slugOf(s) {
  let t = oneLine(s)
    .replace(/[<>:"/\\|?*]/g, ' ')   // not allowed in a Windows name
    .replace(/[~`^]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')           // no hidden files, no leading ".."
    .slice(0, MAX_SLUG)
    .replace(/[.\s]+$/, '');          // Windows silently drops a trailing dot or space
  if (RESERVED.test(t)) t = `note ${t}`;
  return t;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp(ms) {
  const d = new Date(ms);
  return { month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hm: `${pad(d.getHours())}${pad(d.getMinutes())}` };
}
function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function cleanText(s) {
  // Keep tabs and line breaks; drop NULs and other control characters; one kind of line break.
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029\ufeff]/g, '').trim();
}

function shortWord(s, fallback) {
  const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return t || fallback;
}

// Front matter values are written plain when that is unambiguous, else as JSON strings (valid YAML).
function fmValue(v) {
  const s = oneLine(v);
  return /^[A-Za-z0-9(][^"'#{}[\]&*!|>%@`]*$/.test(s) && !/\s#|:(\s|$)/.test(s) ? s : JSON.stringify(s);
}
function frontMatter(fields) {
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${fmValue(v)}`).join('\n')}\n---\n\n`;
}

// ---- folders and confinement ----

function ensureDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new NoteError('There is no Notes folder set.');
  const root = path.resolve(dir);
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) { throw new NoteError(`The Notes folder could not be created (${e.code || 'error'}).`); }
  return root;
}

function inside(root, p) { const r = path.relative(root, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); }

// The month folder, created if needed, and proven to be inside the Notes folder even through links.
function monthDir(root, month) {
  const d = path.join(root, month);
  fs.mkdirSync(d, { recursive: true });
  let real, realRoot;
  try { real = fs.realpathSync(d); realRoot = fs.realpathSync(root); } catch { throw new NoteError('The Notes folder could not be used.'); }
  if (real !== realRoot && !inside(realRoot, real)) throw new NoteError('That folder points outside the Notes folder, so nothing was saved.');
  return d;
}

// Creates the first free "<stem><suffix>" file by creating it empty with the "wx" flag, which fails if
// anything is there already, even if another process (the app and the connector) is racing for the name.
function reserve(folder, stem, exts) {
  // One look at the folder says which numbers are taken, so 500 notes in a minute do not mean 125,000 failed tries.
  let names;
  try { names = new Set(fs.readdirSync(folder).map((n) => n.toLowerCase())); } catch { names = new Set(); }
  for (let n = 1; n <= MAX_SAME_NAME; n++) {
    const base = n === 1 ? stem : `${stem} ${n}`;
    if (exts.some((ext) => names.has((base + ext).toLowerCase()))) continue;
    const taken = [];
    let clash = false;
    for (const ext of exts) {
      const f = path.join(folder, base + ext);
      try { fs.closeSync(fs.openSync(f, 'wx')); taken.push(f); } catch (e) {
        if (e.code === 'EEXIST') { clash = true; break; }
        for (const t of taken) { try { fs.unlinkSync(t); } catch { /* nothing to undo */ } }
        throw e;
      }
    }
    if (!clash) return { base, files: taken };
    for (const t of taken) { try { fs.unlinkSync(t); } catch { /* nothing to undo */ } }
  }
  throw new NoteError('There are too many notes with that name from the same minute. Try a different title.');
}

function writeReserved(files, contents) {
  try { files.forEach((f, i) => writeAtomic(f, contents[i])); } catch (e) {
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* may not exist */ } }
    throw e;
  }
}

// ---- writing ----

function saveNote(dir, { title, text, source = 'pasted', origin = os.hostname(), now = Date.now() } = {}) {
  if (typeof text === 'string' && text.length > 2 * MAX_TEXT) throw new NoteError('That note is too long to save (over 1 MB).');
  const body = cleanText(text);
  if (!body) throw new NoteError('Write something to save first.');
  if (body.length > MAX_TEXT) throw new NoteError('That note is too long to save (over 1 MB).');
  // No title given: use the first words of the text.
  const name = oneLine(title).slice(0, MAX_TITLE).trim() || oneLine(body).slice(0, 60).trim() || 'Note';
  const root = ensureDir(dir);
  const t = stamp(now);
  const folder = monthDir(root, t.month);
  const { base, files } = reserve(folder, `${t.day} ${t.hm} ${slugOf(name) || slugOf(body) || 'note'}`, ['.md']);
  const file = files[0];
  if (!inside(root, path.resolve(file))) { try { fs.unlinkSync(file); } catch { /* ignore */ } throw new NoteError('That name is not allowed.'); }
  writeReserved(files, [`${frontMatter({ title: name, date: isoLocal(now), source: shortWord(source, 'pasted'), origin: oneLine(origin).slice(0, 80) })}${body}\n`]);
  return { file, rel: `${t.month}/${base}.md`, title: name };
}

// What the bytes really are, from their first bytes (nothing is decoded). Returns a key of IMAGE_TYPES or ''.
function sniffImage(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

function saveImage(dir, { bytes, mime = '', title = '', note = '', source = 'pasted', origin = os.hostname(), now = Date.now() } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : (bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null);
  if (!buf || !buf.length) throw new NoteError('There is no image to save.');
  if (buf.length > MAX_IMAGE) throw new NoteError('That image is too large (over 15 MB).');
  const m = String(mime || '').toLowerCase().trim().replace('image/jpg', 'image/jpeg');
  if (m && !Object.values(IMAGE_TYPES).some((t) => t.mime === m)) throw new NoteError('Only PNG, JPEG, WebP and GIF images can be saved.');
  const kind = sniffImage(buf); // the bytes decide, not the label
  if (!kind) throw new NoteError('That file does not look like a PNG, JPEG, WebP or GIF image.');
  if (typeof note === 'string' && note.length > 2 * MAX_TEXT) throw new NoteError('That note is too long to save (over 1 MB).');
  const extra = cleanText(note);
  if (extra.length > MAX_TEXT) throw new NoteError('That note is too long to save (over 1 MB).');
  const name = oneLine(title).slice(0, MAX_TITLE).trim() || 'Screenshot';
  const root = ensureDir(dir);
  const t = stamp(now);
  const folder = monthDir(root, t.month);
  const ext = IMAGE_TYPES[kind].ext;
  const stem = `${t.day} ${t.hm} ${slugOf(name) || 'screenshot'}`;
  // The note beside the picture is always written, even when the person typed nothing: a picture on its own
  // is not a note, so without it the picture would be saved but never listed, found or described.
  const { base, files } = reserve(folder, stem, [ext, '.md']);
  const [file] = files;
  if (!inside(root, path.resolve(file))) { for (const f of files) { try { fs.unlinkSync(f); } catch { /* ignore */ } } throw new NoteError('That name is not allowed.'); }
  const imgName = `${base}${ext}`;
  const alt = name.replace(/[[\]]/g, '');
  const sibling = `${frontMatter({ title: name, date: isoLocal(now), source: 'screenshot', origin: oneLine(origin).slice(0, 80), image: imgName })}![${alt}](<${imgName}>)\n${extra ? `\n${extra}\n` : ''}`;
  writeReserved(files, [buf, sibling]);
  return { file, rel: `${t.month}/${imgName}`, title: name };
}

// ---- reading ----

const DEVICE_SEGMENT = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

// Turns the `rel` a caller gave into a real path inside `dir`, or refuses.
function resolveRel(dir, rel) {
  const bad = () => new NoteError('That is not a note in the Notes folder. Use list_notes to see the valid paths.');
  if (typeof dir !== 'string' || !dir.trim()) throw new NoteError('There is no Notes folder set.');
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 400) throw bad();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(rel)) throw bad();   // ":" covers drive letters and alternate data streams
  if (/^[\\/]/.test(rel)) throw bad();                       // absolute and UNC
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[. ]$/.test(p) || DEVICE_SEGMENT.test(p)) throw bad();
  }
  if (!/\.md$/i.test(parts[parts.length - 1])) throw bad();
  const root = path.resolve(dir);
  const full = path.resolve(root, ...parts);
  if (!inside(root, full)) throw bad();
  return { root, full, rel: parts.join('/') };
}

// The path as it is spelt on disk. On Windows "Notes\2026-11\a.md" and "notes/2026-11/A.md" are one file, and the
// spelling the caller used must never become the file's name (a write through it renames the file) or the key
// of its saved versions. Each segment is matched against a listing of its folder, exactly first, then ignoring case.
// A segment that is not there is left as given: the caller's own "not found" follows.
function onDiskSpelling(r) {
  const parts = r.rel.split('/');
  const out = [];
  let dir = r.root;
  for (const want of parts) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return r; }
    const lower = want.toLowerCase();
    const hit = names.includes(want) ? want : names.find((n) => n.toLowerCase() === lower);
    if (!hit) return r;
    out.push(hit);
    dir = path.join(dir, hit);
  }
  const full = path.resolve(r.root, ...out);
  return inside(r.root, full) ? { root: r.root, full, rel: out.join('/') } : r;
}

// Reads at most MAX_READ_BYTES of a file; { text, truncated }.
function readHead(file, maxBytes = MAX_READ_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const cut = size > n;
    let s = buf.toString('utf8', 0, n).replace(/^\ufeff/, '');
    if (cut) s = s.replace(/\ufffd+$/, ''); // a multi-byte character split by the cut
    return { text: s, truncated: cut, size };
  } finally { fs.closeSync(fd); }
}

// True only when a block between two "---" lines is YAML front matter (at least one key: value line,
// and no prose lines that would belong to a document starting with a horizontal rule).
function isFrontMatter(block) {
  if (typeof block !== 'string' || block.length > 4000) return false;
  let keys = 0, seenKey = false;
  for (const raw of block.split(/\r?\n/)) {
    const trim = raw.trim();
    if (!trim || trim.startsWith('#')) continue;
    if (/^[A-Za-z_][\w-]*:[ \t]*(?:.*)?$/.test(raw)) { keys += 1; seenKey = true; continue; }
    if (seenKey && /^(?:[ \t]+\S|-[ \t]+\S)/.test(raw)) continue;
    return false;
  }
  return keys > 0;
}

function parseNote(raw) {
  const out = { fields: {}, body: raw };
  const s = String(raw == null ? '' : raw).replace(/^\ufeff/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m || !isFrontMatter(m[1])) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!k) continue;
    let v = k[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.replace(/^"|"$/g, ''); } } else if (v.startsWith("'") && v.endsWith("'") && v.length > 1) v = v.slice(1, -1);
    out.fields[k[1].toLowerCase()] = String(v);
  }
  out.body = s.slice(m[0].length).replace(/^\s*\n/, '');
  return out;
}

function nameDate(name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d)\b/.exec(name);
  if (!m) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function describe(rel, raw, mtimeMs) {
  const { fields, body } = parseNote(raw);
  const base = path.posix.basename(rel).replace(/\.md$/i, '');
  const heading = /^#\s+(.+)$/m.exec(body);
  const title = oneLine(fields.title || (heading && heading[1]) || base.replace(/^\d{4}-\d\d-\d\d \d{4}\s*/, '') || base).slice(0, 200);
  const when = fields.date && Number.isFinite(Date.parse(fields.date)) ? fields.date : isoLocal(nameDate(base) || mtimeMs);
  return { rel, title, date: when, source: fields.source || 'file', origin: fields.origin || '', body };
}

// Every .md file under dir (not through links), with a cheap sort key from its name or modified time.
function walk(root) {
  const found = [];
  const stack = [{ d: root, depth: 0 }];
  while (stack.length && found.length < MAX_WALK_FILES) {
    const { d, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 5) stack.push({ d: full, depth: depth + 1 }); continue; }
      if (!e.isFile() || !/\.md$/i.test(e.name) || e.name.startsWith('~$')) continue;
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      found.push({ full, rel: path.relative(root, full).split(path.sep).join('/'), key: nameDate(e.name) || mtime, mtime });
    }
  }
  return found;
}

function listNotes(dir, { limit = 50 } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return [];
  const root = path.resolve(dir);
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 50));
  const out = [];
  for (const f of walk(root).sort((a, b) => b.key - a.key).slice(0, n)) {
    try {
      const { text } = readHead(f.full);
      const d = describe(f.rel, text, f.mtime);
      out.push({ rel: d.rel, title: d.title, date: d.date, source: d.source, origin: d.origin, chars: d.body.trim().length });
    } catch { /* unreadable or gone: leave it out */ }
  }
  return out.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}

function readNote(dir, rel) {
  const r = onDiskSpelling(resolveRel(dir, rel));
  let st;
  try { st = fs.lstatSync(r.full); } catch { throw new NoteError('No note with that path. Use list_notes to see the valid paths.'); }
  if (!st.isFile()) throw new NoteError('That is not a note in the Notes folder. Use list_notes to see the valid paths.');
  // A link inside the folder that points outside it is not followed.
  try {
    const real = fs.realpathSync(r.full);
    if (!inside(fs.realpathSync(r.root), real)) throw new Error('outside');
  } catch { throw new NoteError('That is not a note in the Notes folder. Use list_notes to see the valid paths.'); }
  let head;
  try { head = readHead(r.full); } catch { throw new NoteError('That note could not be read.'); }
  const d = describe(r.rel, head.text, st.mtimeMs);
  let text = d.body.replace(/\s+$/, '');
  if (text.length > MAX_READ || head.truncated) {
    text = `${text.slice(0, MAX_READ)}

[Cut here: this note is longer than ${MAX_READ.toLocaleString('en-GB')} characters, so the rest is not shown.]`;
  }
  return { rel: d.rel, title: d.title, date: d.date, source: d.source, origin: d.origin, text };
}

// ---- changing a note that is already there ----

const KEEP_VERSIONS = 5;
const VERSION_TAIL = /^\.(\d{8}-\d{6})(?:-(\d+))?\.md$/;

function stampCompact(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function versionPrefix(rel) {
  const raw = rel.split('/').join('__');
  if (raw.length <= 100) return raw;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${raw.slice(0, 84)}_${hash}`;
}

// Copies the note as it is now into <dir>/.versions/ and keeps only the newest few copies of that note.
// The folder starts with a dot, so neither listNotes nor the knowledge library ever sees it.
function keepVersion(root, rel, raw, now) {
  const folder = monthDir(root, '.versions');
  const prefix = versionPrefix(rel);
  const stamp = stampCompact(now);
  let existing = [];
  try { existing = fs.readdirSync(folder); } catch { existing = []; }
  let top = 0;
  for (const f of existing) {
    if (!f.startsWith(`${prefix}.`)) continue;
    const t = VERSION_TAIL.exec(f.slice(prefix.length));
    if (t && t[1] === stamp) top = Math.max(top, Number(t[2] || 1));
  }
  let seq = top + 1;
  let name = seq === 1 ? `${prefix}.${stamp}.md` : `${prefix}.${stamp}-${seq}.md`;
  while (fs.existsSync(path.join(folder, name))) {
    seq += 1;
    name = `${prefix}.${stamp}-${seq}.md`;
  }
  const file = path.join(folder, name);
  writeAtomic(file, raw);
  return { file, prune: () => {
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return; }
    const mine = [];
    for (const f of names) {
      if (!f.startsWith(`${prefix}.`)) continue;
      const t = VERSION_TAIL.exec(f.slice(prefix.length));
      if (t) mine.push({ f, key: `${t[1]}-${String(t[2] || 1).padStart(6, '0')}` });
    }
    mine.sort((a, b) => (a.key < b.key ? 1 : -1));
    for (const old of mine.slice(KEEP_VERSIONS)) { try { fs.unlinkSync(path.join(folder, old.f)); } catch { /* left for the next update */ } }
  } };
}

// Replaces the text of a note (front matter and every key in it kept) or adds to the end of it, and sets its
// `updated:` line. The note as it was is kept in .versions first. The file is read once, the new text built from
// that reading, and the file read again just before writing: if it changed meanwhile (a sync service, an editor)
// nothing is written.
function updateNote(dir, rel, { text, mode = 'replace', now = Date.now() } = {}) {
  if (mode !== 'replace' && mode !== 'append') throw new NoteError('The mode must be "replace" or "append".');
  const r = onDiskSpelling(resolveRel(dir, rel));
  // Dot-folders and lock files are never notes (listNotes does not show them), so nothing there is changed.
  if (r.rel.split('/').some((p) => p.startsWith('.') || p.startsWith('~$'))) throw new NoteError('That is not a note in the Notes folder. Use list_notes to see the valid paths.');
  let st;
  try { st = fs.lstatSync(r.full); } catch { throw new NoteError('That note was not found.'); }
  if (!st.isFile()) throw new NoteError('That note was not found.');
  try {
    if (!inside(fs.realpathSync(r.root), fs.realpathSync(r.full))) throw new Error('outside');
  } catch { throw new NoteError('That is not a note in the Notes folder. Use list_notes to see the valid paths.'); }
  const tooLong = new NoteError('That note is too long to save (over 1 MB).');
  if (typeof text === 'string' && text.length > 2 * MAX_TEXT) throw tooLong;
  const body = cleanText(text);
  if (!body) throw new NoteError('Write something to save first.');
  if (body.length > MAX_TEXT || st.size > 4 * MAX_TEXT) throw tooLong;
  let raw;
  try { raw = fs.readFileSync(r.full, 'utf8'); } catch { throw new NoteError('That note could not be read.'); }
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const text0 = bom ? raw.slice(1) : raw;
  const eol = text0.includes('\r\n') ? '\r\n' : '\n';
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text0);
  const hasFront = Boolean(m) && isFrontMatter(m[1]);
  let head = '', rest = text0;
  if (hasFront) {
    const lines = m[1].split(/\r?\n/);
    const stamped = `updated: ${fmValue(isoLocal(now))}`;
    const at = lines.findIndex((l) => /^updated:/i.test(l));
    if (at >= 0) lines[at] = stamped; else lines.push(stamped);
    head = `---${eol}${lines.join(eol)}${eol}---${eol}`;
    rest = text0.slice(m[0].length);
  }
  const add = body.replace(/\n/g, eol);
  let next;
  if (mode === 'replace') next = hasFront ? `${head}${eol}${add}${eol}` : `${add}${eol}`;
  else {
    const old = rest.replace(/\s+$/, '');
    next = old ? `${head}${old}${eol}${eol}${add}${eol}` : `${head}${hasFront ? eol : ''}${add}${eol}`;
  }
  next = bom + next;
  if (next.length > MAX_TEXT) throw tooLong;
  // A copy of what is there now, before anything is changed.
  let kept;
  try { kept = keepVersion(r.root, r.rel, raw, now); } catch (e) { throw e instanceof NoteError ? e : new NoteError('A copy of the note could not be kept, so it was left as it is.'); }
  let again = null;
  try { again = fs.readFileSync(r.full, 'utf8'); } catch { /* gone */ }
  if (again !== raw) { try { fs.unlinkSync(kept.file); } catch { /* ignore */ } throw new NoteError('This note changed while it was being updated. Try again.'); }
  writeAtomic(r.full, next);
  kept.prune();
  return { file: r.full, rel: r.rel, title: describe(r.rel, next.replace(/^﻿/, ''), Date.now()).title };
}

// ---- what a screenshot shows, kept beside the screenshot ----
//
// A picture in the Notes folder has a note of the same name ("shot.png" -> "shot.md": the file saveImage writes when
// the person typed something with it). The description of the picture goes at the end of that note, between two
// comment markers that say it is generated, so that it travels with the picture through a sync service, Claude can
// read it like any note, and it can be found, replaced when the picture changes and told apart from the person's own
// words. Nothing outside the markers is ever touched. The opening marker holds a short hash of the picture it
// describes: the same picture is never described twice (on any PC), a changed one is described afresh.

const DESC_TAG = 'understudy:screenshot-description';
const DESC_OPEN = /^<!-- understudy:screenshot-description sha256=([0-9a-f]{16})[^\r\n]*-->[ \t]*$/gm;
const DESC_CLOSE = /^<!-- \/understudy:screenshot-description -->[ \t]*$/gm;
const DESC_MARKER_LINE = /^<!-- \/?understudy:screenshot-description\b[^\r\n]*-->[ \t]*(?:\r\n|\r|\n|$)/gm;
const MAX_DESCRIPTION = 60000;      // characters; the vision reader writes a few thousand
const MAX_SIBLING_BYTES = 4 * MAX_TEXT;
const FRESH_MS = 30000;             // an empty note this young may still be filling (saveImage reserves names first)

// The note that goes with a picture: same folder, same name, ".md".
function imageSiblingPath(imageFile) { return path.join(path.dirname(imageFile), `${path.basename(imageFile, path.extname(imageFile))}.md`); }

// A short name for the bytes of a picture: 16 hex characters of its SHA-256 ('' when it cannot be read, is over
// maxBytes or is not really an image).
function imageHash(file, maxBytes = MAX_IMAGE) {
  try {
    if (fs.statSync(file).size > maxBytes) return '';
    const b = fs.readFileSync(file);
    return b.length <= maxBytes && sniffImage(b) ? crypto.createHash('sha256').update(b).digest('hex').slice(0, 16) : '';
  } catch { return ''; }
}

// The complete sections in a note: [{ start, end, hash }]. A closing marker belongs to the nearest opening one before
// it, so an opening marker that lost its end (somebody edited around it) is simply not a section.
function descriptionSections(text) {
  const marks = [];
  for (const m of text.matchAll(DESC_OPEN)) marks.push({ at: m.index, end: m.index + m[0].length, hash: m[1] });
  for (const m of text.matchAll(DESC_CLOSE)) marks.push({ at: m.index, end: m.index + m[0].length, hash: '' });
  marks.sort((a, b) => a.at - b.at);
  const out = [];
  let open = null;
  for (const k of marks) {
    if (k.hash) open = k;
    else if (open) { out.push({ start: open.at, end: k.end, hash: open.hash }); open = null; }
  }
  return out;
}

// A note as the library should index it: the marker lines are bookkeeping, not text to find.
function withoutDescriptionMarkers(text) { return text.includes(DESC_TAG) ? text.replace(DESC_MARKER_LINE, '') : text; }

// What the vision reader wrote, made safe to sit inside a section: no marker of ours (so it cannot end the section
// early or start a second one), no heading above level 3 (it stays under "What the screenshot shows" and can never
// become the note's title), and no fence left open (it would swallow whatever is written after the section).
function tidyDescription(markdown) {
  const text = cleanText(markdown).slice(0, MAX_DESCRIPTION).replace(/<!--(?=\s*\/?\s*understudy\b)/gi, '&lt;!--');
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
      out.push(line);
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; out.push(line); continue; }
    const h = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/.exec(line);
    out.push(h ? `${'#'.repeat(Math.min(6, Math.max(3, h[1].length + 1)))}${h[2]}` : line);
  }
  if (fence) out.push(fence.ch.repeat(fence.len));
  return out.join('\n').trim();
}

function descriptionSection(hash, markdown, eol) {
  return [
    `<!-- ${DESC_TAG} sha256=${hash}; written by Understudy from the picture and replaced if the picture changes, so keep your own text outside this block -->`,
    '## What the screenshot shows', '', tidyDescription(markdown), '', `<!-- /${DESC_TAG} -->`,
  ].join('\n').replace(/\n/g, eol);
}

// The note beside a picture, as it is now: { file, raw } with raw null when there is no note, { bad: true } when it
// cannot be used (a link, a folder, too large, not UTF-8), and `hashes` listing the pictures it already describes.
function readImageSibling(imageFile) {
  const file = imageSiblingPath(imageFile);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? { file, raw: null, hashes: [] } : { file, bad: true, raw: null, hashes: [] }; }
  const bad = { file, bad: true, raw: null, hashes: [] };
  if (!st.isFile() || st.size > MAX_SIBLING_BYTES) return bad;
  try {
    const buf = fs.readFileSync(file);
    const raw = buf.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(buf)) return bad;   // not UTF-8: writing it back would change bytes outside the markers
    return { file, raw, fresh: raw === '' && Date.now() - st.mtimeMs < FRESH_MS, hashes: descriptionSections(raw).map((s) => s.hash) };
  } catch { return bad; }
}

// Puts the description of the picture `imageFile` (which must be inside `root`) into the note beside it:
//   - no note yet: a note like the one saveImage writes (title from the file's name, source "screenshot", this PC),
//     then the picture and the section;
//   - a note without a section: the section is added at the end, after one blank line;
//   - a note with a section: that section is replaced (whatever follows it is kept).
// `expected` is the note's text when the caller last looked (null for "was not there"): if it is different now, or
// changes before the write, nothing is written and 'changed' is returned (try again on a later pass). Line endings
// of the note are kept. Returns 'created' | 'written' | 'present' (already described) | 'changed' | 'failed'.
function writeImageDescription(root, imageFile, { hash, markdown, expected, origin = os.hostname(), mtimeMs = 0, now = Date.now() } = {}) {
  try {
    const rootAbs = path.resolve(root);
    const img = path.resolve(imageFile);
    if (!/^[0-9a-f]{16}$/.test(String(hash)) || !inside(rootAbs, img) || !tidyDescription(markdown)) return 'failed';
    const dirReal = fs.realpathSync(path.dirname(img));
    const rootReal = fs.realpathSync(rootAbs);
    if (dirReal !== rootReal && !inside(rootReal, dirReal)) return 'failed';   // a folder that leads out of the Notes folder
    const cur = readImageSibling(img);
    if (cur.bad) return 'failed';
    if (cur.fresh) return 'changed';
    if (expected !== undefined && cur.raw !== expected) return 'changed';
    if (cur.hashes.includes(hash)) return 'present';
    const raw = cur.raw;
    let next, done = 'written';
    if (raw === null) {
      const stem = path.basename(img, path.extname(img));
      const title = oneLine(stem.replace(/^\d{4}-\d\d-\d\d \d{4}\s*/, '')).slice(0, MAX_TITLE).trim() || oneLine(stem).slice(0, MAX_TITLE).trim() || 'Screenshot';
      const name = path.basename(img);
      const alt = title.replace(/[[\]]/g, '');
      const head = frontMatter({ title, date: isoLocal(nameDate(stem) || mtimeMs || now), source: 'screenshot', origin: oneLine(origin).slice(0, 80), image: name });
      next = `${head}![${alt}](<${name.replace(/</g, '%3C').replace(/>/g, '%3E')}>)\n\n${descriptionSection(hash, markdown, '\n')}\n`;
      done = 'created';
    } else {
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const secs = descriptionSections(raw);
      const section = descriptionSection(hash, markdown, eol);
      if (secs.length) { const s = secs[secs.length - 1]; next = raw.slice(0, s.start) + section + raw.slice(s.end); }
      else next = `${raw}${raw && !/\n$/.test(raw) ? eol : ''}${raw.trim() ? eol : ''}${section}${eol}`;
    }
    if (next.length > MAX_TEXT * 2) return 'failed';
    // Looked at again just before the write: a sync service or an editor may have touched it meanwhile.
    const again = readImageSibling(img);
    if (again.bad || again.raw !== raw) return 'changed';
    writeAtomic(cur.file, next);
    return done;
  } catch { return 'failed'; }
}

module.exports = {
  defaultNotesDir, saveNote, saveImage, listNotes, readNote, updateNote,
  imageSiblingPath, imageHash, readImageSibling, writeImageDescription, withoutDescriptionMarkers, descriptionSections,
  sniffImage, slugOf, resolveRel, NoteError, IMAGE_TYPES, MAX_TEXT, MAX_TITLE, MAX_IMAGE, MAX_READ,
};
