'use strict';
// A screenshot inside the Notes folder keeps its description in the note beside it ("shot.png" -> "shot.md"), between
// two markers that say it is generated. That note is an ordinary file: it travels through a sync service, Claude reads
// it like any note, the library indexes it once as a note, and a PC that finds it there never asks the model again.
// A picture in any other folder is read as before (cache only, indexed from the reader's result).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inbox = require('../src/main/notes-inbox');
const { Library, buildSources } = require('../src/main/knowledge/library');
const { createImageReader } = require('../src/main/knowledge/images');
const { inert } = require('../src/main/prompts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-shots-'));
const NOW = new Date(2026, 10, 15, 10, 30, 45).getTime();
const png = (extra = 0, fill = 7) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\0\0\0\rIHDR'), Buffer.alloc(extra, fill)]);
const jpg = (n = 32) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 1)]);
const put = (dir, rel, data) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const sibOf = (img) => img.replace(/\.(png|jpe?g|webp|gif)$/i, '.md');
const tree = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(dir, f).split(path.sep).join('/')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};
const OPEN = /^<!-- understudy:screenshot-description sha256=([0-9a-f]{16})[^\r\n]*-->$/gm;
const CLOSE = /^<!-- \/understudy:screenshot-description -->$/gm;
const count = (re, s) => [...s.matchAll(re)].length;

const SHOWS = '## Text in the image\nError E-4711: scanner timed out\n\n## What it shows\nA build page with a quokkafish pipeline.';

// A model that answers from `script(n, opts)` and keeps a record; the real reader sits on top of it, so the cache,
// the allowance and the hashing are the real ones.
function fakeLlm(script = () => SHOWS) {
  const calls = [];
  return { calls, describe: () => 'test-model', async streamChat(role, opts) { calls.push(opts); const t = await script(calls.length, opts); if (t instanceof Error) throw t; return { text: t, cost: 0.01 }; } };
}
// Notes folder, another folder, a cache, a model and a library that reads them all.
function rig({ llm = fakeLlm(), on = true, maxPerPass = 40 } = {}) {
  const root = tmp();
  const notes = path.join(root, 'Notes');
  const other = path.join(root, 'Other');
  fs.mkdirSync(other, { recursive: true });
  const state = { on };
  const reader = createImageReader({ llm, cacheDir: path.join(root, 'cache'), enabled: () => state.on, maxPerPass });
  const sources = buildSources({ folders: [other], includeMeetings: false, notesDir: notes });
  const fresh = () => new Library({ imageReader: createImageReader({ llm, cacheDir: path.join(root, 'cache'), enabled: () => state.on, maxPerPass }) });
  const lib = new Library({ imageReader: reader });
  return { root, notes, other, llm, reader, lib, sources, state, fresh };
}
const passes = async (lib, sources, n = 1) => { let s; for (let i = 0; i < n; i++) s = await lib.reindex(sources); return s; };
const hashOf = (f) => inbox.imageHash(f);

// ---------------------------------------------------------------- the basics

test('the Notes source is marked, and the person\'s own folders are not', () => {
  const s = buildSources({ folders: ['C:\\Docs'], includeMeetings: true, meetingsDir: 'C:\\Meetings', notesDir: 'C:\\Notes' });
  assert.deepEqual(s.map((x) => [x.label, Boolean(x.notes)]), [['Docs', false], ['Meetings', false], ['Notes', true]]);
});

test('a picture in the Notes folder gets a note beside it with a marked section, and the description is searchable once', async () => {
  const r = rig();
  const saved = inbox.saveImage(r.notes, { bytes: png(20), title: 'Build page', note: 'My own words about it.', origin: 'PC2', now: NOW });
  const sib = sibOf(saved.file);
  const before = fs.readFileSync(sib, 'utf8');
  const stats = await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1);
  const after = fs.readFileSync(sib, 'utf8');
  assert.ok(after.startsWith(before), 'what the person typed is untouched');
  const tail = after.slice(before.length);
  assert.match(tail, /^\n<!-- understudy:screenshot-description sha256=[0-9a-f]{16}; [^\n]*-->\n## What the screenshot shows\n\n### Text in the image\nError E-4711: scanner timed out\n\n### What it shows\nA build page with a quokkafish pipeline\.\n\n<!-- \/understudy:screenshot-description -->\n$/);
  assert.equal(tail.match(OPEN)[0].match(/sha256=([0-9a-f]{16})/)[1], hashOf(saved.file), 'the opening marker names the picture by hash');
  // One file in the library: the note. The picture is not indexed on its own.
  assert.deepEqual([...r.lib.files.keys()], [sib]);
  assert.equal(stats.files, 1);
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711')).length, 1, 'the text is in the library once');
  const hit = r.lib.search('E-4711 scanner timed out')[0];
  assert.equal(hit.file, sib);
  assert.equal(hit.headings[0], 'Build page');
  assert.ok(!r.lib.chunks.some((c) => c && /understudy:screenshot-description|sha256/.test(c.text)), 'the markers are bookkeeping, not text');
  assert.equal(r.lib.search('my own words about it').length >= 1, true, 'the person\'s text is still there');
  // Nothing more happens on later passes, here or after a restart.
  await passes(r.lib, r.sources, 2);
  assert.equal(r.llm.calls.length, 1);
  assert.equal(fs.readFileSync(sib, 'utf8'), after);
  const again = r.fresh();
  await again.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1, 'a restarted app finds the description in the note');
  assert.equal(fs.readFileSync(sib, 'utf8'), after);
  assert.equal(again.chunks.filter((c) => c && c.text.includes('E-4711')).length, 1);
});

test('a picture dropped in by hand gets a note like the one saveImage writes, with a title from its name, listed once and readable', async () => {
  const r = rig();
  const dropped = put(r.notes, '2026-11/Screenshot 2026-11-15 101010.png', png(30));
  const typed = inbox.saveImage(r.notes, { bytes: png(40), title: 'Deploy error', origin: 'PC2', now: NOW });   // a picture with no note typed
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 2);
  const raw = fs.readFileSync(sibOf(dropped), 'utf8');
  assert.match(raw, /^---\ntitle: Screenshot 2026-11-15 101010\ndate: \S+\nsource: screenshot\norigin: \S+\nimage: Screenshot 2026-11-15 101010\.png\n---\n\n!\[Screenshot 2026-11-15 101010\]\(<Screenshot 2026-11-15 101010\.png>\)\n\n<!-- understudy:screenshot-description /);
  assert.equal(count(OPEN, raw), 1);
  assert.equal(count(CLOSE, raw), 1);
  const list = inbox.listNotes(r.notes);
  assert.equal(list.length, 2, 'one entry per picture, not a note and a generated twin');
  assert.deepEqual(list.map((n) => n.title).sort(), ['Deploy error', 'Screenshot 2026-11-15 101010']);
  assert.ok(list.every((n) => n.source === 'screenshot' && n.rel.endsWith('.md')));
  const note = inbox.readNote(r.notes, list.find((n) => n.title === 'Deploy error').rel);
  assert.match(note.text, /^!\[Deploy error\]\(<2026-11-15 1030 Deploy error\.png>\)/);
  assert.ok(note.text.includes('Error E-4711: scanner timed out') && note.text.includes('quokkafish'), 'Claude reads the description with readNote');
  assert.equal(note.title, 'Deploy error');
  assert.equal(inbox.readNote(r.notes, list.find((n) => /Screenshot/.test(n.title)).rel).text.includes('quokkafish'), true);
  assert.deepEqual(tree(r.notes).filter((f) => /\.tmp$/.test(f)), [], 'no temporary file left behind');
  assert.equal(typed.rel.endsWith('.png'), true);
});

test('a note the person typed keeps every byte outside the markers, whatever its line endings, and a changed picture replaces only the section', async () => {
  const r = rig();
  const user = 'Remember to compare this with the March run.\n\nSecond paragraph, no final newline.';
  const saved = inbox.saveImage(r.notes, { bytes: png(20), title: 'Build page', note: user, origin: 'PC2', now: NOW });
  const sib = sibOf(saved.file);
  const before = fs.readFileSync(sib, 'utf8');
  await r.lib.reindex(r.sources);
  const first = fs.readFileSync(sib, 'utf8');
  assert.ok(first.startsWith(before));
  // Somebody (Claude's update_note, or the person) writes more after the section.
  inbox.updateNote(r.notes, saved.rel.replace(/\.png$/, '.md'), { text: 'Added later, after the description.', mode: 'append', now: NOW + 1000 });
  const mid = fs.readFileSync(sib, 'utf8');
  const open = mid.search(/^<!-- understudy:screenshot-description/m);
  const closeAt = mid.indexOf('<!-- /understudy:screenshot-description -->') + '<!-- /understudy:screenshot-description -->'.length;
  const head = mid.slice(0, open), foot = mid.slice(closeAt);
  assert.ok(foot.includes('Added later, after the description.'));
  // The picture is replaced by another one with the same name.
  fs.writeFileSync(saved.file, png(900, 9));
  r.llm.calls.length = 0;
  const llm2 = r.llm;
  const script = llm2.streamChat.bind(llm2);
  llm2.streamChat = async (role, opts) => { await script(role, opts); return { text: '## What it shows\nA walrusfact dashboard.', cost: 0 }; };
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1, 'one request for the changed picture');
  const next = fs.readFileSync(sib, 'utf8');
  assert.ok(next.startsWith(head) && next.endsWith(foot), 'everything outside the section is byte for byte the same');
  assert.equal(count(OPEN, next), 1);
  assert.equal(count(CLOSE, next), 1);
  assert.equal(next.match(OPEN)[0].match(/sha256=([0-9a-f]{16})/)[1], hashOf(saved.file));
  assert.ok(next.includes('walrusfact') && !next.includes('quokkafish'), 'the old description is gone from the note');
  assert.equal(r.lib.search('quokkafish').length, 0, 'and from the library');
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('walrusfact')).length, 1);
  assert.deepEqual([...r.lib.files.keys()], [sib]);
});

test('a note with Windows line endings keeps them, and the section is written the same way', async () => {
  const r = rig();
  const img = put(r.notes, '2026-11/2026-11-15 1030 Win note.png', png(20));
  const crlf = '---\r\ntitle: Win note\r\ndate: 2026-11-15T10:30:00+00:00\r\nsource: screenshot\r\norigin: PC2\r\nimage: 2026-11-15 1030 Win note.png\r\n---\r\n\r\n![Win note](<2026-11-15 1030 Win note.png>)\r\n\r\nWords from a Windows editor.\r\n';
  put(r.notes, '2026-11/2026-11-15 1030 Win note.md', crlf);
  await r.lib.reindex(r.sources);
  let raw = fs.readFileSync(sibOf(img), 'utf8');
  assert.ok(raw.startsWith(crlf));
  assert.equal(/(^|[^\r])\n/.test(raw), false, 'every line break is CRLF');
  assert.equal(count(OPEN, raw.replace(/\r\n/g, '\n')), 1);
  // Replaced after the picture changes: still CRLF, nothing else moved.
  fs.writeFileSync(img, png(500, 3));
  await r.lib.reindex(r.sources);
  raw = fs.readFileSync(sibOf(img), 'utf8');
  assert.ok(raw.startsWith(crlf));
  assert.equal(/(^|[^\r])\n/.test(raw), false);
  assert.equal(count(OPEN, raw.replace(/\r\n/g, '\n')), 1);
  assert.equal(r.llm.calls.length, 2);
});

// ---------------------------------------------------------------- no double work, on any PC

test('a note that arrived from another PC with the description in it: no request, no allowance used, one searchable copy', async () => {
  const r = rig({ maxPerPass: 1 });
  const a = put(r.notes, '2026-11/a.png', png(20, 1));
  const b = put(r.notes, '2026-11/b.png', png(20, 2));
  const c = put(r.notes, '2026-11/c.png', png(20, 3));
  // PC 3 described a.png and Google Drive brought the note along with the picture.
  assert.equal(inbox.writeImageDescription(r.notes, a, { hash: hashOf(a), markdown: 'Remote description of zebrapanel.', origin: 'PC3', mtimeMs: NOW }), 'created');
  const note = fs.readFileSync(sibOf(a), 'utf8');
  const stats = await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1, 'only one of the other two could be asked for: a.png did not use the allowance');
  assert.equal(stats.pendingImages, 1);
  assert.equal(fs.readFileSync(sibOf(a), 'utf8'), note, 'the arrived note is not touched');
  assert.equal(r.lib.chunks.filter((x) => x && x.text.includes('zebrapanel')).length, 1);
  assert.equal(r.lib.search('zebrapanel')[0].file, sibOf(a));
  assert.equal(r.lib.files.has(a), false);
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 2, 'the second pass takes the one that waited');
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 2);
  assert.ok(fs.existsSync(sibOf(b)) && fs.existsSync(sibOf(c)));
});

test('the same picture on a PC whose setting is off: the arrived note is indexed like any note and nothing is sent or written', async () => {
  const r = rig({ on: false });
  const a = put(r.notes, '2026-11/a.png', png(20, 1));
  const lone = put(r.notes, '2026-11/lone.png', png(20, 2));
  inbox.writeImageDescription(r.notes, a, { hash: hashOf(a), markdown: 'Remote description of zebrapanel.', origin: 'PC3', mtimeMs: NOW });
  const names = tree(r.notes);
  await passes(r.lib, r.sources, 2);
  assert.equal(r.llm.calls.length, 0);
  assert.equal(r.lib.search('zebrapanel').length, 1);
  assert.deepEqual(tree(r.notes), names, 'nothing was written');
  assert.equal(fs.existsSync(sibOf(lone)), false);
  assert.equal(fs.existsSync(path.join(r.root, 'cache')), false);
  // Switched on later: the one with no note is read and gets its note, the other is left alone.
  r.state.on = true;
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1);
  assert.ok(fs.existsSync(sibOf(lone)));
  assert.equal(r.lib.chunks.filter((x) => x && x.text.includes('zebrapanel')).length, 1);
});

test('with a reader that answers null (feature off) a note beside a picture is still indexed and nothing is written', async () => {
  const dir = tmp();
  const img = put(dir, 'n/a.png', png(20));
  inbox.writeImageDescription(dir, img, { hash: hashOf(img), markdown: 'Text from elsewhere: quokkafish.', origin: 'PC3', mtimeMs: NOW });
  put(dir, 'n/b.png', png(21));
  const reader = { calls: [], resetPass() {}, async read(f) { this.calls.push(path.basename(f)); return null; }, stats: () => ({}) };
  const lib = new Library({ imageReader: reader });
  const before = tree(dir);
  const s = await lib.reindex(buildSources({ notesDir: dir }));
  assert.equal(lib.search('quokkafish').length, 1);
  assert.deepEqual(s.skipped, []);
  assert.deepEqual(tree(dir), before);
  assert.ok(!reader.calls.includes('a.png'), 'a picture already described is not even offered to the reader');
});

test('the description is in the local cache but not in a note: the note is written with no request', async () => {
  const r = rig();
  const outside = put(r.other, 'same.png', png(20));
  const inside = put(r.notes, '2026-11/copy.png', fs.readFileSync(outside));
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 1, 'two pictures, one request: the second came from the cache');
  const raw = fs.readFileSync(sibOf(inside), 'utf8');
  assert.ok(raw.includes('quokkafish'));
  // The picture in the person\'s own folder: no note, indexed from the reader's result, as before.
  assert.equal(fs.existsSync(sibOf(outside)), false);
  assert.deepEqual(fs.readdirSync(r.other), ['same.png']);
  assert.ok(r.lib.files.has(outside) && r.lib.files.has(sibOf(inside)) && !r.lib.files.has(inside));
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711') && c.file === outside).length >= 1, true);
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711') && c.file === sibOf(inside)).length, 1, 'once in the note');
  // A new app with the same cache and an empty Notes folder copy: still no request.
  fs.unlinkSync(sibOf(inside));
  await r.fresh().reindex(r.sources);
  assert.equal(r.llm.calls.length, 1);
  assert.ok(fs.existsSync(sibOf(inside)));
});

test('pictures in the person\'s own folders never get a note', async () => {
  const r = rig();
  put(r.other, 'sub/shot.png', png(20));
  put(r.other, 'sub/shot.md', '# My own note about the shot\n\nkeep me exactly\n');
  const note = fs.readFileSync(path.join(r.other, 'sub', 'shot.md'), 'utf8');
  const before = tree(r.other);
  await passes(r.lib, r.sources, 2);
  assert.deepEqual(tree(r.other), before);
  assert.equal(fs.readFileSync(path.join(r.other, 'sub', 'shot.md'), 'utf8'), note);
  assert.equal(r.llm.calls.length, 1);
  assert.ok(r.lib.files.has(path.join(r.other, 'sub', 'shot.png')), 'indexed from the reader\'s result, as before');
  // And a library with no Notes source at all writes nothing anywhere.
  const lone = tmp();
  put(lone, 'x.png', png(20));
  await new Library({ imageReader: createImageReader({ llm: fakeLlm(), cacheDir: path.join(lone, '..', 'c-' + path.basename(lone)), enabled: () => true }) }).reindex([{ dir: lone, label: 'x', kind: 'work' }]);
  assert.deepEqual(fs.readdirSync(lone), ['x.png']);
});

// ---------------------------------------------------------------- changes and deletions

test('a deleted picture leaves its note, and the note stays indexed', async () => {
  const r = rig();
  const saved = inbox.saveImage(r.notes, { bytes: png(20), title: 'Build page', note: 'Words of my own.', origin: 'PC2', now: NOW });
  await r.lib.reindex(r.sources);
  fs.unlinkSync(saved.file);
  await passes(r.lib, r.sources, 2);
  const sib = sibOf(saved.file);
  assert.ok(fs.existsSync(sib));
  assert.equal(r.lib.search('quokkafish pipeline')[0].file, sib);
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711')).length, 1);
  assert.equal(r.llm.calls.length, 1);
  assert.equal(inbox.listNotes(r.notes).length, 1);
});

test('a picture replaced under the same name is described afresh once, and a restarted app does not redo it', async () => {
  const r = rig({ llm: fakeLlm((n) => `## What it shows\nReading number ${n} about ${n === 1 ? 'quokkafish' : 'walrusfact'}.`) });
  const img = put(r.notes, '2026-11/chart.png', png(20));
  await r.lib.reindex(r.sources);
  assert.equal(r.lib.search('quokkafish').length, 1);
  fs.writeFileSync(img, png(300, 5));
  await r.lib.reindex(r.sources);
  assert.equal(r.llm.calls.length, 2);
  assert.equal(r.lib.search('quokkafish').length, 0);
  assert.equal(r.lib.search('walrusfact').length, 1);
  const raw = fs.readFileSync(sibOf(img), 'utf8');
  assert.equal(count(OPEN, raw), 1);
  await r.fresh().reindex(r.sources);
  assert.equal(r.llm.calls.length, 2);
  assert.equal(fs.readFileSync(sibOf(img), 'utf8'), raw);
});

test('pending and skipped pictures leave no half-written note and no temporary file', async () => {
  const dir = tmp();
  put(dir, '2026-11/a.png', png(20, 1)); put(dir, '2026-11/b.png', png(20, 2)); put(dir, '2026-11/c.png', png(20, 3));
  put(dir, '2026-11/keep.md', '# Keep\n\nmy text\n');
  const before = tree(dir);
  const reader = { resetPass() {}, async read(f) { return /a\.png/.test(f) ? { pending: true } : /b\.png/.test(f) ? { skip: 'too large (over 5 MB)' } : { skip: 'not read: no key' }; }, stats: () => ({}) };
  const lib = new Library({ imageReader: reader });
  try {
    const s = await lib.reindex(buildSources({ notesDir: dir }));
    assert.deepEqual(tree(dir), before);
    assert.equal(s.pendingImages, 1);
    assert.equal(s.skipped.length, 2);
    assert.equal(lib.files.size, 1);
  } finally { lib.unwatch(); }
  // And through the real reader with an allowance of nothing.
  const r = rig({ maxPerPass: 0 });
  put(r.notes, 'x.png', png(20));
  try { await r.lib.reindex(r.sources); assert.deepEqual(tree(r.notes), ['x.png']); } finally { r.lib.unwatch(); }
});

test('a note that changes while the model is working is skipped this time and written on the next pass, with no second request', async () => {
  let sib = '';
  const llm = fakeLlm(() => { fs.appendFileSync(sib, '\nA line the person added meanwhile.\n'); return SHOWS; });
  const r = rig({ llm });
  const saved = inbox.saveImage(r.notes, { bytes: png(20), title: 'Build page', note: 'First words.', origin: 'PC2', now: NOW });
  sib = sibOf(saved.file);
  try {
    await r.lib.reindex(r.sources);
    const mid = fs.readFileSync(sib, 'utf8');
    assert.ok(mid.includes('A line the person added meanwhile.'));
    assert.equal(count(OPEN, mid), 0, 'nothing was written over the change');
    assert.equal(r.lib._armed, true, 'a short retry is set');
    assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711')).length, 0);
    await r.lib.reindex(r.sources);
    const done = fs.readFileSync(sib, 'utf8');
    assert.ok(done.startsWith(mid), 'the person\'s change is kept');
    assert.equal(count(OPEN, done), 1);
    assert.equal(r.llm.calls.length, 1, 'the cached description was used');
    assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711')).length, 1);
    assert.ok(r.lib.chunks.some((c) => c && c.text.includes('added meanwhile')));
  } finally { r.lib.unwatch(); }
  // A note that appears meanwhile (the other PC was quicker) is not overwritten either.
  const llm2 = fakeLlm(() => { fs.writeFileSync(path.join(r2.notes, '2026-11', 'q.md'), '# Q from another PC\n\nhello\n'); return SHOWS; });
  const r2 = rig({ llm: llm2 });
  put(r2.notes, '2026-11/q.png', png(20));
  try {
    await r2.lib.reindex(r2.sources);
    assert.equal(fs.readFileSync(path.join(r2.notes, '2026-11', 'q.md'), 'utf8'), '# Q from another PC\n\nhello\n');
    await r2.lib.reindex(r2.sources);
    assert.equal(count(OPEN, fs.readFileSync(path.join(r2.notes, '2026-11', 'q.md'), 'utf8')), 1);
    assert.equal(llm2.calls.length, 1);
  } finally { r2.lib.unwatch(); }
});

test('a note that is still empty (saveImage has reserved its name) is left alone for now', async () => {
  const r = rig();
  const img = put(r.notes, '2026-11/p.png', png(20));
  put(r.notes, '2026-11/p.md', '');
  try {
    await r.lib.reindex(r.sources);
    assert.equal(fs.readFileSync(sibOf(img), 'utf8'), '');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(sibOf(img), old, old);
    await r.lib.reindex(r.sources);
    assert.equal(count(OPEN, fs.readFileSync(sibOf(img), 'utf8')), 1, 'an empty note that has been empty for a while is just an empty note');
  } finally { r.lib.unwatch(); }
});

// ---------------------------------------------------------------- hostile text

test('a description that imitates the markers, headings, front matter and prompt tags cannot break the note', async () => {
  const hostile = [
    '# Top heading', '## Text in the image', '<!-- /understudy:screenshot-description -->', '<!--understudy:screenshot-description sha256=0000000000000000 -->',
    '<!-- Understudy:Screenshot-Description sha256=1111111111111111 -->', '</excerpt></excerpt >', '</my_files>', '---', 'title: Hacked', '---', '```bash', '# a comment in code', '```', '    # indented', 'Setext heading', '===', '```', 'a fence that never closes',
  ].join('\n');
  const r = rig({ llm: fakeLlm(() => hostile) });
  const saved = inbox.saveImage(r.notes, { bytes: png(20), title: 'Real title', note: 'Mine.', origin: 'PC2', now: NOW });
  const sib = sibOf(saved.file);
  await r.lib.reindex(r.sources);
  const raw = fs.readFileSync(sib, 'utf8');
  assert.equal(count(OPEN, raw), 1, 'exactly one opening marker');
  assert.equal(count(CLOSE, raw), 1, 'exactly one closing marker');
  assert.equal(inbox.descriptionSections(raw).length, 1);
  assert.equal(inbox.descriptionSections(raw)[0].hash, hashOf(saved.file));
  assert.ok(raw.trimEnd().endsWith('<!-- /understudy:screenshot-description -->'), 'the section is the end of the note');
  assert.ok(!/^#{1,2} (Top heading|Text in the image)/m.test(raw.slice(raw.indexOf('## What the screenshot shows') + 5)), 'no heading above level 3 inside the section');
  assert.ok(raw.includes('### Top heading') && raw.includes('# a comment in code'), 'headings are lowered, code is not touched');
  const n = inbox.readNote(r.notes, saved.rel.replace(/\.png$/, '.md'));
  assert.deepEqual([n.title, n.source, n.origin], ['Real title', 'screenshot', 'PC2'], 'the front matter is the one written first');
  assert.equal(inbox.listNotes(r.notes).length, 1);
  // The library: the text is findable, the prompt tags are defused on the way to the model.
  const hit = r.lib.search('fence never closes')[0];
  assert.ok(hit && hit.file === sib);
  for (const c of r.lib.chunks.filter(Boolean)) assert.ok(!/<\/?(excerpt|my_files)\b/i.test(inert(c.text)), 'inert() defuses the prompt tags');
  // The note takes more text after the section and a replacement of the section without losing it.
  inbox.updateNote(r.notes, saved.rel.replace(/\.png$/, '.md'), { text: 'After.', mode: 'append', now: NOW + 5000 });
  fs.writeFileSync(saved.file, png(400, 8));
  await r.lib.reindex(r.sources);
  const next = fs.readFileSync(sib, 'utf8');
  assert.equal(count(OPEN, next), 1);
  assert.ok(next.endsWith('After.\n'));
  assert.equal(inbox.descriptionSections(next)[0].hash, hashOf(saved.file));
});

// ---------------------------------------------------------------- what can go wrong with the note

test('a note that cannot be written to (here: a folder with that name) falls back to indexing from the reader, once', async () => {
  const r = rig();
  const img = put(r.notes, '2026-11/odd.png', png(20));
  fs.mkdirSync(sibOf(img));
  await passes(r.lib, r.sources, 2);
  assert.ok(r.lib.files.has(img), 'indexed from the reader\'s result');
  assert.equal(r.lib.chunks.filter((c) => c && c.text.includes('E-4711')).length, 1);
  assert.equal(r.llm.calls.length, 1);
  assert.ok(fs.statSync(sibOf(img)).isDirectory());
});

test('two pictures with one name and different types do not fight over one note', async () => {
  const r = rig({ llm: fakeLlm((n) => `## What it shows\nPicture number ${n} wordfor${n}.`) });
  const a = put(r.notes, '2026-11/a.png', png(20));
  const b = put(r.notes, '2026-11/a.jpg', jpg());
  await passes(r.lib, r.sources, 3);
  assert.equal(r.llm.calls.length, 2);
  const raw = fs.readFileSync(sibOf(a), 'utf8');
  assert.equal(count(OPEN, raw), 1);
  assert.equal(raw.match(OPEN)[0].match(/sha256=([0-9a-f]{16})/)[1], hashOf(b), 'the first by type (.jpg) owns the note');
  assert.ok(r.lib.files.has(a) && !r.lib.files.has(b), 'the other is indexed from the reader\'s result');
  assert.equal(r.lib.search('wordfor1').length + r.lib.search('wordfor2').length, 2);
  await passes(r.lib, r.sources, 2);
  assert.equal(fs.readFileSync(sibOf(a), 'utf8'), raw, 'stable');
});

test('writeImageDescription stays inside the Notes folder, is idempotent, and refuses what is not a picture hash', () => {
  const notes = path.join(tmp(), 'Notes');
  const outside = put(path.dirname(notes), 'Other/x.png', png(20));
  const img = put(notes, 'a/x.png', png(20));
  const h = hashOf(img);
  assert.equal(inbox.writeImageDescription(notes, outside, { hash: h, markdown: 'text' }), 'failed', 'outside the Notes folder');
  assert.equal(fs.existsSync(sibOf(outside)), false);
  assert.equal(inbox.writeImageDescription(notes, img, { hash: 'nothex', markdown: 'text' }), 'failed');
  assert.equal(inbox.writeImageDescription(notes, img, { hash: h, markdown: '  \n ' }), 'failed');
  assert.equal(inbox.writeImageDescription(notes, img, { hash: h, markdown: 'text', expected: 'something else' }), 'changed');
  assert.equal(inbox.writeImageDescription(notes, img, { hash: h, markdown: 'text', expected: null }), 'created');
  assert.equal(inbox.writeImageDescription(notes, img, { hash: h, markdown: 'text' }), 'present');
  assert.equal(inbox.writeImageDescription(notes, img, { hash: '0123456789abcdef', markdown: 'other text' }), 'written');
  const raw = fs.readFileSync(sibOf(img), 'utf8');
  assert.equal(count(OPEN, raw), 1);
  assert.ok(raw.includes('other text') && !/\btext\n/.test(raw.replace('other text', '')));
  assert.equal(inbox.imageHash(path.join(notes, 'a', 'missing.png')), '');
  assert.equal(inbox.imageHash(put(notes, 'a/fake.png', 'not an image at all, only text')), '');
  assert.equal(inbox.withoutDescriptionMarkers('a\n<!-- understudy:screenshot-description sha256=0123456789abcdef; x -->\nb\n<!-- /understudy:screenshot-description -->\n'), 'a\nb\n');
});
