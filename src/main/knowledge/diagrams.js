'use strict';
// Architecture written as text, turned into words the library can search.
//
// A diagram is a poor thing to search by words: "A --> B" says nothing about
// what A and B are once a long diagram has been cut into passages. So every
// format here is read into a small model (components, connections, groups) and
// written out as Markdown in which each line stands on its own:
//
//   - Payment Service (container, Node.js): takes card payments
//   - Payment Service -> Ledger DB: writes transactions (JDBC)
//
// The files are untrusted (a cloned repository, a download, a synced folder)
// and are read in the main process, which also handles the live transcript.
// What this module guarantees, in layers, each one catching what the one
// before it cannot:
//
//   1. Bounded work in every parser. Lines are cut at MAX_LINE, at the last
//      separator so that no name is ever invented from half a token. Every
//      pattern that can meet a long run is bounded, or is replaced by indexOf or
//      sticky scanning (a failed attempt never re-reads what it has read).
//      Groups are kept as short strings and nest to MAX_DEPTH levels (deeper
//      ones belong to the last), so a nest of 8,000 is as cheap as one of 12.
//      Per file there are limits on components and connections (MAX_ITEMS),
//      labels per edge, pages, inflated bytes (MAX_INFLATED in a worker,
//      MAX_INFLATED_INLINE inline) and on the text written out (the smaller of
//      8 times the input and 8 MB). A limit that is hit is said in the output
//      in one plain line. Text of any kind is read only up to MAX_TEXT_PARSED
//      (AsciiDoc and reST, which are read from a list of lines, MAX_DOC_INLINE inline).
//   2. A time budget inside the parsers: a cheap check every few lines or
//      tokens abandons the structured reading after BUDGET_MS and gives the
//      plain source with a line saying so (draw.io and Excalidraw, which have no
//      plain form, are left out with a reason). Nothing here throws.
//   3. Off the main thread: convertDiagramAsync and describeFencesAsync run
//      anything larger than ASYNC_INLINE_MAX in one reused worker thread, with a
//      memory limit and a hard timeout (the worker is terminated and the file is
//      indexed as plain text, or left out with a reason). If a worker cannot be
//      started (an unusual packaging, a blocked thread) the bounded inline path
//      is used instead.
//   4. describeFences, which writes the connections of a diagram in a Markdown
//      file after its fence, adds at most a quarter of the text it was given (or
//      FENCES_ADDED_MIN, when that is more),
//      describes identical fences once, and does nothing to text it has already
//      described (so calling it twice, or on this module's own output, is safe).
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { redactSecrets } = require('./redact');

const MAX_LINE = 2000;                       // longest line any pattern is shown
const MAX_STRUCTURED_BYTES = 32 * 1024 * 1024;   // draw.io / Excalidraw larger than this are left out
const MAX_INFLATED = 64 * 1024 * 1024;       // all the compressed pages of one draw.io FILE may not grow beyond this (in a worker)
const MAX_INFLATED_INLINE = 16 * 1024 * 1024;    // the same, for the inline path, which cannot be interrupted while it inflates
const MAX_TEXT_PARSED = 16 * 1024 * 1024;    // characters of a text diagram (of any kind) that are read
const MAX_DOC_INLINE = 4 * 1024 * 1024;      // AsciiDoc and reST are read line by line from a list, which cannot be interrupted: inline, this much
const MAX_SOURCE_SHOWN = 2_000_000;          // characters of the original kept under "Source"
const MAX_ITEMS = 20000;                     // components, and connections, per diagram
const MAX_FENCE_LINES = 600;                 // lines per list added after a fence in a Markdown file
const MAX_DEPTH = 12;                        // levels of groups that are told apart
const MAX_PAGES = 200;                       // draw.io pages per file
const MAX_EDGE_LABELS = 20;                  // label cells that are joined onto one draw.io edge
const MAX_FAN = 400;                         // connections made from one "A & B --> C & D" statement
const MAX_TOKENS = 1_500_000;                // Graphviz tokens
const OUT_FACTOR = 8, OUT_MAX = 8 * 1024 * 1024, OUT_MIN = 16 * 1024;   // converted output: min(8 x input, 8 MB), at least 16 KB
const BUDGET_MS = 250;                       // one diagram, inline
const SMALL_BUDGET_MS = 60;                  // one small diagram that the async path reads inline
const WORKER_BUDGET_MS = 4000;               // one diagram, in the worker
const FENCES_TOTAL_MS = 600;                 // all the fences of one Markdown text, inline
const FENCES_ADDED_MIN = 64 * 1024;          // what describeFences may add to a text however short it is
const ASYNC_INLINE_MAX = 32 * 1024;          // below this the async entry points do not use a worker
const JOB_TIMEOUT_MS = 12000;                // a worker job that takes longer is killed

const EXT_KIND = {
  '.mmd': 'mermaid', '.mermaid': 'mermaid',
  '.puml': 'plantuml', '.plantuml': 'plantuml', '.pu': 'plantuml', '.iuml': 'plantuml',
  '.dsl': 'structurizr',
  '.dot': 'graphviz', '.gv': 'graphviz',
  '.drawio': 'drawio',
  '.excalidraw': 'excalidraw',
  '.adoc': 'asciidoc', '.asciidoc': 'asciidoc', '.rst': 'rst',
};
const DIAGRAM_EXTS = Object.keys(EXT_KIND);
const KIND_LABEL = { mermaid: 'Mermaid', plantuml: 'PlantUML', structurizr: 'C4 model (Structurizr)', graphviz: 'Graphviz', drawio: 'draw.io', excalidraw: 'Excalidraw' };
const FENCE_LANG = { mermaid: 'mermaid', plantuml: 'plantuml', structurizr: 'structurizr', graphviz: 'dot' };

// The kind of diagram a file is, from its name; null for anything else.
function diagramKind(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (n.endsWith('.drawio.xml')) return 'drawio';
  const i = n.lastIndexOf('.');
  return i < 0 ? null : (EXT_KIND[n.slice(i)] || null);
}

// ---------------------------------------------------------------------------------------------------
// The time budget. A parser calls tick() in its loops; when the deadline has passed it throws OutOfTime,
// which only the entry points catch (they never let it out).

class OutOfTime extends Error {}
let deadline = Infinity;
let ticks = 0;
function tick() { if ((++ticks & 7) === 0 && performance.now() > deadline) throw new OutOfTime('time'); }
function withBudget(ms, fn) {
  const before = deadline;
  deadline = Math.min(before, performance.now() + ms);
  try { return fn(); } finally { deadline = before; }
}

// ---------------------------------------------------------------------------------------------------
// Small helpers

const fmt = (n) => n.toLocaleString('en-GB');
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
// Whitespace is collapsed only in the part that can survive the clip (a 5 MB label is not scanned for it).
const tidy = (s, max = 300) => {
  s = String(s == null ? '' : s);
  const keep = max * 8 + 256;
  return clip((s.length > keep ? s.slice(0, keep) : s).replace(/\s+/g, ' ').trim(), max);
};

// A line that is too long is cut at its last separator (never inside a word, so no node is invented from half
// a name); a line with no separator at all in its second half is not a diagram statement and is dropped.
const SEPARATOR = /[\s&;,|]/;
function cutLine(s) {
  for (let k = Math.min(s.length - 1, MAX_LINE); k > MAX_LINE / 2; k--) if (SEPARATOR.test(s[k])) return s.slice(0, k);
  return '';
}
// The lines of src from `from`, cut at MAX_LINE, one at a time (a file of newlines is not an array of millions).
// Lone CRs have been turned into newlines by the caller; a CR before a newline is dropped here.
function* eachLine(src, from, model) {
  const n = src.length;
  let i = from || 0;
  for (;;) {
    let e = src.indexOf('\n', i);
    if (e < 0) e = n;
    let end = e;
    if (end > i && src.charCodeAt(end - 1) === 13) end--;
    let line;
    if (end - i > MAX_LINE) { line = cutLine(src.slice(i, i + MAX_LINE + 1)); if (model) model.said('cut'); } else line = src.slice(i, end);
    tick();
    yield line;
    if (e >= n) return;
    i = e + 1;
  }
}
const stripComment = (line) => { const k = line.indexOf('%%'); return (k < 0 ? line : line.slice(0, k)).trim(); };
const normaliseLines = (t) => (t.indexOf('\r') >= 0 ? t.replace(/\r\n?/g, '\n') : t);

const ENT = Object.assign(Object.create(null), { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    const v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function unquote(s) {
  const m = /^(["'`])([\s\S]*)\1$/.exec(String(s).trim());
  return m ? m[2] : String(s).trim();
}

// A label is cleaned of credentials before it is cut to its length: cut first, a private key would lose its END line.
function shortLabel(t) {
  const whole = tidy(t, 4000);
  return clip(whole.length > 300 ? redactSecrets(whole).text : whole, 300);
}

// A label as drawn: line breaks and markup removed, entities decoded, quotes taken off.
function plain(s) {
  let t = String(s == null ? '' : s);
  if (t.length > 4000) t = t.slice(0, 4000);
  if (!/[<\\#&"'`]/.test(t)) return shortLabel(t);       // nothing to take off: the usual label
  t = t.replace(/<br\s*\/?>/gi, ' ').replace(/\\n/g, ' ');
  t = t.replace(/<<\s*([^<>]{1,80}?)\s*>>/g, '$1').replace(/<\/?[A-Za-z][^<>]{0,200}>/g, '');   // <<stereotype>> keeps its word
  t = t.replace(/#(\d{1,6});/g, '&#$1;').replace(/#([a-z]{2,6});/g, '&$1;');   // Mermaid's #quot; style
  t = decodeEntities(t);
  t = unquote(unquote(t));
  return shortLabel(t);
}

// Index of the first unquoted ")" at or after i, and the arguments in between.
function parseArgs(s, i) {
  const args = [];
  let cur = '', q = null, quoted = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === q) q = null; else cur += ch;
      continue;
    }
    if (ch === '"' || (ch === "'" && !cur.trim())) { q = ch; quoted = true; continue; }
    if (ch === ',') { args.push(cur.trim()); cur = ''; continue; }
    if (ch === ')') { args.push(cur.trim()); return { args, end: i + 1, quoted }; }
    cur += ch;
  }
  args.push(cur.trim());
  return { args, end: s.length, quoted };
}

// The groups an element sits in, as one short string that is kept up to date as groups open and close. Only
// MAX_DEPTH levels are told apart: deeper ones are counted (so that closing them works) and belong to the last.
class Groups {
  constructor() { this.titles = []; this.over = 0; this.path = ''; this.last = ''; }
  push(title) {
    if (this.titles.length >= MAX_DEPTH) { this.over++; return; }
    this.titles.push(tidy(title, 100));
    this._sync();
  }
  pop() {
    if (this.over) this.over--; else this.titles.pop();
    this._sync();
  }
  _sync() { this.path = this.titles.join(' > '); this.last = this.titles.length ? this.titles[this.titles.length - 1] : ''; }
}

// ---------------------------------------------------------------------------------------------------
// The model every format is read into

const SAYINGS = {
  cut: `(line truncated: a line longer than ${fmt(MAX_LINE)} characters is read only as far as its last separator.)`,
  components: `(This diagram is larger than Understudy reads in full: the first ${fmt(MAX_ITEMS)} components are listed.)`,
  connections: `(This diagram is larger than Understudy reads in full: the first ${fmt(MAX_ITEMS)} connections are listed.)`,
  wide: `(Some statements join more than ${MAX_FAN} pairs at once: only the first ${MAX_FAN} pairs of each are listed.)`,
  labels: `(Some connections have more than ${MAX_EDGE_LABELS} label shapes: only the first ${MAX_EDGE_LABELS} are used.)`,
  inflated: '(Some pages are larger than Understudy opens in full: they are not listed.)',
  pages: `(This file has more than ${MAX_PAGES} pages: only the first ${MAX_PAGES} are read.)`,
  size: '(This diagram is larger than Understudy reads in full: only the first part of it is listed.)',
};

class Model {
  constructor() {
    this.comps = new Map();        // id -> { id, name, type, tech, desc, group }
    this.links = [];               // { from, to, label, tech, dir: '->' | '<->' | '--' }
    this.notes = [];
    this.groupTitles = new Map();  // id of a group -> its title, for edges that point at a group
    this.sayings = new Set();      // keys of SAYINGS: limits that were hit while reading
  }

  said(key) { this.sayings.add(key); }
  group(id, title) { if (id && (this.groupTitles.size < MAX_ITEMS || this.groupTitles.has(id))) this.groupTitles.set(id, title); }

  node(id, p = {}) {
    id = tidy(id, 200);
    if (!id) return null;
    let c = this.comps.get(id);
    if (!c) {
      if (this.comps.size >= MAX_ITEMS) { this.said('components'); return { id, name: id, type: '', tech: '', desc: '', group: '' }; }
      const title = this.groupTitles.get(id);
      c = { id, name: title || '', type: title ? 'group' : '', tech: '', desc: '', group: '' };
      this.comps.set(id, c);
    }
    if (p.name) c.name = tidy(p.name, 200);                       // a later label wins
    if (p.type && !c.type) c.type = tidy(p.type, 80);
    if (p.tech && !c.tech) c.tech = tidy(p.tech, 120);
    if (p.desc && !c.desc) c.desc = tidy(p.desc, 400);
    if (p.group && !c.group) c.group = tidy(p.group, 300);
    return c;
  }

  link(from, to, p = {}) {
    const a = this.node(from), b = this.node(to);
    if (!a || !b) return;
    if (this.links.length >= MAX_ITEMS) { this.said('connections'); return; }
    this.links.push({ from: a.id, to: b.id, label: tidy(p.label || '', 300), tech: tidy(p.tech || '', 120), dir: p.dir || '->' });
  }

  nameOf(id) { const c = this.comps.get(id); return (c && c.name) || id; }
  get empty() { return !this.comps.size && !this.links.length && !this.notes.length; }
}

// A name that holds an arrow or a colon would read as an extra hop or as the start of a description, so it is quoted.
const NEEDS_QUOTE = /->|<-|--|=>|:/;
const nameText = (s) => (NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, "'")}"` : s);

function componentLine(c) {
  const bits = [c.type, c.tech, c.group ? `in ${c.group}` : ''].filter(Boolean);
  return `- ${nameText(c.name || c.id)}${bits.length ? ` (${bits.join(', ')})` : ''}${c.desc ? `: ${c.desc}` : ''}`;
}
function connectionLine(model, l) {
  const arrow = l.dir === '<->' ? '<->' : l.dir === '--' ? '--' : '->';
  return `- ${nameText(model.nameOf(l.from))} ${arrow} ${nameText(model.nameOf(l.to))}${l.label ? `: ${l.label}` : ''}${l.tech ? ` (${l.tech})` : ''}`;
}

// The Components and Connections lists, in source order, without exact repeats, and at most maxChars long
// (components may use half of it, so that connections are never crowded out).
// onlyNamed: leave out components that say nothing the connections do not (for lists added to a Markdown file).
function listsOf(model, { onlyNamed = false, maxChars = Infinity } = {}) {
  const components = [], connections = [];
  const seen = new Set();
  let used = 0, trimmed = false;
  const take = (line, into, cap) => {
    if (seen.has(line)) return true;
    if (used + line.length + 1 > cap) { trimmed = true; return false; }
    seen.add(line); used += line.length + 1; into.push(line);
    return true;
  };
  for (const c of model.comps.values()) {
    if (onlyNamed && !((c.name && c.name !== c.id) || c.group || c.desc || c.tech)) continue;
    if (!take(componentLine(c), components, maxChars / 2)) break;
  }
  for (const l of model.links) if (!take(connectionLine(model, l), connections, maxChars)) break;
  return { components, connections, trimmed };
}

const sayingLines = (model) => [...model.sayings].map((k) => SAYINGS[k]).filter(Boolean);

// Said once above a list of connections. It also puts everyday words (talks to, calls, sends to, depends on) in
// the passage, so a question in those words finds a diagram even though the diagram never says them.
const LEAD = 'What each part talks to, calls, sends to or depends on:';

function fenceBlock(text, lang) {
  let longest = 2;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(longest + 1);
  return `${f}${lang || ''}\n${text.trimEnd()}\n${f}`;
}

const outputCap = (inputLength) => Math.min(OUT_MAX, Math.max(OUT_MIN, inputLength * OUT_FACTOR));

// sections: [{ title: string|null, model }]. A single untitled section is the common case.
// notes: plain lines said under the heading (why the lists are missing or short). inputLength sets the output limit.
function buildMarkdown({ name, label, sections, source, lang, notes = [], inputLength = 0 }) {
  const out = [`# ${tidy(name, 200) || 'Diagram'}`, '', `Architecture diagram (${label}).`, ''];
  if (notes.length) out.push(...notes, '');
  const shown = source == null ? '' : (source.length > MAX_SOURCE_SHOWN ? `${source.slice(0, MAX_SOURCE_SHOWN)}\n(the rest of the source is not shown)` : source);
  let room = Math.max(4096, outputCap(inputLength || (source ? source.length : 0)) - shown.length);
  const multi = sections.length > 1 || (sections[0] && sections[0].title != null);
  let trimmed = false;
  for (const s of sections) {
    const { components, connections, trimmed: t } = listsOf(s.model, { maxChars: room });
    room -= components.reduce((n, l) => n + l.length + 1, 0) + connections.reduce((n, l) => n + l.length + 1, 0);
    if (t) { trimmed = true; room = 0; }
    if (multi) out.push(`## ${tidy(s.title, 120) || 'Diagram'}`, '');
    const h = multi ? '###' : '##';
    if (components.length) out.push(`${h} Components`, ...components, '');
    if (connections.length) out.push(`${h} Connections`, LEAD, ...connections, '');
    if (s.model.notes.length) out.push(`${h} Notes`, ...s.model.notes.map((n) => `- ${n}`), '');
    const say = sayingLines(s.model);
    if (say.length) out.push(...say, '');
  }
  if (trimmed) out.push('(This diagram is larger than Understudy reads in full: the lists above are cut where the output limit was reached.)', '');
  if (source != null) out.push('## Source', '', fenceBlock(shown, lang), '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// C4 macros: the same set in C4-PlantUML and in Mermaid's C4 diagrams

function c4Line(line, model, groups) {
  const m = /^\s*([A-Za-z][A-Za-z_]*)\s*\(/.exec(line);
  if (!m) return false;
  const name = m[1];
  const parsed = parseArgs(line, m[0].length);
  const named = {};
  const args = [];
  for (const a of parsed.args) {
    const nm = /^\$(\w+)\s*=\s*([\s\S]*)$/.exec(a);
    if (nm) named[nm[1].toLowerCase()] = nm[2]; else args.push(a);
  }
  const rest = line.slice(parsed.end).trimEnd();
  const opens = rest.endsWith('{');
  const group = groups.path;
  let k;
  if ((k = /^(Person|System|Container|Component)(Db|Queue)?(_Ext)?$/.exec(name))) {
    const base = k[1].toLowerCase();
    const type = `${k[3] ? 'external ' : ''}${base === 'system' ? 'software system' : base}${k[2] === 'Db' ? ' database' : k[2] === 'Queue' ? ' queue' : ''}`;
    const tech = base === 'container' || base === 'component';
    model.node(args[0], {
      name: plain(args[1] || args[0]), type,
      tech: tech ? plain(named.techn || args[2] || '') : '',
      desc: plain(named.descr || (tech ? args[3] : args[2]) || ''),
      group,
    });
    return true;
  }
  if ((k = /^(?:\w+_)?Boundary$|^(Deployment_)?Node(?:_[LR])?$/.exec(name))) {
    const title = plain(args[1] || args[0]);
    if (args[0]) model.group(tidy(args[0], 200), title);
    if (opens) groups.push(title);
    return true;
  }
  if ((k = /^(Rel|BiRel|RelIndex)(?:_(U|Up|D|Down|L|Left|R|Right|Back|Neighbor))?$/.exec(name))) {
    if (k[1] === 'RelIndex') args.shift();
    let [from, to, label, tech] = args;
    tech = named.techn || tech || '';
    label = named.descr && !label ? named.descr : label;
    if (k[2] === 'Back') [from, to] = [to, from];
    model.link(from, to, { label: plain(label || ''), tech: plain(tech), dir: k[1] === 'BiRel' ? '<->' : '->' });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Mermaid

const MM_ID = /[\w¡-￿]+(?:-[\w¡-￿]+)*/y;
// Node shapes: opening mark, closing marks. Longest openings first.
const MM_SHAPES = [
  ['(((', [')))']], ['((', ['))']], ['([', ['])']], ['[(', [')]']], ['[[', [']]']], ['{{', ['}}']],
  ['[/', ['/]', '\\]']], ['[\\', ['\\]', '/]']], ['[', [']']], ['(', [')']], ['{', ['}']], ['>', [']']],
];
const MM_TEXT_EDGES = [
  /^(<)?--(?![->ox])\s*(.{1,300}?)\s*(-{2,})([>ox])?/,
  /^(<)?==(?![=>ox])\s*(.{1,300}?)\s*(={2,})([>ox])?/,
  /^(<)?-\.(?![-.>])\s*(.{1,300}?)\s*(\.+-)([>ox])?/,
];
const MM_PLAIN_EDGE = /^(<)?(-{2,}|={2,}|-\.+-|~{3})(?:(>)|[ox](?=[\s|]|$))?/;
// A word that starts a statement which is not a node (direction, styling, links), but only as a whole word:
// "link-shortener --> db" and "class-service --> db" are nodes. A word that is followed by an arrow is a node too.
const MM_SKIPPED = /^(direction|classDef|class|style|linkStyle|click|accTitle|accDescr|callback|link)(?=[\s:{]|$)/;
const MM_EDGE_AHEAD = /^\s*(?:<?(?:-{2,}|={2,}|-\.|~{3})|&)/;

function mermaidFlow(lines, model) {
  const groups = new Groups();
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    const sg = /^subgraph(?=\s|$)\s*(.*)$/i.exec(line);
    if (sg && !MM_EDGE_AHEAD.test(line.slice(8))) {
      const rest = sg[1].replace(/;$/, '').trim();
      const m = /^([\w¡-￿-]+)\s*\[(.*)\]$/.exec(rest);
      const id = m ? m[1] : plain(rest), title = m ? plain(m[2]) : plain(rest);
      if (id) model.group(id, title);
      groups.push(title || id || 'group');
      continue;
    }
    if (/^end\s*;?$/i.test(line)) { groups.pop(); continue; }
    const kw = MM_SKIPPED.exec(line);
    if (kw && !MM_EDGE_AHEAD.test(line.slice(kw[1].length))) continue;
    flowStatement(line, model, groups.path);
  }
}

function flowStatement(s, model, group) {
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  const skipStatement = () => { const j = s.indexOf(';', i); i = j < 0 ? s.length : j + 1; };

  function shape() {
    for (const [open, closes] of MM_SHAPES) {
      if (!s.startsWith(open, i)) continue;
      let j = i + open.length, text;
      if (s[j] === '"') {
        const q = s.indexOf('"', j + 1);
        if (q < 0) return null;
        text = s.slice(j + 1, q); j = q + 1;
        while (s[j] === ' ') j++;
        const c = closes.find((x) => s.startsWith(x, j));
        if (!c) return null;
        j += c.length;
      } else {
        let best = -1, len = 0;
        for (const c of closes) { const k = s.indexOf(c, j); if (k >= 0 && (best < 0 || k < best)) { best = k; len = c.length; } }
        if (best < 0) return null;
        text = s.slice(j, best); j = best + len;
      }
      i = j;
      return { text: plain(text), db: open === '[(' };
    }
    return null;
  }

  function node() {
    MM_ID.lastIndex = i;
    const m = MM_ID.exec(s);
    if (!m) return null;
    const id = m[0];
    i += id.length;
    let name = '', type = '';
    const sh = shape();
    if (sh) { name = sh.text; if (sh.db) type = 'database'; }
    else if (s.startsWith('@{', i)) {
      const e = s.indexOf('}', i);
      const body = e < 0 ? s.slice(i + 2) : s.slice(i + 2, e);
      i = e < 0 ? s.length : e + 1;
      const lab = /label\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/.exec(body);
      if (lab) name = plain(lab[1]);
      if (/shape\s*:\s*(cyl|lin-cyl|h-cyl|db)\b/.test(body)) type = 'database';
    }
    const cls = /^:::[\w-]+/.exec(s.slice(i, i + 100));
    if (cls) i += cls[0].length;
    model.node(id, { name, type, group });
    return id;
  }

  function nodes() {
    const ids = [];
    for (;;) {
      ws();
      const id = node();
      if (!id) break;
      ids.push(id);
      ws();
      if (s[i] === '&') { i++; continue; }
      break;
    }
    return ids.length ? ids : null;
  }

  function edge() {
    // "I o--o J" and "M x--x N" have a head at the start too
    let lead = false;
    if ((s[i] === 'o' || s[i] === 'x') && /^(?:--|==|-\.)/.test(s.slice(i + 1, i + 3))) { lead = true; i++; }
    const rest = s.slice(i, i + 1000);
    let m, dir, label = '';
    for (const re of MM_TEXT_EDGES) {
      if ((m = re.exec(rest))) { dir = m[4] === '>' || m[4] === 'o' || m[4] === 'x' ? (m[1] || lead ? '<->' : '->') : (lead ? '<->' : '--'); label = plain(m[2]); break; }
    }
    if (!m) {
      m = MM_PLAIN_EDGE.exec(rest);
      if (!m) { if (lead) i--; return null; }
      const head = m[3] || /[ox]$/.test(m[0]);
      dir = head ? (m[1] || lead ? '<->' : '->') : '--';
    }
    i += m[0].length;
    const pipe = /^\s*\|([^|]{0,300})\|/.exec(s.slice(i, i + 400));
    if (pipe) { label = plain(pipe[1]); i += pipe[0].length; }
    return { label, dir };
  }

  let prev = null, pending = null, guard = 0;
  while (i < s.length && guard++ < 400) {
    ws();
    if (i >= s.length) break;
    if (s[i] === ';') { i++; prev = null; pending = null; continue; }
    if (prev === null || pending) {
      const next = nodes();
      if (!next) { skipStatement(); prev = null; pending = null; continue; }
      if (pending && prev) {
        let made = 0;
        for (const a of prev) for (const b of next) { if (made++ < MAX_FAN) model.link(a, b, pending); else model.said('wide'); }
      }
      prev = next; pending = null;
    } else {
      pending = edge();
      if (!pending) { skipStatement(); prev = null; }
    }
  }
}

const SEQ_SKIP = /^(?:note|loop|alt|else|opt|par|and|critical|option|break|rect|box|end|autonumber|activate|deactivate|title|links|link|properties|details|accTitle|accDescr)\b/i;
const SEQ_ARROWS = ['<<-->>', '<<->>', '-->>', '->>', '-->', '--x', '--)', '->', '-)'];

function splitSeqAs(rest) {
  let inQ = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inQ) { if (ch === '\\') i++; else if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    if (/\s/.test(ch)) {
      const m = /^\s+as\s+/i.exec(rest.slice(i));
      if (m) return { id: rest.slice(0, i).trim(), alias: rest.slice(i + m[0].length).trim() };
    }
  }
  return { id: rest.trim(), alias: '' };
}

function findSeqArrow(head) {
  let inQ = null;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (inQ) { if (ch === '\\') i++; else if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    for (const op of SEQ_ARROWS) {
      if (head.startsWith(op, i)) return { at: i, len: op.length, dir: op.startsWith('<<') ? '<->' : '->' };
    }
  }
  inQ = null;
  for (let i = 0; i < head.length - 1; i++) {
    const ch = head[i];
    if (inQ) { if (ch === '\\') i++; else if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    if (ch === '-' && head[i + 1] === 'x' && /[\s+"'A-Z_-]/.test(head[i + 2] || ' ')) {
      return { at: i, len: 2, dir: '->' };
    }
  }
  return null;
}

function mermaidSequence(lines, model) {
  for (const raw of lines) {
    let line = stripComment(raw);
    if (!line || SEQ_SKIP.test(line)) continue;
    if (/^destroy\s+/i.test(line)) {
      if (/^destroy\s+(?:participant|actor)\b/i.test(line)) line = line.replace(/^destroy\s+/i, '');
      else continue;
    } else if (/^create\s+/i.test(line)) {
      line = line.replace(/^create\s+/i, '');
    }
    const decl = /^(participant|actor)\s+(.+)$/i.exec(line);
    if (decl) {
      const cleaned = decl[2].replace(/@\{[^}]*\}/g, '').trim();
      const { id, alias } = splitSeqAs(cleaned);
      const nodeId = plain(unquote(id));
      if (nodeId) model.node(nodeId, { name: alias ? plain(unquote(alias)) : '', type: decl[1].toLowerCase() });
      continue;
    }
    let colon = -1, inQ = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '\\') i++; else if (ch === inQ) inQ = null; }
      else if (ch === '"' || ch === "'") inQ = ch;
      else if (ch === ':') { colon = i; break; }
    }
    if (colon < 0) continue;
    const head = line.slice(0, colon).trim();
    const ar = findSeqArrow(head);
    if (!ar) continue;
    const from = plain(unquote(head.slice(0, ar.at).trim()));
    const to = plain(unquote(head.slice(ar.at + ar.len).trim().replace(/^[+-]\s*/, '')));
    if (from && to) model.link(from, to, { label: plain(line.slice(colon + 1)), dir: ar.dir });
  }
}

function mermaidC4(lines, model) {
  const groups = new Groups();
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    if (line === '}') { groups.pop(); continue; }
    c4Line(line, model, groups);
  }
}

function mermaidClass(lines, model) {
  const REL = /^([\w.$~]+)\s*(?:"([^"]{0,60})"\s*)?((?:<\|?|\*|o)?(?:--|\.\.)(?:\|?>|\*|o)?)\s*(?:"([^"]{0,60})"\s*)?([\w.$~]+)\s*(?::\s*(.*))?$/;
  let depth = 0;
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    if (depth) { if (line.startsWith('}')) depth--; continue; }
    const cls = /^class\s+([\w.$~]+)(?:\s*\["?([^\]"]*)"?\])?\s*(\{)?/.exec(line);
    if (cls) { model.node(cls[1], { name: cls[2] ? plain(cls[2]) : '', type: 'class' }); if (cls[3] && !line.endsWith('}')) depth = 1; continue; }
    const m = REL.exec(line);
    if (!m) continue;
    const [, left, , op, , right, text] = m;
    const lh = /^(<\||\*|o|<)/.exec(op), rh = /(\|>|\*|o|>)$/.exec(op);
    const dotted = op.includes('..');
    let from = left, to = right, label = '', dir = '--';
    if (lh && lh[1] === '<|') { from = right; to = left; label = dotted ? 'implements' : 'inherits from'; dir = '->'; }
    else if (rh && rh[1] === '|>') { label = dotted ? 'implements' : 'inherits from'; dir = '->'; }
    else if (lh && lh[1] === '*') { label = 'is composed of'; dir = '->'; }
    else if (lh && lh[1] === 'o') { label = 'aggregates'; dir = '->'; }
    else if (rh && rh[1] === '*') { from = right; to = left; label = 'is composed of'; dir = '->'; }
    else if (rh && rh[1] === 'o') { from = right; to = left; label = 'aggregates'; dir = '->'; }
    else if (rh && rh[1] === '>') { label = dotted ? 'depends on' : 'uses'; dir = '->'; }
    else if (lh && lh[1] === '<') { from = right; to = left; label = dotted ? 'depends on' : 'uses'; dir = '->'; }
    const extra = plain(text || '');
    model.node(left, { type: 'class' }); model.node(right, { type: 'class' });
    model.link(from, to, { label: extra && label && !/^(inherits|implements|is composed|aggregates)/.test(label) ? extra : (extra && label ? `${label} (${extra})` : (label || extra)), dir });
  }
}

function mermaidEr(lines, model) {
  const REL = /^("[^"]+"|[\w.-]+)\s+([|}][|o])(--|\.\.)([|o][|{])\s+("[^"]+"|[\w.-]+)\s*:\s*(.*)$/;
  const CARD = { '||': 'exactly one', '|o': 'zero or one', 'o|': 'zero or one', '}o': 'zero or more', 'o{': 'zero or more', '}|': 'one or more', '|{': 'one or more' };
  let depth = 0;
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    if (depth) { if (line.startsWith('}')) depth = 0; continue; }
    // the whitespace is folded into the optional parts: two adjacent "\s*" with something optional between them retry each other
    const ent = /^("[^"]+"|[\w.-]+)(?:\s*\[[^\]]*\])?\s*\{(?:\s*(\}))?$/.exec(line);
    if (ent) { model.node(unquote(ent[1]), { type: 'entity' }); if (!ent[2]) depth = 1; continue; }
    const m = REL.exec(line);
    if (!m) continue;
    const a = unquote(m[1]), b = unquote(m[5]);
    model.node(a, { type: 'entity' }); model.node(b, { type: 'entity' });
    const rel = plain(m[6]);
    model.link(a, b, { label: `${rel} (${CARD[m[2]] || m[2]} ${a}, ${CARD[m[4]] || m[4]} ${b})`, dir: '->' });
  }
}

function mermaidState(lines, model) {
  const TR = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/;
  const groups = new Groups();
  // [*] is the start (or end) of whichever state it is written in: the outer one and a composite state's own are different nodes
  const id = (x, asFrom) => (x === '[*]' ? `[*] ${asFrom ? 'start' : 'end'}${groups.path ? ` in ${groups.path}` : ''}` : x);
  const label = (x, asFrom) => (x === '[*]' ? `${asFrom ? 'Start' : 'End'}${groups.last ? ` of ${groups.last}` : ''}` : '');
  for (const raw of lines) {
    const line = stripComment(raw);
    if (!line) continue;
    if (line === '}') { groups.pop(); continue; }
    let m = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)/.exec(line);
    if (m) { model.node(m[2], { name: plain(m[1]), type: 'state', group: groups.path }); continue; }
    m = /^state\s+([\w.-]+)\s*\{$/.exec(line);
    if (m) { groups.push(m[1]); continue; }
    m = TR.exec(line);
    if (!m) continue;
    const from = id(m[1], true), to = id(m[2], false);
    const g = groups.path;
    model.node(from, { name: label(m[1], true), type: 'state', group: g });
    model.node(to, { name: label(m[2], false), type: 'state', group: g });
    model.link(from, to, { label: plain(m[3] || '') });
  }
}

function parseMermaid(src) {
  const model = new Model();
  const it = eachLine(src, 0, model);
  const next = () => { const r = it.next(); return r.done ? null : r.value; };
  let line = next();
  if (line !== null && line.trim() === '---') {            // front matter
    let closed = false;
    for (let k = 0; k < 200; k++) { const l = next(); if (l === null) break; if (l.trim() === '---') { closed = true; break; } }
    if (!closed) return { model: null, label: 'Mermaid diagram' };
    line = next();
  }
  while (line !== null && (!line.trim() || /^\s*%%/.test(line))) line = next();
  const head = (line || '').trim();
  const m = /^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram(?:-v2)?|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/.exec(head);
  if (!m) return { model: null, label: 'Mermaid diagram' };
  const word = m[1];
  let label = 'Mermaid diagram';
  if (word === 'graph' || word === 'flowchart') {
    label = 'Mermaid flowchart';
    // "flowchart TD; A --> B" puts a statement on the header line
    const tail = head.slice(m[0].length).replace(/^\s*(TB|TD|BT|RL|LR)\b\s*;?/i, '').trim();
    if (tail) flowStatement(tail, model, '');
    mermaidFlow(it, model);
  } else if (word === 'sequenceDiagram') { label = 'Mermaid sequence diagram'; mermaidSequence(it, model); }
  else if (word === 'classDiagram') { label = 'Mermaid class diagram'; mermaidClass(it, model); }
  else if (word === 'erDiagram') { label = 'Mermaid entity-relationship diagram'; mermaidEr(it, model); }
  else if (word.startsWith('stateDiagram')) { label = 'Mermaid state diagram'; mermaidState(it, model); }
  else { label = 'Mermaid C4 diagram'; mermaidC4(it, model); }
  return { model, label };
}

// ---------------------------------------------------------------------------------------------------
// PlantUML (components, sequence, class, state, and the C4-PlantUML macros)

const PU_DECL = /^(actor|participant|boundary|control|entity|database|collections|queue|component|node|rectangle|package|cloud|folder|frame|artifact|storage|card|file|interface|usecase|agent|stack|hexagon|person|label|class|abstract(?:\s+class)?|enum|object|state|circle|diamond|annotation)\b\s*(.*)$/i;
const PU_BODY_KINDS = /^(class|abstract|abstract class|enum|object|annotation|entity|interface)$/i;
const PU_NAME_CHARS = /[\w.$¡-￿]+(?:(?:-|::)[\w.$¡-￿]+)*/y;
const PU_ARROW = /(<<|<\||<|\*|o(?=[-.=~])|#(?=[-.=~])|x(?=[-.=~])|\+(?=[-.=~])|\^(?=[-.=~])|\\\\|\/\/)?([-.=~]+)(\[[^\]]{0,100}\])?(?:([a-z]{2,8})(?=[-.=~]))?([-.=~]*)(>>|\|>|>|\*|o|x|#|\+|\^|\)|\\\\?|\/\/?)?/y;

// One end of an arrow, or a name in a declaration, read from s at i.
function puName(s, i) {
  const c = s[i];
  if (c === undefined) return null;
  if (c === '"') { const e = s.indexOf('"', i + 1); return e < 0 ? null : { text: tidy(s.slice(i + 1, e), 200), end: e + 1, bracket: false }; }
  if (c === '[') {
    const e = s.indexOf(']', i + 1);
    if (e < 0) return null;
    const inner = s.slice(i + 1, e);
    if (!inner.trim() || /^[-.=<>\s]/.test(inner) || inner.length > 120) return null;
    return { text: tidy(inner, 200), end: e + 1, bracket: true };
  }
  if (c === '(') {
    if (s[i + 1] === ')') { let j = i + 2; while (s[j] === ' ') j++; return puName(s, j); }   // () interface
    const e = s.indexOf(')', i + 1);
    return e < 0 || e - i > 120 ? null : { text: tidy(s.slice(i + 1, e), 200), end: e + 1, bracket: true };
  }
  if (c === ':') { const e = s.indexOf(':', i + 1); return e < 0 || e - i > 120 ? null : { text: tidy(s.slice(i + 1, e), 200), end: e + 1, bracket: true }; }
  PU_NAME_CHARS.lastIndex = i;
  const m = PU_NAME_CHARS.exec(s);
  return m ? { text: m[0], end: i + m[0].length, bracket: false } : null;
}

function parsePlantuml(src) {
  const model = new Model();
  const groups = new Groups();
  const byName = new Map();          // a declared display name -> its id
  let skipUntil = null, c4 = false;

  const idOf = (name) => (model.comps.has(name) ? name : (byName.get(name) || name));
  // [*] is the start (or end) of the state it is written in, as in Mermaid
  const endpoint = (name, asFrom) => {
    if (name.text === '*' && name.bracket) return `[*] ${asFrom ? 'start' : 'end'}${groups.path ? ` in ${groups.path}` : ''}`;
    return idOf(name.text);
  };
  const special = (id, asFrom) => (id.startsWith('[*] ') ? `${asFrom ? 'Start' : 'End'}${groups.last ? ` of ${groups.last}` : ''}` : '');

  for (const raw of eachLine(src, 0, model)) {
    const line = raw.trim();
    if (skipUntil) { if (skipUntil.test(line)) skipUntil = null; continue; }
    if (!line || line[0] === "'" || line[0] === '@' || line[0] === '!') continue;
    if (line.startsWith("/'")) { if (!line.includes("'/")) skipUntil = /'\//; continue; }
    if (/^note\b/i.test(line) && !line.includes(':')) { skipUntil = /^end\s?note$/i; continue; }
    if (/^(legend|header|footer|title|caption)\s*(?:left|right|center)?\s*$/i.test(line)) { skipUntil = /^end\s?(legend|header|footer|title|caption)$/i; continue; }
    if (/^skinparam\b.*\{\s*$/i.test(line)) { skipUntil = /^\}/; continue; }
    if (line === '}') { groups.pop(); continue; }
    if (c4Line(line, model, groups)) { c4 = true; continue; }

    // declarations: kind "Label" as id
    let m = PU_DECL.exec(line);
    if (m) {
      const kind = m[1].toLowerCase().replace(/\s+/g, ' ');
      let rest = m[2].trimEnd();
      const opens = rest.endsWith('{');
      rest = (opens ? rest.slice(0, -1) : rest).trim();
      const a = puName(rest, 0);
      if (a) {
        let name = a.text, id = a.text;
        let tail = rest.slice(a.end).trim();
        const as = /^as\s+(.+)$/i.exec(tail);
        if (as) {
          const b = puName(as[1].trim(), 0);
          if (b) {
            if (a.bracket || rest[0] === '"') { id = b.text; name = a.text; } else { id = a.text; name = b.text; }
            tail = as[1].trim().slice(b.end).trim();
          }
        }
        const st = /<<\s*([^>]{1,60}?)\s*>>/.exec(tail);
        const parent = groups.path;
        if (PU_BODY_KINDS.test(kind) && opens) skipUntil = /^}/;
        // package { } and similar only group; other things that can hold things (a node, a component) are also components
        if (!(opens && /^(package|folder|frame|rectangle)$/.test(kind))) model.node(id, { name, type: kind, tech: st ? st[1] : '', group: parent });
        if (opens && !PU_BODY_KINDS.test(kind)) { groups.push(name); model.group(id, name); }
        if (byName.size < MAX_ITEMS) byName.set(name, id);
        continue;
      }
    }

    // arrows: A -> B : label, [Comp] --> [Other] : label
    const first = puName(line, 0);
    if (!first) continue;
    let i = first.end;
    const skipWs = () => { while (line[i] === ' ' || line[i] === '\t') i++; };
    skipWs();
    if (line[i] === '"') { const e = line.indexOf('"', i + 1); if (e > 0) { i = e + 1; skipWs(); } }   // cardinality
    const as = /^as\s+(\S+)/i.exec(line.slice(i, i + 200));
    if (as && (first.bracket || line[0] === '"')) {            // [Comp] as C
      const id = tidy(unquote(as[1]), 200);
      model.node(id, { name: first.text, type: 'component', group: groups.path });
      if (byName.size < MAX_ITEMS) byName.set(first.text, id);
      continue;
    }
    PU_ARROW.lastIndex = i;
    const ar = PU_ARROW.exec(line);
    if (!ar || !ar[0].length) {
      if (i >= line.length && first.bracket) model.node(idOf(first.text), { type: 'component', group: groups.path });
      continue;
    }
    i += ar[0].length;
    if (ar[0].endsWith('>') && (line[i] === 'x' || line[i] === 'o') && /\s/.test(line[i + 1] || '')) i++;   // "A ->x B": a lost message, the x is the head
    skipWs();
    if (line[i] === '"') {              // "many" before the second end, or the second end itself
      const e = line.indexOf('"', i + 1);
      if (e > 0) {
        let j = e + 1;
        while (line[j] === ' ') j++;
        if (puName(line, j) && line[j] !== ':') i = j;
      }
    }
    const second = puName(line, i);
    if (!second) continue;
    const after = line.slice(second.end).replace(/^\s*(?:"[^"]*"\s*)?/, '');
    const lab = /^(?:<<[^>]*>>\s*)?(?::\s*(.*))?$/.exec(after);
    if (!lab) continue;
    const L = ar[1] || '', R = ar[6] || '';
    const dotted = ar[2].includes('.') || ar[5].includes('.');
    let from = endpoint(first, true), to = endpoint(second, false), label = '', dir = '--';
    if (R === '>' || R === '>>' || R === ')' || R[0] === '\\' || R[0] === '/') { dir = L === '<' || L === '<<' ? '<->' : '->'; }
    else if (R === '|>') { label = dotted ? 'implements' : 'inherits from'; dir = '->'; }
    else if (L === '<|') { [from, to] = [to, from]; label = dotted ? 'implements' : 'inherits from'; dir = '->'; }
    else if (L === '<' || L === '<<') { [from, to] = [to, from]; dir = '->'; }
    else if (R === '*' || R === '+') { [from, to] = [to, from]; label = 'contains'; dir = '->'; }
    else if (R === 'o') { [from, to] = [to, from]; label = 'aggregates'; dir = '->'; }
    else if (L === '*' || L === '+') { label = 'contains'; dir = '->'; }
    else if (L === 'o') { label = 'aggregates'; dir = '->'; }
    const text = plain(lab[1] || '');
    const g = groups.path;
    model.node(from, { name: special(from, true), group: g });
    model.node(to, { name: special(to, false), group: g });
    model.link(from, to, { label: label && text ? (/^(contains|aggregates)$/.test(label) ? text : `${label} (${text})`) : (label || text), dir });
  }
  return { model, label: c4 ? 'PlantUML C4 model' : 'PlantUML' };
}

// ---------------------------------------------------------------------------------------------------
// Structurizr DSL (C4)

const SZ_ELEMENT = /^(?:([\w.-]+)\s*=\s*)?(person|softwareSystem|container|component|deploymentNode|infrastructureNode|deploymentEnvironment|group|enterprise|softwareSystemInstance|containerInstance|deploymentGroup|workspace)\b\s*(.*)$/;
const SZ_REL = /^(?:([\w.-]+)\s*=\s*)?(?:([\w.-]+)\s*)?(->|-\/>|=>)\s*([\w.-]+)\s*(.*)$/;
const SZ_TYPE = { person: 'person', softwareSystem: 'software system', container: 'container', component: 'component', deploymentNode: 'deployment node', infrastructureNode: 'infrastructure node' };
const MAX_STACK = 1000;

// The first eight "quoted" strings of s, read once from left to right (a pattern for this retries from every
// quote when one is not closed).
function quotedArgs(s) {
  const out = [];
  let i = s.indexOf('"');
  while (i >= 0 && out.length < 8) {
    let j = i + 1, text = '';
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === '\\' && j + 1 < s.length) j++;
      text += s[j];
    }
    if (j >= s.length) break;                    // not closed: nothing after it can be read as a string
    out.push(text);
    i = s.indexOf('"', j + 1);
  }
  return out;
}

function parseStructurizr(src) {
  const model = new Model();
  const stack = [];                       // open { } blocks: { id?, label?, skip?, skipping, near, depth, path }
  let over = 0;                           // blocks opened beyond MAX_STACK
  const tail = new Map();                 // short id -> full id, for "!identifiers hierarchical"
  const rels = [];
  let hierarchical = false, inComment = false;
  const top = () => stack[stack.length - 1];
  // Everything that depends on the blocks around an element is worked out once, when the block opens.
  const push = (e) => {
    const t = top();
    e.skipping = !!e.skip || !!(t && t.skipping);
    e.near = e.id ? e : (t ? t.near : null);
    e.depth = (t ? t.depth : 0) + (e.label ? 1 : 0);
    const above = t ? t.path : '';
    e.path = e.label && e.depth <= MAX_DEPTH ? (above ? `${above} > ${tidy(e.label, 100)}` : tidy(e.label, 100)) : above;
    if (stack.length >= MAX_STACK) over++; else stack.push(e);
  };
  const pop = () => { if (over) over--; else stack.pop(); };
  const path = () => (top() ? top().path : '');
  const nearest = () => (top() ? top().near : null);

  for (const raw of eachLine(src, 0, model)) {
    const line = raw.trim();
    if (inComment) { if (line.includes('*/')) inComment = false; continue; }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inComment = true; continue; }
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    if (line === '}') { pop(); continue; }
    if (/^!identifiers\s+hierarchical/i.test(line)) { hierarchical = true; continue; }
    const opens = line.endsWith('{') && !(line.includes('}') && line.indexOf('}') < line.lastIndexOf('{'));
    const body = opens ? line.slice(0, -1).trim() : line;
    if (top() && top().skipping) { if (opens) push({ skip: true }); continue; }
    if (line[0] === '!') { if (opens) push({}); continue; }
    if (/^(views|configuration)$/.test(body)) { push({ skip: true }); continue; }

    let m = SZ_ELEMENT.exec(body);
    if (m) {
      const [, ident, kind, restText] = m;
      const args = quotedArgs(restText);
      if (kind === 'group' || kind === 'enterprise' || kind === 'deploymentEnvironment') { if (opens) push({ label: args[0] || '' }); continue; }
      if (!SZ_TYPE[kind]) { if (opens) push({}); continue; }       // workspace, instances
      const name = args[0] || ident || '';
      const id = ident || name;
      const parent = nearest();
      const full = hierarchical && parent && ident ? `${parent.id}.${id}` : id;
      const hasTech = kind !== 'person' && kind !== 'softwareSystem';
      model.node(full, { name, type: SZ_TYPE[kind], tech: hasTech ? args[2] : '', desc: args[1], group: path() });
      if (!tail.has(id) && tail.size < MAX_ITEMS) tail.set(id, full);
      if (opens) push({ id: full, label: name });
      continue;
    }
    m = SZ_REL.exec(body);
    if (m) {
      const owner = nearest();
      const from = m[2] === 'this' || !m[2] ? (owner && owner.id) : m[2];
      const args = quotedArgs(m[5]);
      if (from) { if (rels.length < MAX_ITEMS) rels.push({ from, to: m[4], label: args[0], tech: args[1] }); else model.said('connections'); }
      if (opens) push({});
      continue;
    }
    const t = top();
    const prop = /^(description|technology)\s+"((?:[^"\\]|\\.)*)"/.exec(body);
    if (prop && t && t.id) {
      const c = model.comps.get(t.id);
      if (c) { if (prop[1] === 'description') c.desc = c.desc || tidy(prop[2], 400); else c.tech = c.tech || tidy(prop[2], 120); }
      continue;
    }
    if (opens) push({});
  }
  const ref = (r) => (model.comps.has(r) ? r : (tail.get(r) || r));
  for (const r of rels) model.link(ref(r.from), ref(r.to), { label: plain(r.label || ''), tech: plain(r.tech || ''), dir: '->' });
  return { model, label: KIND_LABEL.structurizr };
}

// ---------------------------------------------------------------------------------------------------
// Graphviz (DOT)

function dotTokens(s) {
  const toks = [];
  const n = s.length;
  let i = 0;
  const isId = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '.' || c > '\u007f';
  while (i < n) {
    if (toks.length >= MAX_TOKENS) { toks.capped = true; break; }
    tick();
    const c = s[i];
    if (c <= ' ') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '#' && (i === 0 || s[i - 1] === '\n')) { const e = s.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '"') {
      let j = i + 1, out = '';
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < n) {
          const x = s[j + 1];
          if (x === 'n' || x === 'l' || x === 'r') out += ' ';
          else if (x === '\n') { /* line continuation */ } else if (x === '"' || x === '\\') out += x;
          else out += `\\${x}`;
          j += 2;
          continue;
        }
        if (out.length < 2000) out += s[j];
        j++;
      }
      toks.push({ v: out, q: true });
      i = j + 1;
      continue;
    }
    if (c === '<') {
      let depth = 0, j = i;
      const stop = Math.min(n, i + 200000);          // a label that is not closed in 200,000 characters is cut there
      for (; j < stop; j++) { if (s[j] === '<') depth++; else if (s[j] === '>' && --depth === 0) break; }
      toks.push({ v: plain(s.slice(i + 1, Math.min(j, i + 4000))), q: true, html: true });
      i = j + 1;
      continue;
    }
    if (c === '-' && (s[i + 1] === '>' || s[i + 1] === '-')) { toks.push({ p: s.slice(i, i + 2) }); i += 2; continue; }
    if ('{}[];,=:'.includes(c)) { toks.push({ p: c }); i++; continue; }
    let j = i;
    while (j < n && isId(s[j])) j++;
    if (j === i) { i++; continue; }
    toks.push({ v: s.slice(i, j) });
    i = j;
  }
  return toks;
}

function parseGraphviz(src) {
  const model = new Model();
  const toks = dotTokens(src);
  if (toks.capped) model.said('size');
  const isP = (t, c) => !!t && t.p === c;
  const kw = (t, w) => !!t && t.v !== undefined && !t.q && t.v.toLowerCase() === w;
  const scopeOf = new Map();                  // node id -> the scope it first appeared in
  let p = 0, directed = true;

  // The path of clusters a scope sits in, worked out once per scope (from the nearest one that has it), a
  // level at a time and without recursion, and kept to MAX_DEPTH named levels. It is read at the end, when
  // every label is known.
  const pathOf = (sc) => {
    const chain = [];
    let s = sc;
    while (s && s.path === undefined) { chain.push(s); s = s.parent; }
    let base = s ? s.path : '', depth = s ? s.depth : 0;
    for (let k = chain.length - 1; k >= 0; k--) {
      const c = chain[k];
      if (c.cluster) {
        const name = tidy(c.label || c.id.replace(/^cluster[_-]?/i, ''), 100);
        if (name && depth < MAX_DEPTH) { base = base ? `${base} > ${name}` : name; depth++; }
      }
      c.path = base; c.depth = depth;
    }
    return base;
  };
  const labelText = (v, attrs) => {
    v = v || '';
    if (v === '\\N') return '';
    if (attrs && /record/i.test(attrs.shape || '')) v = v.replace(/[{}]/g, '').replace(/\|/g, ' / ');
    return plain(v);
  };
  function readAttrs(at) {          // toks[at] is "["; returns the attributes of every [ ... ] that follows
    const attrs = {};
    let q = at;
    while (isP(toks[q], '[')) {
      q++;
      while (q < toks.length && !isP(toks[q], ']')) {
        tick();
        const k = toks[q];
        if (k.v !== undefined && isP(toks[q + 1], '=') && toks[q + 2] && toks[q + 2].v !== undefined) { attrs[k.v.toLowerCase()] = toks[q + 2].v; q += 3; } else q++;
      }
      q++;
    }
    return { attrs, end: q };
  }

  while (p < toks.length) {
    // header: [strict] (graph | digraph) [id] {
    while (p < toks.length && !isP(toks[p], '{')) { if (kw(toks[p], 'graph')) directed = false; else if (kw(toks[p], 'digraph')) directed = true; p++; }
    if (p >= toks.length) break;
    p++;
    const stack = [{ cluster: false, parent: null, label: '', id: '' }];
    const cur = () => stack[stack.length - 1];
    const touch = (id, props) => { if (!scopeOf.has(id) && scopeOf.size < MAX_ITEMS) scopeOf.set(id, cur()); return model.node(id, props || {}); };

    function endpoint() {            // one node, or a { ... } / subgraph set of nodes
      let t = toks[p];
      if (kw(t, 'subgraph')) { p++; if (toks[p] && toks[p].v !== undefined) p++; t = toks[p]; if (!isP(t, '{')) return []; }
      if (isP(t, '{')) {
        const ids = [];
        let depth = 0;
        for (; p < toks.length; p++) {
          tick();
          const x = toks[p];
          if (isP(x, '{')) depth++;
          else if (isP(x, '}')) { if (--depth === 0) { p++; break; } }
          else if (x.v !== undefined && isP(toks[p + 1], '=')) p += 2;
          else if (x.v !== undefined && !(kw(x, 'subgraph') || kw(x, 'node') || kw(x, 'edge') || kw(x, 'graph'))) ids.push(x.v);
        }
        return ids;
      }
      if (t && t.v !== undefined) {
        p++;
        while (isP(toks[p], ':') && toks[p + 1] && toks[p + 1].v !== undefined) p += 2;   // port and compass point
        return [t.v];
      }
      return null;
    }

    while (p < toks.length && stack.length) {
      tick();
      const t = toks[p];
      if (isP(t, '}')) { stack.pop(); p++; continue; }
      if (isP(t, ';') || isP(t, ',')) { p++; continue; }
      if (isP(t, '{')) { stack.push({ cluster: false, parent: cur(), label: '', id: '' }); p++; continue; }
      if (kw(t, 'subgraph')) {
        let q = p + 1, id = '';
        if (toks[q] && toks[q].v !== undefined) { id = toks[q].v; q++; }
        if (isP(toks[q], '{')) { stack.push({ cluster: /^cluster/i.test(id), parent: cur(), label: '', id }); p = q + 1; } else p = q;
        continue;
      }
      if ((kw(t, 'graph') || kw(t, 'node') || kw(t, 'edge')) && isP(toks[p + 1], '[')) {
        const r = readAttrs(p + 1);
        if (kw(t, 'graph') && r.attrs.label && stack.length > 1) cur().label = labelText(r.attrs.label);
        p = r.end;
        continue;
      }
      if (t.v !== undefined && isP(toks[p + 1], '=')) {
        if (t.v === 'label' && toks[p + 2] && toks[p + 2].v !== undefined && stack.length > 1) cur().label = labelText(toks[p + 2].v);
        p += 3;
        continue;
      }
      const first = endpoint();
      if (!first) { p++; continue; }
      const sets = [first];
      while (isP(toks[p], '->') || isP(toks[p], '--')) {
        tick();
        p++;
        const next = endpoint();
        if (!next) break;
        sets.push(next);
      }
      let attrs = {};
      if (isP(toks[p], '[')) { const r = readAttrs(p); attrs = r.attrs; p = r.end; }
      if (sets.length === 1) {
        const name = labelText(attrs.label || attrs.xlabel, attrs);
        for (const id of first) touch(id, { name, type: /^cylinder$/i.test(attrs.shape || '') ? 'database' : '' });
        continue;
      }
      let dir = directed ? '->' : '--', swap = false;
      const d = (attrs.dir || '').toLowerCase();
      if (d === 'none' || (directed && /^none$/i.test(attrs.arrowhead || ''))) dir = '--';
      else if (d === 'both') dir = '<->';
      else if (d === 'back') swap = true;
      else if (d === 'forward') dir = '->';
      const label = labelText(attrs.label || attrs.xlabel, {});
      for (let k = 0; k + 1 < sets.length; k++) {
        let made = 0;
        for (const a of sets[k]) {
          for (const b of sets[k + 1]) {
            if (made++ >= MAX_FAN) { model.said('wide'); break; }
            touch(a); touch(b);
            if (swap) model.link(b, a, { label, dir }); else model.link(a, b, { label, dir });
          }
        }
      }
    }
  }
  for (const [id, sc] of scopeOf) { const c = model.comps.get(id); if (c && !c.group) c.group = pathOf(sc); }
  return { model, label: KIND_LABEL.graphviz };
}

// ---------------------------------------------------------------------------------------------------
// draw.io / diagrams.net (plain XML, or a page compressed as base64 -> raw deflate -> URL-encoded XML)

// A tag is read by hand, in one pass: its name, then attributes (a name, and = "value" or = 'value'), then ">" or
// "/>". A tag that does not end properly is skipped from its "<", and a quote that is never closed is
// remembered, so that a file of "<a b=" repeated is not searched to its end once per tag.
const XML_NAME = /[A-Za-z_][\w:.-]*/y;
const XML_ATTR = /[\w:.-]+/y;
const MAX_ATTR_RAW = 24000;          // characters of one attribute value that are looked at
const MAX_ATTRS = 200;
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const noQuote = { '"': false, "'": false };

function readTag(xml, lt) {
  const n = xml.length;
  let p = lt + 1;
  const close = xml.charCodeAt(p) === 47;
  if (close) p++;
  XML_NAME.lastIndex = p;
  const nm = XML_NAME.exec(xml);
  if (!nm) return null;
  p += nm[0].length;
  const attrs = {};                                // (a plain object is much faster than a bare one; an attribute called __proto__ is ignored by it)
  let count = 0;
  for (;;) {
    let q = p;
    while (q < n && isSpace(xml.charCodeAt(q))) q++;
    const c = xml[q];
    if (c === '>') return { close, name: nm[0], attrs, self: false, end: q + 1 };
    if (c === '/' && xml[q + 1] === '>') return { close, name: nm[0], attrs, self: true, end: q + 2 };
    if (q === p) return null;                       // an attribute needs a space before it
    XML_ATTR.lastIndex = q;
    const an = XML_ATTR.exec(xml);
    if (!an) return null;
    p = q + an[0].length;
    let r = p;
    while (r < n && isSpace(xml.charCodeAt(r))) r++;
    if (xml[r] !== '=') continue;                   // an attribute with no value
    r++;
    while (r < n && isSpace(xml.charCodeAt(r))) r++;
    const quote = xml[r];
    if (quote !== '"' && quote !== "'") return null;
    if (noQuote[quote]) return null;
    const e = xml.indexOf(quote, r + 1);
    if (e < 0) { noQuote[quote] = true; return null; }
    if (count < MAX_ATTRS) { const raw = xml.slice(r + 1, Math.min(e, r + 1 + MAX_ATTR_RAW)); attrs[an[0]] = raw.indexOf('&') < 0 ? raw : decodeEntities(raw); count++; }
    p = e + 1;
  }
}

function* xmlTags(xml) {
  noQuote['"'] = false; noQuote["'"] = false;
  let i = 0;
  while ((i = xml.indexOf('<', i)) >= 0) {
    tick();
    const t = readTag(xml, i);
    if (t) { yield t; i = t.end; } else i++;
  }
}

// What a label is made of depends on the cell: a cell whose style says html=1 holds HTML (tags are removed), any
// other holds plain text, in which "<" and ">" are characters ("Queue<Message>").
function cellText(v, html) {
  let t = String(v == null ? '' : v);
  if (t.length > 4000) t = t.slice(0, 4000);
  if (html) {
    t = t.replace(/<\s*(?:br|\/div|\/p|\/li|\/tr|\/h\d)\s*\/?>/gi, ' ');
    t = t.replace(/<\/?[A-Za-z][^<>]{0,300}>/g, '');
    t = decodeEntities(t);
  }
  return shortLabel(t);
}

function drawioPages(text) {
  const pages = [];
  let more = false, i = 0;
  noQuote['"'] = false; noQuote["'"] = false;
  while ((i = text.indexOf('<diagram', i)) >= 0) {
    tick();
    if (/[\w:.-]/.test(text[i + 8] || ' ')) { i += 8; continue; }              // <diagrams ...>
    const t = readTag(text, i);
    if (!t) { i += 8; continue; }
    if (pages.length >= MAX_PAGES) { more = true; break; }
    i = t.end;
    if (t.self) continue;
    const end = text.indexOf('</diagram>', i);
    const body = text.slice(i, end < 0 ? text.length : end).trim();
    i = end < 0 ? text.length : end;
    pages.push({ name: tidy(t.attrs.name || '', 120), body });
  }
  if (!pages.length && /<mxGraphModel\b/.test(text)) pages.push({ name: '', body: text });
  return { pages, more };
}

// ctx.inflated counts what has been inflated so far in this FILE: every page draws on the same allowance.
function drawioXml(body, ctx) {
  if (!body) return '';
  if (body[0] === '<') return body;
  const room = ctx.maxInflated - ctx.inflated;
  if (room <= 0) { const e = new Error('too large'); e.code = 'ERR_BUFFER_TOO_LARGE'; throw e; }
  const buf = zlib.inflateRawSync(Buffer.from(body.replace(/\s+/g, ''), 'base64'), { maxOutputLength: room });
  ctx.inflated += buf.length;
  const raw = buf.toString('utf8');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

const NO_STYLE = Object.freeze({});
function drawioStyle(style) {
  if (!style) return NO_STYLE;
  const out = {};
  for (const part of String(style || '').slice(0, 5000).split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i)] = part.slice(i + 1); }
  return out;
}

function drawioModel(xml) {
  const cells = [];
  let pending = null;                       // the <object> / <UserObject> whose <mxCell> comes next
  // An <object> may name its own attributes in its label: label="%name%" placeholders="1" name="Payment Service".
  const fill = (o, v) => (o.placeholders === '1' && typeof v === 'string' ? v.replace(/%([\w.:-]{1,60})%/g, (m, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : m)) : v);
  for (const t of xmlTags(xml)) {
    if (t.name === 'object' || t.name === 'UserObject') {
      if (t.close) pending = null;
      else if (t.self) cells.push({ id: t.attrs.id, value: fill(t.attrs, t.attrs.label !== undefined ? t.attrs.label : t.attrs.value), style: '', parent: '' });
      else pending = t.attrs;
      continue;
    }
    if (t.name !== 'mxCell' || t.close) continue;
    const a = t.attrs;
    if (pending) { a.value = fill(pending, pending.label !== undefined ? pending.label : (pending.value !== undefined ? pending.value : a.value)); a.id = pending.id || a.id; pending = null; }
    if (a.id !== undefined && cells.length < 200000) cells.push(a);
  }
  const byId = new Map(cells.map((c) => [c.id, c]));
  const isVertex = (c) => c && c.vertex === '1';
  const isEdge = (c) => c && c.edge === '1';
  const styles = new Map(), labels = new Map();
  const styleOf = (c) => { let s = styles.get(c); if (!s) { s = drawioStyle(c.style); styles.set(c, s); } return s; };
  const labelOf = (c) => { let l = labels.get(c); if (l === undefined) { l = cellText(c.value, styleOf(c).html === '1'); labels.set(c, l); } return l; };
  const parentOf = (c) => byId.get(c.parent);

  const edgeLabels = new Map();             // edge id -> label cells attached to it
  const holders = new Set();                // cells that contain other drawn things
  for (const c of cells) {
    tick();
    const par = parentOf(c);
    if (isVertex(c) && isEdge(par)) {
      const l = labelOf(c);
      if (l) { const have = edgeLabels.get(par.id); if (!have) edgeLabels.set(par.id, [l]); else if (have.length < MAX_EDGE_LABELS) have.push(l); }
    } else if (isVertex(c) && isVertex(par)) holders.add(par.id);
  }
  const groupPath = (c) => {
    const names = [];
    for (let p = parentOf(c), n = 0; p && isVertex(p) && n < MAX_DEPTH; p = parentOf(p), n++) { const l = labelOf(p); if (l) names.unshift(l); }
    return names.join(' > ');
  };
  const typeOf = (c) => {
    const shape = String(styleOf(c).shape || '').toLowerCase();
    if (/^cylinder/.test(shape) || /database/.test(shape)) return 'database';
    if (/actor/.test(shape)) return 'actor';
    if (/^cloud/.test(shape)) return 'cloud';
    if (/queue/.test(shape)) return 'queue';
    return '';
  };

  const model = new Model();
  for (const c of cells) {
    tick();
    if (!isVertex(c) || isEdge(parentOf(c))) continue;
    const l = labelOf(c);
    if (!l) continue;
    model.node(c.id, { name: l, type: holders.has(c.id) ? 'group' : typeOf(c), group: groupPath(c) });
  }
  for (const c of cells) {
    tick();
    if (!isEdge(c) || !c.source || !c.target) continue;
    const s = byId.get(c.source), t = byId.get(c.target);
    if (!isVertex(s) || !isVertex(t)) continue;
    for (const end of [s, t]) if (!model.comps.has(end.id)) model.node(end.id, { name: labelOf(end) || `unlabelled ${typeOf(end) || 'shape'}`, group: groupPath(end) });
    const st = styleOf(c);
    const head = st.endArrow !== 'none', tailHead = !!st.startArrow && st.startArrow !== 'none';
    const extra = edgeLabels.get(c.id) || [];
    if (extra.length >= MAX_EDGE_LABELS) model.said('labels');
    const label = [labelOf(c), ...extra].filter(Boolean).join(' ');
    if (head && tailHead) model.link(s.id, t.id, { label, dir: '<->' });
    else if (head) model.link(s.id, t.id, { label, dir: '->' });
    else if (tailHead) model.link(t.id, s.id, { label, dir: '->' });
    else model.link(s.id, t.id, { label, dir: '--' });
  }
  return model;
}

function parseDrawio(text, ctx) {
  const fail = (why) => ({ error: why || 'could not be read as draw.io' });
  noQuote['"'] = false; noQuote["'"] = false;
  const { pages, more } = drawioPages(text);
  if (!pages.length) return fail();
  const sections = [];
  let problem = '', skippedBig = false;
  for (let i = 0; i < pages.length; i++) {
    tick();
    try {
      const xml = drawioXml(pages[i].body, ctx);
      if (!xml) continue;
      if (!/<mxGraphModel\b|<mxCell\b/.test(xml)) { problem = problem || 'could not be read as draw.io'; continue; }
      const model = drawioModel(xml);
      if (more) model.said('pages');
      sections.push({ title: pages.length > 1 ? (pages[i].name || `Page ${i + 1}`) : null, model });
    } catch (e) {
      if (e instanceof OutOfTime) throw e;
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') skippedBig = true;
      problem = problem || (e && e.code === 'ERR_BUFFER_TOO_LARGE' ? `the compressed pages are larger than ${ctx.maxInflated / 1048576} MB when opened` : 'could not be read as draw.io');
    }
  }
  if (!sections.length && problem) return fail(problem);
  if (skippedBig && sections.length) sections[0].model.said('inflated');
  return { sections: sections.length ? sections : [{ title: null, model: new Model() }] };
}

// ---------------------------------------------------------------------------------------------------
// Excalidraw (JSON)

const XD_SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'embeddable', 'iframe']);

function parseExcalidraw(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { error: 'could not be read as Excalidraw' }; }
  const all = Array.isArray(data) ? data : data && data.elements;
  if (!Array.isArray(all) || (Array.isArray(data) && !all.some((e) => e && typeof e.type === 'string'))) return { error: 'could not be read as Excalidraw' };
  const els = all.filter((e) => e && typeof e === 'object' && !e.isDeleted && typeof e.id === 'string').slice(0, 200000);
  const byId = new Map(els.map((e) => [e.id, e]));
  const label = (e) => shortLabel(e.text !== undefined ? e.text : (e.originalText || ''));
  const bound = new Map();                  // container id -> its text
  for (const e of els) {
    tick();
    if (e.type === 'text' && typeof e.containerId === 'string') {
      const l = label(e);
      const have = bound.get(e.containerId);
      if (l && have === undefined) bound.set(e.containerId, l);
      else if (l && have.length < 300) bound.set(e.containerId, `${have} ${l}`);   // a container with thousands of texts is not joined into a long string
    }
  }
  const frameName = (e) => { const f = typeof e.frameId === 'string' ? byId.get(e.frameId) : null; return f ? tidy(f.name || '', 120) : ''; };
  const nameOf = (e) => (e.type === 'text' ? label(e) : (bound.get(e.id) || ''));
  const model = new Model();
  const used = new Set();

  for (const e of els) {
    tick();
    if (!XD_SHAPES.has(e.type)) continue;
    const l = nameOf(e);
    if (l) model.node(e.id, { name: l, group: frameName(e) });
  }
  const end = (b) => {
    const target = b && typeof b.elementId === 'string' ? byId.get(b.elementId) : null;
    if (!target) return null;
    used.add(target.id);
    if (!model.comps.has(target.id)) model.node(target.id, { name: nameOf(target) || `unlabelled ${target.type}`, group: frameName(target) });
    return target.id;
  };
  for (const e of els) {
    tick();
    if (e.type !== 'arrow') continue;
    const from = end(e.startBinding), to = end(e.endBinding);
    if (!from || !to) continue;
    const startHead = e.startArrowhead || null;
    const endHead = e.endArrowhead === undefined ? 'arrow' : e.endArrowhead;
    const l = bound.get(e.id) || '';
    if (startHead && endHead) model.link(from, to, { label: l, dir: '<->' });
    else if (endHead) model.link(from, to, { label: l, dir: '->' });
    else if (startHead) model.link(to, from, { label: l, dir: '->' });
    else model.link(from, to, { label: l, dir: '--' });
  }
  const seen = new Set();
  for (const e of els) {
    tick();
    if (e.type !== 'text' || typeof e.containerId === 'string' || used.has(e.id)) continue;
    const l = label(e);
    if (l && !seen.has(l) && model.notes.length < 200) { seen.add(l); model.notes.push(l); }
  }
  return { sections: [{ title: null, model }] };
}

// ---------------------------------------------------------------------------------------------------
// AsciiDoc and reStructuredText (arc42 and similar): headings become "#" headings so the chunker keeps
// the heading path; diagram blocks become fences so they get their connection lists.

const ADOC_DIAGRAM_LANG = { plantuml: 'plantuml', puml: 'plantuml', mermaid: 'mermaid', graphviz: 'dot', dot: 'dot', structurizr: 'structurizr' };

// "[source,java]" and "[plantuml, format=svg]": the first word, and for "source" the language after it. Read
// with indexOf and a short pattern: a pattern that has to find the closing "]" through "[^\]]*" retries
// from every shorter name when there is none.
function adocAttr(line) {
  if (line[0] !== '[') return null;
  const t = line.trimEnd();
  if (!t.endsWith(']')) return null;
  const inner = t.slice(1, -1);
  if (inner.includes(']')) return null;
  const m = /^([\w.-]+)(?:\s*,\s*([\w.+-]+))?/.exec(inner);
  return m ? [t, m[1], m[2]] : null;
}
// "== Title ==": the closing equals signs of a heading are not part of it.
function adocTitle(rest) {
  let t = rest.trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === '=') k--;
  if (k < t.length && k > 0 && /\s/.test(t[k - 1])) t = t.slice(0, k).trimEnd();
  return t;
}

function asciidocToMarkdown(text) {
  const lines = String(text).split('\n');
  const out = [];
  let lang = '';                              // from the [source,java] / [plantuml] line before a block
  for (let i = 0; i < lines.length; i++) {
    tick();
    const line = clip(lines[i], 4000);
    const block = /^(-{4,}|\.{4,})\s*$/.exec(line);
    if (block) {
      let j = i + 1;
      const body = [];
      while (j < lines.length && lines[j].trimEnd() !== block[1] && body.length < 200000) body.push(lines[j++]);
      const content = body.join('\n');
      out.push(fenceBlock(content, ADOC_DIAGRAM_LANG[lang.toLowerCase()] || lang));
      lang = '';
      i = j;                                  // the closing delimiter (or the end of the file)
      continue;
    }
    const attr = adocAttr(line);
    if (attr) { lang = attr[1] === 'source' ? (attr[2] || '') : attr[1]; out.push(line); continue; }
    if (!/^\.[^\s.]/.test(line) && line.trim()) lang = '';
    const h = /^(={1,6})\s+(\S.*)$/.exec(line);
    out.push(h ? `${'#'.repeat(h[1].length)} ${adocTitle(h[2])}` : line);
  }
  return describeFences(out.join('\n'));
}

const RST_RULE = /^([=\-`:'"~^_*+#<>.])\1{1,}\s*$/;
const RST_CODE = /^\.\.\s+(code-block|sourcecode|code|uml|plantuml|mermaid|graphviz|digraph|graph)::\s*(.*)$/;

function rstToMarkdown(text) {
  const lines = String(text).split('\n').map((l) => clip(l, 4000));
  const out = [];
  const styles = [];                          // the order in which title styles first appear gives the level
  const level = (key) => { let k = styles.indexOf(key); if (k < 0) { styles.push(key); k = styles.length - 1; } return Math.min(k + 1, 6); };
  for (let i = 0; i < lines.length; i++) {
    tick();
    const line = lines[i];
    const d = RST_CODE.exec(line);
    if (d) {
      let j = i + 1;
      const body = [];
      while (j < lines.length && (!lines[j].trim() || /^\s/.test(lines[j])) && body.length < 200000) body.push(lines[j++]);
      while (body.length && !body[0].trim()) body.shift();
      while (body.length && /^\s+:[\w-]+:/.test(body[0])) body.shift();          // directive options
      while (body.length && !body[0].trim()) body.shift();
      const indent = body.reduce((m, l) => (l.trim() ? Math.min(m, /^\s*/.exec(l)[0].length) : m), 1e9);
      let content = body.map((l) => l.slice(indent === 1e9 ? 0 : indent)).join('\n').trimEnd();
      let lang = d[1] === 'uml' ? 'plantuml' : d[1] === 'graphviz' ? 'dot' : (d[1] === 'digraph' || d[1] === 'graph') ? 'dot' : d[2].trim();
      if (d[1] === 'digraph' || d[1] === 'graph') content = `${d[1]} ${d[2].trim() || 'g'} {\n${content}\n}`;
      out.push(fenceBlock(content, lang));
      i = j - 1;
      continue;
    }
    // over- and underlined title: rule, title, rule
    if (RST_RULE.test(line) && i + 2 < lines.length && lines[i + 1].trim() && !RST_RULE.test(lines[i + 1]) && lines[i + 2].trim() === line.trim()) {
      out.push(`${'#'.repeat(level(`o${line[0]}`))} ${lines[i + 1].trim()}`);
      i += 2;
      continue;
    }
    // underlined title
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !/^\s/.test(line) && !RST_RULE.test(line) && !/^(\.\.|[-*+]\s)/.test(line) && RST_RULE.test(next)
      && (next.trim().length >= line.trim().length || next.trim().length >= 4)) {
      out.push(`${'#'.repeat(level(`u${next[0]}`))} ${line.trim()}`);
      i += 1;
      continue;
    }
    out.push(line);
  }
  return describeFences(out.join('\n'));
}

// ---------------------------------------------------------------------------------------------------
// Entry points

function parseText(kind, src) {
  switch (kind) {
    case 'mermaid': return parseMermaid(src);
    case 'plantuml': return parsePlantuml(src);
    case 'structurizr': return parseStructurizr(src);
    case 'graphviz': return parseGraphviz(src);
    default: return { model: null, label: KIND_LABEL[kind] || 'diagram' };
  }
}

const SLOW_NOTE = '(This diagram is larger or more complex than Understudy reads in full, so its connections are not listed. The source is kept as written.)';
const BIG_NOTE = '(This file is larger than Understudy reads in full: the rest of it is not read.)';

// The plain form of a text diagram, when it could not be read in full: its source, and a line saying so.
function plainDiagram(text, kind, name, note) {
  return { markdown: buildMarkdown({ name, label: KIND_LABEL[kind], sections: [], source: text, lang: FENCE_LANG[kind], notes: [note], inputLength: text.length }), limited: true };
}
// What is indexed for a file that could not be read at all in the time allowed.
function giveUp(text, kind, name, why) {
  if (kind === 'drawio' || kind === 'excalidraw') return { reason: why, limited: true };
  if (KIND_LABEL[kind]) return plainDiagram(text, kind, name, SLOW_NOTE);
  return { markdown: clip(text, MAX_TEXT_PARSED), limited: true };
}
const SLOW_REASON = 'larger or more complex than Understudy reads in full';

// Returns { markdown } or, when a draw.io / Excalidraw file cannot be read, { reason }.
// opts: name; budgetMs (default BUDGET_MS); maxInflated (default MAX_INFLATED_INLINE).
function convertDiagram(source, kind, opts = {}) {
  const name = opts.name === undefined ? 'Diagram' : opts.name;
  let text = String(source == null ? '' : source).replace(/^﻿/, '');
  const structured = kind === 'drawio' || kind === 'excalidraw';
  if (structured && text.length > MAX_STRUCTURED_BYTES) return { reason: `larger than ${MAX_STRUCTURED_BYTES / 1048576} MB` };
  let big = false;
  const maxText = kind === 'asciidoc' || kind === 'rst' ? (opts.maxText || MAX_DOC_INLINE) : MAX_TEXT_PARSED;
  if (!structured && text.length > maxText) { text = text.slice(0, maxText); big = true; }
  try {
    return withBudget(opts.budgetMs || BUDGET_MS, () => {
      if (kind === 'asciidoc' || kind === 'rst') {
        const md = (kind === 'asciidoc' ? asciidocToMarkdown : rstToMarkdown)(normaliseLines(text));
        return { markdown: big ? `${md}\n\n${BIG_NOTE}\n` : md, described: true };
      }
      if (structured) {
        const r = kind === 'drawio' ? parseDrawio(text, { inflated: 0, maxInflated: opts.maxInflated || MAX_INFLATED_INLINE }) : parseExcalidraw(text);
        if (!r || r.error) return { reason: r && r.error ? r.error : `could not be read as ${KIND_LABEL[kind]}` };
        return { markdown: buildMarkdown({ name, label: KIND_LABEL[kind], sections: r.sections, source: null, inputLength: text.length }), described: true };
      }
      if (!KIND_LABEL[kind]) return { markdown: text };
      text = normaliseLines(text);
      const r = parseText(kind, text);
      if (r.model && big) r.model.said('size');
      const sections = r.model && (!r.model.empty || r.model.sayings.size) ? [{ title: null, model: r.model }] : [];
      return { markdown: buildMarkdown({ name, label: r.label, sections, source: text, lang: FENCE_LANG[kind], inputLength: text.length }), described: true };
    });
  } catch (e) {
    if (e instanceof OutOfTime) return giveUp(text, kind, name, SLOW_REASON);
    if (structured) return { reason: `could not be read as ${KIND_LABEL[kind]}` };
    return { markdown: KIND_LABEL[kind] ? buildMarkdown({ name, label: KIND_LABEL[kind], sections: [], source: text, lang: FENCE_LANG[kind], inputLength: text.length }) : text };
  }
}

// Markdown text for a diagram file, or '' when it cannot be read (see convertDiagram for the reason).
function diagramToMarkdown(source, kind, opts) {
  const r = convertDiagram(source, kind, opts);
  return r.markdown == null ? '' : r.markdown;
}

// ---------------------------------------------------------------------------------------------------
// Diagrams inside Markdown: the connections are written out in words right after the fence.

const FENCE_PRECHECK = /^[ \t]*(?:`{3,}|~{3,})[ \t]*\{?\.?(?:mermaid|plantuml|puml|uml|structurizr|c4|dot|graphviz|gv)\b/im;
const FENCE_KIND = { mermaid: 'mermaid', plantuml: 'plantuml', puml: 'plantuml', uml: 'plantuml', structurizr: 'structurizr', dsl: 'structurizr', dot: 'graphviz', graphviz: 'graphviz', gv: 'graphviz' };
const DESCRIBED = /^(?:\*\*(?:Components|Connections) in the |\(Same connections as the diagram above\.\)$|\(More diagrams follow than Understudy describes in full here\.\)$)/;
const SAME = '(Same connections as the diagram above.)';
const MORE = '(More diagrams follow than Understudy describes in full here.)';
const CONVERTED = /^# [^\n]*\n\nArchitecture diagram \(/;

function fenceKind(lang, body) {
  const l = lang.toLowerCase();
  if (l === 'c4') return /\b(workspace|softwareSystem|container)\b[^\n(]*"/.test(body) && !/@startuml|^[ \t]*\w+\(/m.test(body) ? 'structurizr' : 'plantuml';
  return FENCE_KIND[l] || null;
}

// opts (for the async path): totalMs, perFenceMs. Text that already has its lists, and the Source fence of this
// module's own output, are left as they are, so the result is the same whichever way it was reached.
function describeFences(markdown, opts = {}) {
  if (typeof markdown !== 'string' || markdown.length < 20 || !FENCE_PRECHECK.test(markdown)) return markdown;
  const started = performance.now();
  const totalMs = opts.totalMs || FENCES_TOTAL_MS, perFence = opts.perFenceMs || BUDGET_MS;
  try {
    const lines = markdown.split('\n');
    const out = [];
    const converted = CONVERTED.test(markdown.slice(0, 600));
    const limit = Math.max(FENCES_ADDED_MIN, markdown.length >> 2);   // at most a quarter of the text is added (or 64 KB, for a short text that is mostly diagrams)
    const seen = new Set();
    let open = null;                     // { ch, len, lang, body, chars, source }
    let before = '';                     // the last line with something on it before the fence that is open
    let added = 0, stopped = false;
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      out.push(line);
      if (line.length > MAX_LINE) { if (open && open.body) { open.body.push(cutLine(line.slice(0, MAX_LINE + 1))); open.cut = true; } continue; }
      const f = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line);   // "." does not match a CR
      if (!open) {
        if (!f) { if (line.trim()) before = line; continue; }
        const info = f[2].trim().replace(/^\{\.?/, '').replace(/\}$/, '');
        const lang = (/^[\w-]+/.exec(info) || [''])[0];
        const wanted = FENCE_KIND[lang.toLowerCase()] || lang.toLowerCase() === 'c4';
        open = { ch: f[1][0], len: f[1].length, lang, body: wanted && !(converted && before.trim() === '## Source') ? [] : null, chars: 0 };
        continue;
      }
      if (f && f[1][0] === open.ch && f[1].length >= open.len && !f[2].trim()) {
        if (open.body && !stopped) {
          // does a description follow already? (a second pass, or a file that was converted and then described)
          let k = n + 1;
          while (k < lines.length && k <= n + 2 && /^\r?$/.test(lines[k])) k++;
          const here = lines[k] === undefined ? '' : lines[k].replace(/\r$/, '');
          if (k < lines.length && DESCRIBED.test(here)) { if (here === MORE) stopped = true; }
          else if (performance.now() - started < totalMs) {
            const text = open.body.join('\n');
            const kind = fenceKind(open.lang, text);
            if (kind) {
              const key = text.length > 200 ? `${kind}\0${text.length}\0${text.slice(0, 100)}\0${text.slice(-100)}\0${crypto.createHash('sha1').update(text).digest('base64')}` : `${kind}\0${text}`;
              const again = seen.has(key);
              const addedLines = again ? [SAME] : describeOne(text, kind, Math.min(perFence, totalMs - (performance.now() - started)), open.cut);
              if (addedLines) {
                const size = addedLines.reduce((s, l) => s + l.length + 1, 0) + 2;
                if (added + size > limit) { out.push('', MORE, ...(lines[n + 1] === undefined || /^\r?$/.test(lines[n + 1]) ? [] : [''])); stopped = true; }
                else {
                  added += size;
                  seen.add(key);
                  out.push('', ...addedLines, ...(lines[n + 1] === undefined || /^\r?$/.test(lines[n + 1]) ? [] : ['']));
                }
              }
            }
          }
        }
        open = null; before = '';
        continue;
      }
      if (open.body) { open.chars += line.length; if (open.chars > MAX_SOURCE_SHOWN) open.body = null; else open.body.push(line); }
    }
    return out.join('\n');
  } catch { return markdown; }
}

function describeOne(text, kind, ms, cut) {
  try {
    const r = withBudget(Math.max(5, ms), () => parseText(kind, normaliseLines(text)));
    if (!r.model || r.model.empty) return null;
    if (cut) r.model.said('cut');
    const { components, connections } = listsOf(r.model, { onlyNamed: true, maxChars: 4 * 1024 * 1024 });
    const what = r.label.replace(/^Mermaid diagram$/, 'diagram');
    const cap = (arr) => (arr.length > MAX_FENCE_LINES ? [...arr.slice(0, MAX_FENCE_LINES), `- (${arr.length - MAX_FENCE_LINES} more)`] : arr);
    const out = [];
    if (components.length) out.push(`**Components in the ${what} above:**`, ...cap(components), '');
    if (connections.length) out.push(`**Connections in the ${what} above (${LEAD.toLowerCase().replace(/:$/, '')}):**`, ...cap(connections));
    while (out.length && out[out.length - 1] === '') out.pop();
    const say = sayingLines(r.model);
    if (out.length && say.length) out.push(...say);
    return out.length ? out : null;
  } catch { return null; }                  // out of time, or anything else: the fence is left without a list
}

// ---------------------------------------------------------------------------------------------------
// Off the main thread. One worker, started when the first large input arrives and reused; jobs run one at a
// time. A job that takes longer than its timeout, or a worker that dies or runs out of memory, is dropped (the
// worker is terminated and the next job starts a new one) and the input is handled in the cheapest safe way.
// A worker that cannot be started at all (the packaged app runs from an archive, a thread limit) is a normal
// case: the inline path, which is bounded, is used and a new start is not attempted for a minute.

const pool = {
  file: path.join(__dirname, 'diagram-worker.js'),
  worker: null,
  ready: false,
  inFlight: 0,
  seq: 0,
  chain: Promise.resolve(),
  downUntil: 0,
  onError: null,                                           // set by the app: unexpected worker errors are reported as issues
  limits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
};

function startWorker() {
  const { Worker } = require('node:worker_threads');
  const w = new Worker(pool.file, { resourceLimits: pool.limits, execArgv: [], stdout: false, stderr: false });
  if (w.unref) w.unref();                                  // an idle worker never keeps the app (or a test run) open
  pool.worker = w; pool.ready = false;
  w.on('message', (m) => { if (m && m.ready && pool.worker === w) pool.ready = true; });
  w.on('error', (e) => {
    if (pool.worker === w) pool.worker = null;
    if (pool.onError && !(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY')) { try { pool.onError(e); } catch { /* reporting never stops the pool */ } }
  });
  w.on('exit', () => { if (pool.worker === w) pool.worker = null; });
  return w;
}
function dropWorker(w) {
  if (pool.worker === w) pool.worker = null;
  try { w.terminate().catch(() => {}); } catch { /* it is going away either way */ }
}

// Runs one job and always resolves: { ok: true, result } or { ok: false, why: 'start' | 'timeout' | 'died' | 'memory' }.
function execute(job, timeoutMs) {
  return new Promise((resolve) => {
    if (Date.now() < pool.downUntil) { resolve({ ok: false, why: 'start' }); return; }
    let w;
    try { w = pool.worker || startWorker(); } catch { pool.downUntil = Date.now() + 60000; resolve({ ok: false, why: 'start' }); return; }
    pool.inFlight++;
    if (w.ref) w.ref();
    const id = ++pool.seq;
    let timer = null, done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.off('message', onMessage); w.off('error', onError); w.off('exit', onExit);
      pool.inFlight = Math.max(0, pool.inFlight - 1);
      if (pool.inFlight === 0 && pool.worker === w && w.unref) w.unref();
    };
    const fail = (why, kill) => {
      if (done) return;
      const neverReady = !pool.ready && pool.worker === w;
      cleanup();
      if (kill || why === 'start') dropWorker(w);
      if (why === 'start' || neverReady) pool.downUntil = Date.now() + 60000;
      resolve({ ok: false, why });
    };
    function onMessage(m) { if (m && m.id === id && !done) { cleanup(); resolve(m.result && m.result.error ? { ok: false, why: 'died' } : { ok: true, result: m.result }); } }
    function onError(e) { fail(!pool.ready ? 'start' : (e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'died'), true); }
    function onExit() { fail(!pool.ready ? 'start' : 'died', true); }
    w.on('message', onMessage); w.on('error', onError); w.on('exit', onExit);
    timer = setTimeout(() => fail(pool.ready ? 'timeout' : 'start', true), timeoutMs + (pool.ready ? 0 : 5000));   // a worker that has not finished loading gets time to
    if (timer.unref) timer.unref();
    try { w.postMessage({ id, ...job }); } catch { fail('died', true); }
  });
}
const runJob = (job, timeoutMs = JOB_TIMEOUT_MS) => {
  const next = pool.chain.then(() => execute(job, timeoutMs));
  pool.chain = next.catch(() => {});
  return next;
};

function shutdownDiagramWorker() {
  const w = pool.worker;
  pool.worker = null;
  if (w) { try { w.terminate().catch(() => {}); } catch { /* gone */ } }
}

// convertDiagram without blocking the caller: small inputs are converted inline (with a short budget), large ones in
// the worker. opts: name, and for tests inlineMax, timeoutMs.
async function convertDiagramAsync(source, kind, opts = {}) {
  const text = String(source == null ? '' : source);
  const name = opts.name === undefined ? 'Diagram' : opts.name;
  const inlineMax = opts.inlineMax === undefined ? ASYNC_INLINE_MAX : opts.inlineMax;
  if (text.length <= inlineMax || !(KIND_LABEL[kind] || kind === 'asciidoc' || kind === 'rst')) {
    return convertDiagram(text, kind, { name, budgetMs: SMALL_BUDGET_MS });
  }
  if ((kind === 'drawio' || kind === 'excalidraw') && text.length > MAX_STRUCTURED_BYTES) return { reason: `larger than ${MAX_STRUCTURED_BYTES / 1048576} MB` };
  const r = await runJob({ op: 'convert', text, kind, name, budgetMs: WORKER_BUDGET_MS, maxInflated: MAX_INFLATED, maxText: MAX_TEXT_PARSED }, opts.timeoutMs);
  if (r.ok && r.result && (r.result.markdown !== undefined || r.result.reason !== undefined)) return r.result;
  if (r.why === 'start') return convertDiagram(text, kind, { name });          // no worker: the bounded inline path
  return giveUp(text.length > MAX_TEXT_PARSED && !(kind === 'drawio' || kind === 'excalidraw') ? text.slice(0, MAX_TEXT_PARSED) : text, kind, name, r.why === 'memory' ? 'too large to read in the memory allowed' : 'took longer to read than the time allowed');
}

// describeFences without blocking the caller (see convertDiagramAsync).
async function describeFencesAsync(markdown, opts = {}) {
  if (typeof markdown !== 'string' || markdown.length < 20 || !FENCE_PRECHECK.test(markdown)) return markdown;
  const inlineMax = opts.inlineMax === undefined ? ASYNC_INLINE_MAX : opts.inlineMax;
  if (markdown.length <= inlineMax) return describeFences(markdown, { totalMs: SMALL_BUDGET_MS, perFenceMs: SMALL_BUDGET_MS });
  const r = await runJob({ op: 'fences', text: markdown, totalMs: WORKER_BUDGET_MS, perFenceMs: WORKER_BUDGET_MS / 2 }, opts.timeoutMs);
  if (r.ok && typeof r.result === 'string') return r.result;
  if (r.why === 'start') return describeFences(markdown);
  return markdown;
}

module.exports = {
  diagramKind, diagramToMarkdown, convertDiagram, describeFences, convertDiagramAsync, describeFencesAsync, shutdownDiagramWorker,
  DIAGRAM_EXTS, MAX_STRUCTURED_BYTES,
  LIMITS: { MAX_LINE, MAX_INFLATED, MAX_INFLATED_INLINE, MAX_TEXT_PARSED, MAX_DOC_INLINE, MAX_ITEMS, MAX_DEPTH, MAX_PAGES, MAX_EDGE_LABELS, MAX_FAN, OUT_FACTOR, OUT_MAX, OUT_MIN, BUDGET_MS, WORKER_BUDGET_MS, ASYNC_INLINE_MAX, JOB_TIMEOUT_MS },
  _pool: { pool, runJob, startWorker },
};
