'use strict';
// "Sync between PCs": which two folders a chosen folder means, what is refused, how files are counted and copied,
// the choice held in the main process, and the apply sequence (settings written only after a good copy).
// Everything runs in temp folders. The Claude connector is only ever given an explicit config file in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const S = require('../src/main/shared-folder');
const V = require('../src/main/validate');
const claude = require('../src/main/claude-connect');

const WIN = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-shared-'));
test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ } });
let n = 0;
const fresh = (name = 'case') => { const d = path.join(root, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, text = 'x', when) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (when) fs.utimesSync(file, when, when);
  return file;
};
const read = (f) => fs.readFileSync(f, 'utf8');
const list = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(dir, path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();
const read1 = (p) => fs.readFileSync(path.join(__dirname, '..', ...p.split('/')), 'utf8').replace(/\r\n/g, '\n');
// A message fit for a person: no error codes, no paths.
const plain = (m) => { assert.ok(typeof m === 'string' && m.length > 0); assert.doesNotMatch(m, /\b(?:E[A-Z]{3,8}|UNKNOWN)\b|[A-Za-z]:\\|\\\\|\/tmp\/|understudy-shared|at .*\(.*\)/, m); assert.doesNotMatch(m, /\u2014/, 'no em-dash'); };

// ---------------------------------------------------------------- which two folders

test('decide: a folder called Understudy is used as it is, whatever its case', () => {
  const base = fresh();
  for (const name of ['Understudy', 'UNDERSTUDY', 'understudy']) {
    const x = path.join(base, name);
    fs.mkdirSync(x, { recursive: true });
    assert.deepEqual(S.decide(x), { parent: x, meetingsDir: path.join(x, 'Meetings'), notesDir: path.join(x, 'Notes') });
  }
});

test('decide: a folder that already holds Meetings or Notes is used as it is, with the names it has', () => {
  const both = fresh(); fs.mkdirSync(path.join(both, 'Meetings')); fs.mkdirSync(path.join(both, 'Notes'));
  assert.deepEqual(S.decide(both), { parent: both, meetingsDir: path.join(both, 'Meetings'), notesDir: path.join(both, 'Notes') });
  const onlyM = fresh(); fs.mkdirSync(path.join(onlyM, 'Meetings'));
  assert.deepEqual(S.decide(onlyM), { parent: onlyM, meetingsDir: path.join(onlyM, 'Meetings'), notesDir: path.join(onlyM, 'Notes') });
  const onlyN = fresh(); fs.mkdirSync(path.join(onlyN, 'Notes'));
  assert.deepEqual(S.decide(onlyN), { parent: onlyN, meetingsDir: path.join(onlyN, 'Meetings'), notesDir: path.join(onlyN, 'Notes') });
  const odd = fresh(); fs.mkdirSync(path.join(odd, 'MEETINGS')); fs.mkdirSync(path.join(odd, 'notes'));
  const d = S.decide(odd);
  assert.equal(d.parent, odd);
  assert.equal(path.basename(d.meetingsDir), 'MEETINGS', 'the folder that is there keeps its spelling');
  assert.equal(path.basename(d.notesDir), 'notes');
});

test('decide: any other folder gets an Understudy folder inside it (an existing one is reused)', () => {
  const plainDir = fresh();
  fs.writeFileSync(path.join(plainDir, 'Notes.txt'), 'a file called Notes.txt is not a Notes folder');
  fs.mkdirSync(path.join(plainDir, 'Photos'));
  const u = path.join(plainDir, 'Understudy');
  assert.deepEqual(S.decide(plainDir), { parent: u, meetingsDir: path.join(u, 'Meetings'), notesDir: path.join(u, 'Notes') });
  const withU = fresh(); fs.mkdirSync(path.join(withU, 'understudy'));
  assert.equal(S.decide(withU).parent, path.join(withU, 'understudy'));
  // a folder that does not exist yet (the drive is empty) is simply plain
  const none = path.join(fresh(), 'not-made-yet');
  assert.equal(S.decide(none).meetingsDir, path.join(none, 'Understudy', 'Meetings'));
});

test('decide: trailing separators and a second PC choosing the same folder give the same two folders', () => {
  const x = fresh();
  const a = S.decide(x), b = S.decide(x + path.sep), c = S.decide(`${x}${path.sep}${path.sep}`);
  assert.deepEqual(b, a); assert.deepEqual(c, a);
  fs.mkdirSync(a.meetingsDir, { recursive: true }); fs.mkdirSync(a.notesDir, { recursive: true });
  // the second PC picks the Drive folder again, or the Understudy folder inside it: the same two folders either way
  assert.deepEqual(S.decide(x), a);
  assert.deepEqual(S.decide(a.parent), a);
  assert.deepEqual(S.decide(a.parent + path.sep), a);
});

test('decide: a UNC path keeps its server and share', { skip: !WIN }, () => {
  const d = S.decide('\\\\nas\\share\\Drive\\');
  assert.equal(d.parent, '\\\\nas\\share\\Drive\\Understudy');
  assert.equal(d.meetingsDir, '\\\\nas\\share\\Drive\\Understudy\\Meetings');
  const u = S.decide('\\\\nas\\share\\UNDERSTUDY');
  assert.equal(u.notesDir, '\\\\nas\\share\\UNDERSTUDY\\Notes');
});

// ---------------------------------------------------------------- refusals

test('refusal: a drive, the home folder, system folders, the data folder and a file are refused with a plain sentence', () => {
  const base = fresh();
  const home = path.join(base, 'home'), data = path.join(base, 'data'), sys = path.join(base, 'sys');
  for (const d of [home, data, sys, path.join(home, 'Drive'), path.join(sys, 'sub'), path.join(data, 'logs')]) fs.mkdirSync(d, { recursive: true });
  const guard = { home, appData: data, system: [sys] };
  const file = put(path.join(base, 'a-file.txt'));
  const cases = [
    [path.parse(base).root, /whole drive/],
    [home, /user folder itself/],
    [sys, /system folder/], [path.join(sys, 'sub'), /system folder/],
    [data, /own data folder/], [path.join(data, 'logs'), /own data folder/],
    [file, /file, not a folder/],
    [path.join(base, 'nothing-here'), /could not be found/],
    ['', /could not be found/],
  ];
  for (const [p, re] of cases) { const m = S.refusal(p, guard); assert.match(m, re, p); plain(m); }
  assert.equal(S.refusal(path.join(home, 'Drive'), guard), '', 'a folder inside the home folder is fine');
  assert.equal(S.refusal(base, guard), '');
  assert.equal(S.refusal(home + path.sep, guard) !== '', true, 'a trailing separator does not get round the rule');
  if (WIN) assert.match(S.refusal(home.toUpperCase(), guard), /user folder itself/, 'case does not get round the rule');
});

test('refusal: the real Windows folders are known by default', { skip: !WIN }, () => {
  for (const p of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files (x86)\\Foo', 'C:\\ProgramData', 'C:\\']) {
    const m = S.refusal(p, { home: 'C:\\Users\\nobody-here', appData: '' });
    assert.ok(m, p); plain(m);
  }
  assert.ok(S.systemDirs('win32', { SystemRoot: 'D:\\Win', ProgramFiles: 'D:\\PF' }).includes('D:\\Win'));
  assert.ok(S.systemDirs('linux').includes('/usr'));
});

// ---------------------------------------------------------------- counting and copying

function seed(dir) {
  const t = new Date('2026-03-04T10:20:30Z');
  put(path.join(dir, '2026-11-14', 'standup.md'), 'one', t);
  put(path.join(dir, '2026-11-15', 'review.md'), 'two', t);
  put(path.join(dir, 'top.md'), 'three', t);
  put(path.join(dir, 'screenshot.png'), 'png', t);
  // not copied
  put(path.join(dir, '_digest 2026-11-15.md'), 'digest');
  put(path.join(dir, '2026-11-15', '_digest.md'), 'digest');
  put(path.join(dir, '.versions', 'old.md'), 'old');
  put(path.join(dir, '.tmp.drivedownload', 'half.md'), 'half');
  put(path.join(dir, '~$review.md'), 'lock');
  for (const j of ['x.tmp', 'y.partial', 'z.crdownload', 'desktop.ini', 'Thumbs.db', 'thumbs.db']) put(path.join(dir, j), 'junk');
}
const KEPT = ['2026-11-14\\standup.md', '2026-11-15\\review.md', 'screenshot.png', 'top.md'].map((p) => p.split('\\').join(path.sep)).sort();

test('walk and count: only what would be copied, and only what is not already there', async () => {
  const from = fresh('from'), to = fresh('to');
  seed(from);
  const seen = [];
  for await (const f of S.walk(from)) seen.push(f.rel);
  assert.deepEqual(seen.sort(), KEPT);
  assert.equal(await S.countNew(from, to), 4);
  put(path.join(to, '2026-11-14', 'standup.md'), 'already here, and different');
  put(path.join(to, 'top.md'), 'already here');
  assert.equal(await S.countNew(from, to), 2, 'a file that is already there is not counted, whatever it holds');
  assert.equal(await S.countNew(from, from), 0, 'the same folder has nothing to copy');
  assert.equal(await S.countNew(path.join(from, 'missing'), to), 0, 'a folder that is not there counts as empty');
});

test('copyTree: copies the tree, keeps modification times, and leaves the originals alone', async () => {
  const from = fresh('from'), to = path.join(fresh('dest'), 'new', 'deeper');
  seed(from);
  const r = await S.copyTree(from, to);
  assert.deepEqual(r, { copied: 4, skipped: 0, failed: 0 });
  assert.deepEqual(list(to), KEPT);
  for (const rel of KEPT) {
    assert.equal(read(path.join(to, rel)), read(path.join(from, rel)));
    assert.equal(fs.statSync(path.join(to, rel)).mtimeMs, fs.statSync(path.join(from, rel)).mtimeMs, `${rel} keeps its date`);
  }
  assert.equal(fs.statSync(path.join(to, 'top.md')).mtime.toISOString(), '2026-03-04T10:20:30.000Z');
  assert.ok(list(from).length > KEPT.length, 'nothing was removed from the originals');
});

test('copyTree: never overwrites; a destination that already has some of the files gets only the rest', async () => {
  const from = fresh('from'), to = fresh('to');
  seed(from);
  put(path.join(to, 'top.md'), 'MINE, newer on this PC');
  put(path.join(to, '2026-11-14', 'standup.md'), 'MINE TOO');
  const r = await S.copyTree(from, to);
  assert.deepEqual(r, { copied: 2, skipped: 2, failed: 0 });
  assert.equal(read(path.join(to, 'top.md')), 'MINE, newer on this PC');
  assert.equal(read(path.join(to, '2026-11-14', 'standup.md')), 'MINE TOO');
  assert.equal(read(path.join(to, '2026-11-15', 'review.md')), 'two');
  const again = await S.copyTree(from, to);
  assert.deepEqual(again, { copied: 0, skipped: 4, failed: 0 }, 'a second run changes nothing');
});

test('copyTree: skips digests, dot-folders and sync leftovers', async () => {
  const from = fresh('from'), to = fresh('to');
  seed(from);
  await S.copyTree(from, to);
  const got = list(to).map((p) => path.basename(p));
  for (const bad of ['_digest 2026-11-15.md', '_digest.md', 'old.md', 'half.md', '~$review.md', 'x.tmp', 'y.partial', 'z.crdownload', 'desktop.ini', 'Thumbs.db', 'thumbs.db']) assert.ok(!got.includes(bad), bad);
  assert.ok(!fs.existsSync(path.join(to, '.versions')) && !fs.existsSync(path.join(to, '.tmp.drivedownload')));
});

test('copyTree: one file that cannot be copied is counted and the rest still go', async () => {
  const from = fresh('from'), to = fresh('to');
  seed(from);
  put(path.join(from, 'unreadable.md'), 'locked');
  const calls = [];
  const flaky = { ...fsp, copyFile: async (a, b, c) => { calls.push(path.basename(a)); if (a.endsWith('unreadable.md')) throw Object.assign(new Error(`EACCES: permission denied, copyfile '${a}'`), { code: 'EACCES' }); return fsp.copyFile(a, b, c); } };
  const r = await S.copyTree(from, to, { fs: flaky });
  assert.deepEqual(r, { copied: 4, skipped: 0, failed: 1 });
  assert.ok(!fs.existsSync(path.join(to, 'unreadable.md')));
  assert.deepEqual(list(to), KEPT);
  // a folder that cannot be read counts as a failure too
  const brokenDir = { ...fsp, readdir: async (p, o) => { if (p.endsWith('2026-11-15')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fsp.readdir(p, o); } };
  const to2 = fresh('to');
  const r2 = await S.copyTree(from, to2, { fs: brokenDir });
  assert.equal(r2.failed, 1); assert.equal(r2.copied, 4);
});

test('copyTree: a full or vanished destination stops the copy, with the count so far', async () => {
  const from = fresh('from'), to = fresh('to');
  for (let i = 0; i < 40; i += 1) put(path.join(from, `f${String(i).padStart(2, '0')}.md`), 'x');
  let k = 0;
  const full = { ...fsp, copyFile: async (a, b, c) => { if (++k > 20) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fsp.copyFile(a, b, c); } };
  await assert.rejects(() => S.copyTree(from, to, { fs: full }), (e) => {
    assert.ok(e instanceof S.CopyStopped);
    assert.match(e.message, /drive is full/); plain(e.message);
    assert.ok(e.partial.copied >= 1 && e.partial.copied < 40, `stopped part way (${e.partial.copied})`);
    return true;
  });
  assert.ok(fs.readdirSync(to).length < 40);
});

test('copyTree: the same folder copies nothing', async () => {
  const from = fresh('from'); seed(from);
  assert.deepEqual(await S.copyTree(from, from), { copied: 0, skipped: 0, failed: 0 });
  assert.deepEqual(await S.copyTree(from, from + path.sep), { copied: 0, skipped: 0, failed: 0 });
});

test('copyTree: 2,000 small files never hold the event loop for long', { timeout: 120000 }, async () => {
  const from = fresh('big-from');
  for (let i = 0; i < 2000; i += 1) fs.writeFileSync((fs.mkdirSync(path.join(from, `d${i % 40}`), { recursive: true }), path.join(from, `d${i % 40}`, `m${i}.md`)), `file ${i}`);
  // What a live meeting would feel: the longest gap between two ticks of the loop while the work runs. A busy
  // machine stretches every gap, so the same sampler is first run on an idle loop and that jitter is allowed for.
  const sample = async (work) => {
    let last = process.hrtime.bigint(), worst = 0;
    const timer = setInterval(() => { const t = process.hrtime.bigint(); worst = Math.max(worst, Number(t - last) / 1e6 - 2); last = t; }, 2);
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    try { await work(); } finally { clearInterval(timer); h.disable(); }
    return { worst, hist: h.max / 1e6 };
  };
  const idle = await sample(() => new Promise((ok) => setTimeout(ok, 300)));
  const allowed = 50 + 2 * idle.worst;
  let result, best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= allowed; attempt += 1) {
    const to = fresh('big-to');
    let counted, r;
    const s = await sample(async () => { counted = await S.countNew(from, to); r = await S.copyTree(from, to); r.again = await S.countNew(from, to); });
    assert.equal(counted, 2000);
    assert.deepEqual({ copied: r.copied, skipped: r.skipped, failed: r.failed, again: r.again }, { copied: 2000, skipped: 0, failed: 0, again: 0 });
    assert.equal(list(to).length, 2000);
    best = Math.min(best, s.worst); result = s;
  }
  assert.ok(best < allowed, `the longest stretch without a turn of the event loop was ${best.toFixed(1)} ms (allowed ${allowed.toFixed(1)} ms, idle jitter ${idle.worst.toFixed(1)} ms; monitorEventLoopDelay max ${result.hist.toFixed(1)} ms)`);
});

// ---------------------------------------------------------------- relations, the choice, and its expiry

test('relate: the same folders, folders inside each other, and unrelated ones', () => {
  const b = fresh();
  const cur = { meetingsDir: path.join(b, 'a', 'Meetings'), notesDir: path.join(b, 'a', 'Notes') };
  assert.deepEqual(S.relate(cur, { ...cur }), { same: true, overlap: false });
  assert.deepEqual(S.relate(cur, { meetingsDir: path.join(b, 'a', 'Meetings') + path.sep, notesDir: path.join(b, 'a', 'Notes') }), { same: true, overlap: false });
  assert.deepEqual(S.relate(cur, { meetingsDir: path.join(b, 'z', 'Meetings'), notesDir: path.join(b, 'z', 'Notes') }), { same: false, overlap: false });
  assert.equal(S.relate(cur, { meetingsDir: path.join(b, 'a', 'Meetings', 'in', 'Meetings'), notesDir: path.join(b, 'a', 'Meetings', 'in', 'Notes') }).overlap, true, 'new inside old');
  assert.equal(S.relate(cur, { meetingsDir: b, notesDir: path.join(b, 'N') }).overlap, true, 'old inside new');
  assert.equal(S.relate(cur, { meetingsDir: path.join(b, 'a', 'Notes'), notesDir: path.join(b, 'a', 'Meetings') }).overlap, true, 'swapped: each is the other');
  assert.equal(S.relate(cur, { meetingsDir: path.join(b, 'a', 'Meetings'), notesDir: path.join(b, 'z', 'Notes') }).overlap, false, 'one folder kept in place is not an overlap');
  assert.equal(S.relate(cur, { meetingsDir: path.join(b, 'a', 'Meetings2'), notesDir: path.join(b, 'a', 'Notes2') }).overlap, false, 'a name that only starts the same is not inside');
  if (WIN) assert.equal(S.relate(cur, { meetingsDir: path.join(b, 'A', 'MEETINGS'), notesDir: path.join(b, 'A', 'NOTES') }).same, true, 'case is ignored on Windows');
});

test('the pending choice expires, is replaced by a newer one, and is empty until set', () => {
  let t = 1000;
  const p = S.createPending({ now: () => t, ttlMs: 600000 });
  assert.equal(p.get(), null, 'nothing yet');
  p.set({ id: 1 });
  t += 599000; assert.deepEqual(p.get(), { id: 1 });
  p.set({ id: 2 });
  t += 599000; assert.deepEqual(p.get(), { id: 2 }, 'a newer choice replaced the older and restarted the clock');
  t += 2000; assert.equal(p.get(), null, 'expired after ten minutes');
  assert.equal(p.get(), null);
  p.set({ id: 3 }); p.clear(); assert.equal(p.get(), null);
  assert.equal(S.TTL_MS, 10 * 60 * 1000);
});

// ---------------------------------------------------------------- the sequence, without Electron

// A fake app: settings in a variable, a meeting flag, and a commit that records what the app would do.
function rig(extra = {}) {
  const base = fresh('rig');
  const oldM = path.join(base, 'Documents', 'Understudy', 'Meetings'), oldN = path.join(base, 'Documents', 'Understudy', 'Notes');
  const drive = path.join(base, 'Drive');
  fs.mkdirSync(drive, { recursive: true });
  const state = { settings: { meetingsDir: '', notesDir: '' }, active: false, commits: [], now: 1000 };
  const dirs = () => ({ meetingsDir: state.settings.meetingsDir || oldM, notesDir: state.settings.notesDir || oldN });
  const sf = S.createSharedFolder({
    current: dirs,
    defaults: () => ({ meetingsDir: oldM, notesDir: oldN }),
    guards: () => ({ home: path.join(base, 'home'), appData: path.join(base, 'data'), system: [path.join(base, 'sys')] }),
    meetingActive: () => state.active,
    commit: (next) => { state.commits.push(next); state.settings.meetingsDir = next.meetingsDir; state.settings.notesDir = next.notesDir; },
    now: () => state.now,
    ...extra,
  });
  return { base, oldM, oldN, drive, state, sf };
}

test('info: not shared by default, shared when both folders sit in one folder, two paths when they do not', () => {
  const r = rig();
  assert.deepEqual(r.sf.info(), { meetingsDir: r.oldM, notesDir: r.oldN, isDefault: true, shared: false, parent: null });
  const m = path.join(r.drive, 'Understudy', 'Meetings'), nn = path.join(r.drive, 'Understudy', 'Notes');
  r.state.settings = { meetingsDir: m, notesDir: nn };
  assert.deepEqual(r.sf.info(), { meetingsDir: m, notesDir: nn, isDefault: false, shared: true, parent: path.join(r.drive, 'Understudy') });
  r.state.settings = { meetingsDir: m, notesDir: path.join(r.base, 'elsewhere', 'Notes') };
  assert.deepEqual(r.sf.info(), { meetingsDir: m, notesDir: path.join(r.base, 'elsewhere', 'Notes'), isDefault: false, shared: false, parent: null });
  r.state.settings = { meetingsDir: path.join(r.oldM), notesDir: path.join(r.base, 'elsewhere', 'Notes') };
  assert.equal(r.sf.info().shared, false, 'the default Meetings folder with Notes elsewhere is not shared');
});

test('choose: the answer has the agreed shape, counts what would be copied, and remembers the choice', async () => {
  const r = rig();
  seed(r.oldM); put(path.join(r.oldN, 'idea.md'), 'idea'); put(path.join(r.oldN, 'shot.png'), 'png');
  const a = await r.sf.choose(r.drive);
  const u = path.join(r.drive, 'Understudy');
  assert.deepEqual(a, { meetingsDir: path.join(u, 'Meetings'), notesDir: path.join(u, 'Notes'), parent: u, existing: { meetings: 4, notes: 2 }, overlap: false, same: false });
  assert.ok(!fs.existsSync(u), 'choosing creates nothing: nothing is applied until the person confirms');
  assert.equal(r.state.commits.length, 0);
  assert.deepEqual(r.sf.pending.get(), { parent: u, meetingsDir: a.meetingsDir, notesDir: a.notesDir, chosen: r.drive });
  // a newer choice replaces it
  const other = path.join(r.base, 'Other'); fs.mkdirSync(other);
  const b = await r.sf.choose(other);
  assert.equal(r.sf.pending.get().parent, b.parent);
});

test('choose: what is already in the new folders is not counted; the current folders are "same"; overlap has nothing to copy', async () => {
  const r = rig();
  put(path.join(r.oldM, 'a.md'), 'a'); put(path.join(r.oldM, 'b.md'), 'b');
  const u = path.join(r.drive, 'Understudy');
  put(path.join(u, 'Meetings', 'a.md'), 'a'); // the other PC already put this one there
  assert.equal((await r.sf.choose(r.drive)).existing.meetings, 1);
  // choosing the folder the app already uses
  const docs = path.join(r.base, 'Documents');
  const same = await r.sf.choose(docs);
  assert.equal(same.same, true); assert.equal(same.overlap, false); assert.deepEqual(same.existing, { meetings: 0, notes: 0 });
  // a folder that would hold the old Meetings folder
  const wrap = path.join(r.base, 'Documents', 'Understudy', 'Meetings', 'Understudy');
  fs.mkdirSync(wrap, { recursive: true });
  const ov = await r.sf.choose(path.join(r.base, 'Documents', 'Understudy', 'Meetings'));
  assert.equal(ov.overlap, true); assert.deepEqual(ov.existing, { meetings: 0, notes: 0 }); assert.equal(ov.same, false);
});

test('choose: refused folders and a running meeting give plain sentences and remember nothing', async () => {
  const r = rig();
  fs.mkdirSync(path.join(r.base, 'home'), { recursive: true }); fs.mkdirSync(path.join(r.base, 'sys'), { recursive: true }); fs.mkdirSync(path.join(r.base, 'data'), { recursive: true });
  for (const p of [path.parse(r.base).root, path.join(r.base, 'home'), path.join(r.base, 'sys'), path.join(r.base, 'data'), path.join(r.base, 'missing')]) {
    await assert.rejects(() => r.sf.choose(p), (e) => { plain(e.message); return true; }, p);
  }
  assert.equal(r.sf.pending.get(), null);
  r.state.active = true;
  await assert.rejects(() => r.sf.choose(r.drive), (e) => e.message === 'Finish the meeting first.');
  assert.throws(() => r.sf.assertIdle(), /Finish the meeting first\./);
});

test('apply: without a choice, or after the choice has expired, it says to choose again and changes nothing', async () => {
  const r = rig();
  await assert.rejects(() => r.sf.apply({ copy: true }), (e) => e.message === 'Choose the folder again.');
  await r.sf.choose(r.drive);
  r.state.now += 10 * 60 * 1000 + 1;
  await assert.rejects(() => r.sf.apply({ copy: false }), (e) => e.message === 'Choose the folder again.');
  assert.equal(r.state.commits.length, 0);
  assert.ok(!fs.existsSync(path.join(r.drive, 'Understudy')), 'nothing was made');
});

test('apply with copy: the files arrive, the settings are written afterwards, and the choice is used up', async () => {
  const r = rig();
  seed(r.oldM); put(path.join(r.oldN, 'idea.md'), 'idea'); put(path.join(r.oldN, 'shot.png'), 'png');
  await r.sf.choose(r.drive);
  const u = path.join(r.drive, 'Understudy');
  r.state.settings = { meetingsDir: '', notesDir: '' };
  const res = await r.sf.apply({ copy: true });
  assert.deepEqual(res, { meetingsDir: path.join(u, 'Meetings'), notesDir: path.join(u, 'Notes'), copied: { meetings: 4, notes: 2, skipped: 0, failed: 0 } });
  assert.deepEqual(list(path.join(u, 'Meetings')), KEPT);
  assert.deepEqual(list(path.join(u, 'Notes')), ['idea.md', 'shot.png']);
  assert.equal(r.state.commits.length, 1);
  assert.equal(r.state.settings.meetingsDir, res.meetingsDir);
  assert.deepEqual(list(r.oldM).length > 4, true, 'the originals stay where they are');
  assert.equal(r.sf.pending.get(), null);
  await assert.rejects(() => r.sf.apply({ copy: true }), /Choose the folder again\./);
  // the app now reports the shared folder
  assert.deepEqual(r.sf.info(), { meetingsDir: res.meetingsDir, notesDir: res.notesDir, isDefault: false, shared: true, parent: u });
});

test('apply without copying: folders are made and switched, files are left behind', async () => {
  const r = rig();
  seed(r.oldM);
  await r.sf.choose(r.drive);
  const res = await r.sf.apply({ copy: false });
  assert.deepEqual(res.copied, { meetings: 0, notes: 0, skipped: 0, failed: 0 });
  assert.ok(fs.statSync(res.meetingsDir).isDirectory() && fs.statSync(res.notesDir).isDirectory(), 'both folders were made');
  assert.deepEqual(list(res.meetingsDir), []);
  assert.equal(r.state.commits.length, 1);
});

test('apply: a copy that cannot finish leaves the settings alone and says how many files were copied', async () => {
  let k = 0, limit = 1e9;
  const flaky = { ...fsp, copyFile: async (a, b, c) => { if (++k > limit) throw Object.assign(new Error(`ENOSPC: no space left on device, copyfile '${a}' -> '${b}'`), { code: 'ENOSPC' }); return fsp.copyFile(a, b, c); } };
  const r = rig({ fs: flaky });
  for (let i = 0; i < 30; i += 1) put(path.join(r.oldM, `m${i}.md`), 'x');
  await r.sf.choose(r.drive);
  k = 0; limit = 5;
  await assert.rejects(() => r.sf.apply({ copy: true }), (e) => {
    plain(e.message);
    assert.match(e.message, /Copying stopped because the drive is full\. \d+ files? (was|were) copied before that, and nothing was switched\. Your originals are untouched\./);
    return true;
  });
  assert.equal(r.state.commits.length, 0, 'the settings were not written');
  assert.deepEqual(r.state.settings, { meetingsDir: '', notesDir: '' });
  assert.equal(list(r.oldM).length, 30, 'the originals are all there');
  // the choice is still held, and trying again finishes the job (nothing is overwritten, what was copied is skipped)
  limit = 1e9; k = 0;
  const res = await r.sf.apply({ copy: true });
  assert.equal(res.copied.meetings + res.copied.skipped, 30);
  assert.ok(res.copied.skipped >= 1);
  assert.equal(r.state.commits.length, 1);
});

test('apply: a file that fails is counted, the rest are copied, and the switch still happens', async () => {
  const bad = { ...fsp, copyFile: async (a, b, c) => { if (a.endsWith('locked.md')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fsp.copyFile(a, b, c); } };
  const r = rig({ fs: bad });
  put(path.join(r.oldM, 'locked.md'), 'x'); put(path.join(r.oldM, 'fine.md'), 'y'); put(path.join(r.oldN, 'n.md'), 'z');
  await r.sf.choose(r.drive);
  const res = await r.sf.apply({ copy: true });
  assert.deepEqual(res.copied, { meetings: 1, notes: 1, skipped: 0, failed: 1 });
  assert.equal(r.state.commits.length, 1);
  assert.ok(fs.existsSync(path.join(r.oldM, 'locked.md')));
});

test('apply: refused while a meeting is running, also when one starts during the copy', async () => {
  const r = rig();
  put(path.join(r.oldM, 'a.md'), 'a');
  await r.sf.choose(r.drive);
  r.state.active = true;
  await assert.rejects(() => r.sf.apply({ copy: true }), (e) => e.message === 'Finish the meeting first.');
  assert.equal(r.state.commits.length, 0);
  assert.ok(!fs.existsSync(path.join(r.drive, 'Understudy')), 'not even the folders were made');
  assert.ok(r.sf.pending.get(), 'the choice is kept for when the meeting is over');
  r.state.active = false;
  // a meeting that starts while files are being copied
  let r2;
  const starts = { ...fsp, copyFile: async (a, b, c) => { r2.state.active = true; return fsp.copyFile(a, b, c); } };
  r2 = rig({ fs: starts });
  put(path.join(r2.oldM, 'a.md'), 'a');
  await r2.sf.choose(r2.drive);
  await assert.rejects(() => r2.sf.apply({ copy: true }), (e) => e.message === 'Finish the meeting first.');
  assert.equal(r2.state.commits.length, 0, 'the settings stay where the live meeting will write');
});

test('apply: overlapping folders switch without copying; a second apply at the same moment is turned away', async () => {
  const r = rig();
  put(path.join(r.oldM, 'a.md'), 'a');
  // the chosen folder is the current Meetings folder's parent chain: Documents\Understudy\Meetings\Understudy\...
  const inside = path.join(r.oldM, 'Understudy');
  fs.mkdirSync(inside, { recursive: true });
  const c = await r.sf.choose(r.oldM);
  assert.equal(c.overlap, true);
  const res = await r.sf.apply({ copy: true });
  assert.deepEqual(res.copied, { meetings: 0, notes: 0, skipped: 0, failed: 0 }, 'copy was asked for and refused: nothing was copied');
  assert.deepEqual(list(res.meetingsDir), []);

  const slow = rig({ fs: { ...fsp, copyFile: async (a, b, x) => { await new Promise((ok) => setTimeout(ok, 30)); return fsp.copyFile(a, b, x); } } });
  put(path.join(slow.oldM, 'a.md'), 'a');
  await slow.sf.choose(slow.drive);
  const first = slow.sf.apply({ copy: true });
  await assert.rejects(() => slow.sf.apply({ copy: true }), (e) => { plain(e.message); return true; });
  assert.equal((await first).copied.meetings, 1);
  assert.equal(slow.state.commits.length, 1, 'switched once');
});

test('apply: folders that cannot be made, and settings that cannot be saved, give plain sentences', async () => {
  const r = rig({ mkdirs: () => { throw new S.PlainError(S.plainReason({ code: 'EACCES' })); } });
  await r.sf.choose(r.drive);
  await assert.rejects(() => r.sf.apply({ copy: false }), (e) => { plain(e.message); assert.match(e.message, /not allowed to write there/); return true; });
  assert.equal(r.state.commits.length, 0);
  // the real mkdir: a file where the folder should go
  const r2 = rig();
  await r2.sf.choose(r2.drive);
  put(path.join(r2.drive, 'Understudy'), 'a file in the way');
  await assert.rejects(() => r2.sf.apply({ copy: false }), (e) => { plain(e.message); return true; });
  // commit fails
  const r3 = rig({ commit: () => { throw Object.assign(new Error('EPERM: cannot write C:\\secret\\settings.json'), { code: 'EPERM' }); } });
  await r3.sf.choose(r3.drive);
  await assert.rejects(() => r3.sf.apply({ copy: false }), (e) => { plain(e.message); assert.match(e.message, /nothing was switched/); return true; });
  assert.ok(r3.sf.pending.get(), 'the choice is kept so it can be tried again');
  // an unexpected error never reaches the window raw
  const r4 = rig({ current: () => { throw new Error('boom at C:\\Users\\someone\\x'); } });
  await assert.rejects(() => r4.sf.choose(r4.drive), (e) => { plain(e.message); return true; });
});

test('plainReason: file system errors become sentences with no code in them', () => {
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOENT', 'ENODEV', 'EIO', 'EHOSTUNREACH', 'ENOTDIR', 'EEXIST', 'EWHATEVER', undefined]) plain(S.plainReason({ code }));
  assert.match(S.plainReason({ code: 'ENOENT' }), /not available/);
  assert.match(S.plainReason({ code: 'ENOSPC' }), /no space/);
});

test('the Claude connection follows the switch, in an explicit config file in a temp folder', async () => {
  const cfgDir = fresh('claude'), configPath = path.join(cfgDir, 'claude_desktop_config.json');
  const exec = { execPath: process.execPath, serverPath: path.join(__dirname, '..', 'src', 'mcp', 'server.js'), configPath };
  let r;
  r = rig({ commit: (next) => { r.state.settings.meetingsDir = next.meetingsDir; r.state.settings.notesDir = next.notesDir; claude.refresh({ ...exec, meetingsDir: next.meetingsDir, notesDir: next.notesDir }); } });
  claude.install({ ...exec, meetingsDir: r.oldM, notesDir: r.oldN });
  assert.equal(JSON.parse(read(configPath)).mcpServers.understudy.env.UNDERSTUDY_MEETINGS_DIR, r.oldM);
  await r.sf.choose(r.drive);
  const res = await r.sf.apply({ copy: false });
  const env = JSON.parse(read(configPath)).mcpServers.understudy.env;
  assert.equal(env.UNDERSTUDY_MEETINGS_DIR, res.meetingsDir);
  assert.equal(env.UNDERSTUDY_NOTES_DIR, res.notesDir);
});

// ---------------------------------------------------------------- arguments, preload and main.js

test('validate: shared:apply takes only { copy: boolean }; a path from a window has no way in', () => {
  assert.deepEqual(V.cleanSharedApply({ copy: true }), { copy: true });
  assert.deepEqual(V.cleanSharedApply({ copy: false }), { copy: false });
  assert.deepEqual(V.cleanSharedApply(undefined), { copy: false });
  assert.deepEqual(V.cleanSharedApply({}), { copy: false });
  assert.deepEqual(V.cleanSharedApply({ copy: true, meetingsDir: 'C:\\evil', notesDir: 'C:\\evil2', parent: 'x' }), { copy: true }, 'extra fields are dropped');
  for (const bad of [{ copy: 'yes' }, { copy: 1 }, 'C:\\evil', 5, [true], true]) assert.throws(() => V.cleanSharedApply(bad), (e) => e instanceof V.ArgError && e.userFacing === true, JSON.stringify(bad));
});

test('main.js and preload: four channels, the folders never go through settings:set, the test hook is for unpackaged test runs only', () => {
  const main = read1('src/main/main.js'), preload = read1('src/preload.js');
  const invoke = new Set([...preload.match(/const INVOKE = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const ch of ['shared:choose', 'shared:apply', 'shared:info', 'shared:open']) {
    assert.ok(invoke.has(ch), `${ch} is callable from a window`);
    assert.ok(main.includes(`handle('${ch}'`), `${ch} is handled`);
  }
  const SETTABLE = new Function(`return ${main.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();
  for (const k of ['meetingsDir', 'notesDir']) assert.ok(!Object.keys(SETTABLE).includes(k) && !Object.values(SETTABLE).some((v) => v.includes(k)), `${k} is not settable from a window`);
  // the commit step: settings, the store's folder, the Claude connection (claudeOpts keeps a test run's config in its data folder), the library
  const commit = main.slice(main.indexOf('const sharedFolder = createSharedFolder('), main.indexOf('// Speech-to-text: open a stream'));
  assert.match(commit, /settings\.set\(\{ meetingsDir: next\.meetingsDir, notesDir: next\.notesDir \}\);[\s\S]*store\.dir = meetingsDir\(\);[\s\S]*claude\.refresh\(claudeOpts\(\)\);[\s\S]*reindexSoon\(\);/);
  assert.match(commit, /meetingActive: \(\) => Boolean\(meeting && meeting\.active\)/);
  assert.match(commit, /appData: app\.getPath\('userData'\)/);
  // the handlers: no path comes from the window, the hook is gated like the other UNDERSTUDY_ hooks
  const choose = main.slice(main.indexOf("handle('shared:choose'"), main.indexOf("handle('shared:apply'"));
  assert.match(choose, /DEV && process\.env\.UNDERSTUDY_DATA_DIR \? process\.env\.UNDERSTUDY_PICK_FOLDER : ''/);
  assert.match(choose, /handle\('shared:choose', async \(\) =>/, 'the choose handler takes no argument');
  assert.match(main, /handle\('shared:apply', \(arg\) => sharedFolder\.apply\(V\.cleanSharedApply\(arg\)\)\)/);
  assert.ok(!/UNDERSTUDY_PICK_FOLDER/.test(preload) && (main.match(/process.env.UNDERSTUDY_PICK_FOLDER/g) || []).length === 1, 'the hook is read in one place');
  // the module needs no Electron
  assert.ok(!/require\('electron'\)/.test(read1('src/main/shared-folder.js')));
});
