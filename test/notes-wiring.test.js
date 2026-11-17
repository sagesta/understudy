'use strict';
// The notes bridge in the main process: what the windows may send (validate.js), the library's side of it
// (pictures, sync leftovers, overlapping folders, note front matter), and the glue in main.js, which
// cannot be required outside Electron and is therefore cut out of its text and run against stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../src/main/validate');
const inbox = require('../src/main/notes-inbox');
const { Library, buildSources, countNoteFiles, isJunk } = require('../src/main/knowledge/library');
const { DEFAULTS } = require('../src/main/settings');
const { MODES } = require('../src/main/triggers');
const { PROVIDERS: STT_PROVIDERS } = require('../src/main/stt');
const { PROVIDERS: LLM_PROVIDERS } = require('../src/main/llm');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-wire-'));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('src/main/main.js');
const between = (a, b) => { const i = mainSrc.indexOf(a), j = mainSrc.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} .. ${b} found in main.js`); return mainSrc.slice(i, j); };
const SETTABLE = new Function(`return ${mainSrc.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();
const ctx = { settable: SETTABLE, autoModes: MODES, sttProviders: Object.keys(STT_PROVIDERS), llmProviders: Object.keys(LLM_PROVIDERS), personalityIds: () => ['default'] };
const sanitise = (raw) => V.sanitiseSettingsPatch(raw, ctx);

const MB = 1024 * 1024;
const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\0\0\0\rIHDR'), Buffer.alloc(extra, 7)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 1)]);
const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

// ---------------------------------------------------------------- data URLs

test('an image data URL is parsed: png, jpeg and webp pass, and the bytes come back as they were', () => {
  for (const [mime, buf] of [['image/png', png()], ['image/jpeg', jpg()], ['image/webp', webp()]]) {
    const r = V.parseImageDataUrl(url(mime, buf));
    assert.equal(r.mime, mime);
    assert.ok(Buffer.isBuffer(r.bytes) && r.bytes.equals(buf));
  }
  assert.equal(V.parseImageDataUrl(url('image/jpg', jpg())).mime, 'image/jpeg', 'image/jpg is the same as image/jpeg');
  assert.equal(V.parseImageDataUrl(url('image/gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]))).mime, 'image/gif');
  assert.equal(V.parseImageDataUrl(url('IMAGE/PNG', png())).mime, 'image/png', 'the label is not case sensitive');
  for (const n of [1, 2, 3, 4, 5]) assert.equal(V.parseImageDataUrl(url('image/png', Buffer.alloc(n, 9))).bytes.length, n, `${n} bytes (padding)`);
});

test('a data URL that is not a base64 image is refused before anything is decoded', () => {
  const b64 = png().toString('base64');
  const bad = [
    `data:text/html;base64,${b64}`, `data:image/svg+xml;base64,${b64}`, `data:application/pdf;base64,${b64}`, `data:image/png,${b64}`, `data:image/png;charset=utf-8;base64,${b64}`,
    `image/png;base64,${b64}`, `https://example.com/a.png`, `file:///C:/a.png`, 'data:image/png;base64,', 'data:', '', b64,
    5, null, undefined, {}, [url('image/png', png())], true,
  ];
  for (const b of bad) assert.throws(() => V.parseImageDataUrl(b), (e) => e instanceof V.ArgError && e.userFacing === true, String(b).slice(0, 40));
  // The right label with something else behind it.
  for (const tail of ['@@@@', 'AAA', 'AAAAA', 'AA=A', 'A===', 'AA AA', 'AA\nAA', 'AAAA\r\n', '=AAA', 'AA%3D%3D', '日本語日']) {
    assert.throws(() => V.parseImageDataUrl(`data:image/png;base64,${tail}`), /could not be read/, JSON.stringify(tail));
  }
});

test('a data URL over 15 MB is refused by its length alone, and one at the limit is not', () => {
  const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((15 * MB) / 3) * 4 + 4)}`;
  assert.throws(() => V.parseImageDataUrl(huge), /too large \(over 15 MB\)/);
  const orig = Buffer.from;
  let decoded = false;
  Buffer.from = function (v, enc) { if (enc === 'base64') decoded = true; return orig.apply(this, arguments); };
  try { assert.throws(() => V.parseImageDataUrl(huge), /too large/); } finally { Buffer.from = orig; }
  assert.equal(decoded, false, 'nothing was decoded');
  const atLimit = png(15 * MB - png().length);
  assert.equal(atLimit.length, 15 * MB);
  assert.equal(V.parseImageDataUrl(url('image/png', atLimit)).bytes.length, 15 * MB);
  assert.throws(() => V.parseImageDataUrl(url('image/png', Buffer.concat([atLimit, Buffer.from([1])]))), /too large/);
  assert.throws(() => V.parseImageDataUrl(url('image/png', Buffer.alloc(11)), 10), /too large/, 'a smaller limit can be given');
  assert.equal(V.parseImageDataUrl(url('image/png', Buffer.alloc(10)), 10).bytes.length, 10);
});

// ---------------------------------------------------------------- the arguments of each channel

test('notes:add takes a title (optional) and text, and nothing else gets through', () => {
  assert.deepEqual(V.cleanNoteAdd({ title: 'Keys', text: 'Rotate monthly.' }), { title: 'Keys', text: 'Rotate monthly.' });
  assert.deepEqual(V.cleanNoteAdd({ text: 'No title' }), { title: '', text: 'No title' });
  assert.deepEqual(V.cleanNoteAdd({ title: null, text: 'x' }), { title: '', text: 'x' });
  assert.deepEqual(Object.keys(V.cleanNoteAdd({ title: 'T', text: 'x', source: 'claude', dir: 'C:\\evil', rel: '../x' })).sort(), ['text', 'title']);
  for (const arg of [undefined, null, 5, 'text', [], [{ text: 'x' }], true]) assert.throws(() => V.cleanNoteAdd(arg), /Write something to save first/, String(arg));
  for (const text of [undefined, null, 5, {}, ['x']]) assert.throws(() => V.cleanNoteAdd({ title: 'T', text }), /Write something to save first/);
  for (const title of [5, {}, ['T'], true]) assert.throws(() => V.cleanNoteAdd({ title, text: 'x' }), /title must be text/);
  assert.throws(() => V.cleanNoteAdd({ title: 'x'.repeat(1001), text: 'x' }), /title is too long/);
  assert.equal(V.cleanNoteAdd({ title: 'x'.repeat(1000), text: 'x'.repeat(1000000) }).text.length, 1000000);
  assert.throws(() => V.cleanNoteAdd({ text: 'x'.repeat(1000001) }), /too long to save \(over 1 MB\)/);
});

test('notes:addImage needs a real image data URL; title and note are optional text', () => {
  const ok = V.cleanNoteImage({ dataUrl: url('image/png', png()), title: 'Pipeline error', note: 'seen on PC 3' });
  assert.deepEqual([ok.mime, ok.title, ok.note, ok.bytes.length], ['image/png', 'Pipeline error', 'seen on PC 3', png().length]);
  assert.deepEqual(V.cleanNoteImage({ dataUrl: url('image/png', png()) }).title, '');
  assert.deepEqual(Object.keys(V.cleanNoteImage({ dataUrl: url('image/png', png()), dir: 'C:\\evil' })).sort(), ['bytes', 'mime', 'note', 'title']);
  for (const arg of [undefined, null, 'data:image/png;base64,AAAA', 5, [], { dataUrl: 5 }, { dataUrl: '' }, { bytes: png() }, { dataUrl: 'data:text/plain;base64,AAAA' }]) assert.throws(() => V.cleanNoteImage(arg), (e) => e.userFacing === true, JSON.stringify(arg));
  assert.throws(() => V.cleanNoteImage({ dataUrl: url('image/png', png()), title: 5 }), /title must be text/);
  assert.throws(() => V.cleanNoteImage({ dataUrl: url('image/png', png()), note: {} }), /note must be text/);
  assert.throws(() => V.cleanNoteImage({ dataUrl: url('image/png', png()), note: 'x'.repeat(1000001) }), /too long to save/);
});

test('notes:list takes nothing, a number or { limit }, kept between 1 and 500', () => {
  for (const arg of [undefined, null, {}, { limit: null }]) assert.deepEqual(V.cleanNotesList(arg), { limit: 50 });
  assert.deepEqual(V.cleanNotesList({ limit: 5 }), { limit: 5 });
  assert.deepEqual(V.cleanNotesList(12), { limit: 12 });
  assert.deepEqual(V.cleanNotesList({ limit: 7.8 }), { limit: 7 });
  assert.deepEqual(V.cleanNotesList({ limit: 0 }), { limit: 1 });
  assert.deepEqual(V.cleanNotesList({ limit: -4 }), { limit: 1 });
  assert.deepEqual(V.cleanNotesList({ limit: 9999 }), { limit: 500 });
  for (const limit of ['5', NaN, Infinity, {}, [5], true]) assert.throws(() => V.cleanNotesList({ limit }), /not a number of notes/, String(limit));
  assert.throws(() => V.cleanNotesList('5'), /not a number of notes/);
});

test('meetings:setActionItem and meetings:addUpdate check every argument', () => {
  assert.deepEqual(V.cleanActionItemCall('20261114-143005', 2, 'Send the plan to Priya', true), { id: '20261114-143005', index: 2, text: 'Send the plan to Priya', done: true });
  assert.equal(V.cleanActionItemCall('m', 0, ' x ', false).text, ' x ', 'the text is passed on as it was: the store matches it exactly');
  for (const id of ['', 'a/b', '..', '../x', 'a\\b', 'a b', 5, null, undefined, {}, 'x'.repeat(49)]) assert.throws(() => V.cleanActionItemCall(id, 0, 't', true), /meeting file no longer exists/, String(id));
  for (const i of [-1, 1.5, '1', NaN, Infinity, 100001, null, undefined, {}]) assert.throws(() => V.cleanActionItemCall('m', i, 't', true), /not an action item/, String(i));
  for (const t of ['', 5, null, undefined, {}, 'x'.repeat(4001)]) assert.throws(() => V.cleanActionItemCall('m', 0, t, true), /not an action item/, String(t).slice(0, 20));
  for (const d of ['true', 1, 0, null, undefined, {}]) assert.throws(() => V.cleanActionItemCall('m', 0, 't', d), /whether the action item is done/, String(d));
  assert.equal(V.cleanActionItemCall('m', 0, 'x'.repeat(4000), false).text.length, 4000);

  assert.deepEqual(V.cleanUpdateCall('m1', '  Priya confirmed the date.  '), { id: 'm1', text: 'Priya confirmed the date.' });
  for (const t of ['', '   \n ', 5, null, undefined, {}]) assert.throws(() => V.cleanUpdateCall('m1', t), /Write the update first/, String(t));
  assert.throws(() => V.cleanUpdateCall('m1', 'x'.repeat(2001)), /at most 2,000 characters/);
  assert.equal(V.cleanUpdateCall('m1', 'x'.repeat(2000)).text.length, 2000);
  assert.throws(() => V.cleanUpdateCall('../x', 'ok'), /meeting file no longer exists/);
});

test('error text shown to the person never carries a disk path', () => {
  const nice = Object.assign(new Error('That note is too long to save (over 1 MB).'), { userFacing: true });
  assert.equal(V.userMessage(nice, 'fallback', { strict: true }), nice.message);
  const fs1 = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\a\\Documents\\Understudy\\Notes\\2026-11\\x.md'"), { code: 'EACCES' });
  assert.equal(V.userMessage(fs1, 'fallback', { strict: true }), 'fallback');
  assert.equal(V.userMessage(fs1, 'fallback'), 'fallback');
  assert.equal(V.userMessage(new Error('Cannot read properties of undefined'), 'fallback', { strict: true }), 'fallback', 'a bug in strict mode');
  assert.equal(V.userMessage(new Error('That action item is no longer in the notes.'), 'fallback'), 'That action item is no longer in the notes.', 'a plain store message passes in the loose mode');
  for (const m of ["ENOENT: no such file or directory, open 'D:\\m\\a.md'", 'failed at /home/a/meetings/x.md', 'could not write \\\\server\\share\\x', 'x'.repeat(301), '']) assert.equal(V.userMessage(new Error(m), 'fallback'), 'fallback', m.slice(0, 40));
  assert.equal(V.userMessage(null, 'fallback'), 'fallback');
  assert.equal(V.userMessage('text', 'fallback'), 'fallback');
});

// ---------------------------------------------------------------- settings

test('library.readImages is settable as a true/false value; notesDir is not settable from a window', () => {
  assert.ok(SETTABLE.library.includes('readImages') && SETTABLE.library.includes('includeMeetings'));
  assert.deepEqual(sanitise({ library: { readImages: true } }), { patch: { library: { readImages: true } }, rejected: [] });
  assert.deepEqual(sanitise({ library: { readImages: false, includeMeetings: false } }).patch, { library: { readImages: false, includeMeetings: false } });
  for (const bad of ['true', 'yes', 1, 0, null, {}, []]) {
    const r = sanitise({ library: { readImages: bad, includeMeetings: false }, me: { role: 'Eng' } });
    assert.deepEqual(r.patch, { library: { includeMeetings: false }, me: { role: 'Eng' } }, `a bad readImages beside good values: ${JSON.stringify(bad)}`);
    assert.deepEqual(r.rejected, ['library.readImages']);
  }
  for (const bad of [{ notesDir: 'C:\\elsewhere' }, { library: { notesDir: 'C:\\x' } }, { library: { folders: ['C:\\x'] } }]) assert.deepEqual(sanitise(bad).patch, {}, JSON.stringify(bad));
  assert.equal(DEFAULTS.library.readImages, false);
  assert.equal(DEFAULTS.notesDir, '');
  assert.deepEqual(sanitise(DEFAULTS).rejected, [], 'the defaults fit every rule');
  // On disk: a bad value goes back to the default, the folder list is left alone.
  const fixed = V.repairSettings({ library: { readImages: 'yes', includeMeetings: true, folders: ['C:\\docs'] }, notesDir: 5 }, DEFAULTS, ctx);
  assert.deepEqual(fixed.fixed, ['library.readImages']);
  assert.deepEqual(fixed.patch, { library: { readImages: false } });
});

// ---------------------------------------------------------------- library: pictures

const w = (dir, rel, data) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const work = (dir, label = 'work') => [{ dir, label, kind: 'work' }];

// A reader that answers from `script(file, st, n)` (n counts the calls for that file) and keeps a record.
function fakeReader(script) {
  const calls = [];
  const seen = new Map();
  return {
    calls, resets: 0,
    resetPass() { this.resets++; },
    async read(file, st) { const n = (seen.get(file) || 0) + 1; seen.set(file, n); calls.push(path.basename(file)); return script(file, st, n); },
    stats() { return { described: 0, cached: 0, pending: 0, skipped: 0, cost: 0 }; },
  };
}
const md = (s) => ({ markdown: s });

test('a picture the reader describes is indexed under its file name, with fences described and secrets removed', async () => {
  const dir = tmp();
  w(dir, 'shots/pipeline.png', png(100));
  const reader = fakeReader(() => md('## Text in the image\nError E-4711: scanner timed out\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n\n## What it shows\n```mermaid\ngraph LR\n  A[Alpha] --> B[Beta]\n```\n'));
  const lib = new Library({ imageReader: reader });
  const stats = await lib.reindex(work(dir));
  const hit = lib.search('E-4711 scanner timed out')[0];
  assert.ok(hit && /pipeline\.png$/.test(hit.rel), JSON.stringify(hit));
  assert.equal(hit.headings[0], 'pipeline.png', 'the heading path starts with the file name');
  assert.ok(hit.headings.includes('Text in the image'));
  assert.ok(lib.chunks.filter(Boolean).some((c) => c.text.includes('- Alpha -> Beta')), 'a diagram fence in the description is written out');
  assert.ok(!lib.chunks.filter(Boolean).some((c) => c.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789')), 'the library redacts what the reader let through');
  assert.ok(stats.redacted >= 1);
  assert.equal(stats.files, 1);
  assert.equal(lib.summary().workFiles, 1);
  assert.equal(reader.resets, 1, 'the reader is told a pass begins');
  await lib.reindex(work(dir));
  assert.equal(reader.resets, 2);
});

test('text files are indexed before any picture is read, and an unchanged picture is never sent again', async () => {
  const dir = tmp();
  for (let i = 0; i < 3; i++) w(dir, `n${i}.md`, `# Note ${i}\n\nzebrafact${i}\n`);
  w(dir, 'a.png', png(10)); w(dir, 'b.jpg', jpg());
  let lib, textReady = null;
  const reader = fakeReader(() => { if (textReady === null) textReady = [0, 1, 2].every((i) => lib.search(`zebrafact${i}`).length === 1); return md('## What it shows\nA picture.'); });
  lib = new Library({ imageReader: reader });
  let early = null;
  await lib.reindex(work(dir), { onTextDone: () => { early = lib.stats.files; } });
  assert.equal(textReady, true, 'every note was searchable when the first picture was asked for');
  assert.equal(early, 3, 'the text pass is reported before the pictures');
  assert.deepEqual(reader.calls.sort(), ['a.png', 'b.jpg']);
  await lib.reindex(work(dir));
  await lib.reindex(work(dir));
  assert.equal(reader.calls.length, 2, 'already described: the reader is not asked again');
  assert.equal(lib.files.size, 5);
});

test('an edited picture is read again and its old description goes', async () => {
  const dir = tmp();
  const f = w(dir, 'diagram.png', png(10));
  const reader = fakeReader((_f, _st, n) => md(n === 1 ? 'First reading mentions quokkafish.' : 'Second reading mentions walrusfact.'));
  const lib = new Library({ imageReader: reader });
  await lib.reindex(work(dir));
  assert.equal(lib.search('quokkafish').length, 1);
  fs.writeFileSync(f, png(500));
  await lib.reindex(work(dir));
  assert.equal(reader.calls.length, 2);
  assert.equal(lib.search('quokkafish').length, 0);
  assert.equal(lib.search('walrusfact').length, 1);
  fs.unlinkSync(f);
  await lib.reindex(work(dir));
  assert.equal(lib.search('walrusfact').length, 0, 'a deleted picture is forgotten');
  assert.equal(lib.files.size, 0);
});

test('pending pictures are not indexed, not listed as skipped, and one retry is set for a minute later', async () => {
  const dir = tmp();
  w(dir, 'notes.md', '# Notes\n\nplain text\n');
  w(dir, 'a.png', png(10)); w(dir, 'b.png', png(20));
  let allowed = 0;
  const reader = fakeReader((_f, _st, n) => (allowed-- > 0 ? md(`description number ${n} walrusfact`) : { pending: true }));
  const lib = new Library({ imageReader: reader });
  try {
    allowed = 1;
    const stats = await lib.reindex(work(dir));
    assert.equal(stats.files, 2, 'the note and one picture');
    assert.equal(stats.pendingImages, 1);
    assert.deepEqual(stats.skipped, [], 'waiting is not being left out');
    assert.equal(lib.skipInfo.size, 0, 'and it is not remembered');
    assert.equal(lib._armed, true, 'a later pass is scheduled');
    const timer = lib._timer;
    // Another pass that still has one waiting does not add a second timer.
    allowed = 0;
    const again = await lib.reindex(work(dir));
    assert.equal(again.pendingImages, 1);
    assert.strictEqual(lib._timer, timer, 'one timer, however many passes');
    // The retry (what the timer does) reads the one that was waiting.
    allowed = 5;
    const last = await lib.reindex(work(dir));
    assert.equal(last.files, 3);
    assert.equal(last.pendingImages, 0);
    assert.equal(lib.search('walrusfact').length, 2);
  } finally { lib.unwatch(); }
});

test('the retry timer is the watcher timer: a change seen meanwhile brings it forward, and it is not lost when watching restarts', async () => {
  const dir = tmp();
  w(dir, 'a.png', png(10));
  const lib = new Library({ imageReader: fakeReader(() => ({ pending: true })) });
  let fired = 0;
  try {
    await lib.reindex(work(dir));
    const waiting = lib._timer;
    lib.watch(() => { fired++; });
    assert.strictEqual(lib._timer, waiting, 're-watching keeps the retry that is already set');
    assert.equal(lib._armed, true);
    lib._schedule(5);                // what a watcher event does
    assert.notStrictEqual(lib._timer, waiting);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fired, 1, 'one pass, not two');
    assert.equal(lib._armed, false);
  } finally { lib.unwatch(); }
});

test('a picture the reader skips is listed with its reason and remembered, except the reader\'s stop case', async () => {
  const dir = tmp();
  const big = w(dir, 'big.png', png(10)); w(dir, 'nokey.png', png(20)); w(dir, 'fine.png', png(30));
  const reader = fakeReader((f) => {
    if (/big/.test(f)) return { skip: 'too large (over 5 MB)' };
    if (/nokey/.test(f)) return { skip: 'not read: Add an Anthropic key in Settings first' };
    return md('A fine picture.');
  });
  const lib = new Library({ imageReader: reader });
  const first = await lib.reindex(work(dir));
  const reasons = Object.fromEntries(first.skipped.map((s) => [path.basename(s.file), s.reason]));
  assert.deepEqual(reasons, { 'big.png': 'too large (over 5 MB)', 'nokey.png': 'not read: Add an Anthropic key in Settings first' });
  assert.equal(first.files, 1);
  assert.deepEqual(reader.calls.sort(), ['big.png', 'fine.png', 'nokey.png']);
  const second = await lib.reindex(work(dir));
  assert.deepEqual(reader.calls.filter((c) => c === 'big.png').length, 1, 'a remembered skip is not asked again');
  assert.deepEqual(reader.calls.filter((c) => c === 'nokey.png').length, 2, 'the stop case is asked again on the next pass');
  assert.equal(reader.calls.filter((c) => c === 'fine.png').length, 1);
  assert.deepEqual(second.skipped.map((s) => path.basename(s.file)).sort(), ['big.png', 'nokey.png'], 'both are still reported');
  fs.writeFileSync(big, png(999)); // a changed picture is another picture
  await lib.reindex(work(dir));
  assert.equal(reader.calls.filter((c) => c === 'big.png').length, 2);
});

test('with the feature off the reader answers null: pictures are ignored quietly and what is indexed stays until the picture changes', async () => {
  const dir = tmp();
  const f = w(dir, 'old.png', png(10));
  w(dir, 'new.png', png(20));
  let on = true;
  const reader = fakeReader((file) => (on ? md(`described ${path.basename(file)} walrusfact`) : null));
  const lib = new Library({ imageReader: reader });
  await lib.reindex(work(dir));
  assert.equal(lib.search('walrusfact').length, 2);
  on = false;
  const off = await lib.reindex(work(dir));
  assert.equal(lib.search('walrusfact').length, 2, 'switched off: what was indexed stays');
  assert.deepEqual(off.skipped, []);
  // A new picture while it is off: not indexed, not listed, not remembered.
  const extra = w(dir, 'extra.png', png(30));
  const still = await lib.reindex(work(dir));
  assert.deepEqual(still.skipped, []);
  assert.equal(lib.files.has(extra), false);
  assert.equal(lib.skipInfo.size, 0);
  // A picture that changes while it is off: its old description would mislead, so it goes.
  fs.writeFileSync(f, png(111));
  await lib.reindex(work(dir));
  assert.equal(lib.search('walrusfact').length, 1);
  assert.equal(lib.files.has(f), false);
  // Switched on again, the new and the changed ones are read.
  on = true;
  await lib.reindex(work(dir));
  assert.equal(lib.search('walrusfact').length, 3);
});

test('without a reader pictures are not even listed, and pictures in a meetings folder are never read', async () => {
  const dir = tmp();
  w(dir, 'a.png', png(10)); w(dir, 'n.md', '# N\n\nhello\n');
  const none = new Library();
  const s = await none.reindex(work(dir));
  assert.deepEqual([s.files, s.skipped], [1, []]);
  assert.equal(none.files.has(path.join(dir, 'a.png')), false);
  const meetings = tmp();
  w(meetings, '2026-11-15/shot.png', png(10));
  w(meetings, '2026-11-15/1030-x.md', '# X\n\nnotes\n\n## Transcript\n\nsecret words\n');
  const reader = fakeReader(() => md('should not happen'));
  const lib = new Library({ imageReader: reader });
  await lib.reindex([{ dir: meetings, label: 'Meetings', kind: 'meeting' }]);
  assert.deepEqual(reader.calls, []);
  assert.equal(lib.files.size, 1);
});

// ---------------------------------------------------------------- library: what sync services leave behind

test('sync and editor leftovers are not indexed, but conflict copies of a note are', async () => {
  const dir = tmp();
  const keep = ['plan.md', 'plan (1).md', 'plan (conflicted copy 2026-11-15).md', 'plan - Copy.md', 'ideas.txt'];
  const junk = ['~$draft.md', '.~lock.draft.md', 'plan.sync-conflict-20261115-101010-ABCDEFG.md', 'old.md.tmp', 'dl.txt.partial', 'x.md.crdownload', 'desktop.ini', 'Thumbs.db', 'thumbs.db',
    '.tmp.drivedownload/inner.md', '.tmp.driveupload/inner2.md', 'sub/.tmp.drivedownload/inner3.md', 'sub/~$other.md'];
  for (const f of keep) w(dir, f, `# ${f}\n\nbody of ${f.replace(/\W/g, '')}\n`);
  for (const f of junk) w(dir, f, `# junk\n\nzebrajunk\n`);
  const lib = new Library({ imageReader: fakeReader(() => md('picture')) });
  w(dir, 'shot.png', png(10)); w(dir, '~$shot.png', png(11)); w(dir, 'shot.sync-conflict-1-2-A.png', png(12)); w(dir, 'half.png.tmp', png(13)); w(dir, 'half2.png.crdownload', png(14));
  const stats = await lib.reindex(work(dir));
  assert.deepEqual([...lib.files.keys()].map((f) => path.relative(dir, f).split(path.sep).join('/')).sort(), [...keep, 'shot.png'].sort());
  assert.deepEqual(stats.skipped, [], 'leftovers are not reported either: they are not files of the person\'s');
  assert.equal(lib.search('zebrajunk').length, 0);
  assert.deepEqual(lib.imageReader.calls, ['shot.png']);
  for (const f of ['plan (1).md', 'plan (conflicted copy 2026-11-15).md']) assert.ok(lib.search(`body of ${f.replace(/\W/g, '')}`).some((h) => h.file.endsWith(f)), `${f} is findable`);
});

test('isJunk and the watcher filter agree on what a sync service leaves behind', () => {
  for (const n of ['~$a.docx', '~$a.md', '.~lock.a.odt#', '.~lock.a.md', 'a.tmp', 'a.md.tmp', 'A.PARTIAL', 'a.crdownload', 'a.sync-conflict-20261115-101010-ABC.md', 'desktop.ini', 'Desktop.INI', 'Thumbs.db', 'a.md.tmp.drivedownload', 'a.tmp.driveupload']) assert.equal(isJunk(n), true, n);
  for (const n of ['a.md', 'plan (1).md', 'plan (conflicted copy 2026-11-15).md', 'tmp.md', 'temporary.md', 'notes about desktop.ini.md', 'a~$b.md', 'partial.md', '.hidden.md', 'a.conflict.md']) assert.equal(isJunk(n), false, n);
  const lib = new Library();
  const worth = (n) => lib._worthALook(n);
  for (const n of ['a.md', 'sub\\b.txt', 'sub/c.mmd', 'plan (1).md', 'plan (conflicted copy 2026-11-15).md', undefined, null]) assert.equal(worth(n), true, String(n));
  for (const n of ['~$a.md', 'sub\\.~lock.a.md', 'a.md.tmp', 'x.md.crdownload', 'a.sync-conflict-1-2-A.md', 'desktop.ini', 'Thumbs.db', '.tmp.drivedownload\\inner.md', 'sub/.tmp.driveupload/inner.md', '.git/x.md', 'node_modules\\x.md', '_daily.md', 'sub/_daily.md', 'a.png', 'a.xml']) assert.equal(worth(n), false, n);
  const withReader = new Library({ imageReader: fakeReader(() => null) });
  assert.equal(withReader._worthALook('shots\\a.PNG'), true, 'a picture counts once there is a reader');
  assert.equal(withReader._worthALook('~$a.png'), false);
});

// ---------------------------------------------------------------- library: overlapping sources

test('a file reachable through two sources is indexed once, whichever way round they are given', async () => {
  const parent = tmp();
  w(parent, 'a.md', '# A\n\nalphafact\n'); w(parent, 'Notes/2026-11/n.md', '# N\n\nnotefact\n'); w(parent, 'Notes/m.md', '# M\n\nmfact\n');
  const notes = path.join(parent, 'Notes');
  const alone = new Library();
  await alone.reindex(work(parent, 'parent'));
  const sources = [{ dir: parent, label: 'parent', kind: 'work' }, { dir: notes, label: 'Notes', kind: 'work', optional: true }];
  for (const order of [sources, [...sources].reverse(), [sources[0], sources[0]], [sources[1], sources[0], sources[1]]]) {
    const lib = new Library();
    const stats = await lib.reindex(order);
    assert.equal(stats.files, 3, 'three files, not more');
    assert.equal(lib.chunkCount, alone.chunkCount, 'and no passage twice');
    assert.equal(lib.search('notefact').length, 1);
    assert.equal(stats.skipped.length, 0);
    if (order.includes(sources[1])) assert.equal(lib.search('notefact')[0].rel, path.join('Notes', '2026-11', 'n.md'), 'listed under the more specific folder');
    assert.equal(lib.search('alphafact')[0].rel, path.join('parent', 'a.md'));
  }
  // The same folder spelt two ways (a trailing separator, other case on Windows).
  const lib = new Library();
  await lib.reindex([{ dir: parent, label: 'one', kind: 'work' }, { dir: process.platform === 'win32' ? parent.toUpperCase() + path.sep : parent + path.sep, label: 'two', kind: 'work' }]);
  assert.equal(lib.files.size, 3);
  assert.equal(lib.chunkCount, alone.chunkCount);
});

test('a meetings folder inside another source stays a meeting: its transcript is never knowledge', async () => {
  const parent = tmp();
  w(parent, 'doc.md', '# Doc\n\ndocfact\n');
  w(parent, 'Meetings/2026-11-15/1030-x.md', '---\nid: m1\ntitle: X\n---\n\n## Summary\n\nsummaryfact\n\n## Transcript\n\n**[10:30:01] Me:** transcriptfact\n');
  const meetings = path.join(parent, 'Meetings');
  for (const order of [[{ dir: parent, label: 'p', kind: 'work' }, { dir: meetings, label: 'Meetings', kind: 'meeting' }], [{ dir: meetings, label: 'Meetings', kind: 'meeting' }, { dir: parent, label: 'p', kind: 'work' }]]) {
    const lib = new Library();
    await lib.reindex(order);
    assert.equal(lib.files.size, 2);
    assert.equal(lib.search('transcriptfact').length, 0);
    assert.equal(lib.search('summaryfact')[0].kind, 'meeting');
    assert.equal(lib.summary().workFiles, 1);
  }
});

test('buildSources: the Notes folder is always there and never twice', () => {
  const folders = ['C:\\Docs', 'C:\\Work'];
  const base = { folders, includeMeetings: true, meetingsDir: 'C:\\Meetings', notesDir: 'C:\\Users\\a\\Documents\\Understudy\\Notes' };
  const s = buildSources(base);
  assert.deepEqual(s.map((x) => [x.label, x.kind]), [['Docs', 'work'], ['Work', 'work'], ['Meetings', 'meeting'], ['Notes', 'work']]);
  assert.equal(s.find((x) => x.label === 'Notes').optional, true, 'a Notes folder that is not there yet is not an error');
  assert.deepEqual(buildSources({ ...base, includeMeetings: false }).map((x) => x.label), ['Docs', 'Work', 'Notes'], 'meetings off: Notes stays');
  assert.deepEqual(buildSources({ ...base, folders: [] }).map((x) => x.label), ['Meetings', 'Notes']);
  // A folder the person added that is the Notes folder: one source, called Notes.
  const same = buildSources({ ...base, folders: [...folders, 'C:\\Users\\a\\Documents\\Understudy\\Notes\\'] });
  assert.deepEqual(same.map((x) => x.label), ['Docs', 'Work', 'Meetings', 'Notes']);
  assert.equal(same.filter((x) => path.resolve(x.dir).toLowerCase() === path.resolve(base.notesDir).toLowerCase()).length, 1);
  // A parent of it stays (the library handles the overlap, see above).
  assert.deepEqual(buildSources({ ...base, folders: ['C:\\Users\\a\\Documents'] }).map((x) => x.label), ['Documents', 'Meetings', 'Notes']);
  // The Notes folder inside the meetings folder or the same as it: the meetings source covers it.
  assert.deepEqual(buildSources({ ...base, notesDir: 'C:\\Meetings' }).map((x) => x.label), ['Docs', 'Work', 'Meetings']);
  // Odd values from a hand-edited file do no harm.
  assert.deepEqual(buildSources({ folders: [5, null, '', 'C:\\Docs', 'C:\\Docs'], notesDir: '' }).map((x) => x.label), ['Docs']);
  assert.deepEqual(buildSources({ folders: 'C:\\x', meetingsDir: 'C:\\M', notesDir: 'C:\\N' }).map((x) => x.label), ['Meetings', 'Notes']);
  assert.deepEqual(buildSources({}).map((x) => x.label), []);
});

test('a Notes folder that does not exist yet is not a problem, and notes appear when it does', async () => {
  const root = tmp();
  const notesDir = path.join(root, 'Notes');
  const lib = new Library();
  const sources = buildSources({ folders: [], includeMeetings: false, notesDir });
  const first = await lib.reindex(sources);
  assert.deepEqual([first.files, first.skipped], [0, []]);
  const saved = inbox.saveNote(notesDir, { title: 'Rotate the vault keys', text: 'Every thirty days.', source: 'claude', origin: 'PC3' });
  const next = await lib.reindex(sources);
  assert.equal(next.files, 1);
  assert.equal(lib.search('rotate vault keys')[0].rel, path.join('Notes', ...saved.rel.split('/')));
  assert.equal(await countNoteFiles(notesDir), 1);
  assert.equal(await countNoteFiles(path.join(root, 'nowhere')), 0);
  inbox.saveImage(notesDir, { bytes: png(5), mime: 'image/png', title: 'Shot', note: 'with a note' });
  assert.equal(await countNoteFiles(notesDir), 2, 'the note beside a picture counts; the picture does not');
});

// ---------------------------------------------------------------- library: a note's own front matter

test('a note\'s front matter is not indexed as text, and its title still counts for search', async () => {
  const dir = tmp();
  const saved = inbox.saveNote(dir, { title: 'Zanzibar cutover plan', text: 'Move traffic in two waves.', source: 'claude', origin: 'ZEBRAPC77' });
  // A hand-made file whose name says nothing about its title, with Windows line endings.
  w(dir, 'a1.md', '---\r\ntitle: "Quokkafish handover"\r\ndate: 2026-11-15T10:30:45+00:00\r\nsource: pasted\r\norigin: WALRUSBOX9\r\n---\r\n\r\nPlain body about vault renewal.\r\n');
  const withImage = inbox.saveImage(dir, { bytes: png(5), mime: 'image/png', title: 'Network sketch', note: 'Drawn on the whiteboard.', origin: 'GIRAFFEPC3', now: Date.now() + 120000 });
  const lib = new Library();
  await lib.reindex(work(dir, 'Notes'));
  const all = lib.chunks.filter(Boolean);
  for (const word of ['origin', 'date:', 'source:', 'ZEBRAPC77', 'WALRUSBOX9', 'GIRAFFEPC3', 'image:', '2026-11-15T10:30:45']) assert.ok(!all.some((c) => c.text.includes(word)), `"${word}" is not in any passage`);
  for (const q of ['zebrapc77', 'walrusbox9', 'giraffepc3']) assert.equal(lib.search(q).length, 0, `${q} is not searchable`);
  const z = lib.search('zanzibar cutover')[0];
  assert.ok(z && z.file === saved.file && z.headings[0] === 'Zanzibar cutover plan');
  const q = lib.search('quokkafish handover')[0];
  assert.ok(q && /a1\.md$/.test(q.file), 'a title that is nowhere in the body or the file name still finds the note');
  assert.equal(q.headings[0], 'Quokkafish handover');
  assert.ok(lib.search('vault renewal')[0].text.includes('Plain body about vault renewal.'));
  const n = lib.search('whiteboard network sketch')[0];
  assert.ok(n && n.file === withImage.file.replace(/\.png$/, '.md'), 'the note beside a picture is found by its text');
});

// ---------------------------------------------------------------- main.js: what it wires

test('main.js: every new channel is handled, and the window may call every one of them', async () => {
  const preload = read('src/preload.js');
  const invoke = new Set([...preload.match(/const INVOKE = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const ch of ['notes:add', 'notes:addImage', 'notes:list', 'notes:info', 'notes:chooseFolder', 'notes:openFolder', 'meetings:setActionItem', 'meetings:addUpdate']) {
    assert.ok(mainSrc.includes(`handle('${ch}'`), `${ch} is handled`);
    assert.ok(invoke.has(ch), `${ch} is in the preload list`);
  }
  // Every channel the main process handles is callable, and every callable one is handled.
  const handled = new Set([...mainSrc.matchAll(/handle\('([a-zA-Z:]+)'/g)].map((m) => m[1]));
  for (const ch of invoke) assert.ok(handled.has(ch), `${ch} has a handler`);
  for (const ch of handled) assert.ok(invoke.has(ch), `${ch} can be called from a window`);
  assert.deepEqual(V.cleanAppShow({ page: 'settings', tab: 'remote' }), { page: 'settings', tab: 'remote' });
  assert.match(mainSrc, /const to = V\.cleanAppShow\(arg\)/);
  const app = read('src/renderer/app.js');
  const speech = app.slice(app.indexOf("  if (settingsTab === 'speech')"), app.indexOf("  if (settingsTab === 'remote')"));
  assert.match(speech, /panel\('Audio sources'/);
  assert.doesNotMatch(speech, /remotePanel|Remote recorder|stackcol/);
  assert.match(mainSrc, /const \{ tailscaleAddresses \} = require\('\.\/network-detect'\);/);
  for (const method of ['info', 'detect', 'newToken', 'copySettings', 'test', 'testCancel']) {
    const ch = `remote:${method}`;
    assert.ok(invoke.has(ch), `${ch} is in the preload list`);
    const line = mainSrc.split('\n').find((s) => s.includes(`handle('${ch}'`));
    assert.ok(line && line.includes('V.cleanRemoteArgs(...args)'), `${ch} checks its arguments`);
    let handler, calls = 0;
    const addresses = ['100.64.1.2', 'fd7a:115c:a1e0::1'];
    new Function('handle', 'V', 'remoteConfig', 'tailscaleAddresses', 'connectionTest', 'serial', 'quitting', line)(
      (name, fn) => { assert.equal(name, ch); handler = fn; }, V, { [method]: () => ++calls }, () => { calls++; return addresses; },
      { run: () => ++calls, cancel: async () => ++calls }, (fn) => Promise.resolve().then(fn), false);
    assert.deepEqual(await handler(), method === 'detect' ? { addresses } : method === 'testCancel' ? true : 1);
    for (const bad of [undefined, null, false, 0, '', 'x', [], {}]) {
      assert.throws(() => handler(bad), V.ArgError);
      assert.throws(() => handler(undefined, bad), V.ArgError);
    }
    assert.equal(calls, 1, 'refused arguments cannot detect addresses, copy settings, replace a token or control a test');
  }
});

test('main.js: the Notes folder is wired into the library, the connector, the settings and the long-notes progress', () => {
  assert.ok(mainSrc.includes('notesDir: notesDir(),'), 'claudeOpts passes the Notes folder');
  assert.match(mainSrc, /const claudeOpts = \(\) => \(\{[^}]*notesDir: notesDir\(\)/);
  assert.match(mainSrc, /return buildSources\(\{ folders: s\.library\.folders, includeMeetings: s\.library\.includeMeetings, meetingsDir: meetingsDir\(\), notesDir: notesDir\(\) \}\);/);
  assert.match(mainSrc, /createImageReader\(\{\s*llm, cacheDir: userDir\('image-notes'\), enabled: \(\) => settings\.get\(\)\.library\.readImages === true,/);
  assert.ok(mainSrc.includes('library.imageReader = imageReader;'));
  assert.match(mainSrc, /generateNotes\(\{[^\n]*onProgress: \(t\) => broadcast\(\{ type: 'notes', id: meta\.id, status: 'working', message: t \}\)/);
  assert.match(mainSrc, /broadcast\(\{ type: 'images', state: 'working'/);
  assert.match(mainSrc, /state: imageError \? 'error' : 'done'/);
  // The folder is chosen by the main process and never accepted through settings:set.
  assert.ok(!SETTABLE.library.includes('notesDir') && !Object.keys(SETTABLE).includes('notesDir'));
  assert.match(between("handle('notes:chooseFolder'", "handle('notes:openFolder'"), /settings\.set\(\{ notesDir: r\.filePaths\[0\] \}\)[\s\S]*claude\.refresh\(claudeOpts\(\)\)[\s\S]*return \{ dir: notesDir\(\) \}/);
  assert.match(between("handle('notes:chooseFolder'", "handle('notes:openFolder'"), /if \(r\.canceled[^\n]*return null;/);
});

test('main.js: the Notes folder is the person\'s choice, else under Documents, and inside the data folder in a test run', () => {
  const line = mainSrc.match(/const notesDir = \(\) => [^\n]*;/)[0];
  const make = (setting, DEV, dataDir) => new Function('settings', 'DEV', 'process', 'path', 'inbox', 'app', `${line}; return notesDir;`)(
    { get: () => ({ notesDir: setting }) }, DEV, { env: dataDir ? { UNDERSTUDY_DATA_DIR: dataDir } : {} }, path, inbox, { getPath: () => 'C:\\Users\\a\\Documents' });
  assert.equal(make('D:\\Drive\\Notes', false)(), 'D:\\Drive\\Notes');
  assert.equal(make('', false)(), path.join('C:\\Users\\a\\Documents', 'Understudy', 'Notes'));
  assert.equal(make('', true, 'C:\\test-data')(), path.join('C:\\test-data', 'Notes'), 'a test run never uses the real Documents');
  assert.equal(make('', true)(), path.join('C:\\Users\\a\\Documents', 'Understudy', 'Notes'), 'a development run without a data folder is not a test run');
  assert.equal(make('', false, 'C:\\test-data')(), path.join('C:\\Users\\a\\Documents', 'Understudy', 'Notes'), 'the hook is for development builds only');
});

// The notes bridge section of main.js, run against stubs and the real notes folder code.
function bridge({ notesDir = tmp(), jobs = new Set(), store = {}, includeMeetings = true, setting = '', images } = {}) {
  const log = { reindex: 0, items: [], updates: [] };
  const meetingStore = {
    setActionItem(id, o) { log.items.push([id, o]); if (store.throwOn) throw store.throwOn; return { file: 'x', item: {} }; },
    addUpdate(id, text) { log.updates.push([id, text]); if (store.throwOn) throw store.throwOn; return { file: 'x' }; },
    find(id) { return store.missing ? null : { meta: { id }, notes: '- [x] done', transcript: '' }; },
  };
  const block = between('// ---------------------------------------------------------------- notes bridge', '// ---------------------------------------------------------------- IPC');
  const make = new Function('V', 'inbox', 'settings', 'notesDir', 'reindexSoon', 'notesJobs', 'store', 'imageReader', 'countNoteFiles', `${block}; return { addNote, addNoteImage, listNotes, notesInfo, setActionItem, addUpdate };`);
  const api = make(V, inbox, { get: () => ({ notesDir: setting, library: { includeMeetings, readImages: Boolean(images) } }) }, () => notesDir, () => { log.reindex++; }, jobs, meetingStore, images || null, countNoteFiles);
  return { api, log, notesDir };
}

test('notes:add and notes:addImage save into the Notes folder, reindex at once, and answer { rel, title }', () => {
  const { api, log, notesDir } = bridge();
  const a = api.addNote({ title: 'Rotate keys', text: 'Every 30 days.' });
  assert.deepEqual(Object.keys(a).sort(), ['rel', 'title']);
  assert.equal(a.title, 'Rotate keys');
  assert.match(a.rel, /^\d{4}-\d\d\/\d{4}-\d\d-\d\d \d{4} Rotate keys\.md$/);
  const saved = fs.readFileSync(path.join(notesDir, ...a.rel.split('/')), 'utf8');
  assert.match(saved, /source: pasted/);
  assert.equal(log.reindex, 1, 'the library is told straight away');
  const i = api.addNoteImage({ dataUrl: url('image/png', png(40)), title: 'Pipeline error', note: 'seen on PC 3' });
  assert.deepEqual(Object.keys(i).sort(), ['rel', 'title']);
  assert.match(i.rel, /Pipeline error\.png$/);
  assert.ok(fs.readFileSync(path.join(notesDir, ...i.rel.replace(/\.png$/, '.md').split('/')), 'utf8').includes('source: screenshot'));
  assert.equal(log.reindex, 2);
  const only = api.addNoteImage({ dataUrl: url('image/jpeg', jpg()) });
  assert.match(only.rel, /Screenshot\.jpg$/);
  assert.equal(fs.existsSync(path.join(notesDir, ...only.rel.replace(/\.jpg$/, '.md').split('/'))), true, 'no note text: the sibling file is still written');
  const list = api.listNotes({ limit: 10 });
  assert.equal(list.length, 3);
  assert.deepEqual(Object.keys(list[0]).sort(), ['chars', 'date', 'origin', 'rel', 'source', 'title']);
  assert.equal(api.listNotes().length, 3);
  assert.equal(api.listNotes({ limit: 1 }).length, 1);
});

test('notes: a refused request saves nothing and says why in plain words, without a path', () => {
  const { api, log, notesDir } = bridge();
  const refused = (fn, re) => assert.throws(fn, (e) => re.test(e.message) && !/[A-Za-z]:\\|\\\\|ENOENT|EACCES|EPERM/.test(e.message), String(re));
  refused(() => api.addNote({ title: 'T', text: '   ' }), /Write something to save first/);
  refused(() => api.addNote(), /Write something to save first/);
  refused(() => api.addNote({ text: 'x'.repeat(1000001) }), /too long to save/);
  refused(() => api.addNoteImage({ dataUrl: 'data:text/html;base64,AAAA' }), /Only PNG, JPEG, WebP and GIF/);
  refused(() => api.addNoteImage({ dataUrl: `data:image/png;base64,${'A'.repeat(21 * MB)}` }), /too large/);
  // The label says png but the bytes are something else: the notes code refuses, in its own words.
  refused(() => api.addNoteImage({ dataUrl: url('image/png', Buffer.from('<html>not an image at all, really not</html>')) }), /does not look like a PNG, JPEG, WebP or GIF image/);
  refused(() => api.listNotes({ limit: 'many' }), /not a number of notes/);
  assert.equal(log.reindex, 0, 'nothing saved, nothing to re-read');
  assert.equal(fs.existsSync(notesDir) ? fs.readdirSync(notesDir).length : 0, 0);
});

test('notes: a failure inside the notes code (a path in its message) becomes a plain sentence', () => {
  const file = path.join(tmp(), 'blocker');
  fs.writeFileSync(file, 'a file where a folder should be');
  const { api } = bridge({ notesDir: path.join(file, 'Notes') });
  assert.throws(() => api.addNote({ title: 'T', text: 'body' }), (e) => /Notes folder could not be created/.test(e.message) && !e.message.includes(file) && !e.message.includes(path.dirname(file)), 'the folder cannot be made: the notes code\'s own sentence, with no path');
  const orig = fs.writeFileSync;
  const { api: ok, notesDir } = bridge();
  fs.writeFileSync = function (f) { if (String(f).endsWith('.tmp')) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return orig.apply(this, arguments); };
  try { assert.throws(() => ok.addNote({ title: 'T', text: 'body' }), (e) => e.message === 'The note could not be saved. Check that the Notes folder is available and try again.' && !e.message.includes(notesDir)); } finally { fs.writeFileSync = orig; }
});

test('notes:info says where the folder is, how many notes it holds, and how the pictures are going', async () => {
  const stats = { described: 3, cached: 1, pending: 2, skipped: 0, cost: 0.04 };
  const a = bridge({ images: { stats: () => stats } });
  // `host` is this PC's name, so the list can leave it out and name only the other PCs.
  const { host, ...rest } = await a.api.notesInfo();
  assert.equal(typeof host, 'string');
  assert.deepEqual(rest, { dir: a.notesDir, isDefault: true, count: 0, readImages: true, images: stats });
  a.api.addNote({ title: 'One', text: 'x' }); a.api.addNote({ title: 'Two', text: 'y' });
  assert.equal((await a.api.notesInfo()).count, 2);
  const b = bridge({ setting: 'D:\\Drive\\Notes' });
  const info = await b.api.notesInfo();
  assert.deepEqual([info.isDefault, info.readImages, info.images], [false, false, { described: 0, cached: 0, pending: 0, skipped: 0, cost: 0 }]);
});

test('meetings:setActionItem and meetings:addUpdate: checked, refused while notes are written, library re-read, meeting returned', () => {
  const { api, log } = bridge();
  const m = api.setActionItem('20261115-103045', 1, 'Send the plan', true);
  assert.deepEqual(m.meta, { id: '20261115-103045' });
  assert.deepEqual(log.items, [['20261115-103045', { index: 1, text: 'Send the plan', done: true }]], 'the store gets exactly what the contract says');
  assert.equal(log.reindex, 1);
  api.addUpdate('20261115-103045', '  Priya confirmed.  ');
  assert.deepEqual(log.updates, [['20261115-103045', 'Priya confirmed.']]);
  assert.equal(log.reindex, 2);
  // Meetings are not part of the library: nothing to re-read.
  const off = bridge({ includeMeetings: false });
  off.api.addUpdate('m1', 'x');
  assert.equal(off.log.reindex, 0);
  // Notes being rewritten for that meeting only.
  const busy = bridge({ jobs: new Set(['m1']) });
  assert.throws(() => busy.api.setActionItem('m1', 0, 't', true), /Notes for this meeting are still being written\. Try again when they are done\./);
  assert.throws(() => busy.api.addUpdate('m1', 'x'), /still being written/);
  assert.deepEqual([busy.log.items, busy.log.updates, busy.log.reindex], [[], [], 0], 'nothing was written');
  assert.doesNotThrow(() => busy.api.addUpdate('m2', 'x'));
  // Bad arguments never reach the store.
  const bad = bridge();
  assert.throws(() => bad.api.setActionItem('../x', 0, 't', true), /no longer exists/);
  assert.throws(() => bad.api.setActionItem('m1', -1, 't', true), /not an action item/);
  assert.throws(() => bad.api.setActionItem('m1', 0, 't', 'yes'), /whether the action item is done/);
  assert.throws(() => bad.api.addUpdate('m1', ' '), /Write the update first/);
  assert.deepEqual([bad.log.items, bad.log.updates], [[], []]);
  // The store's own plain sentences pass; one with a path does not; a vanished file is said plainly.
  const gone = bridge({ store: { throwOn: new Error('That action item is no longer in the notes.') } });
  assert.throws(() => gone.api.setActionItem('m1', 0, 't', true), /^Error: That action item is no longer in the notes\.$/);
  const disk = bridge({ store: { throwOn: Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\Meetings\\2026-11-15\\x.md.tmp'"), { code: 'EPERM' }) } });
  assert.throws(() => disk.api.addUpdate('m1', 'x'), (e) => e.message === 'The update could not be saved. Try again.');
  assert.equal(disk.log.reindex, 0);
  const vanished = bridge({ store: { missing: true } });
  assert.throws(() => vanished.api.addUpdate('m1', 'x'), /That meeting file no longer exists\./);
});
