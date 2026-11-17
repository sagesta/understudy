'use strict';
// Fixes from the QA walk-through that live in the meeting store, the main process and the settings rules:
//   B2  "Rewrite notes" keeps the ticks and the Updates section (meetings/carry-over.js)
//   B9  a saved speaker cannot be renamed to a name another speaker (or the person) already has
//   B10 the live autosave is made again when its folder disappears, and a failure is told once
//   B7  a settings file that could not be read is reported once
//   B15 shortcuts, styles and keys sent straight to the main process are checked
// Temp folders only. main.js cannot be required outside Electron: the functions under test are cut out of its text
// and run against stubs, as hardening.test.js and notes-wiring.test.js do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../src/main/validate');
const { Settings, DEFAULTS } = require('../src/main/settings');
const { MeetingStore, newMeta, scanTasks, parse, useGeneratedTitle } = require('../src/main/meetings/store');
const { carryOver, openForRewrite, rewriteSaved } = require('../src/main/meetings/carry-over');
const { generateNotes, transcriptMdToPlain } = require('../src/main/meetings/notes');
const { createLlm, PROVIDERS: LLM_PROVIDERS } = require('../src/main/llm');
const { PROVIDERS: STT_PROVIDERS } = require('../src/main/stt');
const { MODES } = require('../src/main/triggers');
const { mockLlm } = require('./mocks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-qafix-'));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('src/main/main.js');
const between = (a, b) => { const i = mainSrc.indexOf(a), j = mainSrc.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} .. ${b} found in main.js`); return mainSrc.slice(i, j); };
const SETTABLE = new Function(`return ${mainSrc.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

// ---------------------------------------------------------------- B2: carryOver

const OLD = [
  '## Summary', 'They reviewed the release.', '',
  '## Action items', '### Mine',
  '- [x] Send the rollback plan (due: Friday) (done: 2026-11-10)',
  '- [ ] Book the room (due: not stated)',
  '### Others',
  '- [x] Priya: update the runbook (done: 2026-11-11)',
  '- [x] Tom: hand-ticked with no date',
  '', '## Updates', '',
  '- 2026-11-10: Priya confirmed the runbook lands on Friday.',
  '- 2026-11-12 (by Priya): Rollback tested.',
].join('\n');

const NEW = [
  '## Summary', 'The release was reviewed again.', '',
  '## Action items', '### Mine',
  '- [ ] send the  rollback plan (due: Monday)',
  '- [ ] Book the room (due: not stated)',
  '- [ ] Brand new task (due: not stated)',
  '### Others',
  '- [ ] Priya: UPDATE the runbook',
  '- [ ] Tom: hand-ticked with no date',
  '', '## Open questions', 'None.',
].join('\n');

const TRANSCRIPT = '## Transcript\n\n**[10:00:01] Priya:** Hello there.\n\n**[10:00:09] Ade:** - [ ] this is speech, not a task\n';
const taskLines = (text) => text.split('\n').filter((l) => /^- \[[ x]\]/.test(l));

test('carryOver: ticked tasks are ticked again, matched on their text however it was spaced, cased or dated', () => {
  const out = carryOver(OLD, NEW, { today: '2026-11-15' });
  assert.deepEqual(taskLines(out), [
    '- [x] send the  rollback plan (due: Monday) (done: 2026-11-10)',
    '- [ ] Book the room (due: not stated)',
    '- [ ] Brand new task (due: not stated)',
    '- [x] Priya: UPDATE the runbook (done: 2026-11-11)',
    '- [x] Tom: hand-ticked with no date',
  ]);
  const tasks = scanTasks(out.split('\n'));
  assert.deepEqual(tasks.map((t) => t.done), [true, false, false, true, true]);
  assert.deepEqual(tasks.map((t) => t.doneOn), ['2026-11-10', '', '', '2026-11-11', ''], 'each keeps the date it was ticked on');
  assert.equal(tasks.length, scanTasks(NEW.split('\n')).length, 'the same tasks in the same numbering');
  assert.deepEqual(tasks.map((t) => t.section), scanTasks(NEW.split('\n')).map((t) => t.section));
});

test('carryOver: the old Updates section is carried over line for line, at the end of the notes', () => {
  const out = carryOver(OLD, NEW, { today: '2026-11-15' });
  assert.ok(out.endsWith('## Open questions\nNone.\n\n## Updates\n\n- 2026-11-10: Priya confirmed the runbook lands on Friday.\n- 2026-11-12 (by Priya): Rollback tested.'), out.slice(-300));
  assert.equal((out.match(/^## Updates$/gm) || []).length, 1);
  // The notes the model wrote are otherwise as they were.
  assert.ok(out.startsWith('## Summary\nThe release was reviewed again.'));
});

test('carryOver: a new Updates heading is merged with the old one, in date order, without a second heading', () => {
  const fresh = `${NEW.replace('## Open questions', '## Updates\n\n- 2026-11-11: The model wrote this one itself.\n- 2026-11-13: And this one.\n\n## Open questions')}`;
  const out = carryOver(OLD, fresh, { today: '2026-11-15' });
  assert.equal((out.match(/^## Updates$/gm) || []).length, 1);
  const body = out.split('## Updates\n')[1].split('\n## ')[0].split('\n').filter(Boolean);
  assert.deepEqual(body, [
    '- 2026-11-10: Priya confirmed the runbook lands on Friday.',
    '- 2026-11-11: The model wrote this one itself.',
    '- 2026-11-12 (by Priya): Rollback tested.',
    '- 2026-11-13: And this one.',
  ]);
  assert.ok(out.indexOf('## Updates') < out.indexOf('## Open questions'), 'it stays where the new notes had it');
});

test('carryOver: a done task with no match in the new notes is kept as an update, dated by its tick or by today', () => {
  const fresh = '## Action items\n### Mine\n- [ ] Something else entirely\n';
  const out = carryOver(OLD, fresh, { today: '2026-11-15' });
  const body = out.split('## Updates\n')[1].split('\n').filter(Boolean);
  assert.deepEqual(body, [
    '- 2026-11-10: Priya confirmed the runbook lands on Friday.',
    '- 2026-11-10: Marked done earlier: Send the rollback plan (due: Friday)',
    '- 2026-11-11: Marked done earlier: Priya: update the runbook',
    '- 2026-11-12 (by Priya): Rollback tested.',
    '- 2026-11-15: Marked done earlier: Tom: hand-ticked with no date',
  ]);
  assert.deepEqual(scanTasks(out.split('\n')).map((t) => t.done), [false], 'the open task is as the new notes have it, and the lines under Updates are not tasks');
  // With no Updates in the old notes the section is made.
  const none = carryOver('## Action items\n- [x] Only one (done: 2026-11-09)', '## Summary\nNew.', { today: '2026-11-15' });
  assert.equal(none, '## Summary\nNew.\n\n## Updates\n\n- 2026-11-09: Marked done earlier: Only one');
});

test('carryOver: an open task stays open, and a task the old notes had open is never ticked', () => {
  const out = carryOver('## Action items\n- [ ] Open before\n- [x] Done before (done: 2026-11-01)', '## Action items\n- [x] Open before (done: 2026-11-02)\n- [ ] Done before', { today: '2026-11-15' });
  assert.deepEqual(taskLines(out), ['- [x] Open before (done: 2026-11-02)', '- [x] Done before (done: 2026-11-01)']);
});

test('carryOver: two equal tasks are paired one for one, in order', () => {
  const out = carryOver('- [x] Call them (done: 2026-11-01)\n- [ ] Call them\n- [x] Call them (done: 2026-11-03)', '- [ ] Call them\n- [ ] call them\n- [ ] Call them\n- [ ] Call them', { today: '2026-11-15' });
  assert.deepEqual(taskLines(out), ['- [x] Call them (done: 2026-11-01)', '- [x] call them (done: 2026-11-03)', '- [ ] Call them', '- [ ] Call them']);
});

test('carryOver: running it again changes nothing, whatever the day', () => {
  const cases = [[OLD, NEW], [OLD, '## Action items\n### Mine\n- [ ] Something else entirely\n'], ['- [x] A (done: 2026-11-01)', '- [ ] A'], [OLD, NEW.replace('## Open questions', '## Updates\n\n- 2026-11-11: Own line.\n\n## Open questions')]];
  for (const [o, n] of cases) {
    const once = carryOver(o, n, { today: '2026-11-15' });
    assert.equal(carryOver(o, once, { today: '2026-11-15' }), once, 'the same day');
    assert.equal(carryOver(o, once, { today: '2027-01-02' }), once, 'another day');
    assert.equal(carryOver(once, once, { today: '2027-01-02' }), once, 'the result carried over itself');
  }
  assert.equal(carryOver(OLD, NEW.replace(/\[ \]/g, '[x]'), { today: '2026-11-15' }).includes('(done: 2026-11-10)'), true, 'a task ticked in the new notes takes the old date');
});

test('carryOver: nothing to carry gives the new notes back exactly', () => {
  assert.equal(carryOver('## Summary\nOld.', NEW), NEW);
  assert.equal(carryOver('', ''), '');
  assert.equal(carryOver(undefined, null), '');
  assert.equal(carryOver('- [ ] open only', '- [ ] open only\r\n', { today: '2026-11-15' }), '- [ ] open only\r\n');
});

test('carryOver: the transcript is never touched, and the Updates go above it', () => {
  const out = carryOver(OLD + '\n\n## Transcript\n\n**[09:00:00] Old:** old words', `${NEW}\n\n${TRANSCRIPT}`, { today: '2026-11-15' });
  assert.ok(out.endsWith(`\n\n${TRANSCRIPT}`), 'the transcript is byte for byte as it was');
  assert.ok(out.indexOf('## Updates') < out.indexOf('## Transcript'));
  assert.ok(!out.includes('old words'), 'the old transcript is not used for anything');
  assert.ok(out.includes('- [ ] this is speech, not a task'), 'a line of speech that looks like a task is left alone');
  assert.equal(scanTasks(out.split('## Transcript')[0].split('\n')).length, scanTasks(NEW.split('\n')).length);
});

test('carryOver: Windows line endings in, Windows line endings out, with the same result', () => {
  const lf = carryOver(OLD, NEW, { today: '2026-11-15' });
  const crlf = carryOver(OLD.replace(/\n/g, '\r\n'), NEW.replace(/\n/g, '\r\n'), { today: '2026-11-15' });
  assert.equal(crlf, lf.replace(/\n/g, '\r\n'));
  assert.ok(!/(?<!\r)\n/.test(crlf), 'no bare line feed');
  assert.equal(carryOver(OLD.replace(/\n/g, '\r\n'), crlf, { today: '2026-11-15' }), crlf, 'and again');
  // Old notes with Windows endings, new notes without: one kind of ending in the result.
  assert.equal(carryOver(OLD.replace(/\n/g, '\r\n'), NEW, { today: '2026-11-15' }), lf);
});

test('carryOver: hostile text cannot break the notes, the numbering or the transcript', () => {
  const evil = [
    '## Action items',
    '- [x] Pay $& and $1 and $` and $\' (done: 2026-11-02)',
    '- [x] ## Transcript',
    `- [x] Line${LS}break${PS}here\u0000 with \u202e control`,
    '- [x] ' + 'long '.repeat(900),
    '- [x] `code` **bold** [x] [ ] - [ ] nested',
    '', '## Updates', '', '```', '## Transcript', 'not a heading, inside a fence', '- [ ] not a task either',
  ].join('\n');
  const fresh = '## Action items\n- [ ] Pay $& and $1 and $` and $\'\n- [ ] Unrelated\n\n```\nunclosed fence in the new notes';
  const out = carryOver(evil, `${fresh}\n\n${TRANSCRIPT}`, { today: '2026-11-15' });
  const head = out.split(/^## Transcript[ \t]*$/m);
  assert.equal(head.length, 2, 'exactly one transcript heading');
  assert.equal('## Transcript' + head[1], TRANSCRIPT, 'the transcript is as it was');
  const tasks = scanTasks(head[0].split('\n'));
  assert.equal(tasks.length, 2, 'only the two tasks of the new notes count, nothing in the fences or the updates');
  assert.ok(tasks[0].done && tasks[0].text === "Pay $& and $1 and $` and $'" && tasks[0].doneOn === '2026-11-02');
  assert.ok(!tasks[1].done);
  for (const l of head[0].split('\n').filter((x) => x.includes('Marked done earlier'))) {
    assert.ok(l.length < 2100, 'one update line is at most 2,000 characters of text');
    assert.ok(!/[\u0000\u202e]/.test(l) && !l.includes(LS) && !l.includes(PS), 'no control or invisible characters in what is written');
  }
  assert.equal(carryOver(evil, `${fresh}\n\n${TRANSCRIPT}`, { today: '2026-11-15' }), out, 'and it is stable');
});

// ---------------------------------------------------------------- B2: the regenerate path, through main.js

const DAY = new Date(2026, 10, 14, 10, 0, 0);
function savedMeeting(store, { notes = OLD, speakers = ['Ade Okoye', 'Priya N', 'Tom B.'], title = 'Release planning' } = {}) {
  const meta = newMeta(title, DAY);
  meta.end = '10:30'; meta.durationMin = 30; meta.speakers = speakers;
  const transcript = '**[10:00:01] Priya N:** Hello there.\n\n**[10:00:09] Ade Okoye:** Morning.\n\n**[10:00:20] Tom B.:** Hi both.';
  store.save(meta, notes, transcript);
  return meta;
}

async function regenerateRig(dir, reply) {
  const mock = await mockLlm(reply);
  const cfg = new Settings(path.join(dir, 'cfg'), { available: () => false });
  cfg.setSecret('anthropic', 'key');
  cfg.set({ me: { name: 'Ade Okoye' }, llm: { baseUrls: { anthropic: mock.url } } });
  const llm = createLlm(cfg, { allowBaseUrls: true });
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const events = [], handlers = {}, notesJobs = new Map();
  const settings = { get: () => ({ me: { name: 'Ade Okoye' }, library: { includeMeetings: false } }) };
  const src = `${between('// Notes are written after the transcript is already safely on disk.', '// ---------------------------------------------------------------- notes bridge')}\n${between("  handle('meetings:regenerate'", "  handle('meetings:renameSpeaker'")}`;
  new Function('store', 'llm', 'settings', 'generateNotes', 'transcriptMdToPlain', 'useGeneratedTitle', 'rewriteSaved', 'openForRewrite', 'broadcast', 'reindexLibrary', 'notesJobs', 'handle', src)(
    store, llm, settings, generateNotes, transcriptMdToPlain, useGeneratedTitle, rewriteSaved, openForRewrite, (m) => events.push(m), () => {}, notesJobs, (name, fn) => { handlers[name] = fn; });
  return { mock, store, events, regenerate: handlers['meetings:regenerate'], close: () => mock.close() };
}

const FRESH_NOTES = 'TITLE: A better title\n\n## Summary\nRegenerated.\n\n## Action items\n### Mine\n- [ ] Send the rollback plan (due: Monday)\n- [ ] Brand new task (due: not stated)\n### Others\n- [ ] Priya: update the runbook\n\n## Open questions\nNone.';

test('Rewrite notes keeps the ticks and the updates: ticked in the app, rewritten, still ticked', async () => {
  const dir = tmp();
  const r = await regenerateRig(dir, () => FRESH_NOTES);
  try {
    const meta = savedMeeting(r.store, { notes: '## Summary\nFirst.\n\n## Action items\n### Mine\n- [ ] Send the rollback plan (due: Friday)\n- [ ] Book the room\n### Others\n- [ ] Priya: update the runbook\n\n## Open questions\nNone.' });
    r.store.setActionItem(meta.id, { index: 0, text: 'Send the rollback plan (due: Friday)', done: true, on: '2026-11-14' });
    r.store.setActionItem(meta.id, { index: 2, text: 'Priya: update the runbook', done: true, on: '2026-11-15' });
    r.store.addUpdate(meta.id, 'Priya confirmed the runbook lands on Friday.', { on: '2026-11-15' });
    const before = r.store.find(meta.id);
    assert.equal(await r.regenerate(meta.id), true);
    assert.deepEqual(r.events.map((e) => e.status), ['working', 'done']);
    const after = r.store.find(meta.id);
    assert.ok(after.notes.includes('Regenerated.'), 'the new notes are in');
    assert.deepEqual(scanTasks(after.notes.split('\n')).map((t) => [t.text, t.done, t.doneOn]), [
      ['Send the rollback plan (due: Monday)', true, '2026-11-14'], ['Brand new task (due: not stated)', false, ''], ['Priya: update the runbook', true, '2026-11-15'],
    ]);
    assert.ok(after.notes.includes('## Updates\n\n- 2026-11-15: Priya confirmed the runbook lands on Friday.'));
    assert.ok(/- 2026-\d\d-\d\d: Marked done earlier: Send/.test(after.notes) === false, 'the matched tick is not also listed');
    assert.equal(after.transcript, before.transcript, 'the transcript is untouched');
    assert.equal(after.meta.title, 'Release planning', 'a title the person has is never replaced');
    assert.equal(r.mock.calls.length, 1);
    // And once more: nothing is lost on the second rewrite either.
    await r.regenerate(meta.id);
    const twice = r.store.find(meta.id);
    assert.equal(twice.notes, after.notes);
  } finally { await r.close(); }
});

test('Rewrite notes: a tick whose task the model dropped is kept as an update', async () => {
  const dir = tmp();
  const r = await regenerateRig(dir, () => 'TITLE: x\n\n## Summary\nShort.\n\n## Action items\n### Mine\nNone.');
  try {
    const meta = savedMeeting(r.store, { notes: '## Action items\n### Mine\n- [ ] Order the cake\n' });
    r.store.setActionItem(meta.id, { index: 0, text: 'Order the cake', done: true, on: '2026-11-13' });
    await r.regenerate(meta.id);
    const notes = r.store.find(meta.id).notes;
    assert.ok(notes.endsWith('## Updates\n\n- 2026-11-13: Marked done earlier: Order the cake'), notes);
  } finally { await r.close(); }
});

test('Rewrite notes: a file Understudy cannot read, or one that is gone, is refused before the model is asked', async () => {
  const dir = tmp();
  const r = await regenerateRig(dir, () => FRESH_NOTES);
  try {
    const meta = savedMeeting(r.store);
    const file = r.store.find(meta.id).file;
    const broken = fs.readFileSync(file, 'utf8').replace('duration_min: 30', 'duration_min: 30\nthis line is not a key');
    fs.writeFileSync(file, broken);
    await assert.rejects(() => r.regenerate(meta.id), /edited in a way Understudy cannot read, so it was left as it is\./);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'untouched');
    await assert.rejects(() => r.regenerate('20000101-000000'), /That meeting file no longer exists\./);
    await assert.rejects(() => r.regenerate(undefined), /no longer exists/);
    assert.equal(r.mock.calls.length, 0, 'no model call was made');
    assert.deepEqual(r.events, [], 'and nothing is left "working"');
  } finally { await r.close(); }
});

test('Rewrite notes: the saved notes are read again when the model has answered, so a change made meanwhile is carried too', async () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = savedMeeting(store, { notes: '## Action items\n- [ ] Order the cake' });
  const m = openForRewrite(store, meta.id);
  store.setActionItem(meta.id, { index: 0, text: 'Order the cake', done: true, on: '2026-11-13' }); // while the model writes
  const file = rewriteSaved(store, { ...m.meta, autoTitle: false }, '## Action items\n- [ ] Order the cake', m.transcript, { today: '2026-11-15' });
  assert.ok(store.find(meta.id).notes.includes('- [x] Order the cake (done: 2026-11-13)'));
  assert.equal(path.basename(file), path.basename(store.find(meta.id).file));
  fs.rmSync(file);
  assert.throws(() => rewriteSaved(store, { ...m.meta }, 'x', m.transcript), /no longer exists/);
});

test('main.js: the rewrite goes through carry-over, and the button says what is kept', () => {
  assert.ok(mainSrc.includes("require('./meetings/carry-over')"));
  assert.match(mainSrc, /const file = rewrite \? rewriteSaved\(store, meta, notes\.notesMd, transcriptMd\) : store\.save\(meta, notes\.notesMd, transcriptMd\);/, 'only a rewrite carries; the first writing has nothing to carry');
  assert.match(mainSrc, /writeNotes\(meta, m\.transcript, transcriptMdToPlain\(m\.transcript\), \{ rewrite: true \}\)/);
  assert.match(mainSrc, /writeNotes\(result\.meta, result\.transcriptMd, result\.transcriptPlain\)/, 'the first writing is as it was');
  const app = read('src/renderer/app.js');
  assert.ok(app.includes("const KEPT = 'Your ticks and updates are kept.'"));
  assert.equal((app.match(/'Rewrite notes', 'refresh', \(\) => rewriteNotes\(id\)[^)]*KEPT/g) || []).length, 1);
  assert.match(app, /hasNotes \? 'Rewrite notes' : 'Write notes', 'refresh', \(\) => rewriteNotes\(id\), '', hasNotes \? KEPT : ''/);
});

// ---------------------------------------------------------------- B9: renaming a saved speaker

test('renameSpeaker refuses the person\'s own name, whatever else is asked', () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = savedMeeting(store);
  const file = store.find(meta.id).file;
  const before = fs.readFileSync(file, 'utf8');
  const OWN = 'That is your own name. Choose another.';
  const reserved = ['Ade Okoye', 'Ade'];
  for (const to of ['Ade Okoye', 'ade okoye', '  ADE   Okoye ', 'Ade', 'ADE']) {
    for (const merge of [false, true]) {
      assert.throws(() => store.renameSpeaker(meta.id, 'Tom B.', to, { reserved, merge }), (e) => e.message === OWN && e.userFacing === true, `${to} merge=${merge}`);
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was written');
  // The person had no lines in this meeting: the name is still theirs.
  const quiet = newMeta('Quiet', new Date(2026, 10, 14, 11, 0, 0)); quiet.speakers = ['Tom B.'];
  store.save(quiet, 'x', '**[11:00:01] Tom B.:** Hello.');
  assert.throws(() => store.renameSpeaker(quiet.id, 'Tom B.', 'ade okoye', { reserved }), (e) => e.message === OWN);
  assert.equal(store.renameSpeaker(quiet.id, 'Tom B.', 'Tom Brown', { reserved }).notesMentionOld, false);
});

test('renameSpeaker: onto another speaker\'s name only with merge, and then the two are one', () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = savedMeeting(store);
  const file = store.find(meta.id).file;
  const before = fs.readFileSync(file, 'utf8');
  const ASK = (n) => `There is already a speaker called ${n} in this meeting. Choose merge to combine them.`;
  for (const to of ['Priya N', 'priya n', '  priya   N ']) {
    assert.throws(() => store.renameSpeaker(meta.id, 'Tom B.', to), (e) => e.message === ASK('Priya N') && e.userFacing === true, to);
    assert.throws(() => store.renameSpeaker(meta.id, 'Tom B.', to, { merge: false }), (e) => e.message === ASK('Priya N'));
  }
  // A speaker who only appears in the transcript is as present as one in the list.
  const lonely = newMeta('Lonely', new Date(2026, 10, 14, 13, 0, 0)); lonely.speakers = ['Priya N'];
  store.save(lonely, 'x', '**[13:00:01] Priya N:** One.\n\n**[13:00:09] Tom B.:** Two.');
  assert.throws(() => store.renameSpeaker(lonely.id, 'Priya N', 'Tom B.'), (e) => e.message === ASK('Tom B.'));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refusal writes nothing');
  const r = store.renameSpeaker(meta.id, 'Tom B.', 'priya n', { merge: true });
  assert.equal(r.merged, 'Priya N', 'joined under the spelling the meeting already has');
  const got = store.find(meta.id);
  assert.deepEqual(got.meta.speakers, ['Ade Okoye', 'Priya N']);
  assert.ok(got.transcript.includes('] Priya N:** Hi both.'));
  assert.ok(!/Tom B\./.test(got.transcript));
  // merge on a free name is just a rename, and says nothing was merged.
  const free = store.renameSpeaker(meta.id, 'Priya N', 'Priya Nair', { merge: true });
  assert.equal(free.merged, '');
});

test('renameSpeaker: a speaker may change the case or spacing of its own name, and any free name is still fine', () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = savedMeeting(store);
  store.renameSpeaker(meta.id, 'Tom B.', 'tom b.', { reserved: ['Ade Okoye'] });
  assert.deepEqual(store.find(meta.id).meta.speakers, ['Ade Okoye', 'Priya N', 'tom b.']);
  store.renameSpeaker(meta.id, 'tom b.', 'TOM  B.');
  assert.deepEqual(store.find(meta.id).meta.speakers, ['Ade Okoye', 'Priya N', 'TOM B.']);
  store.renameSpeaker(meta.id, 'TOM B.', 'Thomas Brown');
  assert.deepEqual(store.find(meta.id).meta.speakers, ['Ade Okoye', 'Priya N', 'Thomas Brown']);
  assert.ok(store.find(meta.id).transcript.includes('] Thomas Brown:** Hi both.'));
  assert.throws(() => store.renameSpeaker(meta.id, 'Thomas Brown', 'Thomas Brown'), /already the name/);
});

test('renameSpeaker: two unnamed voices are joined without asking (a voice the transcriber split in two)', () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = savedMeeting(store, { speakers: ['Ade Okoye', 'Speaker 1', 'Speaker 2', 'Priya N'] });
  store.save(meta, '', '**[10:00:01] Speaker 1:** a\n\n**[10:00:09] Speaker 2:** b\n\n**[10:00:20] Priya N:** c\n\n**[10:00:30] Ade Okoye:** d');
  assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 2', 'Priya N'), /Choose merge to combine them/);
  assert.throws(() => store.renameSpeaker(meta.id, 'Priya N', 'Speaker 1'), /Choose merge to combine them/);
  store.renameSpeaker(meta.id, 'Speaker 2', 'Speaker 1');
  assert.deepEqual(store.find(meta.id).meta.speakers, ['Ade Okoye', 'Speaker 1', 'Priya N']);
});

test('merge reaches the store only as true, from the window\'s own arguments', () => {
  assert.deepEqual(V.cleanRenameSpeakerCall('20261114-100000', 'Tom', 'Priya', true), { id: '20261114-100000', from: 'Tom', to: 'Priya', merge: true });
  assert.equal(V.cleanRenameSpeakerCall('20261114-100000', 'Tom', 'Priya').merge, false);
  assert.equal(V.cleanRenameSpeakerCall('20261114-100000', 'Tom', 'Priya', null).merge, false);
  for (const bad of ['yes', 1, {}, [true]]) assert.throws(() => V.cleanRenameSpeakerCall('20261114-100000', 'Tom', 'Priya', bad), (e) => e.message === 'Say whether to join the two speakers.');
  for (const [id, from, to] of [['../x', 'a', 'b'], [5, 'a', 'b'], ['20261114-100000', '', 'b'], ['20261114-100000', 5, 'b'], ['20261114-100000', 'a', 5], ['20261114-100000', 'a', 'x'.repeat(2001)]]) assert.throws(() => V.cleanRenameSpeakerCall(id, from, to, false), (e) => e instanceof V.ArgError);
});

test('main.js passes the person\'s name and aliases and the merge flag; the window asks twice before joining', () => {
  assert.match(mainSrc, /handle\('meetings:renameSpeaker', \(id, from, to, merge\) => \{\s*const c = V\.cleanRenameSpeakerCall\(id, from, to, merge\);/);
  assert.ok(mainSrc.includes('{ reserved: [me.name, ...(Array.isArray(me.aliases) ? me.aliases : [])], merge: c.merge }'));
  const app = read('src/renderer/app.js');
  assert.ok(app.includes("function editSpeaker(el, from, save, onError)"));
  assert.ok(app.includes("detail.querySelector('.titleline')"));
  assert.ok(app.includes("armBtn(`Merge ${from} into ${other[1]}`, null, `Merge into ${other[1]}? Click again`"));
  assert.ok(app.includes('`Merged ${from} into ${r.merged}.`'));
});

// ---------------------------------------------------------------- B10: the live autosave

const turn = (id, text) => ({ type: 'turn', turn: { id, t: DAY.getTime() + id * 1000, end: DAY.getTime() + id * 1000 + 500, speaker: 'Priya', text } });
const liveIn = (store, id) => fs.readFileSync(store._livePath(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('appendLive: the folder is made again when it disappears, and everything said so far is written to it', () => {
  const dir = tmp();
  const hints = [];
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'), { onLiveProblem: (m) => hints.push(m) });
  const meta = newMeta('Live', DAY);
  store.beginLive(meta);
  store.appendLive(meta.id, turn(1, 'first words'));
  store.appendLive(meta.id, { type: 'names', names: { 'k:1': 'Priya' } });
  fs.rmSync(path.join(dir, 'live'), { recursive: true, force: true });
  assert.doesNotThrow(() => store.appendLive(meta.id, turn(2, 'second words')));
  store.appendLive(meta.id, turn(3, 'third words'));
  const lines = liveIn(store, meta.id);
  assert.equal(lines[0].type, 'meta');
  assert.equal(lines[0].meta.id, meta.id);
  assert.deepEqual(lines.slice(1).map((l) => (l.turn ? l.turn.text : l.type)), ['first words', 'names', 'second words', 'third words']);
  assert.deepEqual(hints, [], 'it worked, so there is nothing to say');
  // Killed now: the next start turns it into a meeting with everything in it.
  const recovered = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live')).recoverOrphans(null);
  assert.equal(recovered.length, 1);
  const text = fs.readFileSync(recovered[0], 'utf8');
  for (const w of ['first words', 'second words', 'third words']) assert.ok(text.includes(w), w);
  // The same when only the file was removed.
  const meta2 = newMeta('Live two', new Date(2026, 10, 14, 12, 0, 0));
  store.beginLive(meta2); store.appendLive(meta2.id, turn(1, 'before'));
  fs.rmSync(store._livePath(meta2.id));
  store.appendLive(meta2.id, turn(2, 'after'));
  assert.deepEqual(liveIn(store, meta2.id).map((l) => (l.turn ? l.turn.text : l.type)), ['meta', 'before', 'after']);
  store.endLive(meta2.id);
  assert.ok(!fs.existsSync(store._livePath(meta2.id)), 'ending a meeting removes it, as before');
  assert.equal(store._live.has(meta2.id), false, 'and the copy kept in memory goes too');
});

test('appendLive: a failure that is not a missing folder is told once, and told again when it works', () => {
  const dir = tmp();
  const hints = [];
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'), { onLiveProblem: (m) => hints.push(m) });
  const meta = newMeta('Live', DAY);
  store.beginLive(meta);
  store.appendLive(meta.id, turn(1, 'one'));
  // A folder where the file should be: appending to it fails every time.
  const file = store._livePath(meta.id);
  fs.rmSync(file); fs.mkdirSync(file);
  for (const [i, w] of [[2, 'two'], [3, 'three'], [4, 'four']]) assert.doesNotThrow(() => store.appendLive(meta.id, turn(i, w)));
  assert.deepEqual(hints, ['Could not keep the recovery copy of this meeting. Understudy will keep trying.'], 'once, however often it fails');
  fs.rmdirSync(file);
  store.appendLive(meta.id, turn(5, 'five'));
  store.appendLive(meta.id, turn(6, 'six'));
  assert.deepEqual(hints, ['Could not keep the recovery copy of this meeting. Understudy will keep trying.', 'Recovery copy is working again.']);
  assert.deepEqual(liveIn(store, meta.id).map((l) => (l.turn ? l.turn.text : l.type)), ['meta', 'one', 'two', 'three', 'four', 'five', 'six'], 'what was said while it failed is in the file too');
  // A second episode is told again.
  fs.rmSync(file); fs.mkdirSync(file);
  store.appendLive(meta.id, turn(7, 'seven'));
  assert.equal(hints.length, 3);
});

test('appendLive: never throws, whatever the folder, the callback or the line is', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'blocked'), 'a file, not a folder');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'blocked', 'live'), { onLiveProblem: () => { throw new Error('the callback is broken'); } });
  const meta = newMeta('Live', DAY);
  assert.throws(() => store.beginLive(meta), 'starting still reports a folder that cannot be made, as it always did');
  assert.doesNotThrow(() => store.appendLive(meta.id, turn(1, 'x')), 'no autosave was begun');
  const ok = new MeetingStore(path.join(dir, 'M2'), path.join(dir, 'live2'));
  ok.beginLive(meta);
  const circular = {}; circular.me = circular;
  assert.doesNotThrow(() => ok.appendLive(meta.id, circular));
  assert.doesNotThrow(() => ok.appendLive('no-such-meeting', turn(1, 'x')));
  assert.doesNotThrow(() => new MeetingStore(path.join(dir, 'M3'), path.join(dir, 'live3')).appendLive('x', { type: 'turn' }));
});

test('appendLive: the copy kept in memory is bounded (about 8 MB), and a recreated file still holds the meta and what follows', () => {
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = newMeta('Long', DAY);
  store.beginLive(meta);
  const big = 'x'.repeat(1024 * 1024);
  for (let i = 1; i <= 9; i++) store.appendLive(meta.id, turn(i, big));
  const rec = store._live.get(meta.id);
  assert.equal(rec.full, true);
  assert.equal(rec.lines.length, 0, 'nothing more is kept once the limit is passed');
  assert.ok(rec.bytes <= 8 * 1024 * 1024);
  fs.rmSync(path.join(dir, 'live'), { recursive: true, force: true });
  store.appendLive(meta.id, turn(10, 'after the folder went'));
  assert.deepEqual(liveIn(store, meta.id).map((l) => (l.turn ? l.turn.text.slice(0, 8) : l.type)), ['meta', 'after th']);
});

test('main.js gives the store a callback that shows both sentences as hints', () => {
  assert.match(mainSrc, /new MeetingStore\(meetingsDir\(\), liveDir\(\), \{ onLiveProblem: \(message\) => broadcast\(\{ type: 'hint', message \}\) \}\)/);
});

// ---------------------------------------------------------------- B7: the notice for a damaged settings file

test('takeLoadNotice: one plain sentence for each file, no path, and only once', () => {
  const S = 'Your settings file could not be read, so Understudy started with its defaults. A copy of the damaged file was kept next to it.';
  const K = 'Your saved API keys could not be read. Please add them again. A copy of the damaged file was kept next to it.';
  const withPath = 'C:\\Users\\me\\AppData\\settings.corrupt-20261115-101500.json';
  const a = { loadProblem: { file: 'settings.json', backup: withPath }, loadProblems: [{ file: 'settings.json', backup: withPath }] };
  assert.equal(V.takeLoadNotice(a), S);
  assert.equal(a.loadProblem, null);
  assert.deepEqual(a.loadProblems, []);
  assert.equal(V.takeLoadNotice(a), '', 'shown once');
  assert.equal(V.takeLoadNotice({ loadProblem: { file: 'secrets.json', backup: withPath } }), K, 'only loadProblem, as an older settings.js has it');
  assert.equal(V.takeLoadNotice({ loadProblems: [{ file: 'settings.json', backup: 'a' }, { file: 'secrets.json', backup: 'b' }] }), `${S} ${K}`);
  assert.equal(V.takeLoadNotice({ loadProblem: { file: 'settings.json', backup: '' } }), 'Your settings file could not be read, so Understudy started with its defaults.', 'no copy could be made: it does not claim one');
  for (const none of [{}, { loadProblem: null }, { loadProblem: undefined, loadProblems: [] }, null, undefined, 5, { loadProblem: { file: '../x', backup: 'a' } }]) assert.equal(V.takeLoadNotice(none), '');
  assert.ok(!S.includes('\\') && !K.includes('\\'));
});

test('takeLoadNotice with the real Settings: a corrupt settings.json is set aside and reported', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
  const s = new Settings(dir, { available: () => false });
  assert.deepEqual(s.get().shortcuts, DEFAULTS.shortcuts);
  assert.ok(fs.readdirSync(dir).some((f) => /^settings\.corrupt-/.test(f)), 'the damaged file was kept');
  assert.match(V.takeLoadNotice(s), /^Your settings file could not be read, so Understudy started with its defaults\. A copy of the damaged file was kept next to it\.$/);
  assert.equal(V.takeLoadNotice(s), '');
  const clean = new Settings(tmp(), { available: () => false });
  assert.equal(V.takeLoadNotice(clean), '');
});

test('main.js shows the notice once, after the window has loaded, through the settings notice path', () => {
  assert.match(mainSrc, /appWin\.webContents\.once\('did-finish-load', \(\) => setTimeout\(\(\) => \{\s*const message = V\.takeLoadNotice\(settings\);\s*if \(message\) broadcast\(\{ type: 'error', where: 'settings', message \}\);/);
  assert.ok(read('src/renderer/app.js').includes("case 'error': toast(m.message, 'error', 9000); break;"), 'the window shows an error event as a toast');
});

// ---------------------------------------------------------------- B15: what the windows may send

const ctx = (current) => ({ settable: SETTABLE, autoModes: MODES, sttProviders: Object.keys(STT_PROVIDERS), llmProviders: Object.keys(LLM_PROVIDERS), personalityIds: () => ['default'], ...(current ? { currentShortcuts: () => current } : {}) });
const sc = (shortcuts, current = DEFAULTS.shortcuts) => V.sanitiseSettingsPatch({ shortcuts }, ctx(current));

test('shortcuts: a valid accelerator is accepted, and "" clears one', () => {
  const good = ['Alt+Shift+A', 'alt+shift+a', 'Control+Alt+F5', 'Ctrl+Shift+F24', 'CommandOrControl+Alt+Left', 'CmdOrCtrl+Shift+Space', 'Alt+Plus', 'Ctrl+Alt+,', 'Ctrl+Alt+-', 'Ctrl+\\',
    'Super+Enter', 'Meta+Tab', 'AltGr+X', 'Command+Alt+PageUp', 'Ctrl+Alt+Backspace', 'Ctrl+Alt+Delete', 'Ctrl+Alt+Home', 'Ctrl+Alt+End', 'Ctrl+Alt+Escape', 'Ctrl+Alt+Down', 'Ctrl+Alt+Up',
    'Ctrl+Alt+PageDown', 'Ctrl+Alt+Right', 'Ctrl+Alt+7', 'Ctrl+Alt+;', 'Ctrl+Alt+/', 'F9', 'F1', 'Shift+F12'];
  for (const a of good) {
    const r = sc({ take: a }, {});
    assert.deepEqual(r.patch, { shortcuts: { take: a } }, a);
    assert.deepEqual(r.rejected, [], a);
  }
  assert.deepEqual(sc({ take: '' }).patch, { shortcuts: { take: '' } });
});

test('shortcuts: a combination that is not one is refused with a sentence', () => {
  const bad = ['NotAKey+Q', 'Ctrl++', 'Ctrl+', '+A', '+', 'Ctrl+Ctrl+A', 'Ctrl+Control+A', 'Alt+Shift', 'Shift', 'F25', 'F0', 'Ctrl+Alt+AB', 'A', 'q', '5', ',', 'Ctrl+Hyper+A', 'Ctrl + A', ' Ctrl+A', 'Ctrl+Alt+Alt+F5',
    'Ctrl+€', 'Ctrl+Alt+Q+W', 'Ctrl+Alt+Plus+Plus', 'x'.repeat(41), 'Ctrl+Alt+\u0000', 5, null, {}, ['Ctrl+A'], true];
  for (const a of bad) {
    const r = sc({ take: a });
    assert.equal(r.patch.shortcuts, undefined, `${JSON.stringify(a)} is not saved`);
    assert.deepEqual(r.rejected, ['shortcuts.take'], JSON.stringify(a));
    assert.equal(r.refused['shortcuts.take'], 'That is not a shortcut Understudy can use. Hold Ctrl or Alt and press one key.', JSON.stringify(a));
  }
  // A good value beside a bad one is kept.
  const mix = V.sanitiseSettingsPatch({ shortcuts: { take: 'NotAKey+Q', catchup: 'Alt+Shift+K' }, me: { role: 'Eng' } }, ctx(DEFAULTS.shortcuts));
  assert.deepEqual(mix.patch, { shortcuts: { catchup: 'Alt+Shift+K' }, me: { role: 'Eng' } });
});

test('shortcuts: one already used by another action is refused, naming it; a swap in one patch is fine', () => {
  const names = { answer: 'What to say', screen: 'Read screen', take: 'My take', catchup: 'Catch up', pause: 'Pause or resume', toggleOverlay: 'Show or hide overlay' };
  assert.deepEqual(V.SHORTCUT_NAMES, names);
  for (const [other, name] of Object.entries(names)) {
    const key = other === 'take' ? 'pause' : 'take';
    for (const v of [DEFAULTS.shortcuts[other], DEFAULTS.shortcuts[other].toLowerCase(), DEFAULTS.shortcuts[other].replace(/^(\w+)\+(\w+)\+(\w)$/, '$2+$1+$3'),DEFAULTS.shortcuts[other].replace('Alt', 'alt')]) {
      const r = sc({ [key]: v });
      assert.equal(r.patch.shortcuts, undefined, v);
      assert.deepEqual(r.rejected, [`shortcuts.${key}`]);
      assert.equal(r.refused[`shortcuts.${key}`], `That shortcut is already used for ${name}.`, v);
    }
  }
  assert.equal(sc({ take: 'Ctrl+Alt+Z' }, { answer: 'Control+Alt+Z' }).refused['shortcuts.take'], 'That shortcut is already used for What to say.', 'Ctrl is Control');
  assert.equal(sc({ take: 'CommandOrControl+Alt+Z' }, { answer: 'Control+Alt+Z' }).refused['shortcuts.take'], 'That shortcut is already used for What to say.');
  // Its own combination again, and a free one, are fine; so is clearing.
  assert.deepEqual(sc({ take: DEFAULTS.shortcuts.take }).patch, { shortcuts: { take: DEFAULTS.shortcuts.take } });
  assert.equal(sc({ take: 'Alt+Shift+Q' }).refused, undefined);
  assert.deepEqual(sc({ take: '' }).patch, { shortcuts: { take: '' } });
  assert.deepEqual(sc({ take: DEFAULTS.shortcuts.take.toLowerCase() }).patch.shortcuts.take, DEFAULTS.shortcuts.take.toLowerCase(), 'a change of case of its own');
  // A swap is judged on the result.
  const swap = sc({ answer: DEFAULTS.shortcuts.screen, screen: DEFAULTS.shortcuts.answer });
  assert.deepEqual(swap.patch, { shortcuts: { answer: DEFAULTS.shortcuts.screen, screen: DEFAULTS.shortcuts.answer } });
  assert.deepEqual(swap.rejected, []);
  // A chain: one moves onto a free combination, another takes the one it left.
  assert.deepEqual(sc({ take: 'Alt+Shift+Q', catchup: DEFAULTS.shortcuts.take }).patch.shortcuts, { take: 'Alt+Shift+Q', catchup: DEFAULTS.shortcuts.take });
  // Clearing one and giving its combination to another.
  assert.deepEqual(sc({ answer: '', take: DEFAULTS.shortcuts.answer }).patch.shortcuts, { answer: '', take: DEFAULTS.shortcuts.answer });
  // Two keys of one patch asking for one new combination: the later one is refused.
  const both = sc({ take: 'Alt+Shift+Q', catchup: 'alt+shift+q' });
  assert.deepEqual(both.patch.shortcuts, { take: 'Alt+Shift+Q' });
  assert.equal(both.refused['shortcuts.catchup'], 'That shortcut is already used for My take.');
  // Without the current set in the context, only the patch itself is judged.
  assert.deepEqual(V.sanitiseSettingsPatch({ shortcuts: { take: 'Alt+Shift+A' } }, ctx()).patch, { shortcuts: { take: 'Alt+Shift+A' } });
});

test('shortcuts: values already on disk are repaired by the same rule, and the defaults all pass it', () => {
  for (const v of Object.values(DEFAULTS.shortcuts)) assert.ok(V.parseAccel(v), v);
  const { patch, fixed } = V.repairSettings({ shortcuts: { answer: 'NotAKey+Q', screen: 'Alt+Shift+K', take: 'Alt+Shift+A' } }, DEFAULTS, ctx());
  assert.deepEqual(patch, { shortcuts: { answer: DEFAULTS.shortcuts.answer } });
  assert.deepEqual(fixed, ['shortcuts.answer']);
});

test('main.js: a refused shortcut goes back to the window that asked, and the recorder shows it in place', () => {
  const sandbox = (current) => {
    const sent = [];
    const src = between('const vctx = () =>', '// Settings written by an older version');
    const make = new Function('SETTABLE', 'AUTO_MODES', 'STT_PROVIDERS', 'LLM_PROVIDERS', 'listPersonalities', 'settings', 'V', 'broadcast', `${src}; return settable;`);
    return { sent, settable: make(SETTABLE, MODES, STT_PROVIDERS, LLM_PROVIDERS, () => [{ id: 'default' }], { get: () => ({ shortcuts: current }) }, V, (m) => sent.push(m)) };
  };
  const t = sandbox(DEFAULTS.shortcuts);
  const r = t.settable({ shortcuts: { take: DEFAULTS.shortcuts.answer }, me: { role: 'Eng' } });
  assert.deepEqual(r.patch, { me: { role: 'Eng' } });
  assert.deepEqual(r.refused, { 'shortcuts.take': 'That shortcut is already used for What to say.' });
  assert.deepEqual(t.sent, [], 'the sentence is not also thrown at the window as a notice');
  const o = t.settable({ appearance: { theme: 'neon' }, shortcuts: { take: 'NotAKey+Q' } });
  assert.deepEqual(o.refused, { 'shortcuts.take': 'That is not a shortcut Understudy can use. Hold Ctrl or Alt and press one key.' });
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].message, /appearance\.theme/);
  assert.ok(!t.sent[0].message.includes('shortcuts'), 'the other refusals are told as before');
  assert.deepEqual(t.settable({ me: { role: 'Eng' } }).refused, {});
  assert.match(mainSrc, /return Object\.keys\(refused\)\.length \? \{ \.\.\.publicSettings\(\), refused \} : publicSettings\(\);/);
  const app = read('src/renderer/app.js');
  assert.ok(app.includes("say.textContent = (cfg.refused && cfg.refused[`shortcuts.${key}`]) || '';"));
  assert.ok(app.includes('return [b, say];'));
});

test('personalities: the argument is checked, with plain sentences', () => {
  assert.deepEqual(V.cleanPersonalitySave({ id: '', name: 'Blunt', description: 'Short.', text: 'Be brief.' }), { id: '', name: 'Blunt', description: 'Short.', text: 'Be brief.' });
  assert.deepEqual(V.cleanPersonalitySave({ name: 'Blunt', text: 'x' }), { id: '', name: 'Blunt', description: '', text: 'x' });
  assert.equal(V.cleanPersonalitySave({ id: 'a'.repeat(80), text: 'x'.repeat(20000) }).text.length, 20000);
  const refuse = (arg, re) => assert.throws(() => V.cleanPersonalitySave(arg), (e) => e instanceof V.ArgError && e.userFacing === true && re.test(e.message), String(JSON.stringify(arg)).slice(0, 50));
  for (const bad of [null, undefined, 'x', 5, [], true]) refuse(bad, /^That style could not be saved\.$/);
  refuse({ name: 'x', text: 'y'.repeat(20001) }, /^The style is too long \(over 20,000 characters\)\.$/);
  refuse({ id: 'a'.repeat(81), text: 'x' }, /^The style id is too long \(over 80 characters\)\.$/);
  refuse({ name: 'n'.repeat(81), text: 'x' }, /^The style name is too long/);
  refuse({ name: 'x', description: 'd'.repeat(501), text: 'x' }, /^The description is too long/);
  refuse({ name: 5, text: 'x' }, /^The style name must be text\.$/);
  refuse({ id: {}, text: 'x' }, /^The style id must be text\.$/);
  refuse({ name: 'x', text: ['a'] }, /^The style must be text\.$/);
  refuse({ name: 'x', text: '   ' }, /^A style needs a name and a description of how to answer\.$/);
  refuse({ name: '  ', id: '', text: 'x' }, /^A style needs a name and a description of how to answer\.$/);
  assert.equal(V.cleanPersonalityDelete('blunt-mine'), 'blunt-mine');
  for (const bad of [null, undefined, 5, {}, ['a'], '', '   ', 'a'.repeat(81)]) assert.throws(() => V.cleanPersonalityDelete(bad), (e) => e.message === 'That style could not be found.', String(bad));
  assert.ok(mainSrc.includes("handle('personalities:save', (arg) => {\n    const { id, name, description, text } = V.cleanPersonalitySave(arg);"));
  assert.ok(mainSrc.includes('V.cleanPersonalityDelete(id)'));
});

test('secrets: the key must be text, trimmed, one line, at most 500 characters; "" removes it', () => {
  assert.equal(V.cleanSecretValue('  sk-ant-123  \n'), 'sk-ant-123');
  assert.equal(V.cleanSecretValue(''), '');
  assert.equal(V.cleanSecretValue('   '), '', 'blank is the same as empty');
  assert.equal(V.cleanSecretValue('k'.repeat(500)).length, 500);
  const refuse = (v, re) => assert.throws(() => V.cleanSecretValue(v), (e) => e instanceof V.ArgError && re.test(e.message), JSON.stringify(v));
  for (const bad of [{ a: 1 }, [1], 5, null, undefined, true]) refuse(bad, /^A key must be text\.$/);
  refuse('k'.repeat(501), /^That key is too long \(over 500 characters\)\.$/);
  for (const bad of ['a\nb', 'a\r\nb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', `a${LS}b`, 'a\u200bb', 'a\u202eb']) refuse(bad, /^A key cannot contain line breaks or other control or invisible characters\.$/);
  // The handler: a known name, then the checked value.
  const run = (name, value) => {
    const saved = [];
    const src = mainSrc.match(/handle\('secrets:set'[\s\S]*?\n  \}\);/)[0];
    const handlers = {};
    new Function('handle', 'settings', 'V', 'publicSettings', src)((n, fn) => { handlers[n] = fn; }, { setSecret: (n, v) => saved.push([n, v]) }, V, () => 'settings');
    return { saved, result: () => handlers['secrets:set'](name, value) };
  };
  const ok = run('anthropic', '  sk-1 ');
  assert.equal(ok.result(), 'settings');
  assert.deepEqual(ok.saved, [['anthropic', 'sk-1']]);
  assert.throws(run('anthropic', { a: 1 }).result, (e) => e.message === 'A key must be text.');
  assert.throws(run('evil', 'x').result, (e) => e.message === 'Unknown key name.');
  assert.throws(run({ toString: () => 'anthropic' }, 'x').result, (e) => e.message === 'Unknown key name.');
  assert.throws(run('__proto__', 'x').result, (e) => e.message === 'Unknown key name.');
  const removed = run('openai', '');
  removed.result();
  assert.deepEqual(removed.saved, [['openai', '']]);
});

test('the window\'s own calls still pass the checks: a style as the Styles page sends it, a key as the Keys page sends it', () => {
  const app = read('src/renderer/app.js');
  assert.ok(app.includes("call('personalities:save', { id: sel.isNew ? '' : sel.id, name: name.value, description: desc.value, text: text.value })"));
  assert.deepEqual(V.cleanPersonalitySave({ id: '', name: 'My style', description: 'How to answer', text: 'Long text '.repeat(500) }).id, '');
  assert.deepEqual(V.cleanPersonalitySave({ id: 'default-mine', name: 'Default (mine)', description: '', text: 'x' }).name, 'Default (mine)');
});

// ---------------------------------------------------------------- pages that read the file as it is

test('a rewritten file still reads back as the same meeting: front matter, transcript and the person\'s own lines', async () => {
  const dir = tmp();
  const r = await regenerateRig(dir, () => FRESH_NOTES);
  try {
    const meta = savedMeeting(r.store, { notes: '## Action items\n### Mine\n- [ ] Send the rollback plan (due: Friday)' });
    const file = r.store.find(meta.id).file;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('source: understudy', 'source: understudy\nowner: "Ade"'));
    r.store.setActionItem(meta.id, { index: 0, text: 'Send the rollback plan (due: Friday)', done: true, on: '2026-11-14' });
    await r.regenerate(meta.id);
    const raw = fs.readFileSync(r.store.find(meta.id).file, 'utf8');
    assert.ok(raw.includes('owner: "Ade"'), 'front matter the person added is kept');
    const m = parse(raw, file);
    assert.equal(m.frontMatter, 'ok');
    assert.deepEqual(m.meta.speakers, ['Ade Okoye', 'Priya N', 'Tom B.']);
    assert.ok(m.notes.includes('- [x] Send the rollback plan (due: Monday) (done: 2026-11-14)'));
  } finally { await r.close(); }
});

// ---------------------------------------------------------------- live renaming and the background check

const { Transcript } = require('../src/main/transcript');
const { MeetingSession } = require('../src/main/session');
const { Library } = require('../src/main/knowledge/library');
const { mockDeepgram } = require('./mocks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return fn(); };

test('live: a voice cannot be given the person\'s own name or alias; another voice\'s name is allowed (joining two labels)', () => {
  const t = new Transcript({ myLabel: 'Ade Okoye', myNames: ['Ade Okoye', 'A.'] });
  t.addFinal('them', 'First thing.', 'Speaker 1', 1000, '1.1');
  t.addFinal('them', 'Second thing.', 'Speaker 2', 9000, '1.1');
  const OWN = 'That is your own name. Choose another.';
  for (const n of ['Ade Okoye', 'ade okoye', '  ADE   OKOYE ', 'A.', ' a. ']) assert.throws(() => t.setName('1.1:Speaker 1', n), (e) => e.message === OWN, n);
  assert.equal(t.names.size, 0, 'nothing was named');
  t.setName('1.1:Speaker 1', 'Priya');
  t.setName('1.1:Speaker 2', 'priya'); // the same person under two labels: allowed
  assert.deepEqual(t.turns.map((x) => x.speaker), ['Priya', 'priya']);
  t.setName('1.1:Speaker 1', ''); // clearing is always fine
  // Without the person's names nothing changes.
  assert.doesNotThrow(() => new Transcript({ myLabel: 'Ade' }).addFinal('them', 'x y z', 'Speaker 1', 1, '1.1') && new Transcript().names);
});

async function sessionRig(dir, reply, me = { name: 'Ade Okoye', aliases: ['Ade'] }) {
  const mock = await mockLlm(reply);
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), { available: () => false });
  settings.set({ me, llm: { baseUrls: { anthropic: mock.url } } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library: new Library(), store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  return { session, mock, close: async () => { await mock.close(); await dg.close(); } };
}

test('live: session.renameSpeaker refuses the person\'s own name and alias, taken from the settings', async () => {
  const dir = tmp();
  const r = await sessionRig(dir, () => 'ok');
  try {
    r.session.start({ channels: ['them'] });
    r.session.transcript.addFinal('them', 'Hello from the other side.', 'Speaker 1', Date.now(), '1.1');
    for (const n of ['Ade Okoye', 'ade', ' ADE  okoye']) assert.throws(() => r.session.renameSpeaker('1.1:Speaker 1', n), (e) => e.message === 'That is your own name. Choose another.', n);
    assert.deepEqual(r.session.renameSpeaker('1.1:Speaker 1', 'Priya').map((x) => x.display), ['Priya']);
    await r.session.stop();
  } finally { await r.close(); }
});

test('the background check ("proactive") does not search the web; the other actions still may', async () => {
  const dir = tmp();
  const r = await sessionRig(dir, () => 'SKIP');
  const searched = (c) => JSON.stringify(c.body).includes('web_search');
  try {
    r.session.start({ channels: ['them'] });
    r.session.runAction('proactive', {}, { auto: true });
    assert.ok(await until(() => r.mock.calls.length >= 1), 'the check asked the model');
    r.session.runAction('say', { typed: 'What is the capital of France?' });
    assert.ok(await until(() => r.mock.calls.length >= 2), 'a normal answer asked the model');
    assert.equal(searched(r.mock.calls[0]), false, 'the background check has no search tool');
    assert.equal(searched(r.mock.calls[1]), true, 'an answer you asked for does');
    r.session.runAction('catchup', {});
    assert.ok(await until(() => r.mock.calls.length >= 3));
    assert.equal(searched(r.mock.calls[2]), false, 'and a recap, as before, does not');
    await r.session.stop();
  } finally { await r.close(); }
});

test('the overlay shows a refused name where it is, and the source says which actions search', () => {
  assert.ok(read('src/renderer/overlay.js').includes('.catch((err) => transient(err.message, true));'));
  assert.ok(read('src/main/session.js').includes("action !== 'catchup' && action !== 'proactive'"));
});
