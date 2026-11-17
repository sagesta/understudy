'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chunkMarkdown } = require('./chunker');
const { Bm25Index, tokenize } = require('./bm25');
const { redactSecrets } = require('./redact');
const { diagramKind, convertDiagramAsync, describeFencesAsync, DIAGRAM_EXTS, MAX_STRUCTURED_BYTES } = require('./diagrams');
const { IMAGE_EXTS, MAX_IMAGE_BYTES, PERMANENT_SKIP } = require('./images');
const inbox = require('../notes-inbox');
const { inert } = require('../prompts');

// Notes, plus architecture: diagram-as-code, draw.io, Excalidraw, and AsciiDoc / reST documents (see diagrams.js).
// ".drawio.xml" counts although ".xml" in general does not, so a file is judged by its whole name.
const EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', ...DIAGRAM_EXTS]);
const IMAGES = new Set(IMAGE_EXTS);
const baseName = (file) => path.basename(file, path.extname(file)).replace(/[.]drawio$/i, '');   // "a.drawio.xml" is called "a"
const wanted = (name) => EXTS.has(path.extname(name).toLowerCase()) || !!diagramKind(name);
const isImage = (name) => IMAGES.has(path.extname(name).toLowerCase());
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '.venv', 'dist', 'build']);
// A folder that is never read: the listed names (in any case, as Windows and macOS see them) and every dot-folder
// (which includes Google Drive's temporary ones). The walk and the watcher both use it, so a change inside such a
// folder neither starts a pass nor is looked at.
const isSkippedDir = (name) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
// What sync services, editors and browsers leave beside real files while they work: Office and LibreOffice lock
// files, half-downloaded and half-uploaded files, Syncthing's copy of the version that lost, Windows' own
// folder files, and Google Drive's temporary names (its ".tmp.drivedownload" / ".tmp.driveupload" folders are
// dot-folders, which are skipped as folders; the pattern covers the same names used for a file).
// A conflict copy such as "name (1).md" or "name (conflicted copy 2026-11-15).md" is NOT here: it is a whole
// note, it may hold the newer text, and finding the same fact twice is better than losing it.
const JUNK = /^~\$|\.(?:tmp|partial|crdownload)$|^\.~lock\.|\.sync-conflict-|^(?:desktop\.ini|thumbs\.db)$|\.tmp\.drive(?:down|up)load$/i;
const isJunk = (name) => JUNK.test(name);

// Two spellings of one folder or file are one place: Windows ignores case and a trailing separator.
const pathKey = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
const samePath = (a, b) => pathKey(a) === pathKey(b);
const within = (parent, child) => { const r = path.relative(pathKey(parent), pathKey(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
// When a file can be reached through two sources, which one describes it: a meetings folder wins (it must
// stay a meeting, whose transcript is never knowledge), otherwise the more specific (deeper) folder.
const outranks = (a, b) => ((a.kind === 'meeting') !== (b.kind === 'meeting') ? a.kind === 'meeting' : within(b.dir, a.dir) && !samePath(a.dir, b.dir));

// The folders the library reads: the person's own, the meetings folder when meetings count as knowledge, and
// the app's Notes folder, which is always part of it. The Notes folder is never listed twice: a folder the person
// added that is the same place is replaced by it (so it is called "Notes"), and a parent of it just overlaps
// (a file reached through both is indexed once, see reindex). The Notes source is marked `notes: true`: it is the one
// folder where the library may write (the description of a picture goes into the note beside it, see reindex).
function buildSources({ folders = [], includeMeetings = true, meetingsDir = '', notesDir = '' } = {}) {
  const meetings = includeMeetings !== false && meetingsDir ? { dir: meetingsDir, label: 'Meetings', kind: 'meeting' } : null;
  const notes = notesDir && !(meetings && samePath(meetings.dir, notesDir)) ? { dir: notesDir, label: 'Notes', kind: 'work', optional: true, notes: true } : null;
  const own = (Array.isArray(folders) ? folders : []).filter((d) => typeof d === 'string' && d && !(notes && samePath(d, notesDir)));
  const seen = new Set();
  const src = [];
  for (const dir of own) { if (seen.has(pathKey(dir))) continue; seen.add(pathKey(dir)); src.push({ dir, label: path.basename(dir), kind: 'work' }); }
  if (meetings) src.push(meetings);
  if (notes) src.push(notes);
  return src;
}
// Large compilations are fine. Only something that is clearly not a notes file
// (or that would not fit in memory as text) is left out, and it is reported.
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const SLICE_CHARS = 400_000;     // a big file is processed this much at a time
const MAX_CHUNKS_PER_FILE = 400_000;
const MAX_LIBRARY_CHARS = 250_000_000;
const MAX_LIBRARY_CHUNKS = 500_000;
const PINNED_MAX_CHARS = 80000; // about 20 thousand tokens: what a folder marked "always include" may send with every answer

const tick = () => new Promise((r) => setImmediate(r));

// `images`: pictures are listed too (only when something is there to read them).
async function walk(dir, out, skipped, images = false) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { skipped.push({ file: dir, reason: e.code || e.message }); return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // The app's own "Issues" folder (problem reports, see issues.js) sits next to Notes and Meetings: it is never knowledge.
      if (isSkippedDir(e.name) || (/^issues$/i.test(e.name) && entries.some((x) => x.isDirectory() && /^(?:notes|meetings)$/i.test(x.name)))) continue;
      await walk(full, out, skipped, images);
    } else if (e.isFile() && (wanted(e.name) || (images && isImage(e.name))) && !e.name.startsWith('_') && !isJunk(e.name)) {
      out.push(full);   // files starting with "_" are generated digests
    }
  }
}

// How many notes (Markdown files) a folder holds, for the Knowledge page.
async function countNoteFiles(dir) {
  const out = [];
  await walk(dir, out, []);
  return out.filter((f) => /\.md$/i.test(f)).length;
}

function* slices(text) {
  let i = 0;
  while (i < text.length) {
    let j = Math.min(text.length, i + SLICE_CHARS);
    if (j < text.length) {
      const nl = text.lastIndexOf('\n', j);
      if (nl > i + SLICE_CHARS / 2) j = nl + 1;
      else if (j > i + 1) {
        const code = text.charCodeAt(j - 1);
        if (code >= 0xd800 && code <= 0xdbff) j -= 1;
      }
    }
    yield text.slice(i, j);
    i = j;
  }
}

// An in-memory search index over folders of notes.
//
// Re-reading is incremental: only files that are new, changed or gone since the
// last pass are touched, so a change to one note in a library of thousands
// costs a directory scan, not a re-index. All work is done in short slices so
// the app stays responsive while a large library is read.
class Library {
  // imageReader: optional ({ read, resetPass }, see images.js). Without one, pictures are not even listed.
  constructor({ imageReader = null, maxLibraryChars = MAX_LIBRARY_CHARS, maxLibraryChunks = MAX_LIBRARY_CHUNKS } = {}) {
    this.imageReader = imageReader;
    this.maxLibraryChars = maxLibraryChars;
    this.maxLibraryChunks = maxLibraryChunks;
    this.totalChars = 0;
    this.folders = [];
    this.chunks = [];                 // document number -> chunk, or null once removed
    this.index = new Bm25Index();
    this.files = new Map();           // path -> { sig, kind, rel, mtime, docs: [numbers], chars, redacted }
    this.skipInfo = new Map();        // path -> { sig, reason } for files that were looked at and left out
    this.described = new Map();       // picture in the Notes folder -> sig it had when its description was found in (or written to) the note beside it
    this.stats = { files: 0, chunks: 0, chars: 0, skipped: [], redacted: 0, indexedAt: null };
    this.watchers = [];
    this.onChange = null;
    this._timer = null;               // the one timer for "look again soon": a change seen by a watcher, or pictures still waiting
    this._armed = false;
  }

  get chunkCount() { return this.index.size; }

  // sources: [{ dir, label, kind, optional? }] - kind is 'work' (your files) or 'meeting' (past meetings);
  // an optional folder that does not exist yet is simply not there (no meetings recorded, no notes saved).
  // onTextDone, when given, is called once every text file is indexed and before pictures are read, which can take a while.
  async reindex(sources, { onTextDone } = {}) {
    this.folders = sources;
    const skipped = [];
    const reader = this.imageReader || null;
    if (reader) { try { reader.resetPass(); } catch { /* a reader that cannot reset still reads */ } }
    let sliceStart = performance.now();
    const breathe = async () => { if (performance.now() - sliceStart > 8) { await tick(); sliceStart = performance.now(); } };

    // 1. What is on disk now. A file that can be reached through two sources (a folder added twice, a Notes folder
    // inside a folder that was added, the same place spelt in another case) is one file: it is listed once, under
    // the source that outranks the other, so it can never be indexed twice.
    const found = new Map();   // normalised path -> { file, src }
    for (const src of sources) {
      if ((src.kind === 'meeting' || src.optional) && !fs.existsSync(src.dir)) continue;
      const list = [];
      await walk(src.dir, list, skipped, Boolean(reader) && (src.kind || 'work') === 'work');
      for (const file of list) {
        const k = pathKey(file);
        const have = found.get(k);
        if (!have) found.set(k, { file, src });
        else if (outranks(src, have.src)) have.src = src;
      }
    }
    const present = new Map();   // path -> { src, st, rel }
    const all = [...found.values()];
    for (let i = 0; i < all.length; i += 64) {
      const batch = all.slice(i, i + 64);
      const stats = await Promise.all(batch.map((b) => fsp.stat(b.file).catch((e) => ({ error: e }))));
      batch.forEach(({ file, src }, n) => {
        const st = stats[n];
        if (st.error) { skipped.push({ file, reason: st.error.code || st.error.message }); return; }
        present.set(file, { src, st, rel: path.join(src.label || path.basename(src.dir), path.relative(src.dir, file)) });
      });
    }

    // 2. Forget what has gone.
    for (const file of [...this.files.keys()]) if (!present.has(file)) this._removeFile(file);
    for (const file of [...this.skipInfo.keys()]) if (!present.has(file)) this.skipInfo.delete(file);
    for (const file of [...this.described.keys()]) if (!present.has(file)) this.described.delete(file);

    // 3. Read what is new or changed: every text file first, so a slow picture reader never holds notes up.
    const pictures = [];
    for (const [file, { src, st, rel }] of present) {
      if (isImage(file)) { pictures.push([file, { src, st, rel }]); continue; }
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      const known = this.files.get(file);
      if (known && known.sig === sig && known.rel === rel && known.kind === (src.kind || 'work')) continue;
      const skip = this.skipInfo.get(file);
      if (skip && skip.sig === sig) { skipped.push({ file, reason: skip.reason }); continue; }
      this._removeFile(file);
      this.skipInfo.delete(file);
      try {
        const why = await this._indexFile(file, src, st, rel, sig, breathe);
        if (why) { if (why !== 'library size limit reached') this.skipInfo.set(file, { sig, reason: why }); skipped.push({ file, reason: why }); }
      } catch (e) {
        this._removeFile(file);
        skipped.push({ file, reason: e.code || e.message });
      }
      await breathe();
    }
    this.stats = this._summarise(skipped, 0);
    if (onTextDone) { try { onTextDone(this.stats); } catch { /* a listener must not stop the pass */ } }

    // 3b. Pictures, one at a time through the reader (which describes each only once and keeps its own allowance).
    // A picture inside the Notes folder keeps its description in the note beside it (notes-inbox.js), so it is looked for
    // there first (it may have come with the picture from another PC), and what the reader writes is put there instead
    // of being indexed from here: the note is an ordinary file, indexed once as a note. Pictures in the person's own
    // folders are never written beside; they are indexed from the reader's result.
    const notesDirOf = (file) => { const n = sources.find((x) => x.notes && within(x.dir, file)); return n ? n.dir : ''; };
    const owner = new Map();   // two pictures of one name ("a.png", "a.jpg") would fight over one note: the first by extension has it
    for (const [file] of pictures) {
      if (!notesDirOf(file)) continue;
      const k = pathKey(inbox.imageSiblingPath(file)), have = owner.get(k);
      if (!have || path.extname(file).toLowerCase() < path.extname(have).toLowerCase()) owner.set(k, file);
    }
    const presentByKey = new Map([...present.keys()].map((f) => [pathKey(f), f]));
    let pending = 0, retry = 0, again = 0;
    const seen = (state) => { if (reader && typeof reader.countSeen === 'function') { try { reader.countSeen(state); } catch { /* only the figures */ } } };
    for (const [file, { src, st, rel }] of pictures) {
      const kind = src.kind || 'work';
      if (kind !== 'work' || !reader) continue;
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      const known = this.files.get(file);
      if (known && known.sig === sig && known.rel === rel && known.kind === kind) { seen('read'); continue; }   // already described: never sent again
      const notesDir = notesDirOf(file);
      const beside = Boolean(notesDir) && owner.get(pathKey(inbox.imageSiblingPath(file))) === file;
      if (beside && this.described.get(file) === sig) { seen('read'); continue; }   // its description is in the note beside it already
      const skip = this.skipInfo.get(file);
      if (skip && skip.sig === sig) { skipped.push({ file, reason: skip.reason }); seen('skipped'); continue; }   // counted too: a remembered skip is still a picture the screen must know about
      if (skip) this.skipInfo.delete(file);
      let hash = '', sib = null;
      // With the feature off nothing is asked and nothing is written, so there is no need to look (the notes beside
      // pictures are indexed like any note either way).
      if (beside && !(typeof reader.enabled === 'function' && !reader.enabled())) {
        hash = inbox.imageHash(file, MAX_IMAGE_BYTES);
        sib = inbox.readImageSibling(file);
        if (hash && sib.hashes.includes(hash)) { this._removeFile(file); this.described.set(file, sig); seen('read'); continue; }   // described already, here or on another PC: no request, no allowance used
      }
      let r;
      try { r = await reader.read(file, st); } catch { r = { skip: 'could not be described' }; }   // it never throws; this is only a guard
      // An old description of a picture that has since changed would mislead, so it goes unless the picture is the same.
      const stale = () => { if (known && known.sig !== sig) this._removeFile(file); };
      if (r === null || r === undefined) { stale(); continue; }   // the feature is off: ask nothing, and leave what is indexed as it is
      if (r.pending) { stale(); pending++; continue; }            // not read yet: neither indexed nor remembered as left out
      if (typeof r.skip === 'string' && r.skip) {
        stale();
        // Remembered for the session only when the picture itself is the reason (too large, not an image, refused by
        // the model). "not read:" is the reader's stop case (no key, no credit), and "could not be described" or a
        // failed read may be a service that was down for a minute: those are asked again on a later pass.
        const permanent = typeof r.permanent === 'boolean' ? r.permanent : PERMANENT_SKIP.test(r.skip);
        if (permanent) this.skipInfo.set(file, { sig, reason: r.skip });
        else if (!r.skip.startsWith('not read:')) again++;
        skipped.push({ file, reason: r.skip });
        continue;
      }
      if (!r.markdown || typeof r.markdown !== 'string') { stale(); continue; }
      if (sib && hash) {
        const done = inbox.writeImageDescription(notesDir, file, { hash, markdown: redactSecrets(r.markdown).text, expected: sib.raw, mtimeMs: st.mtimeMs });
        if (done === 'changed') { stale(); retry++; continue; }   // the note changed while the model was working: nothing written; the description is cached, so the next pass only has to write it
        if (done !== 'failed') {
          this._removeFile(file);
          this.described.set(file, sig);
          await this._indexNoteBeside(file, src, present, presentByKey, breathe);
          continue;
        }
        // The note cannot be written (a folder, a link, not UTF-8, too large): the description is indexed from here, as for any picture.
      }
      this._removeFile(file);
      try {
        const name = path.basename(file);
        await this._indexText({ file, kind, rel, st, sig, text: r.markdown, base: baseName(file), startHeadings: [name] }, breathe);
      } catch (e) {
        this._removeFile(file);
        skipped.push({ file, reason: e.code || e.message });
      }
      await breathe();
    }
    if (retry) this._schedule(10000, true);     // a note that changed under us: a short wait, then write the description that is already cached
    if (pending || again) this._schedule(60000, true);   // the rest of them, and the ones that could not be described: a minute from now (once, however many passes ran meanwhile)

    // 4. Reclaim space once enough has been removed.
    if (this.index.dead.size > 20000 && this.index.dead.size > this.index.size * 0.3) await this._compact(breathe);

    this.stats = this._summarise(skipped, pending);
    return this.stats;
  }

  // (Re)indexes the note beside a picture after its description was written into it. It may be in this pass's list
  // already (then it was indexed as it was before the write, and is replaced here).
  async _indexNoteBeside(image, src, present, presentByKey, breathe) {
    const sibling = inbox.imageSiblingPath(image);
    const file = presentByKey.get(pathKey(sibling)) || sibling;
    const seen = present.get(file);
    const of = seen ? seen.src : src;
    const rel = seen ? seen.rel : path.join(src.label || path.basename(src.dir), path.relative(src.dir, file));
    let st;
    try { st = await fsp.stat(file); } catch { return; }
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
    const known = this.files.get(file);
    if (known && known.sig === sig && known.rel === rel) return;
    this._removeFile(file);
    this.skipInfo.delete(file);
    try {
      const why = await this._indexFile(file, of, st, rel, sig, breathe);
      if (why && why !== 'library size limit reached') this.skipInfo.set(file, { sig, reason: why });
    } catch { this._removeFile(file); }   // the next pass looks at it again
    await breathe();
  }

  _summarise(skipped, pendingImages) {
    let chars = 0, redacted = 0;
    for (const f of this.files.values()) { chars += f.chars; redacted += f.redacted; }
    return { files: this.files.size, chunks: this.index.size, chars, skipped, redacted, indexedAt: Date.now(), pendingImages };
  }

  // Returns a reason when the file was left out, otherwise nothing.
  async _indexFile(file, src, st, rel, sig, breathe) {
    if (st.size > MAX_FILE_BYTES) return `larger than ${MAX_FILE_BYTES / 1048576} MB`;
    const dkind = diagramKind(file);
    // draw.io and Excalidraw are read as a whole (XML / JSON), so they have a smaller limit
    if ((dkind === 'drawio' || dkind === 'excalidraw') && st.size > MAX_STRUCTURED_BYTES) return `larger than ${MAX_STRUCTURED_BYTES / 1048576} MB`;
    if (this.totalChars >= this.maxLibraryChars || this.index.size >= this.maxLibraryChunks) return 'library size limit reached';
    let text = await fsp.readFile(file, 'utf8');
    const actualBytes = Buffer.byteLength(text, 'utf8');
    if (actualBytes > MAX_FILE_BYTES) return `larger than ${MAX_FILE_BYTES / 1048576} MB`;
    if ((dkind === 'drawio' || dkind === 'excalidraw') && actualBytes > MAX_STRUCTURED_BYTES) return `larger than ${MAX_STRUCTURED_BYTES / 1048576} MB`;
    await breathe();
    // A file with NUL bytes or mostly unprintable text is not notes.
    if (text.includes('\u0000') || (text.length > 200 && (text.slice(0, 4000).match(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g) || []).length > 80)) return 'not a text file';
    const kind = src.kind || 'work';
    if (kind === 'meeting') {
      // Only the notes of a past meeting are remembered. The raw transcript is
      // other people's words and is never treated as knowledge.
      let cut = -1;
      for (const m of text.matchAll(/^## Transcript[ \t]*$/gm)) cut = m.index;
      if (cut !== -1) text = text.slice(0, cut);
      if (/^_.*not been generated/m.test(text)) return '';
    }
    text = inbox.withoutDescriptionMarkers(text);   // the markers around a picture's description are bookkeeping, not text to find
    const base = baseName(file);
    let described = false;
    if (dkind) {
      // Architecture files are turned into Markdown whose lines say what is connected to what. A large or hostile file
      // is read in a worker thread (see diagrams.js), so the meeting is never held up by one. Its Markdown already
      // has the lists after its fences, so it is not described a second time.
      const r = await convertDiagramAsync(text, dkind, { name: base });
      if (r.reason) return r.reason;
      text = r.markdown;
      described = Boolean(r.described);
      await breathe();
    }
    return this._indexText({ file, kind, rel, st, sig, text, base, described }, breathe);
  }

  // Chunks and indexes Markdown text for `file`. `startHeadings` puts every chunk under a heading path of its own
  // (a picture's description sits under the picture's file name) and the text then has no front matter to strip.
  // A note file's own front matter (title, date, source, origin, image) is not text: chunkMarkdown drops it, and
  // keeps only the title, as the top heading, which the index counts twice like every heading.
  // `described`: the text comes from the diagram converter, which has already written the lists after its fences.
  async _indexText({ file, kind, rel, st, sig, text, base, startHeadings, described = false }, breathe) {
    if (this.totalChars >= this.maxLibraryChars || this.index.size >= this.maxLibraryChunks) return 'library size limit reached';
    const info = { sig, kind, rel, mtime: st.mtimeMs, docs: [], chars: 0, redacted: 0 };
    // What is indexed from one file may not be much longer than the file. Lists written after diagram fences are
    // limited to a quarter of a slice (see describeFences); this is the guard behind it, and it covers pictures too.
    const cap = described ? Infinity : Math.ceil(text.length * 1.5) + 65536;
    let headings, first = true, hitCap = false;
    for (const piece of slices(text)) {
      if (info.chars > cap) break;
      if (this.totalChars + info.chars >= this.maxLibraryChars || this.index.size >= this.maxLibraryChunks) { hitCap = true; break; }
      // a diagram fence gets its connections written out in words (in a worker when the slice is large)
      const fenced = described ? piece : await describeFencesAsync(piece);
      await breathe();
      const clean = redactSecrets(fenced);
      if (this.totalChars + info.chars + clean.text.length > this.maxLibraryChars && (this.totalChars > 0 || info.chars > 0)) { hitCap = true; break; }
      info.redacted += clean.count;
      info.chars += clean.text.length;
      const cs = chunkMarkdown(clean.text, first ? (startHeadings ? { noFrontmatter: true, startHeadings } : {}) : { noFrontmatter: true, startHeadings: headings });
      first = false;
      if (cs.length) headings = cs[cs.length - 1].headings;
      for (const c of cs) {
        if (info.docs.length >= MAX_CHUNKS_PER_FILE) break;
        if (this.index.size >= this.maxLibraryChunks) { hitCap = true; break; }
        const head = c.headings.join(' ');
        // File name and headings are counted twice: they are the best summary of a chunk.
        const doc = this.index.add(tokenize(`${base} ${head} ${base} ${head} ${c.text}`));
        this.chunks[doc] = { file, rel, kind, headings: c.headings, text: c.text };
        info.docs.push(doc);
        if ((info.docs.length & 31) === 0) await breathe();
      }
      if (hitCap) break;
      await breathe();
    }
    if (!info.docs.length) {   // a note that is only a title is still findable by it
      if (hitCap) return 'library size limit reached';
      const h = (text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m) || [])[1];
      const doc = this.index.add(tokenize(`${base} ${h || ''} ${base} ${h || ''}`));
      this.chunks[doc] = { file, rel, kind, headings: h ? [h] : [], text: h || base };
      info.docs.push(doc);
    }
    this.totalChars += info.chars;
    this.files.set(file, info);
    return '';
  }

  _removeFile(file) {
    const info = this.files.get(file);
    if (!info) return;
    for (const d of info.docs) { this.index.remove(d); this.chunks[d] = null; }
    this.totalChars = Math.max(0, this.totalChars - (info.chars || 0));
    this.files.delete(file);
  }

  async _compact(breathe) {
    const index = new Bm25Index();
    const chunks = [];
    let totalChars = 0;
    for (const info of this.files.values()) {
      const docs = [];
      totalChars += info.chars || 0;
      for (const d of info.docs) {
        const c = this.chunks[d];
        if (!c) continue;
        const base = baseName(c.file);
        const head = c.headings.join(' ');
        const n = index.add(tokenize(`${base} ${head} ${base} ${head} ${c.text}`));
        chunks[n] = c; docs.push(n);
        if ((docs.length & 63) === 0) await breathe();
      }
      info.docs = docs;
    }
    this.index = index;
    this.chunks = chunks;
    this.totalChars = totalChars;
  }

  // What the Knowledge page shows.
  summary() {
    let workFiles = 0, workChunks = 0, workChars = 0, meetingChunks = 0;
    for (const f of this.files.values()) {
      if (f.kind === 'work') { workFiles++; workChunks += f.docs.length; workChars += f.chars; } else meetingChunks += f.docs.length;
    }
    return { workFiles, workChunks, workChars, meetingChunks };
  }

  // The files under the folders marked "always include", as whole documents, for every answer: a small folder of
  // facts cannot then be missed by a word search. Newest files first until `maxChars` is used up; a file that does not fit is
  // left out whole (counted in `omitted`), never cut. Sorted by name afterwards so the same text leads every request.
  pinned(dirs, { maxChars = PINNED_MAX_CHARS } = {}) {
    const roots = (Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && d);
    const list = [];
    if (roots.length) {
      for (const [file, info] of this.files) {
        if (info.kind === 'work' && roots.some((r) => within(r, file))) list.push({ file, rel: info.rel, mtime: info.mtime, docs: info.docs });
      }
    }
    list.sort((a, b) => b.mtime - a.mtime || String(a.rel).localeCompare(String(b.rel)));
    const items = [];
    let used = 0, omitted = 0, newestMs = 0;
    for (const f of list) {
      const text = f.docs.map((d) => this.chunks[d]).filter(Boolean).map((c) => (c.headings.length ? `[${c.headings.join(' > ')}]\n` : '') + c.text).join('\n\n');
      if (!text) continue;
      if (used + text.length > maxChars) { omitted++; continue; }
      used += text.length;
      newestMs = Math.max(newestMs, f.mtime);
      items.push({ file: f.file, rel: f.rel, text });
    }
    items.sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
    return { items, files: new Set(items.map((i) => i.file)), chars: used, omitted, newestMs };
  }

  search(query, { k = 6, maxChars = 6000, perFile = 3, exclude = null } = {}) {
    let excluded = null;
    if (exclude && (Array.isArray(exclude) || exclude instanceof Set || typeof exclude[Symbol.iterator] === 'function')) {
      const keys = [...exclude].filter((x) => typeof x === 'string' && x).map((x) => pathKey(x));
      if (keys.length) excluded = new Set(keys);
    }
    const tokens = tokenize(query);
    const terms = [...new Set(tokens)];
    const candidateLimit = excluded ? Math.max(k * 8, k * 4 + excluded.size * Math.max(1, perFile) * 2) : k * 4;
    const hits = this.index.search(tokens, candidateLimit); // repeats count: a question said twice outweighs the talk around it
    // How many distinct query terms each candidate passage holds: a passage sharing one word with the question
    // can still score well on a rare word, and a caller deciding how much to trust a hit needs to tell the two apart.
    const matched = new Map(hits.map((h) => [h.doc, 0]));
    for (const t of terms) {
      const p = this.index.postings.get(t);
      if (p) for (let i = 0; i < p.length; i += 2) if (matched.has(p[i])) matched.set(p[i], matched.get(p[i]) + 1);
    }
    const out = [];
    const perFileCount = new Map();
    let used = 0;
    for (const h of hits) {
      const c = this.chunks[h.doc];
      if (!c) continue;
      if (excluded && (excluded.has(pathKey(c.file)) || excluded.has(pathKey(c.rel)))) continue;
      const n = perFileCount.get(c.file) || 0;
      if (n >= perFile) continue;
      if (used + c.text.length > maxChars && out.length) continue;
      perFileCount.set(c.file, n + 1);
      used += c.text.length;
      out.push({ ...c, score: h.score, matched: matched.get(h.doc) });
      if (out.length >= k) break;
    }
    return out;
  }

  // The sample the profile is written from. A whole library cannot go into one
  // request, so it is a mix: the newest files (who you are now) and an even
  // spread over everything older (how you got here). The result says how much
  // of the library it covers, so the screen can too.
  async sampleForProfile(budgetChars = 240000) {
    const work = [...this.files.entries()].filter(([, i]) => i.kind === 'work').map(([file, i]) => ({ file, ...i }));
    work.sort((a, b) => b.mtime - a.mtime);
    // Alternate "next newest" with a point on a golden-ratio walk over the whole
    // list: any number of steps of that walk is spread evenly over all of the
    // history, so however much fits, old and new are both represented.
    const order = [];
    const seen = new Set();
    for (let i = 0; i < work.length; i++) {
      const spread = work[Math.floor(((i * 0.6180339887498949) % 1) * work.length)];
      for (const f of [work[i], spread]) if (f && !seen.has(f.file)) { seen.add(f.file); order.push(f); }
    }
    const parts = [];
    let used = 0, round = 0, added = true;
    while (added && used < budgetChars) {
      added = false;
      for (let i = 0; i < order.length && used < budgetChars; i++) {
        const c = this.chunks[order[i].docs[round]];
        if (!c) continue;
        const piece = (c.headings.length ? `[${c.headings.join(' > ')}]\n` : '') + c.text;
        (parts[i] = parts[i] || []).push(piece); used += piece.length; added = true;
      }
      round++;
    }
    const includedFiles = order.filter((_, i) => parts[i] && parts[i].length);
    // What a file says can be anything (an architecture file is read from a stranger's repository), so its text and
    // its name are defused here, once, before the wrapper tags go around them; the profile prompt then takes it as it is.
    const name = (rel) => inert(rel).replace(/["\r\n]+/g, ' ').replace(/[<>]/g, '');
    const text = order.map((f, i) => (parts[i] && parts[i].length ? `<file path="${name(f.rel)}">\n${inert(parts[i].join('\n\n'))}\n</file>` : '')).filter(Boolean).join('\n\n');
    const chunksTotal = work.reduce((n, f) => n + f.docs.length, 0);
    const chunksIncluded = parts.reduce((n, p) => n + (p ? p.length : 0), 0);
    return { text, safe: true, files: includedFiles.length, filesTotal: work.length, chunksIncluded, chunksTotal, chars: text.length };
  }

  // Whether a change reported by the watcher (a path under a source folder) can matter to the index.
  _worthALook(name) {
    if (!name) return true;
    const parts = String(name).split(/[\\/]/);
    const leaf = parts.pop();
    if (parts.some(isSkippedDir)) return false;   // Google Drive's temporary folders, .git, node_modules, ...
    if (!leaf || leaf.startsWith('_') || isJunk(leaf)) return false;               // a sync client's scratch file is not a change to a note
    return wanted(leaf) || (Boolean(this.imageReader) && isImage(leaf));
  }

  // One timer for "look again soon": a watcher event always (re)starts it with the short delay; the wait for
  // pictures that are still queued only takes it when nothing is due already, so passes can never pile up.
  _schedule(ms, onlyIfIdle = false) {
    if (onlyIfIdle && this._armed) return;
    clearTimeout(this._timer);
    this._armed = true;
    this._timer = setTimeout(() => { this._armed = false; if (this.onChange) this.onChange(); }, ms);
    if (this._timer.unref) this._timer.unref();
  }

  watch(onChange) {
    this._closeWatchers();   // not the timer: a retry for pictures set during the pass that just ended must survive this
    this.onChange = onChange;
    const covered = [];
    // A recursive watch already sees everything below it, so a folder inside another one needs none of its own.
    for (const src of [...this.folders].sort((a, b) => String(a.dir).length - String(b.dir).length)) {
      if (covered.some((d) => within(d, src.dir))) continue;
      try {
        const w = fs.watch(src.dir, { recursive: true }, (_ev, name) => {
          if (this._worthALook(name)) this._schedule(2500);
        });
        w.on('error', () => {});
        this.watchers.push(w);
        covered.push(src.dir);
      } catch { /* folder missing or recursive watch unsupported: manual reindex still works */ }
    }
  }

  _closeWatchers() {
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
  }

  unwatch() {
    this._closeWatchers();
    clearTimeout(this._timer);
    this._armed = false;
  }
}

module.exports = { Library, buildSources, countNoteFiles, samePath, isJunk, PINNED_MAX_CHARS, MAX_LIBRARY_CHARS, MAX_LIBRARY_CHUNKS };
