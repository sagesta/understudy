'use strict';
// A year of notes: large compilations, many files, and changes while it is open.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Library } = require('../src/main/knowledge/library');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-scale-'));
const words = 'pipeline terraform vault kubernetes argo trivy scanner rotation incident rollback canary cluster ingress policy iam role token patch baseline audit alert runbook latency budget'.split(' ');
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const para = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)] + (rnd() < 0.3 ? Math.floor(rnd() * 500) : '')).join(' ');
function doc(bytes, title, tail = '') {
  const out = [`# ${title}\n`];
  let size = 0;
  while (size < bytes) { const s = `\n## ${para(3)}\n\n${para(120)}.\n\n${para(90)}.\n`; out.push(s); size += s.length; }
  out.push(tail);
  return out.join('');
}
const src = (dir) => [{ dir, label: 'notes', kind: 'work' }];

test('a large compilation is read completely: a fact near the end is found under its heading', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'everything.md'), doc(6 * 1024 * 1024, 'Everything', '\n## The December decision\n\nThe unique late fact is quokkafish-eleven and it was agreed in December.\n'));
  const lib = new Library();
  const stats = await lib.reindex(src(dir));
  assert.deepEqual(stats.skipped, [], 'nothing is left out');
  assert.ok(stats.chunks > 3000, `only ${stats.chunks} passages`);
  const hit = lib.search('quokkafish-eleven december decision')[0];
  assert.ok(hit.text.includes('quokkafish-eleven'));
  assert.deepEqual(hit.headings.slice(-1), ['The December decision'], 'the heading path survives slicing');
});

test('only what changed is read again; added, edited and deleted notes are reflected at once', async () => {
  const dir = tmp();
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), doc(8000, `Note ${i}`, `\nMarker for note ${i}: zebrafact${i}.\n`));
  const lib = new Library();
  await lib.reindex(src(dir));
  const untouched = lib.files.get(path.join(dir, 'n10.md')).docs;
  await new Promise((r) => setTimeout(r, 20));
  fs.appendFileSync(path.join(dir, 'n3.md'), '\n## Edited\nThe changed fact is quokkafish-edited.\n');
  fs.writeFileSync(path.join(dir, 'fresh.md'), '# Fresh\nBrand new quokkafish-added note.\n');
  fs.unlinkSync(path.join(dir, 'n4.md'));
  const stats = await lib.reindex(src(dir));
  assert.equal(stats.files, 60);
  assert.ok(lib.search('quokkafish-edited')[0].file.endsWith('n3.md'));
  assert.ok(lib.search('quokkafish-added')[0].file.endsWith('fresh.md'));
  assert.equal(lib.search('zebrafact4').filter((h) => /n4\.md$/.test(h.file)).length, 0, 'a deleted note is gone');
  assert.strictEqual(lib.files.get(path.join(dir, 'n10.md')).docs, untouched, 'an untouched note was not read again');
  assert.equal(lib.chunkCount, lib.chunks.filter(Boolean).length);
});

test('reading a large library does not freeze the app', async () => {
  const dir = tmp();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `n${i}.md`), doc(250 * 1024, `Note ${i}`));
  fs.writeFileSync(path.join(dir, 'big.md'), doc(8 * 1024 * 1024, 'Big'));
  const lib = new Library();
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  await lib.reindex(src(dir));
  h.disable();
  assert.ok(h.max / 1e6 < 300, `the event loop stalled for ${Math.round(h.max / 1e6)} ms`);
  assert.ok(lib.chunkCount > 5000);
});

test('the profile sample covers the newest files and an even spread of the older ones', async () => {
  const dir = tmp();
  const base = Date.now() - 400 * 86400000;
  for (let i = 0; i < 500; i++) {
    const f = path.join(dir, `day-${String(i).padStart(3, '0')}.md`);
    fs.writeFileSync(f, `# Day ${i}\n\nMarker${i} ${para(80)}.\n`);
    fs.utimesSync(f, new Date(base + i * 86400000 * 0.8), new Date(base + i * 86400000 * 0.8));
  }
  const lib = new Library();
  await lib.reindex(src(dir));
  const sample = await lib.sampleForProfile(60000);
  assert.equal(sample.filesTotal, 500);
  assert.ok(sample.files < 500 && sample.files > 20, `${sample.files} files in the sample`);
  const included = new Set([...sample.text.matchAll(/Marker(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(included.has(499), 'the newest file is included');
  assert.ok([...included].some((n) => n < 100), 'old history is represented');
  assert.ok([...included].some((n) => n > 200 && n < 400), 'so is the middle');
});

test('files that are not notes are reported, not silently dropped', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'real.md'), '# Real\nSome notes.\n');
  fs.writeFileSync(path.join(dir, 'blob.txt'), Buffer.concat([Buffer.from('x'), Buffer.alloc(400, 0), Buffer.from('y')]));
  const lib = new Library();
  const stats = await lib.reindex(src(dir));
  assert.equal(stats.files, 1);
  assert.ok(stats.skipped.some((s) => /blob\.txt$/.test(s.file) && /not a text file/.test(s.reason)));
  // The same verdict on the next pass without reading it again.
  const again = await lib.reindex(src(dir));
  assert.equal(again.skipped.length, 1);
});
