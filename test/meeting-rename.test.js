'use strict';
// Renaming a saved meeting: the store method (src/main/meetings/store.js), the checks on what a window sends
// (src/main/validate.js) and the rule that keeps the person's title when notes are rewritten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MeetingStore, newMeta, parse, useGeneratedTitle } = require('../src/main/meetings/store');
const V = require('../src/main/validate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-rn-'));
const NOTES = '## Summary\nWe agreed the plan.\n\n## Action items\n### Mine\n- [ ] Send the deck\n\n## Open questions\nNone.';
const TRANSCRIPT = '**[10:00:01] Speaker 1:** Hello.\n\n**[10:00:09] Ade:** Hi there.';
const SENT = {
  none: 'Type a title for this meeting.',
  gone: 'That meeting file no longer exists.',
  changed: 'This meeting file changed while it was being renamed. Try again.',
  unreadable: 'This meeting file has been edited in a way Understudy cannot read, so it was left as it is.',
};
const read = (f) => fs.readFileSync(f, 'utf8');

function setup({ title = 'Standup', at = new Date(2026, 10, 14, 10, 0, 0), notes = NOTES, extra } = {}) {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = newMeta(title, at);
  meta.speakers = ['Speaker 1', 'Ade'];
  if (extra) meta.frontExtra = extra;
  const file = store.save(meta, notes, TRANSCRIPT);
  return { dir, store, meta, file, id: meta.id, day: path.dirname(file) };
}
const mdFiles = (day) => fs.readdirSync(day).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();
const msg = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test('a rename changes the title in the front matter, the heading and the file name, and nothing else', () => {
  const { store, id, file, day } = setup();
  const before = read(file);
  const r = store.renameMeeting(id, 'Pipeline review with Ade');
  assert.equal(r.changed, true);
  assert.equal(path.basename(r.file), '1000-pipeline-review-with-ade.md');
  assert.equal(fs.existsSync(file), false, 'the old file is gone');
  assert.deepEqual(mdFiles(day), ['1000-pipeline-review-with-ade.md']);
  const after = read(r.file);
  assert.equal(after, before.replace('title: "Standup"', 'title: "Pipeline review with Ade"').replace('# Standup', '# Pipeline review with Ade'));
  const m = store.find(id);
  assert.equal(m.meta.title, 'Pipeline review with Ade');
  assert.equal(m.notes, parse(before, file).notes);
  assert.equal(m.transcript, parse(before, file).transcript);
  assert.deepEqual(m.meta.speakers, ['Speaker 1', 'Ade']);
});

test('the listing and the daily digest show the new title at once', () => {
  const { store, id, day, meta } = setup();
  assert.equal(store.list()[0].title, 'Standup'); // fills the listing cache
  store.dailyDigest(meta.date);
  const r = store.renameMeeting(id, 'Roadmap');
  const l = store.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'Roadmap');
  assert.equal(l[0].file, r.file);
  const digest = read(path.join(day, '_daily.md'));
  assert.match(digest, /## 10:00 Roadmap/);
  assert.match(digest, /File: 1000-roadmap\.md/);
  assert.doesNotMatch(digest, /Standup/);
  assert.equal(store.find(id).file, r.file);
});

test('unknown front matter keys, CRLF line endings and a byte-order mark are kept', () => {
  const { store, id, file } = setup({ extra: ['project: "Apollo"', 'tags: [a, b]', '# my own comment'] });
  const crlf = '\uFEFF' + read(file).replace(/\n/g, '\r\n');
  fs.writeFileSync(file, crlf);
  const r = store.renameMeeting(id, 'Apollo kickoff');
  const after = fs.readFileSync(r.file, 'utf8');
  assert.equal(after, crlf.replace('title: "Standup"', 'title: "Apollo kickoff"').replace('# Standup', '# Apollo kickoff'));
  assert.ok(after.startsWith('\uFEFF---\r\n'));
  assert.ok(after.includes('project: "Apollo"\r\n') && after.includes('tags: [a, b]\r\n') && after.includes('# my own comment\r\n'));
  assert.ok(!/[^\r]\n/.test(after), 'every line ending is still CRLF');
  assert.equal(store.find(id).meta.title, 'Apollo kickoff');
});

test('a heading that no longer shows the old title is left alone, and a missing title line is added', () => {
  const { store, id, file } = setup();
  fs.writeFileSync(file, read(file).replace('# Standup', '# Something I wrote myself'));
  const r = store.renameMeeting(id, 'Planning');
  assert.ok(read(r.file).includes('# Something I wrote myself'));
  assert.ok(read(r.file).includes('title: "Planning"'));

  const b = setup({ title: 'Other' });
  fs.writeFileSync(b.file, read(b.file).replace(/^title: .*\n/m, ''));
  const r2 = b.store.renameMeeting(b.id, 'Added title');
  assert.equal(b.store.find(b.id).meta.title, 'Added title');
  assert.match(read(r2.file), /^id: .*\ntitle: "Added title"\n/m);
});

test('the same title changes nothing', () => {
  const { store, id, file } = setup();
  const before = read(file);
  const r = store.renameMeeting(id, '  Standup  ');
  assert.equal(r.changed, false);
  assert.equal(read(file), before);
});

test('a name that is already taken by another meeting is never overwritten', () => {
  const a = setup({ title: 'Budget' });
  const other = newMeta('Standup', new Date(2026, 10, 14, 10, 0, 7));
  const fileB = a.store.save(other, '## Summary\nOther meeting.', TRANSCRIPT);
  assert.equal(path.basename(fileB), '1000-standup.md');
  const beforeA = read(a.file);
  // B takes the title (and so the name) of A.
  const r = a.store.renameMeeting(other.id, 'Budget');
  assert.equal(read(a.file), beforeA, "the other meeting's file is untouched");
  assert.notEqual(r.file, a.file);
  assert.match(path.basename(r.file), /^1000\d\d-budget\.md$/);
  assert.equal(a.store.find(a.id).meta.title, 'Budget');
  assert.equal(a.store.find(other.id).meta.title, 'Budget');
  assert.equal(a.store.find(other.id).notes, '## Summary\nOther meeting.');
  assert.equal(mdFiles(a.day).length, 2);
});

test('when two files carry one id, the file the list shows is the one renamed; the other is left as it is', () => {
  const { store, id, file, day } = setup();
  const copy = path.join(day, '1000-zzz-copy.md'); // sorts first, so it is the one list() shows
  fs.copyFileSync(file, copy);
  fs.writeFileSync(copy, read(copy).replace('title: "Standup"', 'title: "Copy of standup"').replace('# Standup', '# Copy of standup'));
  const beforeOriginal = read(file);
  assert.equal(store.find(id).file, copy);
  const r = store.renameMeeting(id, 'Retro');
  assert.equal(read(file), beforeOriginal, 'the file that is not shown is untouched');
  assert.equal(path.basename(r.file), '1000-retro.md');
  assert.equal(fs.existsSync(copy), false);
  assert.equal(store.find(id).meta.title, 'Standup', 'now the original is the one listed (the same id twice is the sync service\'s doing)');

  // The name the title would get is held by the other file with this id: write to the file that was read.
  const c = setup();
  const copy2 = path.join(c.day, '1000-zzz-copy.md');
  fs.copyFileSync(c.file, copy2);
  fs.writeFileSync(copy2, read(copy2).replace('title: "Standup"', 'title: "Copy of standup"').replace('# Standup', '# Copy of standup'));
  const original = read(c.file);
  const r2 = c.store.renameMeeting(c.id, 'Standup');
  assert.equal(r2.file, copy2);
  assert.equal(read(c.file), original);
  assert.equal(read(copy2).match(/^title: .*$/m)[0], 'title: "Standup"');
});

test('titles that try to be a path, a device name, extra front matter or a second transcript are made safe', () => {
  const hostile = [
    '..\\..\\x', '../../etc/passwd', 'CON', 'NUL.txt', 'a:b', 'trailing dots...', 'trailing spaces   ', 'C:\\Windows\\System32',
    'a\n---\nid: other', 'a\r\ntitle: "b"\r\n---\r\n', '## Transcript', 'x\n\n## Transcript\n\n**[00:00:01] Evil:** injected', '"quoted" and \\ backslash',
    '\u202Ereversed\u202C', 'zero\u200Bwidth\u2060joiner\ufeff', 'line\u2028separator\u2029here', 'tab\there', '# heading', '   leading', '---',
  ];
  for (const t of hostile) {
    const { store, id, file, day, dir } = setup();
    const before = parse(read(file), file);
    const r = store.renameMeeting(id, t);
    const files = mdFiles(day);
    assert.equal(files.length, 1, `one meeting file after "${JSON.stringify(t)}"`);
    assert.match(files[0], /^1000-[a-z0-9-]+\.md$/, `a plain file name for ${JSON.stringify(t)}`);
    assert.equal(path.dirname(r.file), day);
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x !== '2026-11-14' && x !== '.live'), [], 'nothing outside the day folder');
    const m = store.find(id);
    assert.ok(m, 'still found by its id');
    assert.equal(m.meta.id, id);
    assert.equal(store.find('other'), null);
    assert.equal(m.transcript, before.transcript, 'the transcript is untouched');
    assert.equal(m.notes, before.notes, 'the notes are untouched');
    assert.deepEqual(m.meta.speakers, ['Speaker 1', 'Ade']);
    assert.equal(m.meta.title, V.cleanMeetingTitle(t));
    assert.doesNotMatch(m.meta.title, /[\r\n\u202e\u200b\u2060\ufeff\u2028\u2029\t]/);
    assert.equal((read(r.file).match(/^## Transcript$/gm) || []).length, 1, 'one transcript heading');
  }
});

test('a very long title is cut to 200 characters, never in the middle of an emoji', () => {
  const { store, id } = setup();
  store.renameMeeting(id, 'x'.repeat(5000));
  assert.equal(store.find(id).meta.title.length, 200);
  store.renameMeeting(id, 'a' + '\u{1F600}'.repeat(300)); // 1 + 300 characters, each of two UTF-16 units
  const t = store.find(id).meta.title;
  assert.equal([...t].length, 200);
  assert.ok(t.isWellFormed());
  assert.ok(store.list()[0].file.endsWith('.md'));
});

test('nothing left of the title: refused with a sentence, the file untouched', () => {
  const { store, id, file } = setup();
  const before = read(file);
  for (const t of ['', '   ', '\n\t ', '\u200b\u202e', null, undefined, 42, {}]) {
    assert.equal(msg(() => store.renameMeeting(id, t)), SENT.none, JSON.stringify(t));
  }
  assert.equal(read(file), before);
});

test('a meeting that is not there, or a file that cannot be read, is refused and left byte for byte', () => {
  const { store, id, file, day } = setup();
  assert.equal(msg(() => store.renameMeeting('20200101-000000', 'Nope')), SENT.gone);
  const bad = [
    '---\nid: BROKEN1\ntitle:\n  - a list\n---\n\n# x\n\nNotes.\n\n## Transcript\n\nT\n',            // the title spread over lines
    '---\nid: BROKEN2\ntitle: "x"\nthis line is not a key\n---\n\n# x\n\nNotes.\n\n## Transcript\n\nT\n', // a line that is nothing
    '---\nid: BROKEN3\ntitle: "x"\n\n# x\n\nNotes.\n\n## Transcript\n\nT\n',                              // never closed
  ];
  bad.forEach((text, i) => {
    const f = path.join(day, `0900-broken${i}.md`);
    fs.writeFileSync(f, text);
    const got = msg(() => store.renameMeeting(['BROKEN1', 'BROKEN2', '0900-broken2'][i], 'Fixed')); // the last has no closed front matter: its id is its file name
    assert.equal(got, SENT.unreadable, `case ${i}`);
    assert.equal(read(f), text);
  });
  assert.equal(read(file).includes('title: "Standup"'), true);
  assert.deepEqual(mdFiles(day).length, 4);
});

test('a file changed on disk between reading and writing is refused, and what is on disk stays', () => {
  const { store, id, file, day } = setup();
  const orig = store._fileFor.bind(store);
  store._fileFor = (...a) => { fs.appendFileSync(file, '\n- 2026-11-14: written by another program\n'); return orig(...a); };
  assert.equal(msg(() => store.renameMeeting(id, 'Late change')), SENT.changed);
  store._fileFor = orig;
  assert.ok(read(file).endsWith('written by another program\n'));
  assert.ok(read(file).includes('title: "Standup"'));
  assert.deepEqual(mdFiles(day), ['1000-standup.md']);
  assert.equal(fs.readdirSync(day).some((f) => f.endsWith('.tmp')), false);
});

test('writes are atomic (a .tmp file, then a rename) and the old file goes only after the new one is in place', () => {
  const { store, id, file, day } = setup();
  const log = [];
  const w = fs.writeFileSync, rn = fs.renameSync, ul = fs.unlinkSync;
  fs.writeFileSync = (f, ...a) => { log.push(['write', String(f)]); return w(f, ...a); };
  fs.renameSync = (a, b) => { log.push(['rename', String(a), String(b)]); return rn(a, b); };
  fs.unlinkSync = (f) => { log.push(['unlink', String(f)]); return ul(f); };
  let r;
  try { r = store.renameMeeting(id, 'Atomic check'); } finally { fs.writeFileSync = w; fs.renameSync = rn; fs.unlinkSync = ul; }
  const titleWrites = log.filter((e) => e[0] === 'write' && !/_daily\.md/.test(e[1]));
  assert.ok(titleWrites.length >= 1);
  for (const e of titleWrites) assert.ok(e[1].endsWith('.tmp'), `${e[1]} is written under a temporary name`);
  const moved = log.findIndex((e) => e[0] === 'rename' && e[2] === r.file);
  const removed = log.findIndex((e) => e[0] === 'unlink' && e[1] === file);
  assert.ok(moved >= 0 && removed > moved, 'the new file is renamed into place before the old one is removed');
  assert.equal(fs.readdirSync(day).some((f) => f.endsWith('.tmp')), false);
});

test('the old file is not removed when it no longer carries this id', () => {
  const { store, id, file } = setup();
  const orig = store._fileFor.bind(store);
  // Between choosing the new name and removing the old file, a sync client puts another meeting under the old name.
  const idAt = store._idAt.bind(store);
  store._idAt = (f) => (f === file && store._swap ? 'someone-else' : idAt(f));
  store._fileFor = (...a) => { const t = orig(...a); store._swap = true; return t; };
  const r = store.renameMeeting(id, 'Moved');
  assert.ok(fs.existsSync(r.file));
  assert.ok(fs.existsSync(file), 'a file that is not this meeting is not removed');
});

test('a person\'s title is kept when notes are written again', () => {
  const { store, id, meta } = setup({ title: '' });
  assert.equal(meta.autoTitle, true);
  assert.equal(meta.title, 'Meeting 10:00');
  // The live meeting, ended and notes still to come: a generated title may replace the placeholder.
  assert.equal(useGeneratedTitle(meta, 'Pipeline review'), true);
  assert.equal(useGeneratedTitle(meta, ''), false);
  store.renameMeeting(id, 'Meeting 10:00 with Ade');
  const saved = store.find(id);
  assert.equal(saved.meta.title, 'Meeting 10:00 with Ade');
  assert.equal('autoTitle' in saved.meta, false, 'the file does not say whether a title is generated');
  // "Rewrite notes" starts from the saved file and forces autoTitle off (main.js); a title is never replaced.
  assert.equal(useGeneratedTitle({ ...saved.meta, autoTitle: false }, 'Something else'), false);
  assert.equal(useGeneratedTitle(saved.meta, 'Something else'), false, 'even without the flag a title read from a file is kept');
  // Even a typed title that looks like a placeholder is safe from a rewrite.
  store.renameMeeting(id, 'Meeting 09:15');
  const placeholder = store.find(id);
  assert.equal(useGeneratedTitle({ ...placeholder.meta, autoTitle: false }, 'Replaced'), false);
  assert.equal(useGeneratedTitle(placeholder.meta, 'Replaced'), false);
  // The notes are rewritten the way main.js does it (store.save with the file's own meta): the title stays.
  const got = store.find(id);
  const meta2 = { ...got.meta, autoTitle: false, startMs: 0 };
  if (useGeneratedTitle(meta2, 'Replaced')) meta2.title = 'Replaced';
  store.save(meta2, '## Summary\nNew notes.', got.transcript);
  assert.equal(store.find(id).meta.title, 'Meeting 09:15');
  assert.equal(store.find(id).notes, '## Summary\nNew notes.');
});

test('what a window may send: an id of the usual shape and a title that is a string with something in it', () => {
  assert.deepEqual(V.cleanRenameCall('20261114-100000', '  Hello   world \n'), { id: '20261114-100000', title: 'Hello world' });
  for (const id of ['', '../x', 'a b', 'x'.repeat(49), 5, null, undefined, {}]) assert.throws(() => V.cleanRenameCall(id, 'ok'), { message: SENT.gone });
  for (const t of ['', '  ', 7, null, undefined, [], {}]) assert.throws(() => V.cleanRenameCall('20261114-100000', t), { message: SENT.none });
  assert.equal(V.cleanMeetingTitle('a\u202Eb\u200Dc'), 'abc');
  assert.equal(V.cleanMeetingTitle('x'.repeat(10 ** 6)).length, 200);
  assert.equal(V.cleanMeetingTitle('\ud800 lone').trim(), 'lone');
});
