'use strict';
// Meetings on disk. No Electron imports: the MCP server uses this file too.
//
//   <meetingsDir>/2026-11-14/1430-pipeline-review.md   one file per meeting
//   <meetingsDir>/2026-11-14/_daily.md                 roll-up of that day
//
// Each meeting file is Markdown with a small front-matter block, the notes,
// and the full transcript under "## Transcript", so any tool that can read a
// folder of Markdown (Claude included) can use the library directly.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeAtomic } = require('../settings');
const { cleanSpeakerName } = require('../transcript');
const { cleanMeetingTitle } = require('../validate');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function defaultMeetingsDir() { return path.join(os.homedir(), 'Documents', 'Understudy', 'Meetings'); }

function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'meeting';
}

function newMeta(title, start = new Date()) {
  return {
    id: `${ymd(start).replace(/-/g, '')}-${pad(start.getHours())}${pad(start.getMinutes())}${pad(start.getSeconds())}`,
    // The cap applies here, when a title is first made; a title already in a file is never shortened.
    title: String(title || '').slice(0, 200) || `Meeting ${hm(start)}`,
    autoTitle: !title,
    date: ymd(start),
    start: hm(start),
    startMs: start.getTime(),
    end: '',
    durationMin: 0,
    speakers: [],
  };
}


// The same file on a case-insensitive disk is the same file.
function sameFile(a, b) {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function insidePath(root, p) {
  const a = process.platform === 'win32' || process.platform === 'darwin' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  const r = path.relative(a, b);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

// Whether the notes just written may replace this meeting's title: only for a meeting that was started without
// one and still has its "Meeting 14:30" placeholder. `autoTitle` is not kept in the file: a saved meeting read back
// from disk has none, so a title the person typed (or any title a file already has) is never replaced.
function useGeneratedTitle(meta, generated) {
  return Boolean(generated) && Boolean(meta) && meta.autoTitle === true && /^Meeting \d\d:\d\d$/.test(String(meta.title));
}

// The text of a meeting file with a new title: the `title:` line of the front matter (added after `id:` when
// there is none) and the "# title" heading under it when that still shows the old title. Every other byte,
// line ending and the byte-order mark are kept. Returns null when the result does not read back as the same
// meeting with only the title changed.
function retitle(raw, m, clean) {
  const lines = raw.split('\n');
  if (lines[0].replace(/^\uFEFF/, '').replace(/\r$/, '') !== '---') return null;
  let k = 1; // the closing "---", found the way parse() and notesRange() find it
  while (k < lines.length && !/^---[ \t]*\r?$/.test(lines[k])) k++;
  if (k >= lines.length) return null;
  const eol = (l) => (l.endsWith('\r') ? '\r' : '');
  let at = -1, idAt = -1;
  for (let i = 1; i < k; i++) { if (/^title:/.test(lines[i])) at = i; else if (/^id:/.test(lines[i])) idAt = i; }
  if (at >= 0) lines[at] = `title: ${yamlStr(clean)}${eol(lines[at])}`;
  else if (idAt >= 0) { lines.splice(idAt + 1, 0, `title: ${yamlStr(clean)}${eol(lines[idAt])}`); k += 1; }
  else return null;
  let i = k + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = i < lines.length ? /^# (.*?)\s*$/.exec(lines[i]) : null;
  if (head && head[1] === m.meta.title) lines[i] = `# ${clean}${eol(lines[i])}`;
  const next = lines.join('\n');
  const after = parse(next, m.file);
  const same = after.frontMatter === 'ok' && after.meta.title === clean && after.notes === m.notes && after.transcript === m.transcript
    && JSON.stringify({ ...after.meta, title: '' }) === JSON.stringify({ ...m.meta, title: '' });
  return same ? next : null;
}

function yamlStr(s) { return `"${String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

// The file is split at its "## Transcript" heading, so notes must never contain one.
function safeNotes(notesMd) {
  return String(notesMd || '').replace(/^##\s+Transcript\s*$/gim, '### Transcript (as quoted in the notes)');
}

function render(meta, notesMd, transcriptMd) {
  const extras = Array.isArray(meta.frontExtra) ? meta.frontExtra.filter((x) => typeof x === 'string' && x.trim()) : [];
  const fm = [
    '---',
    `id: ${meta.id}`,
    `title: ${yamlStr(meta.title)}`,
    `date: ${meta.date}`,
    `start: ${yamlStr(meta.start)}`,
    `end: ${yamlStr(meta.end || '')}`,
    `duration_min: ${meta.durationMin || 0}`,
    `speakers: [${(meta.speakers || []).map(yamlStr).join(', ')}]`,
    // Front matter the person added themselves, written back as it was found.
    ...(extras.some((x) => /^source:/.test(x)) ? [] : ['source: understudy']),
    ...extras,
    '---',
  ].join('\n');
  const notes = notesMd && notesMd.trim() ? safeNotes(notesMd).trim() : '_Notes have not been generated for this meeting yet._';
  return `${fm}\n\n# ${String(meta.title).replace(/[\r\n]+/g, ' ')}\n\n${notes}\n\n## Transcript\n\n${transcriptMd && transcriptMd.trim() ? transcriptMd.trim() : '_No speech was captured._'}\n`;
}

/// The front-matter keys Understudy writes itself. Any other line is the
// person's own and is carried through every rewrite untouched.
const BUILT_IN = new Set(['id', 'title', 'date', 'start', 'end', 'duration_min', 'speakers']);
const KEY_LINE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

function parseYamlList(inner) {
  const s = inner.trim();
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      let j = i + 1, val = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { val += s[j + 1]; j += 2; }
        else val += s[j++];
      }
      out.push(val);
      i = s.indexOf(',', j + 1);
      if (i < 0) break;
      i++;
    } else if (s[i] === "'") {
      let j = i + 1, val = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { val += "'"; j += 2; }
        else if (s[j] === "'") break;
        else val += s[j++];
      }
      out.push(val);
      i = s.indexOf(',', j + 1);
      if (i < 0) break;
      i++;
    } else {
      const comma = s.indexOf(',', i);
      const raw = (comma < 0 ? s.slice(i) : s.slice(i, comma)).trim();
      if (raw) out.push(raw);
      if (comma < 0) break;
      i = comma + 1;
    }
  }
  return out;
}

function parse(text, file) {
  const out = { meta: {}, notes: '', transcript: '', file, frontMatter: 'none' };
  const extra = [];
  let body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (/^---[ \t]*\n/.test(body)) {
    const firstNl = body.indexOf('\n');
    const closeRe = /\n---[ \t]*(?:\n|$)/g;
    closeRe.lastIndex = firstNl;
    const closeMatch = closeRe.exec(body);
    if (!closeMatch) out.frontMatter = 'broken'; // never closed
    else {
      // 'ok' means every line was understood and a built-in key can be rewritten
      // without losing anything; a rename refuses any other file.
      let ok = true, cur = null;
      for (const line of body.slice(firstNl + 1, closeMatch.index).split('\n')) {
        const m = line.match(KEY_LINE);
        if (m) {
          cur = { key: m[1], lines: [line] };
          // Our own "source: understudy" line is written fresh each time; any other is the person's.
          if (!BUILT_IN.has(m[1]) && !(m[1] === 'source' && m[2].trim() === 'understudy')) extra.push(cur);
          let v = m[2].trim();
          if (v.startsWith('[')) {
            if (!v.endsWith(']')) ok = false;
            else v = parseYamlList(v.slice(1, -1));
          } else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
            v = v.slice(1, -1).replace(/\\(.)/g, '$1');
          } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
            v = v.slice(1, -1).replace(/''/g, "'");
          }
          if (BUILT_IN.has(m[1])) out.meta[m[1]] = v;
        } else if (cur && /^(\s+\S|-\s)/.test(line)) {
          // A continuation (an indented line, a list item) belongs to the key above.
          if (BUILT_IN.has(cur.key)) ok = false; // a built-in key over several lines cannot be rewritten faithfully
          else cur.lines.push(line);
        } else if (/^\s*#/.test(line)) extra.push({ key: null, lines: [line] }); // a comment
        else if (line.trim()) ok = false; // neither a key, a continuation nor a comment
      }
      out.frontMatter = ok && 'id' in out.meta ? 'ok' : 'broken';
      body = body.slice(closeMatch.index + closeMatch[0].length);
    }
  }
  // The real transcript is always the last "## Transcript" section in the file.
  let tIdx = -1;
  for (const m of body.matchAll(/^## Transcript[ \t]*$/gm)) tIdx = m.index;
  let notes = tIdx === -1 ? body : body.slice(0, tIdx);
  out.transcript = tIdx === -1 ? '' : body.slice(tIdx).replace(/^## Transcript[ \t]*\n?/, '').trim();
  notes = notes.replace(/^\s*# .*\n/, '').trim();
  out.notes = notes;
  const m = out.meta;
  // Nothing in the front matter is trusted to build a path: the day comes from
  // the folder the file is in, and ids and times must have the expected shape.
  const fileBase = path.basename(file || '', path.extname(file || ''));
  const dayDir = file ? path.basename(path.dirname(file)) : '';
  const str = (v) => (typeof v === 'string' ? v : '');
  out.meta = {
    id: ID_RE.test(str(m.id)) ? m.id : fileBase.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'meeting',
    // Not shortened here: a title already in a file stays as long as it is.
    title: (str(m.title) || fileBase).replace(/[\r\n]+/g, ' '),
    date: DATE_RE.test(dayDir) ? dayDir : (DATE_RE.test(str(m.date)) ? m.date : ''),
    start: TIME_RE.test(str(m.start)) ? m.start : '00:00',
    end: TIME_RE.test(str(m.end)) ? m.end : '',
    durationMin: Number(m.duration_min) || 0,
    speakers: Array.isArray(m.speakers) ? m.speakers : [],
    frontExtra: extra.map((x) => x.lines.join('\n')),
  };
  return out;
}

function section(notes, heading) {
  // Body of a "## heading" section of the notes, without the heading line.
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
  const m = notes.match(re);
  if (!m) return '';
  const rest = notes.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

// Markdown that is not prose: `inline code`, the address part of a link, an
// <autolink>, a bare web address and a [reference]: address line. A rewrite of
// the notes must leave these as they are.
const NOT_PROSE = new RegExp([
  '(?<!`)(`+)(?!`)(?:(?!\\n[ \\t]*\\n)[\\s\\S])*?(?<!`)\\1(?!`)',
  '\\]\\([^)\\n]*\\)',
  '<[A-Za-z][A-Za-z0-9+.-]*:[^>\\n]*>',
  '\\b(?:https?:\\/\\/|www\\.)\\S*',
  '^[ \\t]{0,3}\\[[^\\]\\n]+\\]:[^\\n]*',
].join('|'), 'gm');

// Calls fn on each stretch of prose in the Markdown and puts the results back
// together with everything else (fenced code blocks and the spans above) untouched.
function mapProse(md, fn) {
  const out = [];
  let buf = [], fence = null;
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n');
    let res = '', last = 0;
    for (const m of text.matchAll(NOT_PROSE)) { res += fn(text.slice(last, m.index)) + m[0]; last = m.index + m[0].length; }
    out.push(res + fn(text.slice(last)));
    buf = [];
  };
  for (const line of String(md).split('\n')) {
    if (fence) {
      out.push(line);
      const c = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
    } else {
      const o = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (o) { flush(); fence = o[1]; out.push(line); } else buf.push(line);
    }
  }
  flush();
  return out.join('\n');
}

// ---- action items ----
// A task is a "- [ ] text" or "- [x] text" line of the notes (never of the transcript), numbered from 0
// in file order. Lines are read exactly as renderMarkdown (src/renderer/ui.js) reads them, so the number
// the screen counts is the number found here: the same test makes a line a task, and nothing inside a
// ``` fence is one.
const TASK = /^(\s*(?:[-*•]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*)$/;
const FENCE = /^\s*(?:`{3,}(?![^`\r\n]*`)|~{3,}(?![^~\r\n]*~{3}))/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const DONE_MARK = /\s*\(done:\s*(\d{4}-\d{2}-\d{2})\s*\)$/;

function stepFence(fence, raw) {
  const line = String(raw).replace(/\s+$/, '');
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return fence;
  if (fence) return m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim() ? null : fence;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  if (m[1][0] === '~' && m[2].trim() && m[2].trimEnd().endsWith('~~~')) return null;
  return { ch: m[1][0], len: m[1].length };
}

function scanTasks(lines) {
  const out = [];
  let code = null, sect = '';
  lines.forEach((raw, at) => {
    const line = raw.replace(/\s+$/, '');
    const nextCode = stepFence(code, line);
    if (code || nextCode) { code = nextCode; return; }
    const head = HEADING.exec(line);
    if (head) { const t = head[2].trim().replace(/:$/, '').toLowerCase(); sect = head[1].length >= 3 && (t === 'mine' || t === 'others') ? t : ''; return; }
    const m = TASK.exec(line);
    if (!m) return;
    const mark = DONE_MARK.exec(m[4]);
    const done = m[2] !== ' ';
    out.push({ index: out.length, at, prefix: m[1], gap: m[3], text: m[4].replace(DONE_MARK, ''), done, doneOn: done && mark ? mark[1] : '', marked: Boolean(mark), section: sect });
  });
  return out;
}
const shownTask = (t) => ({ index: t.index, text: t.text, done: t.done, doneOn: t.doneOn, section: t.section });

// Where the notes sit in a file's raw lines: after the front matter, up to the last "## Transcript"
// line. Found the way parse() finds them, so a line edited here is a line parse() reports.
function notesRange(raw) {
  const lines = raw.split('\n');
  let from = 0;
  if (/^---[ \t]*$/.test(lines[0].replace(/^﻿/, '').replace(/\r$/, ''))) {
    let k = 1;
    while (k < lines.length && !/^---[ \t]*\r?$/.test(lines[k])) k++;
    from = Math.min(k + 1, lines.length);
  }
  let to = lines.length;
  for (let i = lines.length - 1; i >= from; i--) if (/^## Transcript[ \t]*\r?$/.test(lines[i])) { to = i; break; }
  return { lines, from, to };
}

// Errors written for the person (or for Claude): the connector shows these and nothing else.
const plain = (message, extra) => Object.assign(new Error(message), { userFacing: true }, extra);
const UNREADABLE = 'This meeting file has been edited in a way Understudy cannot read, so it was left as it is.';
const UNSAFE = 'This meeting file could not be updated safely, so it was left as it is.';
const UPDATE_MAX = 2000;
// Control characters and the invisible ones that can hide or reorder text.
const hidden = (c) => (c <= 8) || (c >= 14 && c <= 31) || c === 127 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;

// The listing cache: how much of a file's start is read first, what is kept, and how many.
const HEAD_BYTES = 16 * 1024;
const MAX_MEETING_BYTES = 32 * 1024 * 1024;
const TRANSCRIPT_LINE = /^## Transcript[ \t]*\r?\n/m;
const CACHE_FILES = 2000; // about 1 KB each
const NOTES_FILES = 48, NOTES_CACHED_CHARS = 40000; // one day's digest, so a save does not re-read the day's other meetings
const READ_AHEAD = 4;

const isSuperseded = (e) => Boolean(e) && e.code === 'SUPERSEDED';

// The live autosave kept in memory too (see beginLive): at most this many characters of lines, about 8 MB, which is
// many hours of speech; beyond it nothing more is kept, so a very long meeting cannot grow the process without end.
const LIVE_KEEP_MAX = 8 * 1024 * 1024;
const LIVE_LOST = 'Could not keep the recovery copy of this meeting. Understudy will keep trying.';
const LIVE_BACK = 'Recovery copy is working again.';

class MeetingStore {
  constructor(meetingsDir, liveDir, { onLiveProblem } = {}) {
    this.dir = meetingsDir || defaultMeetingsDir();
    this.onLiveProblem = onLiveProblem; // (message) => void: the autosave of a running meeting has failed, or works again
    this._live = new Map(); // meeting id -> { first, lines, bytes, full, problem }: see beginLive()
    this.liveDir = liveDir || path.join(this.dir, '.live');
    this._idx = new Map(); // meeting id -> file, so a lookup does not read every file
    // What list() shows for each file, kept while the file's size and modification time are unchanged.
    // Entries are small (the front matter and a short summary, never a transcript) and capped.
    this._cache = new Map(); // file -> { size, mtimeMs, item }
    this._cacheMax = CACHE_FILES;
    this._dirs = new Map(); // day folder -> { mtimeMs, at, files }
    this._notes = new Map(); // file -> { size, mtimeMs, notes }: the notes the daily digest needs, a few days' worth
    this._cacheDir = this.dir; // the folder is changed in place from Settings: a cache of another folder is dropped
    this._searchSeq = 0; // the newest searchAsync(): an older one stops when it sees it has been overtaken
  }

  // ---- live autosave: one JSON line per event, so a crash loses nothing ----
  //
  // What was written is also kept in memory for the length of the meeting, so that if the autosave folder (or the
  // file) is removed while the meeting runs, it is made again and written out whole. The copy is bounded: past
  // LIVE_KEEP_MAX bytes of lines it stops growing (a recreated file then holds the first line, the meta, and
  // what is written from then on, which recoverOrphans still turns into a meeting).
  beginLive(meta) {
    fs.mkdirSync(this.liveDir, { recursive: true });
    const first = JSON.stringify({ type: 'meta', meta }) + '\n';
    fs.writeFileSync(this._livePath(meta.id), first);
    this._live.set(meta.id, { first, lines: [], bytes: 0, full: false, problem: false });
  }
  // Never throws: disk trouble must not stop the meeting. A write that fails for a reason other than a missing
  // folder is told to onLiveProblem(message), once while it keeps failing, and again when it works again.
  appendLive(id, obj) {
    let rec = null;
    try {
      rec = this._live.get(id) || null;
      const line = JSON.stringify(obj) + '\n';
      if (rec && !rec.full) {
        if (rec.bytes + line.length > LIVE_KEEP_MAX) { rec.full = true; rec.lines = []; } else { rec.lines.push(line); rec.bytes += line.length; }
      }
      const file = this._livePath(id);
      try {
        // After a failure (or with the file gone) the whole file is written again, so lines that did not get
        // through while it was failing are in it too.
        if (rec && (rec.problem || !fs.existsSync(file))) this._restoreLive(file, rec, line);
        else fs.appendFileSync(file, line);
      } catch (e) {
        if (!rec || e.code !== 'ENOENT') throw e;
        this._restoreLive(file, rec, line);
      }
      if (rec && rec.problem) { rec.problem = false; this._liveSay(LIVE_BACK); }
    } catch {
      if (rec && !rec.problem) { rec.problem = true; this._liveSay(LIVE_LOST); }
    }
  }
  // The folder and the file are made again, with the first line and every line kept (the new one is among them
  // unless the copy is full, and is then added by itself).
  _restoreLive(file, rec, line) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rec.first + (rec.full ? line : rec.lines.join('')));
  }
  _liveSay(message) { try { if (typeof this.onLiveProblem === 'function') this.onLiveProblem(message); } catch { /* a notice must not stop the meeting either */ } }
  endLive(id) { this._live.delete(id); try { fs.unlinkSync(this._livePath(id)); } catch {} }
  _livePath(id) { return path.join(this.liveDir, `${id}.jsonl`); }

  // Turn any autosave left behind by a crash into a normal meeting file.
  recoverOrphans(activeId) {
    const recovered = [];
    let files = [];
    try { files = fs.readdirSync(this.liveDir).filter((f) => f.endsWith('.jsonl')); } catch { return recovered; }
    for (const f of files) {
      const id = path.basename(f, '.jsonl');
      if (id === activeId) continue;
      try {
        const lines = fs.readFileSync(path.join(this.liveDir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const turns = new Map();
        let names = {};
        for (const l of lines) {
          if (l.type === 'turn' && l.turn) turns.set(l.turn.id, l.turn);
          else if (l.type === 'names' && l.names && typeof l.names === 'object') names = l.names; // the last one wins
        }
        // Speaker names given during the meeting apply to every turn from that
        // voice, including turns written before the name was chosen.
        const shown = (t) => (t.speakerKey && typeof names[t.speakerKey] === 'string' && names[t.speakerKey]) || (t.speakerKey ? t.label : '') || t.speaker;
        const list = [...turns.values()].map((t) => ({ ...t, speaker: shown(t) })).sort((a, b) => a.t - b.t);
        let meta = (lines.find((l) => l.type === 'meta') || {}).meta;
        if (!meta && list.length && ID_RE.test(id)) {
          // The first line was damaged: rebuild what is needed from the turns.
          const start = new Date(list[0].t - 1000);
          meta = { id, title: `Recovered meeting ${hm(start)}`, autoTitle: true, date: ymd(start), start: hm(start), startMs: start.getTime(), end: '', durationMin: 0, speakers: [] };
        }
        if (!meta) {
          // Nothing usable: keep the file aside rather than deleting it.
          fs.mkdirSync(path.join(this.liveDir, 'corrupt'), { recursive: true });
          fs.renameSync(path.join(this.liveDir, f), path.join(this.liveDir, 'corrupt', f));
          continue;
        }
        if (list.length) {
          const last = list[list.length - 1];
          const end = new Date(last.end || last.t);
          meta.end = hm(end);
          meta.durationMin = Math.max(1, Math.round((end.getTime() - meta.startMs) / 60000));
          meta.speakers = [...new Set(list.map((t) => t.speaker))];
          const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
          const md = list.map((t) => `**[${clock(t.t)}] ${t.speaker}:** ${t.text}`).join('\n\n');
          recovered.push(this.save(meta, '_Recovered after the app closed unexpectedly. Notes have not been generated._', md));
        }
        fs.unlinkSync(path.join(this.liveDir, f));
      } catch { /* leave the file for the next start */ }
    }
    return recovered;
  }

  // Rename one speaker in a saved meeting: the transcript lines, the speakers
  // list and, for a plain "Speaker N" label, the notes. Notes written by the
  // model for any other name are left alone (see notesMentionOld).
  // The person's own name (`reserved`: their name and aliases, from the settings; the file itself does not say which
  // label is theirs) is never given to another speaker. The name of another speaker in the meeting (the speakers list
  // and every label in the transcript) is given only with `merge: true`, which joins the two under that speaker's
  // own spelling: a transcriber can split one person into two labels, so joining is sometimes the point, but it
  // cannot be undone and is therefore asked for. Only the case of a speaker's own name changes freely.
  // Returns { file, notesMentionOld, merged } where `merged` is the name joined into, or ''.
  renameSpeaker(id, from, to, { reserved = [], merge = false } = {}) {
    const found = this.find(id);
    if (!found) throw new Error('That meeting file no longer exists.');
    // Work from one reading of the file, so that what is checked, changed and
    // compared with the disk later is the same text.
    let raw;
    try { this._assertConfined(found.file); raw = fs.readFileSync(found.file, 'utf8'); } catch { throw new Error('That meeting file no longer exists.'); }
    const m = parse(raw, found.file);
    if (m.frontMatter !== 'ok') throw new Error('This meeting file has been edited in a way Understudy cannot read, so it was left as it is.');
    from = String(from == null ? '' : from).trim();
    let next = cleanSpeakerName(to);
    if (!next) throw new Error('Type a name for this speaker.');
    if (next === from) throw new Error('That is already the name.');
    const same = (a) => String(a).replace(/\s+/g, ' ').trim().toLowerCase();
    // Checked before anything else about the speaker: this name is not available whatever else is true.
    if ((Array.isArray(reserved) ? reserved : []).some((x) => typeof x === 'string' && x.trim() && same(x) === same(next))) throw plain('That is your own name. Choose another.');
    if (![...m.transcript.matchAll(/^\*\*\[[^\]\n]+\] (.+?):\*\*/gm)].some((l) => l[1] === from)) throw new Error('That speaker is not in this meeting.');
    const others = new Map(); // normalised name -> the spelling the meeting has
    for (const x of m.meta.speakers || []) if (x !== from && !others.has(same(x))) others.set(same(x), x);
    for (const l of m.transcript.matchAll(/^\*\*\[[^\]\n]+\] (.+?):\*\*/gm)) if (l[1] !== from && !others.has(same(l[1]))) others.set(same(l[1]), l[1]);
    // Two unnamed voices ("Speaker 2" onto "Speaker 1") are joined without asking: that is how a voice the
    // transcriber split in two is put right, and these labels carry no name to lose.
    const unnamed = /^Speaker \d+$/;
    const into = others.get(same(next)) || '';
    let merged = '';
    if (into) {
      if (!merge && !(unnamed.test(from) && unnamed.test(into))) throw plain(`There is already a speaker called ${into} in this meeting. Choose merge to combine them.`);
      merged = into;
      next = into;
    }
    // "**[hh:mm:ss] Label:** text": only the label of a paragraph is touched, never the words.
    const transcript = m.transcript.replace(/^(\*\*\[[^\]\n]+\] )(.+?)(:\*\*)/gm, (all, a, label, c) => (label === from ? `${a}${next}${c}` : all));
    const meta ={ ...m.meta, speakers: [...new Set((m.meta.speakers || []).map((x) => (x === from ? next : x)))] };
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let notes = m.notes;
    // "Speaker 2" must not match inside "Speaker 21". Named speakers are never
    // rewritten in the notes: the same word may be someone else's name. Code,
    // and the address part of links, are not prose and are left as they are.
    if (/^Speaker \d+$/.test(from)) notes = mapProse(notes, (t) => t.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?!\\d)`, 'gu'), () => next));
    let prose = '';
    mapProse(notes, (t) => { prose += `${t}\n`; return t; });
    // Another program (or a sync client) may have written the file since it was
    // read: do not replace newer content with an older copy of it.
    let now = null;
    try { this._assertConfined(found.file); now = fs.readFileSync(found.file, 'utf8'); } catch { /* gone */ }
    if (now !== raw) throw new Error('This meeting file changed while it was being renamed. Try again.');
    const file = this.save(meta, notes, transcript);
    return { file, merged, notesMentionOld: new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'u').test(prose) };
  }

  // ---- meeting files ----
  _assertConfined(file) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_MEETING_BYTES) throw new Error('Refusing to read a non-file or oversized meeting.');
    const root = fs.realpathSync(this.dir);
    const real = fs.realpathSync(file);
    if (!insidePath(root, real)) throw new Error('Refusing to read a meeting file outside the Meetings folder.');
  }

  save(meta, notesMd, transcriptMd) {
    if (!ID_RE.test(String(meta.id)) || !DATE_RE.test(String(meta.date)) || !TIME_RE.test(String(meta.start))) throw new Error('This meeting file has an invalid id, date or start time, so it was not written.');
    const existingFile = this._idx.get(meta.id) || null;
    // A meeting object that never came from a file (the live one) knows nothing of
    // front matter the person added since: keep what the file on disk has.
    if (!Array.isArray(meta.frontExtra) && existingFile) {
      try { this._assertConfined(existingFile); meta = { ...meta, frontExtra: parse(fs.readFileSync(existingFile, 'utf8'), existingFile).meta.frontExtra }; } catch { /* no earlier file to keep anything from */ }
    }
    const file = this._fileFor(meta, existingFile);
    writeAtomic(file, render(meta, notesMd, transcriptMd));
    // Remove the old file after a retitle - but not when the two names are the same file, and only
    // while it is still this meeting (a sync service may have put something else there).
    if (existingFile && !sameFile(existingFile, file) && this._idAt(existingFile) === meta.id) { try { fs.unlinkSync(existingFile); } catch {} }
    this._idx.set(meta.id, file);
    // Do not trust a size and time check for a file this process has just written (a coarse
    // file system clock could give the new file the old one's time and size).
    this._forget(file); if (existingFile) this._forget(existingFile);
    this._dirs.delete(path.dirname(file)); if (existingFile) this._dirs.delete(path.dirname(existingFile));
    // The digest is derived data and another PC may be rewriting it: if it cannot be written now, the next save will.
    try { this.writeDaily(meta.date); } catch { /* left for the next save */ }
    return file;
  }

  // The file a meeting is written to: the day's folder, the start time and the title. Two meetings in the same
  // minute, or titles that slug to the same name, must not overwrite each other: use the seconds, then the whole
  // id. `existingFile` is where the meeting is now (a retitle moves it). Shared by save() and renameMeeting().
  _fileFor(meta, existingFile) {
    const hhmm = meta.start.replace(':', '');
    const base = slug(meta.title);
    let file = path.join(this.dir, meta.date, `${hhmm}-${base}.md`);
    const hasEntry = (f) => Boolean(fs.lstatSync(f, { throwIfNoEntry: false }));
    const taken = (f) => hasEntry(f) && this._idAt(f) !== meta.id;
    if (existingFile && !sameFile(file, existingFile) && hasEntry(existingFile) && hasEntry(file) && this._idAt(file) === meta.id) {
      // Another file with this id (a copy made by a sync service, or the meeting captured twice) holds
      // the name this one would get. Write to the file this meeting was read from, never to the other.
      file = existingFile;
    } else {
      if (taken(file)) file = path.join(this.dir, meta.date, `${hhmm}${String(meta.id).slice(-2)}-${base}.md`);
      if (taken(file)) file = path.join(this.dir, meta.date, `${hhmm}-${base}-${meta.id}.md`);
    }
    const outside = () => new Error('Refusing to write a meeting file outside the Meetings folder.');
    const rel = path.relative(path.resolve(this.dir), path.resolve(file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw outside();
    const rootSt = fs.lstatSync(this.dir, { throwIfNoEntry: false });
    if (rootSt) {
      let realRoot;
      try { realRoot = fs.realpathSync(this.dir); } catch { throw outside(); }
      const dayDir = path.dirname(file);
      const daySt = fs.lstatSync(dayDir, { throwIfNoEntry: false });
      if (daySt) {
        if (daySt.isSymbolicLink() || !daySt.isDirectory()) throw outside();
        let realDay;
        try { realDay = fs.realpathSync(dayDir); } catch { throw outside(); }
        if (!insidePath(realRoot, realDay)) throw outside();
      }
      const fileSt = fs.lstatSync(file, { throwIfNoEntry: false });
      if (fileSt) {
        if (!fileSt.isFile()) throw outside();
        let realFile;
        try { realFile = fs.realpathSync(file); } catch { throw outside(); }
        if (!insidePath(realRoot, realFile)) throw outside();
      }
    }
    return file;
  }

  // Every meeting file, newest day first; a date, or from and to, leaves the other days unlooked at.
  _files({ date, from, to } = {}) {
    const out = [];
    let realRoot;
    try { realRoot = fs.realpathSync(this.dir); } catch { return out; }
    let days = [];
    try {
      days = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink() && DATE_RE.test(d.name))
        .map((d) => d.name);
    } catch { return out; }
    const seenDirs = new Set();
    for (const day of days.sort().reverse()) {
      const dir = path.join(this.dir, day);
      seenDirs.add(dir);
      if ((date && day !== date) || (from && day < from) || (to && day > to)) continue;
      for (const f of this._dayFiles(dir, realRoot)) out.push(f);
    }
    for (const d of this._dirs.keys()) if (!seenDirs.has(d)) this._dirs.delete(d);
    return out;
  }

  // One day's meeting files, newest first. The listing is kept while the folder's modification
  // time is unchanged (adding, removing and renaming a file all change it), but only once that
  // time is more than two seconds older than the listing: on a file system with a coarse clock
  // a change made just after we looked could otherwise carry the same time.
  _dayFiles(dir, realRoot) {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return [];
    const c = this._dirs.get(dir);
    if (c && c.mtimeMs === st.mtimeMs && c.mtimeMs < c.at - 2000) return c.files;
    let root = realRoot;
    try {
      if (!root) root = fs.realpathSync(this.dir);
      if (!insidePath(root, fs.realpathSync(dir))) return [];
    } catch { return []; }
    const at = Date.now();
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('_') && !e.name.startsWith('.') && !e.name.startsWith('~$'))
        .map((e) => e.name)
        .sort()
        .reverse()
        .map((f) => path.join(dir, f));
    } catch { return []; }
    this._dirs.set(dir, { mtimeMs: st.mtimeMs, at, files });
    return files;
  }

  _read(file) {
    this._assertConfined(file);
    return parse(fs.readFileSync(file, 'utf8'), file);
  }

  // The id written in a file's front matter, read from its first bytes only.
  _idAt(file) {
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st || !st.isFile()) return '';
      const fd = fs.openSync(file, 'r');
      try { const b = Buffer.alloc(600); const n = fs.readSync(fd, b, 0, 600, 0); const m = b.toString('utf8', 0, n).match(/^id:\s*(\S+)\s*$/m); return m ? m[1] : ''; } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  _forget(file) { this._cache.delete(file); this._notes.delete(file); }

  // The folder is changed in place from Settings: nothing cached for the old one may be served.
  _syncDir() { if (this._cacheDir !== this.dir) { this._cache.clear(); this._notes.clear(); this._dirs.clear(); this._cacheDir = this.dir; } }

  // Parses a file from its first bytes only. The notes sit above the transcript, so the head
  // is enough for the list and the digest; it grows until it holds the whole of the front
  // matter and the "## Transcript" heading, or the whole file. (A file with a second such
  // heading further down, which the app never writes, ends its notes at the first.)
  _readHead(file) {
    this._assertConfined(file);
    const fd = fs.openSync(file, 'r');
    try {
      for (let len = HEAD_BYTES; ; len = Math.min(len * 8, MAX_MEETING_BYTES)) {
        const buf = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, buf, 0, len, 0);
        const text = buf.toString('utf8', 0, n);
        if (n < len || len >= MAX_MEETING_BYTES || (TRANSCRIPT_LINE.test(text) && (!/^\uFEFF?---\r?\n/.test(text) || /\n---/.test(text.slice(4))))) return parse(text, file);
      }
    } finally { fs.closeSync(fd); }
  }

  // The files shown by list(), in order, as { item, notes } (notes only when asked for).
  // A file is read again only when it is new or its size or modification time has changed.
  // A second file claiming an id already shown (a planted file, a copy made by a sync service, one meeting
  // captured on two PCs) is not listed: the first in this order is the file that id means, for list(), find()
  // and every write. `stopAt` ends the pass once the file for that id has been seen.
  _scan({ date, from, to, limit = 200, stopAt } = {}, withNotes = false) {
    this._syncDir();
    const all = this._files({ date, from, to });
    // Forget files that are gone: any cached file of a day just looked at that was not found in it.
    const live = new Set(all), looked = new Set(all.map((f) => path.dirname(f)));
    for (const f of this._cache.keys()) if (!live.has(f) && (looked.has(path.dirname(f)) || !(date || from || to))) this._forget(f);
    const out = [];
    const seen = new Set();
    for (const file of all) {
      const day = path.basename(path.dirname(file));
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st || !st.isFile() || st.size > MAX_MEETING_BYTES) { this._forget(file); continue; }
      let e = this._cache.get(file);
      let notes;
      if (e && (e.size !== st.size || e.mtimeMs !== st.mtimeMs)) e = null;
      if (e && withNotes) {
        const n = this._notes.get(file);
        if (n && n.size === st.size && n.mtimeMs === st.mtimeMs) notes = n.notes; else e = null;
      }
      if (!e) {
        let m;
        try { m = this._readHead(file); } catch { this._forget(file); continue; } // unreadable file: skip
        const { frontExtra, ...shown } = m.meta; // the person's own front matter is for rewrites, not for the lists
        e = { size: st.size, mtimeMs: st.mtimeMs, item: { ...shown, date: m.meta.date || day, file, hasNotes: !/^_.*not been generated/m.test(m.notes), summary: section(m.notes, 'Summary').slice(0, 400) } };
        this._cache.delete(file);
        this._cache.set(file, e);
        while (this._cache.size > this._cacheMax) this._cache.delete(this._cache.keys().next().value);
        notes = m.notes;
        if (withNotes && notes.length <= NOTES_CACHED_CHARS) {
          this._notes.delete(file);
          this._notes.set(file, { size: st.size, mtimeMs: st.mtimeMs, notes });
          while (this._notes.size > NOTES_FILES) this._notes.delete(this._notes.keys().next().value);
        }
      }
      if (seen.has(e.item.id)) continue; // a second file claiming the same id is ignored
      seen.add(e.item.id);
      this._idx.set(e.item.id, file);
      out.push({ item: { ...e.item, speakers: e.item.speakers.slice() }, notes });
      if (out.length >= limit || e.item.id === stopAt) break;
    }
    return out;
  }

  // The file a meeting id means: the one list() shows for it. Never a second file with the same id.
  _shown(id) {
    const x = this._scan({ limit: Infinity, stopAt: id }).find((y) => y.item.id === id);
    return x ? x.item.file : null;
  }

  list(opts = {}) { return this._scan(opts).map((x) => x.item); }

  find(id) {
    const file = this._shown(id);
    if (!file) return null;
    try { const m = this._read(file); if (m.meta.id === id) return m; } catch { /* moved or deleted since */ }
    return null;
  }

  // Appends one hit per matching paragraph of a parsed meeting.
  _hitsIn(m, file, terms, hits) {
    const paras = `${m.notes}\n\n${m.transcript}`.split(/\n\s*\n/);
    for (const p of paras) {
      const low = p.toLowerCase();
      const matched = terms.filter((t) => low.includes(t)).length;
      if (!matched) continue;
      hits.push({ score: matched / terms.length + (matched === terms.length ? 1 : 0), id: m.meta.id, title: m.meta.title, date: m.meta.date, start: m.meta.start, file, snippet: p.trim().slice(0, 500) });
    }
  }

  _rank(hits, limit) {
    hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
    return hits.slice(0, limit);
  }

  search(query, { limit = 10 } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (!terms.length) return [];
    const hits = [];
    for (const file of this._files()) {
      let m;
      try { m = this._read(file); } catch { continue; }
      this._hitsIn(m, file, terms, hits);
    }
    return this._rank(hits, limit);
  }

  // The same answer as search(), without holding the thread: files are read off the main
  // thread and parsed a few at a time, with a turn of the event loop between stretches of
  // about budgetMs, so a live meeting is not kept waiting. Only the newest call finishes;
  // an older one is overtaken and rejects with code 'SUPERSEDED' (see isSuperseded).
  async searchAsync(query, { limit = 10, budgetMs = 8 } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const mine = ++this._searchSeq;
    if (!terms.length) return [];
    const stale = () => { if (mine !== this._searchSeq) throw Object.assign(new Error('A newer search replaced this one.'), { code: 'SUPERSEDED' }); };
    const files = this._files();
    if (!files.length) return [];
    let realRoot;
    try { realRoot = await fs.promises.realpath(this.dir); } catch { return []; }
    stale();
    const readSafe = async (f) => {
      try {
        const st = await fs.promises.lstat(f);
        if (!st.isFile() || st.size > MAX_MEETING_BYTES) return null;
        const real = await fs.promises.realpath(f);
        if (!insidePath(realRoot, real)) return null;
        return await fs.promises.readFile(f, 'utf8');
      } catch { return null; }
    };
    const hits = [];
    const ahead = new Map(); // reads already under way: the disk works while the thread parses
    const fetch = (i) => { if (i < files.length && !ahead.has(i)) ahead.set(i, readSafe(files[i])); };
    let sliceStart = performance.now();
    for (let i = 0; i < files.length; i++) {
      for (let k = 0; k < READ_AHEAD; k++) fetch(i + k);
      const text = await ahead.get(i);
      ahead.delete(i);
      stale();
      if (text !== null) this._hitsIn(parse(text, files[i]), files[i], terms, hits);
      if (performance.now() - sliceStart >= budgetMs) {
        await new Promise((resolve) => setImmediate(resolve));
        stale();
        sliceStart = performance.now();
      }
    }
    return this._rank(hits, limit);
  }

  // With a meeting id: that meeting's tasks, [{ index, text, done, doneOn, section }]. With a range (or nothing):
  // every meeting in it that has an "Action items" section or any task, as { id, title, date, start, items, tasks }
  // where `items` is the section's text and `tasks` the same list of tasks. One meeting is listed once even when
  // two files carry its id.
  actionItems(arg = {}) {
    if (typeof arg === 'string') {
      const file = this._shown(arg);
      try { const m = file && this._read(file); if (m && m.meta.id === arg) return scanTasks(m.notes.split('\n')).map(shownTask); } catch { /* gone since */ }
      return [];
    }
    const { from, to } = arg || {};
    return this._scan({ from, to }, true).map(({ item: m, notes }) => {
      const items = section(notes, 'Action items');
      const tasks = scanTasks(notes.split('\n')).map(shownTask);
      return items || tasks.length ? { id: m.id, title: m.title, date: m.date, start: m.start, items, tasks } : null;
    }).filter(Boolean);
  }

  // The one way a meeting file is changed in place. The file is read once; `build(raw, parsed)` makes the new
  // text from that reading (or returns null for "nothing to change"); the file is read again just before it is
  // written and refused if another program (a sync client, an editor) has changed it meanwhile. The line edits
  // leave front matter, transcript and every other line exactly as they were, so nothing the person added is
  // lost, and the write is atomic. The file read is the one list() shows for this id, and it is the one
  // written, never a second file that claims the same id.
  _mutate(id, build) {
    const file = this._shown(id);
    let raw = null;
    try { if (file) { this._assertConfined(file); raw = fs.readFileSync(file, 'utf8'); } } catch { /* gone */ }
    const m = raw === null || raw === false ? null : parse(raw, file);
    if (!m || m.meta.id !== id) throw plain('That meeting file no longer exists.', { notFound: true });
    if (m.frontMatter !== 'ok') throw plain(UNREADABLE);
    const next = build(raw, m);
    if (next == null || next === raw) return { file, changed: false };
    // Another program (or a sync client) may have written the file since it was read.
    let now = null;
    try { this._assertConfined(file); now = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
    if (now !== raw) throw plain('This meeting file changed while it was being updated. Try again.');
    writeAtomic(file, next);
    this._idx.set(id, file);
    this._forget(file); this._dirs.delete(path.dirname(file));
    try { this.writeDaily(path.basename(path.dirname(file))); } catch { /* derived data: the next save rewrites it */ }
    return { file, changed: true };
  }

  // Ticks an action item off (or reopens it). The item at `index` must have exactly `text`; if the notes were
  // rewritten since the list was read, the one item with exactly that text is used instead.
  setActionItem(id, { index, text, done, on } = {}) {
    const day = on === undefined || on === null || on === '' ? ymd(new Date()) : String(on);
    if (!DATE_RE.test(day)) throw plain('That date is not valid.');
    const want = Boolean(done);
    let shown = null;
    const r = this._mutate(id, (raw, m) => {
      const { lines, from, to } = notesRange(raw);
      const tasks = scanTasks(lines.slice(from, to));
      const exact = typeof text === 'string' ? tasks.filter((t) => t.text === text) : [];
      const t = Number.isInteger(index) && tasks[index] && typeof text === 'string' && tasks[index].text === text ? tasks[index] : (exact.length === 1 ? exact[0] : null);
      if (!t) throw plain('That action item is no longer in the notes.');
      shown = shownTask(t);
      if (want ? t.done : (!t.done && !t.marked)) return null; // already as asked
      const at = from + t.at;
      const cr = lines[at].endsWith('\r') ? '\r' : '';
      lines[at] = `${t.prefix}[${want ? 'x' : ' '}]${t.gap}${t.text}${want ? ` (done: ${day})` : ''}${cr}`;
      const next = lines.join('\n');
      // Read the result back as parse() will: the same tasks, only this one changed, nothing else touched.
      const after = parse(next, m.file);
      const again = scanTasks(after.notes.split('\n'));
      const fine = after.frontMatter === 'ok' && after.transcript === m.transcript && again.length === tasks.length
        && again.every((a, i) => a.text === tasks[i].text && a.done === (i === t.index ? want : tasks[i].done));
      if (!fine) throw plain(UNSAFE);
      shown = { index: t.index, text: t.text, done: want, doneOn: want ? day : '', section: t.section };
      return next;
    });
    return { file: r.file, item: shown };
  }

  // Gives a saved meeting a new title: the title in the front matter, the "# title" heading under it (when that
  // still shows the old title) and the file name, which follows the title as it does in save(). Nothing else in
  // the file is touched (the notes, the transcript, other front matter, line endings and a byte-order mark stay as
  // they were). The same rules as the other edits: the file read is the one list() shows for the id, a file whose
  // front matter cannot be read is refused untouched, the file is read again just before it is written and
  // refused if it changed, the write is atomic, and the old file is removed only after the new one is written and
  // only while it still carries this id. A name already used by another meeting is never overwritten (save()'s
  // rule: the seconds, then the whole id, are added). The title is cleaned like any title (cleanMeetingTitle).
  // Nothing is kept in the file to say the title is the person's own: a notes rewrite starts from the saved file
  // and never replaces a title (see useGeneratedTitle). Returns { file, changed }.
  renameMeeting(id, title) {
    const clean = cleanMeetingTitle(title);
    const file = this._shown(id);
    let raw = null;
    try { if (file) { this._assertConfined(file); raw = fs.readFileSync(file, 'utf8'); } } catch { /* gone */ }
    const m = typeof raw === 'string' ? parse(raw, file) : null;
    if (!m || m.meta.id !== id) throw plain('That meeting file no longer exists.', { notFound: true });
    if (m.frontMatter !== 'ok') throw plain(UNREADABLE);
    if (m.meta.title === clean) return { file, changed: false };
    const next = retitle(raw, m, clean);
    if (next === null) throw plain(UNSAFE);
    const target = this._fileFor({ ...m.meta, title: clean }, file);
    // Another program (or a sync client) may have written the file since it was read.
    let now = null;
    try { this._assertConfined(file); now = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
    if (now !== raw) throw plain('This meeting file changed while it was being renamed. Try again.');
    writeAtomic(target, next);
    if (!sameFile(file, target) && this._idAt(file) === id) { try { fs.unlinkSync(file); } catch {} }
    this._idx.set(id, target);
    this._forget(file); this._forget(target);
    this._dirs.delete(path.dirname(file)); this._dirs.delete(path.dirname(target));
    try { this.writeDaily(path.basename(path.dirname(target))); } catch { /* derived data: the next save rewrites it */ }
    return { file: target, changed: true };
  }

  // Adds "- YYYY-MM-DD: text" under "## Updates" at the end of the notes (above the transcript), creating that
  // heading when it is missing, and keeping the lines in date order. `by` other than "me" is named on the line.
  addUpdate(id, text, { on, by = 'me' } = {}) {
    const day = on === undefined || on === null || on === '' ? ymd(new Date()) : String(on);
    if (!DATE_RE.test(day)) throw plain('That date is not valid.');
    const src = String(text == null ? '' : text);
    const tooLong = plain(`That update is too long (over ${UPDATE_MAX.toLocaleString('en-GB')} characters).`);
    if (src.length > 20000) throw tooLong;
    const breaks = /[\r\n\u000b\u000c\u0085\u2028\u2029]+/;
    // A line of it that starts a heading would break the notes' structure; the transcript marker is a heading.
    if (src.split(breaks).some((l) => /^\s*#{1,6}(\s|$)/.test(l))) throw plain('An update cannot contain a line that starts with # (a heading).');
    const clean = [...src.replace(breaks, ' ')].filter((ch) => !hidden(ch.charCodeAt(0))).join('').replace(/\s+/g, ' ').trim();
    if (!clean) throw plain('Write something to add first.');
    if (clean.length > UPDATE_MAX) throw tooLong;
    const who = String(by == null ? '' : by).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 30);
    const entry = `- ${day}${who && who.toLowerCase() !== 'me' ? ` (by ${who})` : ''}: ${clean}`;
    const r = this._mutate(id, (raw, m) => {
      const { lines, from, to } = notesRange(raw);
      const cr = raw.includes('\r\n') ? '\r' : '';
      const line = (s) => s + cr;
      const blank = (i) => !lines[i].trim();
      // The "## Updates" heading (not one inside a code fence), and where that section ends.
      let head = -1, fence = null;
      for (let i = from; i < to && head < 0; i++) {
        const l = lines[i].replace(/\s+$/, '');
        const nextFence = stepFence(fence, l);
        if (fence || nextFence) fence = nextFence;
        else if (/^## Updates$/i.test(l)) head = i;
      }
      let at, insert;
      if (head >= 0) {
        let end = to;
        fence = null;
        for (let i = head + 1; i < to; i++) {
          const l = lines[i].replace(/\s+$/, '');
          const nextFence = stepFence(fence, l);
          if (fence || nextFence) fence = nextFence;
          else if (/^## /.test(l)) { end = i; break; }
        }
        at = -1;
        for (let i = head + 1; i < end; i++) { const d = /^- (\d{4}-\d{2}-\d{2})\b/.exec(lines[i]); if (d && d[1] > day) { at = i; break; } }
        if (at < 0) { at = end; while (at - 1 > head && blank(at - 1)) at--; }
        insert = at - 1 === head && !/^- /.test(lines[at] || '') ? [line(''), line(entry)] : [line(entry)];
      } else {
        at = to;
        while (at > from && blank(at - 1)) at--;
        insert = [...(at > from ? [line('')] : []), line('## Updates'), line(''), line(entry)];
        if (at < lines.length && !blank(at)) insert.push(line(''));
      }
      lines.splice(at, 0, ...insert);
      const next = lines.join('\n');
      const before = scanTasks(m.notes.split('\n'));
      const after = parse(next, m.file);
      const fine = after.frontMatter === 'ok' && after.transcript === m.transcript && after.notes.includes(entry)
        && JSON.stringify(scanTasks(after.notes.split('\n'))) === JSON.stringify(before);
      if (!fine) throw plain(UNSAFE);
      return next;
    });
    return { file: r.file };
  }

  dailyDigest(date) {
    // One look at each file (and none for a file the cache already holds the notes of): the
    // digest is rewritten on every save, and a day can hold several long meetings.
    const found = this._scan({ date }, true).reverse();
    const meetings = found.map((x) => x.item);
    if (!meetings.length) return '';
    const parts = [`# Meetings on ${date}`, '', `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}, ${meetings.reduce((n, m) => n + m.durationMin, 0)} minutes in total.`];
    for (const { item: m, notes: raw } of found) {
      const notes = raw.replace(/^## /gm, '### ').replace(/^### (?=Mine|Others)/gm, '#### ');
      parts.push('', `## ${m.start}${m.end ? `-${m.end}` : ''} ${m.title} (${m.durationMin} min)`, '', `File: ${path.basename(m.file)}`, '', notes);
    }
    return parts.join('\n') + '\n';
  }

  writeDaily(date) {
    if (!DATE_RE.test(String(date))) return;
    const dayDir = path.join(this.dir, date);
    const st = fs.lstatSync(dayDir, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return;
    const text = this.dailyDigest(date);
    if (text) writeAtomic(path.join(dayDir, '_daily.md'), text);
  }
}

module.exports = { MeetingStore, useGeneratedTitle, scanTasks, stepFence, isSuperseded, defaultMeetingsDir, newMeta, render, parse, section, slug, ymd, hm, safeNotes, DATE_RE, ID_RE, FENCE, hidden, plain, UPDATE_MAX, UNREADABLE };
