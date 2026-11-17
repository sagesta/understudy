'use strict';
// Speaker names: renaming live, suggestions (plumbing), epochs and saved files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockDeepgram } = require('./mocks');
const { Settings, DEFAULTS } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const { createStream } = require('../src/main/stt');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore, newMeta, parse } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const { Transcript, cleanSpeakerName } = require('../src/main/transcript');
const { transcriptMdToPlain } = require('../src/main/meetings/notes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-spk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { available: () => false };
const speech = (s, rate = 16000) => Int16Array.from({ length: Math.round(s * rate) }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 200 / rate) * 7000 * (0.6 + 0.4 * Math.sin(i / 300))));

async function sessionFor(dir, lines = []) {
  const dg = await mockDeepgram(lines);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade', aliases: ['A.'] }, stt: { skipSilence: false } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library: new Library(), store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  return { dg, settings, store, session };
}

const liveLines = (store, id) => fs.readFileSync(store._livePath(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- Transcript

test('cleanSpeakerName: trims, collapses, strips Markdown and control characters, caps at 40', () => {
  assert.equal(cleanSpeakerName('  Priya   Shah \n'), 'Priya Shah');
  assert.equal(cleanSpeakerName('a\nb\tc'), 'a b c');
  assert.equal(cleanSpeakerName('**[Priya]:** #_`<x>|'), 'Priya x');
  assert.equal(cleanSpeakerName('Pri\x01ya\x7f'), 'Priya');
  assert.equal(cleanSpeakerName('x'.repeat(60)).length, 40);
  assert.equal(cleanSpeakerName('a'.repeat(39) + '  b'), 'a'.repeat(39), 'a trailing space left by the cut is removed');
  assert.equal(cleanSpeakerName('   '), '');
  assert.equal(cleanSpeakerName('*_:'), '');
  assert.equal(cleanSpeakerName(null), '');
  assert.equal(cleanSpeakerName(undefined), '');
  assert.equal(cleanSpeakerName("Siobhan O'Neil-Smith Jr."), "Siobhan O'Neil-Smith Jr.");
});

test('turns carry label, speakerKey and display; the key includes the epoch', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  const a = t.addFinal('them', 'Hello there everyone.', 'Speaker 2', 1000, '2.0').turn;
  const b = t.addFinal('me', 'Hi.', undefined, 5000).turn;
  const c = t.addFinal('them', 'No label from this provider.', null, 9000, '2.0').turn;
  assert.deepEqual([a.speakerKey, a.label, a.speaker], ['2.0:Speaker 2', 'Speaker 2', 'Speaker 2']);
  assert.deepEqual([b.speakerKey, b.label, b.speaker], ['me', 'Ade', 'Ade']);
  assert.deepEqual([c.speakerKey, c.label, c.speaker], ['2.0:Them', 'Them', 'Them']);
  assert.equal(new Transcript().addFinal('them', 'x y z', 'Speaker 1', 0).turn.speakerKey, '0.0:Speaker 1', 'epoch defaults to 0.0');
});

test('setName rewrites past turns, future turns get the name, and an empty name clears it', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  t.addFinal('them', 'First thing.', 'Speaker 1', 1000, '1.1');
  t.addFinal('them', 'Second thing.', 'Speaker 2', 9000, '1.1');
  t.addFinal('them', 'Third thing.', 'Speaker 1', 20000, '1.1');
  const changed = t.setName('1.1:Speaker 1', '  Priya *Shah* ');
  assert.deepEqual(changed.map((x) => x.id), [1, 3]);
  assert.deepEqual(t.turns.map((x) => x.speaker), ['Priya Shah', 'Speaker 2', 'Priya Shah']);
  assert.deepEqual(t.turns.map((x) => x.label), ['Speaker 1', 'Speaker 2', 'Speaker 1'], 'the raw label is kept');
  const next = t.addFinal('them', 'Fourth thing.', 'Speaker 1', 40000, '1.1').turn;
  assert.equal(next.speaker, 'Priya Shah');
  assert.ok(t.toMarkdown().includes('] Priya Shah:** Fourth thing.'));
  assert.ok(t.forPrompt().includes('Priya Shah: Third thing.'));
  assert.deepEqual(t.speakers(), ['Priya Shah', 'Speaker 2']);
  t.setName('1.1:Speaker 1', '');
  assert.deepEqual(t.turns.map((x) => x.speaker), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 1']);
  assert.equal(t.names.size, 0);
});

test('turns merge by speakerKey: the same label in a different epoch is a different voice', () => {
  const t = new Transcript();
  assert.equal(t.addFinal('them', 'One thing.', 'Speaker 1', 1000, '1.1').merged, false);
  assert.equal(t.addFinal('them', 'And another.', 'Speaker 1', 2000, '1.1').merged, true);
  assert.equal(t.addFinal('them', 'After a reconnect.', 'Speaker 1', 2500, '1.2').merged, false, 'same label, new connection');
  assert.equal(t.addFinal('them', 'After a resume.', 'Speaker 1', 3000, '2.1').merged, false, 'same label, new opening');
  assert.equal(t.turns.length, 3);
  assert.equal(t.turns[0].text, 'One thing. And another.');
  // A named voice still merges with itself.
  t.setName('2.1:Speaker 1', 'Priya');
  assert.equal(t.addFinal('them', 'Still me.', 'Speaker 1', 3500, '2.1').merged, true);
});

test('setName refuses the user\'s own key and unknown keys', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  t.addFinal('me', 'Hello.', null, 1000);
  t.addFinal('them', 'Hi.', 'Speaker 1', 5000, '1.1');
  assert.throws(() => t.setName('me', 'Someone'), /Settings/);
  assert.throws(() => t.setName('9.9:Speaker 7', 'Someone'), /not in this meeting/);
  assert.equal(t.turns[0].speaker, 'Ade');
  assert.equal(t.names.size, 0);
});

test('speakerList: one entry per voice in order of first appearance, never the user', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  t.addFinal('them', 'a b c', 'Speaker 2', 1000, '1.1');
  t.addFinal('me', 'mine', null, 5000);
  t.addFinal('them', 'd e f', 'Speaker 1', 9000, '1.1');
  t.addFinal('them', 'g h i', 'Speaker 2', 20000, '1.1');
  t.addFinal('them', 'j k l', 'Speaker 2', 30000, '2.1');
  t.setName('1.1:Speaker 1', 'Priya');
  assert.deepEqual(t.speakerList(), [
    { key: '1.1:Speaker 2', label: 'Speaker 2', name: '', display: 'Speaker 2', turns: 2, firstAt: 1000, epoch: '1.1' },
    { key: '1.1:Speaker 1', label: 'Speaker 1', name: 'Priya', display: 'Priya', turns: 1, firstAt: 9000, epoch: '1.1' },
    { key: '2.1:Speaker 2', label: 'Speaker 2', name: '', display: 'Speaker 2', turns: 1, firstAt: 30000, epoch: '2.1' },
  ]);
});

// ---------------------------------------------------------------- Deepgram

test('deepgram: epoch counts connections and is reported in every final', async () => {
  const dg = await mockDeepgram(['first line here', 'second line here'], { speaker: 1 });
  const stream = createStream({ provider: 'deepgram', skipSilence: false, identifySpeakers: true, models: {} }, () => 'k', 'them', { baseUrlOverride: dg.url });
  const finals = [];
  stream.on('final', (f) => finals.push(f));
  assert.equal(stream.epoch, 0);
  stream.start();
  stream.send(speech(0.5));
  for (let i = 0; i < 40 && !finals.length; i++) await sleep(50);
  assert.equal(finals.length, 1);
  assert.deepEqual([finals[0].text, finals[0].speaker, finals[0].epoch], ['first line here', 'Speaker 2', 1]);
  assert.equal(stream.epoch, 1);
  // Drop the connection from our side; the stream reconnects by itself.
  stream.ws.terminate();
  stream.send(speech(0.5)); // held until the new socket opens
  for (let i = 0; i < 60 && finals.length < 2; i++) await sleep(50);
  assert.equal(finals.length, 2, 'a final arrives on the new connection');
  assert.equal(finals[1].epoch, 2);
  assert.equal(dg.stats.connections, 2);
  await stream.stop();
  await dg.close();
});

// ---------------------------------------------------------------- Session

test('session.renameSpeaker: emits speakers, writes a names line, updates snapshot and markdown', async () => {
  const dir = tmp();
  const { dg, session, store } = await sessionFor(dir);
  const events = [];
  session.on('speakers', (p) => events.push(p));
  session.start({ title: 'Sync', channels: ['them'] });
  session._onFinal('them', 'Welcome everybody to the sync.', 'Speaker 1', '1.1');
  session._onFinal('them', 'Thanks, glad to be here.', 'Speaker 2', '1.1');
  const id = session.meta.id;

  const list = session.renameSpeaker('1.1:Speaker 1', ' Priya ');
  assert.equal(list[0].name, 'Priya');
  assert.equal(events.length, 1);
  assert.equal(events[0].speakers[0].display, 'Priya');
  assert.deepEqual(events[0].turns.map((t) => [t.id, t.speaker]), [[1, 'Priya']]);
  const names = liveLines(store, id).filter((l) => l.type === 'names');
  assert.deepEqual(names.at(-1).names, { '1.1:Speaker 1': 'Priya' });

  const snap = session.snapshot();
  assert.equal(snap.speakers.length, 2);
  assert.equal(snap.turns[0].speaker, 'Priya');
  assert.deepEqual(snap.suggestions, []);

  session.renameSpeaker('1.1:Speaker 1', ''); // clear
  assert.deepEqual(liveLines(store, id).filter((l) => l.type === 'names').at(-1).names, {});
  assert.equal(events.at(-1).turns[0].speaker, 'Speaker 1');

  assert.throws(() => session.renameSpeaker('me', 'Someone'), /Settings/);
  assert.throws(() => session.renameSpeaker('1.1:Speaker 9', 'Someone'), /not in this meeting/);
  assert.equal(events.length, 2, 'refused renames emit nothing');

  session.renameSpeaker('1.1:Speaker 2', 'Sam');
  const result = await session.stop();
  assert.ok(result.transcriptMd.includes('] Sam:** Thanks, glad to be here.'));
  assert.deepEqual(result.meta.speakers, ['Speaker 1', 'Sam']);
  assert.throws(() => session.renameSpeaker('1.1:Speaker 1', 'Late'), /No meeting is running/);
  await dg.close();
});

test('a crashed meeting is recovered with the names given before the crash', async () => {
  const dir = tmp();
  const { dg, session, store } = await sessionFor(dir);
  session.start({ title: 'Crashy', channels: ['them'] });
  session._onFinal('them', 'Hello from the first voice.', 'Speaker 1', '1.1');
  session._onFinal('them', 'And I am another voice.', 'Speaker 2', '1.1');
  session.renameSpeaker('1.1:Speaker 1', 'Priya');
  session._onFinal('them', 'More from the first voice, later on.', 'Speaker 1', '1.1');
  // The app dies here: read the autosave with a separate store, as the next start would.
  const next = new MeetingStore(path.join(dir, 'Recovered'), store.liveDir);
  const rec = next.recoverOrphans(null);
  assert.equal(rec.length, 1);
  const text = fs.readFileSync(rec[0], 'utf8');
  assert.ok(text.includes('] Priya:** Hello from the first voice.'));
  assert.ok(text.includes('] Priya:** More from the first voice, later on.'));
  assert.ok(text.includes('] Speaker 2:** And I am another voice.'));
  await session.stop();
  await dg.close();
});

test('recoverOrphans applies the last names line to every turn', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const m = newMeta('Orphan', new Date(2026, 10, 15, 9, 0, 0));
  store.beginLive(m);
  const turn = (id, at, speaker, key, label, text) => ({ type: 'turn', turn: { id, t: m.startMs + at, end: m.startMs + at + 500, channel: key === 'me' ? 'me' : 'them', speaker, speakerKey: key, label, text } });
  store.appendLive(m.id, turn(1, 1000, 'Speaker 1', '1.1:Speaker 1', 'Speaker 1', 'Hello from the first voice.'));
  store.appendLive(m.id, turn(2, 5000, 'Ade', 'me', 'Ade', 'Welcome.'));
  store.appendLive(m.id, turn(3, 9000, 'Speaker 2', '1.1:Speaker 2', 'Speaker 2', 'I am the second voice.'));
  store.appendLive(m.id, { type: 'names', names: { '1.1:Speaker 1': 'Priya' } });
  store.appendLive(m.id, { type: 'names', names: { '1.1:Speaker 1': 'Priya', '1.1:Speaker 2': 'Sam' } });
  store.appendLive(m.id, turn(4, 12000, 'Sam', '1.1:Speaker 2', 'Speaker 2', 'Still the second voice.'));
  const rec = store.recoverOrphans(null);
  assert.equal(rec.length, 1);
  const got = parse(fs.readFileSync(rec[0], 'utf8'), rec[0]);
  assert.deepEqual(got.meta.speakers, ['Priya', 'Ade', 'Sam']);
  assert.ok(got.transcript.includes('] Priya:** Hello from the first voice.'));
  assert.ok(got.transcript.includes('] Sam:** I am the second voice.'));
  assert.ok(got.transcript.includes('] Sam:** Still the second voice.'));
  assert.ok(got.transcript.includes('] Ade:** Welcome.'));
});

test('recoverOrphans: a name that was cleared falls back to the raw label; old autosaves still recover', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const m = newMeta('Orphan', new Date(2026, 10, 15, 10, 0, 0));
  store.beginLive(m);
  store.appendLive(m.id, { type: 'turn', turn: { id: 1, t: m.startMs + 1000, end: m.startMs + 1500, channel: 'them', speaker: 'Priya', speakerKey: '1.1:Speaker 1', label: 'Speaker 1', text: 'Spoken while named.' } });
  store.appendLive(m.id, { type: 'names', names: {} });
  const m2 = newMeta('Old', new Date(2026, 10, 15, 11, 0, 0));
  store.beginLive(m2);
  store.appendLive(m2.id, { type: 'turn', turn: { id: 1, t: m2.startMs + 1000, end: m2.startMs + 1500, speaker: 'Speaker 1', text: 'From an older version.' } });
  const rec = store.recoverOrphans(null);
  assert.equal(rec.length, 2);
  const texts = rec.map((f) => fs.readFileSync(f, 'utf8'));
  assert.ok(texts.some((t) => t.includes('] Speaker 1:** Spoken while named.')));
  assert.ok(texts.some((t) => t.includes('] Speaker 1:** From an older version.')));
});

test('hints: speaker numbers restart after a resume, and after a provider reconnect, but only when names exist', async () => {
  const dir = tmp();
  const { dg, session } = await sessionFor(dir);
  const hints = [];
  session.on('hint', (h) => hints.push(h.message));
  session.start({ title: 'Hints', channels: ['them'] });
  assert.equal(session.openSeq, 1);
  const stream = session.streams.them;
  stream.emit('final', { text: 'Welcome everybody to the sync.', speaker: 'Speaker 1', epoch: 1 });
  assert.equal(session.transcript.turns[0].speakerKey, '1.1:Speaker 1');
  // Reconnect without any names: nothing to warn about.
  stream.emit('final', { text: 'Back after a blip.', speaker: 'Speaker 1', epoch: 2 });
  assert.equal(session.transcript.turns[1].speakerKey, '1.2:Speaker 1', 'a new connection is a new voice');
  assert.deepEqual(hints, []);
  session.renameSpeaker('1.2:Speaker 1', 'Priya');
  // The next reconnect warns once, however many finals follow.
  stream.emit('final', { text: 'Another blip happened.', speaker: 'Speaker 1', epoch: 3 });
  stream.emit('final', { text: 'And more words after it.', speaker: 'Speaker 2', epoch: 3 });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /Speaker numbers restart/);
  // Pause and resume opens new streams.
  await session.pause();
  session.resume();
  assert.equal(session.openSeq, 2);
  assert.equal(hints.length, 2);
  session.streams.them.emit('final', { text: 'After the resume now.', speaker: 'Speaker 1' });
  assert.equal(session.transcript.turns.at(-1).speakerKey, '2.0:Speaker 1', 'a stream without an epoch counts as 0');
  assert.equal(hints.length, 2, 'the first final of a new opening is not a reconnect');
  await session.stop();
  await dg.close();
});

test('no hint on resume when nobody has been named', async () => {
  const dir = tmp();
  const { dg, session } = await sessionFor(dir);
  const hints = [];
  session.on('hint', (h) => hints.push(h));
  session.start({ channels: ['them'] });
  session._onFinal('them', 'Some words go here.', 'Speaker 1', '1.1');
  await session.pause(); session.resume();
  assert.deepEqual(hints, []);
  await session.stop();
  await dg.close();
});

// ---------------------------------------------------------------- Suggestions (plumbing)

test('suggestions: queued, de-duplicated, accepted into a rename, dismissed for good', async () => {
  const dir = tmp();
  const { dg, session } = await sessionFor(dir);
  const added = [], cleared = [];
  session.on('speaker-suggestion', (p) => added.push(p.suggestion));
  session.on('speaker-suggestion-clear', (p) => cleared.push(p.id));
  session.start({ title: 'Suggest', channels: ['them'] });
  session._onFinal('them', 'Hi, I am Priya and I run the platform team.', 'Speaker 1', '1.1');
  session._onFinal('them', 'Good to meet everyone here today.', 'Speaker 2', '1.1');
  const k1 = '1.1:Speaker 1', k2 = '1.1:Speaker 2';

  const s1 = session._addSuggestion({ key: k1, label: 'Speaker 1', name: ' Priya ', evidence: 'x'.repeat(300) });
  assert.equal(s1.name, 'Priya');
  assert.equal(s1.evidence.length, 140);
  assert.equal(typeof s1.id, 'number');
  assert.deepEqual(session.snapshot().suggestions, [s1]);
  assert.equal(added.length, 1);

  // Refusals: one pending per key, same pair twice, the user's own key, unknown key, empty name.
  assert.equal(session._addSuggestion({ key: k1, label: 'Speaker 1', name: 'Priya', evidence: 'again' }), null);
  assert.equal(session._addSuggestion({ key: k1, label: 'Speaker 1', name: 'Someone Else', evidence: 'y' }), null, 'one pending per speaker');
  assert.equal(session._addSuggestion({ key: 'me', label: 'Ade', name: 'Ade', evidence: 'y' }), null);
  assert.equal(session._addSuggestion({ key: '1.1:Speaker 8', label: 'Speaker 8', name: 'Zed', evidence: 'y' }), null);
  assert.equal(session._addSuggestion({ key: k2, label: 'Speaker 2', name: '*_*', evidence: 'y' }), null);
  assert.equal(added.length, 1);

  // Dismiss: gone, and never offered again (case-insensitively) for that speaker.
  const s2 = session._addSuggestion({ key: k2, label: 'Speaker 2', name: 'Sam', evidence: 'Thanks, Sam' });
  assert.equal(session.resolveSuggestion(s2.id, false), true);
  assert.deepEqual(cleared, [s2.id]);
  assert.equal(session.snapshot().suggestions.length, 1);
  assert.equal(session._addSuggestion({ key: k2, label: 'Speaker 2', name: 'SAM', evidence: 'Thanks, Sam' }), null);
  assert.ok(session._addSuggestion({ key: k2, label: 'Speaker 2', name: 'Samira', evidence: 'Thanks, Samira' }), 'a different name is fine');
  assert.equal(session.resolveSuggestion(s2.id, true), false, 'an answered suggestion cannot be answered twice');

  // Accept: renames, and the suggestion (and any other for that key) is cleared.
  const speakers = [];
  session.on('speakers', (p) => speakers.push(p));
  assert.equal(session.resolveSuggestion(s1.id, true), true);
  assert.equal(session.transcript.turns[0].speaker, 'Priya');
  assert.equal(speakers.length, 1);
  assert.ok(cleared.includes(s1.id));
  assert.equal(session._addSuggestion({ key: k1, label: 'Speaker 1', name: 'Priyanka', evidence: 'z' }), null, 'already named');

  // Renaming a speaker by hand drops its pending suggestion.
  const pending = session.snapshot().suggestions.find((s) => s.key === k2);
  session.renameSpeaker(k2, 'Samira S');
  assert.ok(cleared.includes(pending.id));
  assert.deepEqual(session.snapshot().suggestions, []);

  // A new meeting starts clean, dismissals included.
  await session.stop();
  session.start({ title: 'Next', channels: ['them'] });
  session._onFinal('them', 'Fresh meeting with a new voice.', 'Speaker 2', '1.1');
  assert.ok(session._addSuggestion({ key: k2, label: 'Speaker 2', name: 'Sam', evidence: 'Thanks, Sam' }));
  await session.stop();
  assert.deepEqual(session.snapshot().suggestions, [], 'pending suggestions are cleared when the meeting ends');
  await dg.close();
});

test('the engine hook exists and does nothing by default', async () => {
  const dir = tmp();
  const { dg, session } = await sessionFor(dir);
  assert.equal(typeof session._maybeSuggestNames, 'function');
  session.start({ channels: ['them'] });
  session._onFinal('them', 'Words from a voice.', 'Speaker 1', '1.1');
  assert.equal(session.suggestions.size, 0);
  await session.stop();
  await dg.close();
});

// ---------------------------------------------------------------- Saved meetings

const T = (clock, who, text) => `**[${clock}] ${who}:** ${text}`;

function savedMeeting(store, { notes = '', speakers = ['Ade', 'Speaker 1', 'Speaker 2', 'Speaker 21'], lines } = {}) {
  const meta = newMeta('Roadmap', new Date(2026, 10, 14, 14, 30, 5));
  meta.end = '15:00'; meta.durationMin = 30; meta.speakers = speakers;
  const transcript = (lines || [
    T('14:30:09', 'Speaker 2', 'Speaker 2 here. I think Speaker 21 will agree.'),
    T('14:30:15', 'Ade', 'Thanks, Speaker 2: what about the date?'),
    T('14:30:20', 'Speaker 21', 'Friday works.'),
    T('14:30:25', 'Speaker 2', 'Then it is settled.'),
    T('14:30:30', 'Speaker 1', 'I was quiet.'),
  ]).join('\n\n');
  store.save(meta, notes, transcript);
  return meta;
}

const NOTES = '## Summary\nSpeaker 2 and Speaker 21 agreed on Friday.\n\n## Action items\n### Others\n- [ ] Speaker 2: send the plan (due: Friday)\n- [ ] Speaker 21: book the room (due: not stated)\n\n## Open questions\nNone.';

test('store.renameSpeaker: only exact label paragraphs change; the file still parses', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = savedMeeting(store, { notes: NOTES });
  const r = store.renameSpeaker(meta.id, 'Speaker 2', '  Priya *Shah* ');
  assert.equal(r.notesMentionOld, false);
  const got = store.find(meta.id);
  assert.equal(r.file, got.file);
  const paras = got.transcript.split('\n\n');
  assert.equal(paras[0], T('14:30:09', 'Priya Shah', 'Speaker 2 here. I think Speaker 21 will agree.'), 'words inside the text are not touched');
  assert.equal(paras[1], T('14:30:15', 'Ade', 'Thanks, Speaker 2: what about the date?'));
  assert.equal(paras[2], T('14:30:20', 'Speaker 21', 'Friday works.'), 'Speaker 21 is a different label');
  assert.equal(paras[3], T('14:30:25', 'Priya Shah', 'Then it is settled.'));
  assert.equal(paras[4], T('14:30:30', 'Speaker 1', 'I was quiet.'));
  // Front matter and the rest of the file survive.
  assert.deepEqual(got.meta.speakers, ['Ade', 'Speaker 1', 'Priya Shah', 'Speaker 21']);
  assert.equal(got.meta.title, 'Roadmap');
  assert.equal(got.meta.durationMin, 30);
  assert.equal(store.list().length, 1);
  // Downstream readers keep working.
  const plainText = transcriptMdToPlain(got.transcript);
  assert.ok(plainText.includes('[14:30:09] Priya Shah: Speaker 2 here.'));
  assert.ok(/^\*\*\[[^\]]+\] [^*]+?:\*\*/m.test(got.transcript), 'the **[time] Name:** format is intact');
});

test('store.renameSpeaker: "Speaker N" is replaced as a whole label in the notes, never inside "Speaker 21"', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = savedMeeting(store, { notes: NOTES });
  store.renameSpeaker(meta.id, 'Speaker 2', 'Priya');
  const notes = store.find(meta.id).notes;
  assert.ok(notes.includes('Priya and Speaker 21 agreed on Friday.'));
  assert.ok(notes.includes('- [ ] Priya: send the plan'));
  assert.ok(notes.includes('- [ ] Speaker 21: book the room'));
  assert.ok(!/Speaker 2(?!\d)/.test(notes));
  // And the other way round: Speaker 21 does not touch Speaker 2.
  store.renameSpeaker(meta.id, 'Speaker 21', 'Sam');
  const after = store.find(meta.id);
  assert.ok(after.notes.includes('Priya and Sam agreed'));
  assert.ok(after.transcript.includes('] Sam:** Friday works.'));
});

test('store.renameSpeaker: notes are left alone for a real name, and notesMentionOld says so', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = savedMeeting(store, { notes: NOTES });
  store.renameSpeaker(meta.id, 'Speaker 2', 'Priya');
  // Notes written later (say, regenerated by the model) mention the name.
  const found = store.find(meta.id);
  store.save(found.meta, `${found.notes}\n\nPriya will follow up. Priyanka too.`, found.transcript);
  const r = store.renameSpeaker(meta.id, 'Priya', 'Priya Nair');
  assert.equal(r.notesMentionOld, true, 'the notes still say Priya');
  const notes = store.find(meta.id).notes;
  assert.ok(notes.includes('Priya will follow up.'), 'a real name is not rewritten in the notes');
  assert.ok(store.find(meta.id).transcript.includes('] Priya Nair:** Then it is settled.'));
  // A "Speaker N" label that notes still carry in a form that is not whole-label is not reported.
  const meta2 = savedMeeting(store, { notes: 'Speaker 2s are great. Speaker 21 too.' });
  assert.equal(store.renameSpeaker(meta2.id, 'Speaker 2', 'Priya').notesMentionOld, false);
});

test('store.renameSpeaker: renaming onto an existing speaker merges and de-duplicates; notes mentioning nothing stay clean', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = savedMeeting(store, { notes: '' });
  store.renameSpeaker(meta.id, 'Speaker 2', 'Speaker 1');
  const got = store.find(meta.id);
  assert.deepEqual(got.meta.speakers, ['Ade', 'Speaker 1', 'Speaker 21']);
  assert.equal(got.transcript.split('\n\n').filter((p) => p.includes('] Speaker 1:**')).length, 3);
  assert.ok(/not been generated/.test(got.notes), 'empty notes stay empty');
});

test('store.renameSpeaker: friendly errors and no changes when refused', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = savedMeeting(store, { notes: NOTES });
  const file = store.find(meta.id).file;
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 2', ''), /Type a name/);
  assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 2', ' *_ '), /Type a name/);
  assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 2', 'Speaker 2'), /already the name/);
  assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 7', 'Priya'), /not in this meeting/);
  assert.throws(() => store.renameSpeaker('20000101-000000', 'Speaker 2', 'Priya'), /no longer exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('settings, IPC channels and the settable list carry the new option', () => {
  assert.equal(DEFAULTS.stt.suggestNames, true);
  assert.equal(new Settings(tmp(), plain).get().stt.suggestNames, true);
  const root = path.join(__dirname, '..', 'src');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  for (const ch of ['meeting:renameSpeaker', 'meeting:suggestion', 'meetings:renameSpeaker']) assert.ok(preload.includes(`'${ch}'`), ch);
  const main = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
  assert.ok(/stt: \[[^\]]*'suggestNames'/.test(main));
  for (const ev of ['speakers', 'speaker-suggestion', 'speaker-suggestion-clear', 'hint']) assert.ok(main.includes(`'${ev}'`), ev);
  for (const ch of ['meeting:renameSpeaker', 'meeting:suggestion', 'meetings:renameSpeaker']) assert.ok(main.includes(`handle('${ch}'`), ch);
});
