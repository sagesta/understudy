'use strict';
// The meeting store at library size: 300 one-hour meetings of 100 to 200 KB each. The list must come from a
// cache that cannot go stale, and a search must never hold the main thread (which is also handling a live meeting).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MeetingStore, isSuperseded, newMeta, render, parse, section, ymd } = require('../src/main/meetings/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-speed-'));
const now = () => performance.now();

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const NEEDLES = ['pipeline', 'release', 'trivy', 'budget', 'roadmap', 'migration', 'incident', 'hiring'];
const HOUR_AGO = new Date(Date.now() - 3600 * 1000);

// 300 meetings over 100 days, each with notes and a long transcript, in the layout the app writes.
function buildCorpus(dir, n = 300) {
  const r = rng(42), pick = (a) => a[Math.floor(r() * a.length)];
  const syl = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vo', 'nel', 'dra', 'pi', 'qua', 'bor', 'ex', 'il', 'on', 'ta'];
  const vocab = Array.from({ length: 900 }, () => { let w = ''; for (let i = 0, k = 1 + Math.floor(r() * 3); i <= k; i++) w += pick(syl); return w; });
  const pool = Array.from({ length: 3000 }, (_, i) => {
    const words = Array.from({ length: 40 + Math.floor(r() * 50) }, () => (r() < 0.012 ? pick(NEEDLES) : pick(vocab)));
    const t = `${String(9 + (i % 9)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`;
    return `**[${t}] Speaker ${1 + (i % 4)}:** ${words.join(' ')}.`;
  });
  const days = new Set();
  for (let i = 0; i < n; i++) {
    const day = new Date(2026, 0, 1 + Math.floor(i / 3)), hh = 9 + (i % 3) * 3;
    const meta = { id: `${ymd(day).replace(/-/g, '')}-${String(hh).padStart(2, '0')}0000`, title: `Meeting ${i} ${pick(NEEDLES)} sync`, date: ymd(day), start: `${String(hh).padStart(2, '0')}:00`, end: `${String(hh + 1).padStart(2, '0')}:00`, durationMin: 60, speakers: ['Speaker 1', 'Speaker 2', 'Ade'] };
    const notes = `## Summary\nWe discussed ${pick(NEEDLES)} and ${pick(NEEDLES)} ${pick(vocab)}. Unique marker zq${i}x.\n\n## Decisions\n- ${pick(vocab)} ${pick(vocab)}\n\n## Action items\n### Mine\n- [ ] Follow up on ${pick(NEEDLES)}\n### Others\n- [ ] Speaker 2: ${pick(vocab)}`;
    const paras = [];
    let size = 0;
    const target = 100000 + Math.floor(r() * 100000);
    while (size < target) { const p = pick(pool); paras.push(p); size += p.length + 2; }
    const f = path.join(dir, meta.date, `${meta.start.replace(':', '')}-${meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, render(meta, notes, paras.join('\n\n')));
    fs.utimesSync(f, HOUR_AGO, HOUR_AGO);
    days.add(path.dirname(f));
  }
  for (const d of days) fs.utimesSync(d, HOUR_AGO, HOUR_AGO); // meetings saved an hour ago: nothing about them is "just changed"
}

// What list() returned before the cache: every file read whole and parsed.
function oldList(store, { date, from, to, limit = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (const file of store._files()) {
    const day = path.basename(path.dirname(file));
    if (date && day !== date) continue;
    if (from && day < from) continue;
    if (to && day > to) continue;
    try {
      const m = parse(fs.readFileSync(file, 'utf8'), file);
      if (seen.has(m.meta.id)) continue;
      seen.add(m.meta.id);
      const { frontExtra, ...shown } = m.meta;
      out.push({ ...shown, date: m.meta.date || day, file, hasNotes: !/^_.*not been generated/m.test(m.notes), summary: section(m.notes, 'Summary').slice(0, 400) });
    } catch { /* unreadable */ }
    if (out.length >= limit) break;
  }
  return out;
}

// What search() did before it shared its per-file step.
function oldSearch(store, query, { limit = 10 } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits = [];
  for (const file of store._files()) {
    let m;
    try { m = parse(fs.readFileSync(file, 'utf8'), file); } catch { continue; }
    for (const p of `${m.notes}\n\n${m.transcript}`.split(/\n\s*\n/)) {
      const low = p.toLowerCase();
      const matched = terms.filter((t) => low.includes(t)).length;
      if (!matched) continue;
      hits.push({ score: matched / terms.length + (matched === terms.length ? 1 : 0), id: m.meta.id, title: m.meta.title, date: m.meta.date, start: m.meta.start, file, snippet: p.trim().slice(0, 500) });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  return hits.slice(0, limit);
}

// Runs fn while a setImmediate loop watches the event loop; returns the longest gap between two turns of it.
async function longestStretch(fn) {
  let max = 0, last = now(), run = true;
  const tick = () => { const t = now(); max = Math.max(max, t - last); last = t; if (run) setImmediate(tick); };
  setImmediate(tick);
  const result = await fn();
  run = false;
  await new Promise((r) => setImmediate(r));
  return { result, max };
}

const dir = tmp();
const store = new MeetingStore(dir, path.join(dir, '.live'));
let built = false;
const ensure = () => { if (!built) { buildCorpus(dir); built = true; } };

test('list: the same answer as before, and a second call is served from the cache', () => {
  ensure();
  const bytes = store._files().reduce((n, f) => n + fs.statSync(f).size, 0);
  assert.ok(bytes / 300 > 100000 && bytes / 300 < 200000, `meetings average ${Math.round(bytes / 300)} bytes`);
  const expected = oldList(store, { limit: 300 });
  assert.equal(expected.length, 300);

  let t = now();
  const first = store.list({ limit: 300 });
  const firstMs = now() - t;
  let secondMs = Infinity, second;
  for (let i = 0; i < 6; i++) { t = now(); second = store.list({ limit: 300 }); secondMs = Math.min(secondMs, now() - t); } // the best of six: a busy moment on the machine is not the cache
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  console.log(`list of 300: first ${firstMs.toFixed(1)} ms, second ${secondMs.toFixed(1)} ms`);
  assert.ok(secondMs < 100, `second list took ${secondMs.toFixed(1)} ms`); // 50 ms on an idle machine; the suite runs other test files at the same time
  // What is left of the second call is a stat of each file and day folder (about 400 calls): the first call reads only the start of each file.
  assert.ok(secondMs * 4 <= firstMs, `second list ${secondMs.toFixed(1)} ms is not 4 times faster than the first ${firstMs.toFixed(1)} ms`);

  // The filters and the limit behave as they did, and a caller changing a result does not change the cache.
  assert.deepEqual(store.list({ date: expected[5].date }), oldList(store, { date: expected[5].date }));
  assert.deepEqual(store.list({ from: '2026-02-01', to: '2026-02-10', limit: 7 }), oldList(store, { from: '2026-02-01', to: '2026-02-10', limit: 7 }));
  store.list({ limit: 1 })[0].title = 'changed by a caller';
  store.list({ limit: 1 })[0].speakers.push('x');
  assert.deepEqual(store.list({ limit: 300 }), expected);
  assert.ok(store._cache.size <= 300, 'one small entry per file');
});

test('searchAsync: the same hits and ranking as search(), in short stretches', async () => {
  ensure();
  let total = 0;
  const stretches = [];
  for (const q of ['release friday', 'pipeline budget trivy', 'MIGRATION', 'nomatchzzz', 'a', '']) {
    const expected = store.search(q, { limit: 30 });
    if (q === 'release friday' || q === 'MIGRATION') assert.deepEqual(expected, oldSearch(store, q, { limit: 30 }), `search("${q}") is as it was`);
    // The best of three runs of each query: a stretch that is long because another process had the CPU is not one that
    // searchAsync held. Every run must still give the right answer.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t = now();
      const { result, max } = await longestStretch(() => store.searchAsync(q, { limit: 30 }));
      total += now() - t;
      best = Math.min(best, max);
      assert.deepEqual(result, expected, `searchAsync("${q}")`);
    }
    stretches.push(best);
  }
  // The test files of the suite run side by side, so one query can lose its turn on the CPU for a while: the typical
  // query must stay under 80 ms (a blocking search holds the thread for the whole half second) and none far beyond.
  stretches.sort((a, b) => a - b);
  const typical = stretches[Math.floor(stretches.length / 2)];
  console.log(`searchAsync: ${total.toFixed(0)} ms for 6 queries, longest blocking stretch ${stretches[stretches.length - 1].toFixed(1)} ms, typical ${typical.toFixed(1)} ms`);
  assert.ok(typical < 80, `the thread was held for ${typical.toFixed(1)} ms`);
  assert.ok(stretches[stretches.length - 1] < 400, `the thread was held for ${stretches[stretches.length - 1].toFixed(1)} ms`);
});

test('searchAsync: a newer search overtakes an older one, which stops early', async () => {
  ensure();
  const full = now();
  store.search('release friday');
  const fullMs = now() - full;
  const a = store.searchAsync('release friday', { limit: 30 });
  const t = now();
  let aEnded = 0;
  const aSettled = a.then(() => 'done', (e) => { aEnded = now() - t; return e; });
  await new Promise((r) => setTimeout(r, 30));
  const b = store.searchAsync('pipeline budget', { limit: 30 });
  const err = await aSettled;
  assert.ok(isSuperseded(err), 'the older search rejects as superseded');
  assert.equal(err.code, 'SUPERSEDED');
  assert.ok(aEnded < 30 + fullMs * 0.5, `the older search ran on for ${aEnded.toFixed(0)} ms of a ${fullMs.toFixed(0)} ms search`);
  assert.deepEqual(await b, store.search('pipeline budget', { limit: 30 }));
  assert.equal((await store.searchAsync('zq77x')).length, 1, 'a search nobody overtook finishes');
  assert.ok(!isSuperseded(new Error('other')) && !isSuperseded(null));
});

test('list: an edit outside the app, a new file and a deleted file show on the next call', () => {
  ensure();
  store.list({ limit: 300 });
  const files = store._files();

  // Edited in another program: a longer title, then a change that keeps the size exactly.
  const edited = files[10];
  let text = fs.readFileSync(edited, 'utf8');
  fs.writeFileSync(edited, text.replace(/^title: "(.*)"$/m, 'title: "$1 - rescheduled"'));
  let got = store.list({ limit: 300 });
  assert.deepEqual(got, oldList(store, { limit: 300 }));
  assert.ok(got.find((m) => m.file === edited).title.endsWith(' - rescheduled'));
  text = fs.readFileSync(edited, 'utf8');
  fs.writeFileSync(edited, text.replace('rescheduled', 'rescheduleD'));
  got = store.list({ limit: 300 });
  assert.ok(got.find((m) => m.file === edited).title.endsWith(' - rescheduleD'), 'same size, new modification time');

  // A file added to a day that was already listed, and to a day that is new.
  const sibling = files[40];
  const copy = (to, id) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, fs.readFileSync(sibling, 'utf8').replace(/^id: .*/m, `id: ${id}`).replace(/^title: .*/m, `title: "Added ${id}"`)); };
  copy(path.join(path.dirname(sibling), '2200-added.md'), 'added-1');
  copy(path.join(dir, '2027-03-03', '0900-added.md'), 'added-2');
  got = store.list({ limit: 300 });
  assert.deepEqual(got, oldList(store, { limit: 300 }));
  assert.equal(got[0].id, 'added-2', 'newest day first');
  assert.ok(got.some((m) => m.id === 'added-1'));

  // Deleted, and a whole day gone.
  fs.unlinkSync(files[100]);
  fs.rmSync(path.join(dir, '2027-03-03'), { recursive: true });
  got = store.list({ limit: 300 });
  assert.deepEqual(got, oldList(store, { limit: 300 }));
  assert.ok(!got.some((m) => m.file === files[100] || m.id === 'added-2'));
  assert.ok(!store._cache.has(files[100]) && !store._cache.has(path.join(dir, '2027-03-03', '0900-added.md')), 'entries for files that are gone are dropped');

  // A file that cannot be read as a meeting is left out, as before; one that is emptied is not served from the cache.
  fs.writeFileSync(files[3], '');
  assert.deepEqual(store.list({ limit: 300 }), oldList(store, { limit: 300 }));
});

test('list: the meetings folder changed in Settings never shows the old folder', () => {
  ensure();
  const other = tmp();
  store.list({ limit: 300 });
  const s2 = new MeetingStore(other, path.join(other, '.live'));
  const meta = newMeta('Other folder', new Date(2026, 5, 1, 10, 0, 0));
  const dirBefore = store.dir;
  try {
    // main.js changes dir in place; a second store would not have had anything cached.
    store.dir = other;
    assert.deepEqual(store.list({ limit: 300 }), []);
    s2.save(meta, '## Summary\nElsewhere.', 'hello there');
    assert.deepEqual(store.list(), s2.list());
    assert.equal(store.list()[0].summary, 'Elsewhere.');
  } finally { store.dir = dirBefore; }
  assert.ok(store.list({ limit: 300 }).length >= 299);
});

test('list: the cache is bounded', () => {
  const d = tmp();
  const s = new MeetingStore(d, path.join(d, '.live'));
  assert.equal(s._cacheMax, 2000, 'about 1 KB an entry, so about 2 MB at most');
  s._cacheMax = 40;
  for (let i = 0; i < 100; i++) {
    const day = path.join(d, `2025-03-${pad(1 + (i % 28))}`);
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `${String(i).padStart(4, '0')}-m.md`), `---
id: m${i}
title: "M ${i}"
date: ${path.basename(day)}
start: "10:00"
end: ""
duration_min: 1
speakers: []
---

# M

## Summary
S${i}

## Transcript

hello
`);
  }
  assert.equal(s.list({ limit: 500 }).length, 100);
  assert.equal(s._cache.size, 40);
  assert.equal(s.list({ limit: 500 }).length, 100);
  assert.equal(s._cache.size, 40);
  assert.deepEqual(s.list({ limit: 500 }), oldList(s, { limit: 500 }), 'an entry that was dropped is simply read again');
});
const pad = (n) => String(n).padStart(2, '0');

test('the store\'s own writes show on the very next list, however fast', () => {
  const d = tmp();
  const s = new MeetingStore(d, path.join(d, '.live'));
  const meta = newMeta('', new Date(2026, 10, 14, 14, 30, 5));
  meta.end = '15:10'; meta.durationMin = 40; meta.speakers = ['Speaker 1', 'Ade'];
  const transcript = '**[14:30:09] Speaker 1:** Can we move the release to Friday?\n\n**[14:30:15] Ade:** Only if the scan is green.';
  s.save(meta, '', transcript);
  let l = s.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].hasNotes, false);
  // Notes arrive (the same size would not matter: the entry for the file is dropped by the write).
  s.save(meta, '## Summary\nAgreed to release on Friday.\n\n## Action items\n### Mine\n- [ ] Check the scan', transcript);
  l = s.list();
  assert.equal(l[0].hasNotes, true);
  assert.equal(l[0].summary, 'Agreed to release on Friday.');
  // A new title moves the file; the old one must not be listed as well.
  meta.title = 'Friday release';
  const f = s.save(meta, '## Summary\nAgreed to release on Friday.', transcript);
  l = s.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'Friday release');
  assert.equal(l[0].file, f);
  // A speaker renamed.
  s.renameSpeaker(meta.id, 'Speaker 1', 'Priya');
  l = s.list();
  assert.deepEqual(l[0].speakers, ['Priya', 'Ade']);
  // A second meeting on the same day, in the same minute.
  const meta2 = newMeta('Second', new Date(2026, 10, 14, 14, 30, 50));
  s.save(meta2, '', 'x');
  assert.equal(s.list().length, 2);
  assert.deepEqual(s.list(), oldList(s));
});

test('the daily digest is the same as before and reads each meeting of the day once', () => {
  const d = tmp();
  const s = new MeetingStore(d, path.join(d, '.live'));
  const metas = [0, 1, 2, 3].map((i) => { const m = newMeta(`Meeting ${i}`, new Date(2026, 10, 14, 9 + i, 0, 0)); m.end = `${10 + i}:00`; m.durationMin = 60; return m; });
  const body = (i) => `## Summary\nSummary ${i}.\n\n## Action items\n### Mine\n- [ ] Task ${i}\n### Others\n- [ ] Ade: thing ${i}`;
  const transcript = Array.from({ length: 800 }, (_, i) => `**[09:00:${pad(i % 60)}] Ade:** ${'word '.repeat(40)}${i}`).join('\n\n');
  // The reference: the digest as it was built, from list() and find().
  const reference = (date) => {
    const meetings = oldList(s, { date }).reverse();
    const parts = [`# Meetings on ${date}`, '', `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}, ${meetings.reduce((n, m) => n + m.durationMin, 0)} minutes in total.`];
    for (const m of meetings) {
      const full = s.find(m.id);
      parts.push('', `## ${m.start}${m.end ? `-${m.end}` : ''} ${m.title} (${m.durationMin} min)`, '', `File: ${path.basename(m.file)}`, '', full ? full.notes.replace(/^## /gm, '### ').replace(/^### (?=Mine|Others)/gm, '#### ') : '');
    }
    return parts.join('\n') + '\n';
  };
  const opens = [];
  const realOpen = fs.openSync, realRead = fs.readFileSync;
  const watch = (f) => { if (typeof f === 'string' && f.endsWith('.md') && !f.endsWith('_daily.md')) opens.push(f); };
  fs.openSync = (f, ...a) => { watch(f); return realOpen(f, ...a); };
  fs.readFileSync = (f, ...a) => { watch(f); return realRead(f, ...a); };
  try {
    metas.forEach((m, i) => s.save(m, body(i), transcript)); // each save rewrites the digest
    opens.length = 0;
    s.save(metas[2], `${body(2)}\n\nMore.`, transcript); // the same day again, one meeting changed
    const perFile = new Map();
    for (const f of opens) perFile.set(f, (perFile.get(f) || 0) + 1);
    // The changed file is read for the digest once; the others not at all (the save itself only asks a file's id).
    const digestReads = [...perFile.values()].reduce((n, c) => n + c, 0);
    assert.ok(digestReads <= 4, `${digestReads} reads of meeting files in one save: ${JSON.stringify([...perFile])}`);
  } finally { fs.openSync = realOpen; fs.readFileSync = realRead; }
  const daily = realRead(path.join(d, '2026-11-14', '_daily.md'), 'utf8');
  assert.equal(daily, reference('2026-11-14'));
  assert.equal(s.dailyDigest('2026-11-14'), daily);
  assert.equal(s.dailyDigest('2026-01-01'), '');
  assert.ok(daily.includes('More.') && daily.includes('Task 0'));
  // actionItems, which the MCP server uses, gives what it gave.
  const ai = s.actionItems({ from: '2026-11-01' });
  assert.equal(ai.length, 4);
  assert.ok(ai[0].items.includes('### Mine') && ai[0].items.includes('Task'));
});

test('a save on a day with several long meetings stays quick', () => {
  const d = tmp();
  const s = new MeetingStore(d, path.join(d, '.live'));
  const transcript = Array.from({ length: 1500 }, (_, i) => `**[09:00:${pad(i % 60)}] Ade:** ${'lorem ipsum dolor sit amet '.repeat(10)}${i}`).join('\n\n');
  const metas = [0, 1, 2, 3, 4, 5].map((i) => { const m = newMeta(`Long ${i}`, new Date(2026, 10, 14, 8 + i, 0, 0)); m.end = `${9 + i}:00`; m.durationMin = 60; return m; });
  metas.forEach((m, i) => s.save(m, `## Summary\nS${i}\n\n## Action items\n- [ ] A${i}`, transcript));
  assert.ok(transcript.length > 100000);
  let best = Infinity, old = Infinity;
  for (let i = 0; i < 5; i++) {
    let t = now();
    s.writeDaily('2026-11-14');
    best = Math.min(best, now() - t);
    s._forget(s._idx.get(metas[5].id)); // one meeting changed since
  }
  const oldDigest = () => { const ms = oldList(s, { date: '2026-11-14' }); for (const m of ms) s.find(m.id); };
  for (let i = 0; i < 3; i++) { const t = now(); oldDigest(); old = Math.min(old, now() - t); }
  console.log(`digest of a day with 6 long meetings: ${best.toFixed(1)} ms, was ${old.toFixed(1)} ms`);
  assert.ok(best < old);
});
