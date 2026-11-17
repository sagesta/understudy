'use strict';
// The Meetings folder watcher (src/main/meetings/watch.js): what counts as a change, one call per burst, a folder
// that is missing or changes, and a clean stop. Real folders in the temp directory; short delays to stay fast.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watchMeetings, worthALook } = require('../src/main/meetings/watch');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-watch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return fn(); };
const day = (dir) => { const d = path.join(dir, '2026-11-14'); fs.mkdirSync(d, { recursive: true }); return d; };
const FAST = { debounceMs: 120, recheckMs: 100 };

function start(getDir, opts = FAST) {
  const calls = { n: 0 };
  const w = watchMeetings(getDir, () => { calls.n += 1; }, opts);
  return { w, calls };
}

test('a new meeting file gives one call, after the delay', async () => {
  const dir = tmp(), d = day(dir);
  const { w, calls } = start(() => dir);
  try {
    await sleep(100); // the watcher is up
    fs.writeFileSync(path.join(d, '1000-standup.md'), '---\nid: a\n---\n');
    assert.ok(await until(() => calls.n === 1), 'called');
    await sleep(350);
    assert.equal(calls.n, 1, 'and only once');
  } finally { w.stop(); }
});

test('a burst of ten writes gives one call', async () => {
  const dir = tmp(), d = day(dir);
  // A long debounce (a timing margin only): on a busy machine a pause between two of the writes can last well over
  // 100 ms, and with the short one used elsewhere in this file the burst would then be two bursts.
  const { w, calls } = start(() => dir, { debounceMs: 800, recheckMs: 100 });
  try {
    await sleep(100);
    for (let i = 0; i < 10; i++) { fs.writeFileSync(path.join(d, `10${String(i).padStart(2, '0')}-m${i}.md`), `x${i}`); await sleep(10); }
    assert.ok(await until(() => calls.n >= 1));
    await sleep(400);
    assert.equal(calls.n, 1);
  } finally { w.stop(); }
});

test('digests, temporary files, sync leftovers, other file types and dot-folders are ignored', async () => {
  const dir = tmp(), d = day(dir);
  fs.mkdirSync(path.join(d, '.tmp.driveupload'));
  const { w, calls } = start(() => dir);
  try {
    await sleep(100);
    for (const n of ['_daily.md', '1000-x.md.tmp', 'desktop.ini', 'Thumbs.db', '~$1000-x.md', '1000-y.partial', 'z.crdownload', '.~lock.1000-x.md#', 'notes.txt']) fs.writeFileSync(path.join(d, n), 'x');
    fs.writeFileSync(path.join(d, '.tmp.driveupload', '1000-hidden.md'), 'x');
    await sleep(400);
    assert.equal(calls.n, 0, 'nothing worth a look yet');
    fs.writeFileSync(path.join(d, '1000-real.md'), 'x');
    assert.ok(await until(() => calls.n === 1));
  } finally { w.stop(); }
});

test('a change to an existing meeting and a removal are seen too', async () => {
  const dir = tmp(), d = day(dir);
  const f = path.join(d, '1000-a.md');
  fs.writeFileSync(f, 'one');
  const { w, calls } = start(() => dir);
  try {
    await sleep(100);
    fs.appendFileSync(f, ' two');
    assert.ok(await until(() => calls.n === 1));
    fs.unlinkSync(f);
    assert.ok(await until(() => calls.n === 2));
  } finally { w.stop(); }
});

test('a folder that is not there yet is watched once it appears', async () => {
  const base = tmp();
  const dir = path.join(base, 'later', 'Meetings');
  const { w, calls } = start(() => dir);
  try {
    await sleep(300);
    assert.equal(calls.n, 0);
    const d = day(dir);
    assert.ok(await until(() => calls.n >= 1), 'told when it appeared (what is in it may be new)');
    const seen = calls.n;
    await sleep(400);
    fs.writeFileSync(path.join(d, '1000-late.md'), 'x');
    assert.ok(await until(() => calls.n > seen), 'and the files made in it afterwards are seen');
  } finally { w.stop(); }
});

test('when the folder changes, the new one is watched and the old one is not', async () => {
  const a = tmp(), b = tmp();
  let cur = a;
  const { w, calls } = start(() => cur);
  try {
    await sleep(100);
    cur = b;
    assert.ok(await until(() => calls.n >= 1), 'told about the switch');
    await sleep(350);
    calls.n = 0;
    fs.writeFileSync(path.join(day(a), '1000-old.md'), 'x');
    await sleep(400);
    assert.equal(calls.n, 0, 'the old folder is no longer watched');
    fs.writeFileSync(path.join(day(b), '1000-new.md'), 'x');
    assert.ok(await until(() => calls.n === 1), 'the new one is');
  } finally { w.stop(); }
});

test('a folder that is removed while watched is picked up again when it comes back', async () => {
  const dir = tmp();
  day(dir);
  const { w, calls } = start(() => dir);
  try {
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
    await sleep(350);
    calls.n = 0;
    const d = day(dir);
    await sleep(350);
    calls.n = 0;
    fs.writeFileSync(path.join(d, '1000-back.md'), 'x');
    assert.ok(await until(() => calls.n >= 1));
  } finally { w.stop(); }
});

test('a caller that throws does not stop the watcher; getDir that throws is survived', async () => {
  const dir = tmp(), d = day(dir);
  let n = 0, bad = false;
  const w = watchMeetings(() => { if (bad) throw new Error('no folder'); return dir; }, () => { n += 1; throw new Error('boom'); }, FAST);
  try {
    await sleep(100);
    fs.writeFileSync(path.join(d, '1000-a.md'), 'x');
    assert.ok(await until(() => n === 1));
    bad = true;
    await sleep(350);
    bad = false;
    await sleep(350);
    fs.writeFileSync(path.join(d, '1000-b.md'), 'x');
    assert.ok(await until(() => n >= 2));
  } finally { w.stop(); }
});

test('stop() twice is fine, nothing fires afterwards and no timer or watch is left', async () => {
  // Unreferenced timers do not show in process.getActiveResourcesInfo(), so the watcher's own are followed directly.
  const live = new Set(), watches = [];
  const real = { setTimeout, setInterval, clearTimeout, clearInterval, watch: fs.watch };
  const mine = (cb) => cb && (cb.name === 'fire' || cb.name === 'check');
  global.setTimeout = (cb, ...a) => { const t = real.setTimeout(cb, ...a); if (mine(cb)) live.add(t); return t; };
  global.setInterval = (cb, ...a) => { const t = real.setInterval(cb, ...a); if (mine(cb)) live.add(t); return t; };
  global.clearTimeout = (t) => { live.delete(t); return real.clearTimeout(t); };
  global.clearInterval = (t) => { live.delete(t); return real.clearInterval(t); };
  fs.watch = (...a) => { const w = real.watch(...a); const rec = { w, closed: false }; const close = w.close.bind(w); w.close = () => { rec.closed = true; return close(); }; watches.push(rec); return w; };
  const dir = tmp(), d = day(dir);
  let calls;
  try {
    let w;
    ({ w, calls } = start(() => dir));
    await sleep(100);
    assert.equal(watches.length, 1);
    assert.ok(live.size >= 1, 'the periodic check is running');
    fs.writeFileSync(path.join(d, '1000-a.md'), 'x'); // a call is waiting when it is stopped
    await sleep(40);
    w.stop();
    w.stop();
    assert.equal(live.size, 0, 'no timer of the watcher is left');
    assert.ok(watches.every((x) => x.closed), 'the folder watch is closed');
    await sleep(350);
    assert.equal(calls.n, 0, 'the pending call was cancelled');
    fs.writeFileSync(path.join(d, '1000-b.md'), 'x');
    await sleep(400);
    assert.equal(calls.n, 0);
    assert.equal(watches.length, 1, 'and nothing was watched again');
  } finally { Object.assign(global, { setTimeout: real.setTimeout, setInterval: real.setInterval, clearTimeout: real.clearTimeout, clearInterval: real.clearInterval }); fs.watch = real.watch; }
});

test('which names are worth a look', () => {
  for (const n of ['2026-11-14\\1000-a.md', '2026-11-14/1000-a.MD', '1000-a.md', '2026-11-14']) assert.equal(worthALook(n, 'rename'), true, n);
  assert.equal(worthALook('2026-11-14', 'change'), false, 'a day folder only changes because a file in it did');
  for (const n of ['2026-11-14\\_daily.md', '_daily.md', 'a.txt', 'a.md.tmp', 'desktop.ini', 'Thumbs.db', '~$a.md', '.~lock.a.md#', 'a.partial', 'a.crdownload', '.live\\a.md', '2026-11-14\\.tmp.driveupload\\a.md', '', null, undefined, 5]) assert.equal(worthALook(n), false, String(n));
});
