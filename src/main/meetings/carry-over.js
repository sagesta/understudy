'use strict';
// "Rewrite notes" writes new notes from the transcript. What the person did to the old notes since (ticked action
// items, follow-up lines under "## Updates") is not in the transcript, so it is carried over into the new text here
// rather than lost. Pure Node, no Electron: main.js calls rewriteSaved(), the tests call everything.
//
//   carryOver(oldNotes, newNotes, { today })   the new notes text with the old ticks and updates put back
//   openForRewrite(store, id)                  the saved meeting, or a plain sentence saying why it cannot be rewritten
//   rewriteSaved(store, meta, newNotes, transcriptMd)   the save a rewrite ends with
//
// Rules (see also scanTasks in store.js, which reads tasks exactly as the screen's renderMarkdown does):
//  - the old "## Updates" section is carried over line for line, at the end of the notes (above the transcript);
//    when the new notes have an "## Updates" heading of their own the entries are merged under that one heading;
//  - a task that was done in the old notes and has a matching task in the new ones is marked done again, with
//    its own "(done: date)" marker. A task matches on its text: trimmed, spaces collapsed, case ignored, and
//    without a trailing "(due: ...)" or "(done: ...)";
//  - a done task with no match is not lost: "- <date>: Marked done earlier: <task>" goes under "## Updates";
//  - open tasks stay as the new notes have them, and the transcript is never touched;
//  - running it again on its own result changes nothing.

const { scanTasks, stepFence, safeNotes, ymd, DATE_RE, hidden, plain, UPDATE_MAX, UNREADABLE } = require('./store');

// Line breaks of every kind (the same set addUpdate treats as one).
const BREAKS = new RegExp('[\r\n\v\f\x85' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
const UPDATES_HEAD = /^## Updates$/i;
const ENTRY_DATE = /^- (\d{4}-\d{2}-\d{2})\b/;
const MARKED = /^- (\d{4}-\d{2}-\d{2})(?: \(by [^)]*\))?: Marked done earlier: (.*)$/;
const TRANSCRIPT_HEAD = /^## Transcript[ \t]*$/gm;

// The text of a task as compared: no "(due: ...)" or "(done: ...)" at the end, spaces collapsed, case ignored.
function taskKey(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  for (let prev = null; prev !== t;) { prev = t; t = t.replace(/\s*\((?:due|done):[^)]*\)\s*$/i, '').trim(); }
  return t.toLowerCase();
}

// One line of an update from a task's text: the same cleaning addUpdate does (no control or invisible
// characters, one line, one space between words), kept under the 2,000 characters an update may have.
function oneLine(text, max) {
  const s = [...String(text).replace(BREAKS, ' ')].filter((ch) => !hidden(ch.charCodeAt(0))).join('').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trim()}…` : s;
}

// The text before the last "## Transcript" heading, and the rest (heading included, '' when there is none).
function splitTranscript(text) {
  let at = -1;
  for (const m of text.matchAll(TRANSCRIPT_HEAD)) at = m.index;
  return at < 0 ? { head: text, tail: '' } : { head: text.slice(0, at), tail: text.slice(at) };
}

// Where "## Updates" sections are in these lines (not one inside a code fence): [{ head, end }], `end` the line of
// the next "## " heading or the end of the lines.
function updateSections(lines) {
  const out = [];
  let fence = null, cur = null;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\s+$/, '');
    const nextFence = stepFence(fence, l);
    if (fence || nextFence) { fence = nextFence; return; }
    if (/^## /.test(l)) {
      if (cur) { cur.end = i; cur = null; }
      if (UPDATES_HEAD.test(l)) { cur = { head: i, end: lines.length }; out.push(cur); }
    }
  });
  return out;
}

const blank = (l) => !l.trim();
const trimBlank = (lines) => { let a = 0, b = lines.length; while (a < b && blank(lines[a])) a++; while (b > a && blank(lines[b - 1])) b--; return lines.slice(a, b); };
const fenceOpen = (lines) => { let f = null; for (const l of lines) f = stepFence(f, l.replace(/\s+$/, '')); return f; };

// Puts a dated entry in a section's lines the way addUpdate does: before the first entry with a later date, else
// after the last line that has anything on it. Returns the new lines.
function insertEntry(body, entry) {
  const day = ENTRY_DATE.exec(entry)[1];
  let at = -1;
  for (let i = 0; i < body.length; i++) { const d = ENTRY_DATE.exec(body[i]); if (d && d[1] > day) { at = i; break; } }
  if (at < 0) { at = body.length; while (at > 0 && blank(body[at - 1])) at--; }
  return [...body.slice(0, at), entry, ...body.slice(at)];
}

function carryOver(oldNotes, newNotes, { today } = {}) {
  const raw = String(newNotes == null ? '' : newNotes);
  const day = DATE_RE.test(String(today)) ? String(today) : ymd(new Date());
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const { head: newHead, tail } = splitTranscript(raw.replace(/\r\n/g, '\n'));
  const oldHead = splitTranscript(String(oldNotes == null ? '' : oldNotes).replace(/\r\n/g, '\n')).head;
  const oldLines = oldHead.split('\n');
  const lines = newHead.split('\n');
  let changed = false;

  const carriedRaw = [];
  for (const s of updateSections(oldLines)) carriedRaw.push(...trimBlank(oldLines.slice(s.head + 1, s.end)));
  const markedFromUpdates = [];
  carriedRaw.forEach((rawLine, idx) => {
    const m = MARKED.exec(rawLine.replace(/\s+$/, ''));
    if (m) markedFromUpdates.push({ text: m[2], done: true, doneOn: m[1], marked: true, carriedIdx: idx });
  });

  // 1. Done tasks (including those preserved under Updates on an earlier rewrite): matched one for one, in order, on their text.
  const oldDone = [...scanTasks(oldLines).filter((t) => t.done), ...markedFromUpdates];
  const newTasks = scanTasks(lines);
  const used = new Set();
  const matchedCarried = new Set();
  const unmatched = [];
  for (const d of oldDone) {
    const key = taskKey(d.text);
    const n = newTasks.find((t) => !used.has(t.index) && taskKey(t.text) === key);
    if (!n) { if (d.carriedIdx === undefined) unmatched.push(d); continue; }
    used.add(n.index);
    if (d.carriedIdx !== undefined) matchedCarried.add(d.carriedIdx);
    if (n.done && (n.marked || !d.marked)) continue; // already as it was
    const on = d.marked ? d.doneOn : n.marked ? n.doneOn : '';
    lines[n.at] = `${n.prefix}[x]${n.gap}${n.text}${on ? ` (done: ${on})` : ''}`;
    changed = true;
  }

  // 2. Updates: the old section's lines, and a line for each done task that has no match.
  const carried = carriedRaw.filter((_, idx) => !matchedCarried.has(idx));
  const entries = [];
  for (const d of unmatched) {
    const text = oneLine(d.text, UPDATE_MAX - 60);
    if (text) entries.push({ key: taskKey(text), line: `- ${d.doneOn || day}: Marked done earlier: ${text}` });
  }
  if (carried.length || entries.length) {
    const sections = updateSections(lines);
    const have = (body) => new Set(body.map((l) => l.replace(/\s+$/, '')));
    const addEntries = (body) => {
      for (const e of entries) {
        if (body.some((l) => { const m = MARKED.exec(l); return m && taskKey(m[2]) === e.key; })) continue;
        body = insertEntry(body, e.line);
      }
      return body;
    };
    if (sections.length) {
      // The new notes have an "## Updates" of their own: merge into the first one.
      const s = sections[0];
      const before = lines.slice(s.head + 1, s.end);
      const present = have(before);
      let body = before.slice();
      for (const l of carried) {
        if (blank(l) || present.has(l.replace(/\s+$/, ''))) continue;
        present.add(l.replace(/\s+$/, ''));
        const entry = ENTRY_DATE.test(l) && !/^\s/.test(l);
        if (entry) body = insertEntry(body, safeNotes(l)); else { let at = body.length; while (at > 0 && blank(body[at - 1])) at--; body.splice(at, 0, safeNotes(l)); }
      }
      body = addEntries(body);
      const open = fenceOpen(body);
      if (open) { let at = body.length; while (at > 0 && blank(body[at - 1])) at--; body.splice(at, 0, open.ch.repeat(open.len)); }
      if (body.length !== before.length || body.some((l, i) => l !== before[i])) {
        // A heading with nothing under it gets its blank line.
        if (!blank(body[0] || '') && !before.length) body.unshift('');
        lines.splice(s.head + 1, s.end - s.head - 1, ...body);
        changed = true;
      }
    } else {
      let body = carried.map((l) => safeNotes(l));
      body = addEntries(body);
      if (body.length) {
        const openBody = fenceOpen(body);
        if (openBody) body.push(openBody.ch.repeat(openBody.len));
        // Above the transcript, after whatever the notes end with, as addUpdate puts it.
        let at = lines.length;
        while (at > 0 && blank(lines[at - 1])) at--;
        const block = [...(at > 0 ? [''] : []), '## Updates', '', ...body];
        const openBefore = fenceOpen(lines.slice(0, at));
        if (openBefore) block.unshift(openBefore.ch.repeat(openBefore.len));
        lines.splice(at, lines.length - at, ...block);
        changed = true;
      }
    }
  }
  if (!changed) return raw;

  const head = lines.join('\n').replace(/\s+$/, '');
  const out = tail ? `${head}\n\n${tail}` : head;
  // Nothing may have gone astray: the same tasks in the same order, and the transcript as it was.
  const was = scanTasks(newHead.split('\n'));
  const now = scanTasks(splitTranscript(out).head.split('\n'));
  if (was.length !== now.length || was.some((t, i) => taskKey(t.text) !== taskKey(now[i].text) || (t.done && !now[i].done)) || splitTranscript(out).tail !== tail) {
    throw plain('The notes could not be combined with your ticks and updates safely, so the saved notes were left as they are.');
  }
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

// The saved meeting a rewrite starts from. A meeting that is gone, or whose front matter Understudy cannot read, is
// refused with a sentence for the person, before the model is asked for anything.
function openForRewrite(store, id) {
  const m = store.find(id);
  if (!m) throw plain('That meeting file no longer exists.', { notFound: true });
  if (m.frontMatter === 'broken') throw plain(UNREADABLE);
  return m;
}

// The save that ends a rewrite. The saved notes are read again now (a tick or an update may have been added while
// the model was writing), and carried into the new ones. Concurrent metadata and transcript edits on disk are kept too.
function rewriteSaved(store, meta, newNotesMd, transcriptMd, { today } = {}) {
  const current = openForRewrite(store, meta.id);
  if (meta && typeof meta === 'object' && current.meta && current.meta.title) meta.title = current.meta.title;
  const mergedMeta = { ...meta, ...current.meta, autoTitle: false };
  return store.save(mergedMeta, carryOver(current.notes, newNotesMd, { today }), current.transcript || transcriptMd);
}

// The tasks the person has ticked in saved notes, as short single lines (at most DONE_MAX of DONE_CHARS characters), for the
// model to be told before it writes the new follow-up message. The transcript part is not looked at.
const DONE_MAX = 30, DONE_CHARS = 200;
function doneTaskTexts(notes) {
  const head = splitTranscript(String(notes == null ? '' : notes).replace(/\r\n/g, '\n')).head;
  const oldLines = head.split('\n');
  const seen = new Set(), out = [];
  const push = (rawText) => {
    if (out.length >= DONE_MAX) return;
    const text = oneLine(rawText, DONE_CHARS), key = taskKey(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const t of scanTasks(oldLines)) {
    if (t.done) push(t.text);
  }
  for (const s of updateSections(oldLines)) {
    for (const rawLine of oldLines.slice(s.head + 1, s.end)) {
      const m = MARKED.exec(rawLine.replace(/\s+$/, ''));
      if (m) push(m[2]);
    }
  }
  return out;
}

module.exports = { carryOver, openForRewrite, rewriteSaved, taskKey, doneTaskTexts, DONE_MAX, DONE_CHARS };
