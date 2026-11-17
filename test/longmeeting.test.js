'use strict';
// A four-hour meeting: nothing may grow with the length of one person's speech. A turn is capped,
// analysis reads a bounded tail, a question is answered once per turn, a request has a constant
// size, and nobody can make the app call the model without limit. Plus the small hardening
// that went with it (settings that are not what was expected, odd action names, pause, gaps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram } = require('./mocks');
const { Transcript, tailFromSentence, TURN_MAX_CHARS, TURN_MAX_MS, MERGE_GAP_MS } = require('../src/main/transcript');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-long-'));
const realNow = Date.now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { available: () => false };
const until = async (fn, ms = 6000) => { const end = realNow() + ms; while (!fn()) { if (realNow() > end) throw new Error('timed out waiting'); await sleep(10); } };

// A controlled clock: the session reads Date.now(), so a "60-minute" meeting takes a moment.
let fake = 0;
const useClock = (start = 1_700_000_000_000) => { fake = start; Date.now = () => fake; };
const restoreClock = () => { Date.now = realNow; };
const clocked = (fn) => async () => { useClock(); try { await fn(); } finally { restoreClock(); } };

async function sessionFor(dir, { channels = ['them'], mode = 'questions' } = {}) {
  const llmMock = await mockLlm(() => 'Here is what to say.');
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade', aliases: ['A.'] }, llm: { baseUrls: { anthropic: llmMock.url } }, stt: { skipSilence: false, suggestNames: false }, copilot: { autoMode: mode } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library: new Library(), store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const events = { card: [], done: [], removed: [], passed: [], hint: [], error: [] };
  session.on('card', (c) => events.card.push(c));
  session.on('card-done', (c) => events.done.push(c));
  session.on('card-remove', (c) => events.removed.push(c.id));
  session.on('passed', (p) => events.passed.push(p));
  session.on('hint', (h) => events.hint.push(h.message));
  session.on('error', (e) => events.error.push(e.message));
  session.start({ title: 't', channels });
  const livePath = () => path.join(dir, 'live', `${session.meta.id}.jsonl`);
  const close = async () => { await session.stop(); await llmMock.close(); await dg.close(); };
  return { session, llmMock, events, livePath, close };
}

// Every line becomes its own turn: the previous turn is aged so the same voice twice in a row does not merge.
const feed = (session, lines) => {
  for (const [who, text] of lines) {
    const last = session.transcript.turns.at(-1);
    if (last) last.end -= 5000;
    session._onFinal('them', text, who, '1.1');
  }
};

const STATEMENTS = ['We moved the cluster to the new region last quarter and the numbers look steady.', 'The scan covers every image before it reaches staging and nothing ships without it.', 'Latency on the ingest path dropped by a third once the cache was warmed properly.', 'There were two incidents in March and both traced back to the same expired certificate.', 'Most of the cost comes from storage rather than compute, which surprised the team.', 'The migration plan has four stages and each one can be rolled back on its own.'];
// A result of about 200 characters, as a streaming provider returns them, two seconds apart: a dense talker.
const chunker = () => { let n = 0; return () => `${STATEMENTS[n++ % 6]} ${STATEMENTS[n++ % 6]} Next point is ${n} on the list.`; };
const QUESTION = 'What is our rollback plan if the scan fails?';

// Speaks for `minutes`, one result every two seconds on the controlled clock, and reports the
// largest text analysis was ever handed. `inject` maps a result number to words said instead.
async function monologue(session, minutes, { inject = {}, who = 'Speaker 1' } = {}) {
  const next = chunker();
  let maxAnalysed = 0;
  const total = minutes * 30;
  for (let i = 0; i < total; i++) {
    fake += 2000;
    session._onFinal('them', inject[i] || next(), who, '1.1');
    maxAnalysed = Math.max(maxAnalysed, session._analysisText(session.transcript.turns.at(-1)).length);
    if (i % 10 === 0) await sleep(2); // let a settled question's timer run
  }
  return { maxAnalysed };
}
const size = (call) => JSON.stringify(call.body.messages).length;

// ------------------------------------------------------------ transcript: a turn has a maximum size

test('transcript: a 60-minute monologue is turns within the limit, and nothing is lost', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  const next = chunker();
  const said = [];
  let at = 1_700_000_000_000;
  for (let i = 0; i < 1800; i++) { at += 2000; const x = next(); said.push(x); t.addFinal('them', x, 'Speaker 1', at); }
  assert.ok(t.turns.length >= 1800 / 7, 'cut into many turns');
  for (const turn of t.turns) {
    assert.ok(turn.text.length <= TURN_MAX_CHARS + 260, `a turn holds at most the limit plus the result that crossed it (${turn.text.length})`);
    assert.ok(turn.end - turn.t <= TURN_MAX_MS);
  }
  assert.equal(t.turns.map((x) => x.text).join(' '), said.join(' '), 'the cut falls between results: every word is kept, in order');
  assert.ok(t.turns.every((x, i) => i === 0 || x.t - t.turns[i - 1].end < MERGE_GAP_MS), 'each continues the one before');
  // Consecutive turns by one voice need nothing special anywhere.
  assert.equal(t.toMarkdown().split('\n\n').length, t.turns.length);
  assert.ok(t.toMarkdown().split('\n\n').every((l) => /^\*\*\[\d\d:\d\d:\d\d\] Speaker 1:\*\* /.test(l)));
  assert.equal(t.toPlain().split('\n').length, t.turns.length);
  assert.deepEqual(t.speakers(), ['Speaker 1']);
  const list = t.speakerList();
  assert.equal(list.length, 1, 'still one voice');
  assert.equal(list[0].turns, t.turns.length, 'the count is of turns');
  assert.equal(list[0].firstAt, t.turns[0].t);
});

test('transcript: slow talk is cut by time, a turn never spans more than 90 seconds', () => {
  const t = new Transcript();
  let at = 1_700_000_000_000;
  for (let i = 0; i < 1800; i++) { at += 2000; t.addFinal('them', i % 5 === 4 ? 'Okay so that is that.' : 'Right and then we go on', 'Speaker 2', at); }
  assert.ok(t.turns.length >= 39 && t.turns.length <= 45, `about 60 minutes / 90 s (${t.turns.length})`);
  assert.ok(t.turns.every((x) => x.end - x.t <= TURN_MAX_MS && x.text.length <= TURN_MAX_CHARS));
});

test('transcript: a turn carried on across an interjection is cut by the same limit', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  const long = `${'We keep going over the plan. '.repeat(50)}and then`; // well over the limit in one result
  assert.ok(long.length > TURN_MAX_CHARS);
  t.addFinal('them', long, 'Speaker 1', 1000);
  t.addFinal('me', 'yeah', null, 1500);
  const r = t.addFinal('them', 'we start on Monday.', 'Speaker 1', 2000);
  assert.equal(r.merged, false, 'a full turn is not carried on');
  assert.deepEqual(t.turns.map((x) => x.text.length > 100), [true, false, false]);
  assert.equal(t.turns[2].text, 'we start on Monday.');
  // A short one still is (the existing behaviour).
  const s = new Transcript({ myLabel: 'Ade' });
  s.addFinal('them', 'So what I wanted to ask is', 'Speaker 1', 1000);
  s.addFinal('me', 'yeah', null, 1500);
  assert.equal(s.addFinal('them', 'how do you rotate the secrets?', 'Speaker 1', 2000).merged, true);
  // An old turn is cut by time on that path as well: the same words, a second apart in the one case.
  const old = (resumeAt) => {
    const u = new Transcript({ myLabel: 'Ade' });
    u.addFinal('them', 'We start with the plan', 'Speaker 1', 1000);
    for (let at = 3000; at <= 89000; at += 2000) u.addFinal('them', 'and we go on', 'Speaker 1', at);
    u.addFinal('me', 'yeah', null, 89500);
    return u.addFinal('them', 'then the rest.', 'Speaker 1', resumeAt).merged;
  };
  assert.equal(old(90500), true, 'under 90 seconds since it began');
  assert.equal(old(91001), false, 'over 90 seconds since it began');
});

test('transcript: forPrompt keeps the newest words of an over-long turn and stays within maxChars', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  t.addFinal('them', 'An older turn that should be dropped first.', 'Speaker 2', 1000);
  // An over-long turn (as saved by an older version, or from a provider that never pauses).
  const text = Array.from({ length: 2000 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  t.turns.push({ id: 99, t: 5000, end: 6000, channel: 'them', speaker: 'Speaker 1', speakerKey: '0.0:Speaker 1', label: 'Speaker 1', text: `${text} Last words are these.` });
  for (const maxChars of [3000, 800, 24000]) {
    const out = t.forPrompt({ maxChars });
    assert.ok(out.length <= maxChars, `${out.length} <= ${maxChars}`);
    assert.ok(out.endsWith('Last words are these.'), 'the latest words are there');
    assert.ok(out.includes(': …Sentence number') || out.includes(': …'), 'cut from the front, marked');
    assert.ok(!out.includes('Sentence number 0 is'));
    assert.ok(!out.includes('An older turn'), 'nothing else fits beside it');
  }
  // With a partial being spoken, the partial is kept and the total still fits.
  t.setPartial('them', 'and one more thing is');
  const withPartial = t.forPrompt({ maxChars: 3000 });
  assert.ok(withPartial.length <= 3000);
  assert.ok(withPartial.includes('(still speaking): and one more thing is'));
  assert.ok(withPartial.includes('Last words are these.'));
  // A normal transcript is left alone.
  const n = new Transcript();
  n.addFinal('them', 'First thing.', 'Speaker 1', 1000);
  n.addFinal('me', 'Second thing, with a bit more to say.', null, 9000);
  assert.ok(n.forPrompt({ maxChars: 500 }).includes('First thing.'));
});

test('tailFromSentence: starts at a sentence, or cuts at a word and says so', () => {
  assert.equal(tailFromSentence('One two. Three four five. Six seven eight.', 20, '…'), '…Six seven eight.');
  assert.equal(tailFromSentence('One two. Three.', 100), 'One two. Three.');
  const run = `${'word '.repeat(50)}end`;
  const cut = tailFromSentence(run, 30);
  assert.ok(cut.startsWith('…') && cut.length <= 30 && cut.endsWith('end'));
});

// ------------------------------------------------------------ session: bounded work and one answer

test('session: a 60-minute monologue is bounded in analysis, autosave and answers, and one question is answered once', clocked(async () => {
  const { session, llmMock, events, livePath, close } = await sessionFor(tmp());
  const { maxAnalysed } = await monologue(session, 60, { inject: { 900: QUESTION } });
  await sleep(1300);
  const turns = session.transcript.turns;
  assert.ok(turns.length > 100);
  assert.ok(turns.every((x) => x.text.length <= TURN_MAX_CHARS + 260));
  assert.ok(maxAnalysed <= 1500 + 600 + 1, `analysis never read more than a bounded tail (${maxAnalysed})`);
  assert.equal(llmMock.calls.length, 1, 'one question, one answer, however long the speaker carries on');
  assert.equal(events.card.filter((c) => c.auto).length, 1);
  assert.equal(events.card[0].quote, QUESTION);
  const bytes = fs.statSync(livePath()).size;
  assert.ok(bytes < 3_000_000, `autosave for an hour of one voice: ${bytes} bytes (was about 160 MB)`);
  // Recovery reads the last line per turn id: every turn comes back, in order.
  const byId = new Map();
  for (const l of fs.readFileSync(livePath(), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x))) if (l.type === 'turn') byId.set(l.turn.id, l.turn);
  assert.deepEqual([...byId.values()].map((x) => x.text), turns.map((x) => x.text));
  await close();
}));

test('session: the quote of a long question is its end, from a sentence start, within 500 characters', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  const lead = Array.from({ length: 12 }, (_, i) => `Point ${i} is that the rollout touches every region we run in.`).join(' ');
  session._onFinal('them', `${lead} ${QUESTION}`, 'Speaker 1', '1.1');
  // The question is one sentence, so the ask is that sentence; make the ask itself long with a run-on question.
  await until(() => events.card.length === 1);
  assert.equal(events.card[0].quote, QUESTION);
  const long = `${Array.from({ length: 30 }, (_, i) => `and when step ${i} of the rollout finishes we check the dashboards`).join(', ')}, so what do we do then?`;
  assert.ok(long.length > 1500);
  const b = await sessionFor(tmp());
  b.session._onFinal('them', long, 'Speaker 1', '1.1');
  await until(() => b.events.card.length === 1);
  const quote = b.events.card[0].quote;
  assert.ok(quote.length <= 500, `${quote.length}`);
  assert.ok(quote.endsWith('so what do we do then?'), 'the end is kept');
  await b.close(); await close();
}));

test('session: the request after a 60-minute monologue with "Let\'s ask Ade" is as big as at minute 5', clocked(async () => {
  const sizes = {};
  for (const minutes of [5, 60]) {
    const { session, llmMock, events, close } = await sessionFor(tmp());
    await monologue(session, minutes);
    fake += 2000;
    session._onFinal('them', "Let's ask Ade about the rollout plan for the data migration next quarter.", 'Speaker 1', '1.1');
    await until(() => llmMock.calls.length >= 1);
    for (let i = 0; i < 5; i++) { fake += 2000; session._onFinal('them', STATEMENTS[i], 'Speaker 1', '1.1'); await sleep(2); } // and the speaker carries on
    await sleep(1300);
    assert.equal(llmMock.calls.length, 1, `${minutes} min: a turn that only names the user is answered once as it grows`);
    assert.ok(events.card[0].quote.length <= 500);
    assert.ok(events.card[0].quote.includes("Let's ask Ade"));
    sizes[minutes] = size(llmMock.calls[0]);
    await close();
  }
  assert.ok(Math.abs(sizes[60] - sizes[5]) / sizes[5] <= 0.1, `minute 5: ${sizes[5]}, minute 60: ${sizes[60]}`);
  assert.ok(sizes[60] < 32000, `${sizes[60]}`);
}));

test('session: analysis of a legacy over-long turn reads only its tail, from a sentence start', async () => {
  const { session, close } = await sessionFor(tmp());
  const text = Array.from({ length: 4000 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  session._onFinal('them', 'Opening words.', 'Speaker 1', '1.1');
  const turn = session.transcript.turns[0];
  turn.text = text;
  const read = session._analysisText(turn);
  assert.ok(read.length <= 1500);
  assert.ok(read.endsWith('Sentence number 3999 is here.'));
  assert.ok(/^Sentence number \d+ is here\./.test(read), 'starts where a sentence starts');
  await close();
});

test('session: a question that straddles a turn cut is detected once, whole', async () => {
  const { session, events, llmMock, close } = await sessionFor(tmp());
  const pad = (n) => `${'x'.repeat(n - 1)}.`;
  const open = 'So what I wanted to ask is';
  let at = realNow();
  const say = (text) => { at += 2000; return session.transcript.addFinal('them', text, 'Speaker 1', at, '1.1'); }; // straight into the transcript
  // Fill a turn so that "open" is the result that takes it over the limit.
  while (session.transcript.turns.at(-1) === undefined || session.transcript.turns.at(-1).text.length < 1000) say(pad(100));
  const len = session.transcript.turns.at(-1).text.length;
  say(pad(1201 - len - 1 - open.length - 1 + 1 > 1 ? 1201 - len - 1 - open.length : 2));
  say(open);
  assert.ok(session.transcript.turns.at(-1).text.length > TURN_MAX_CHARS, 'the turn is now full');
  const before = session.transcript.turns.length;
  // The rest of the question arrives as a new turn (2 s later), through the session.
  const realDate = Date.now; Date.now = () => at + 2000;
  try { session._onFinal('them', 'how do you rotate the secrets?', 'Speaker 1', '1.1'); } finally { Date.now = realDate; }
  assert.equal(session.transcript.turns.length, before + 1, 'cut: a new turn');
  const turn = session.transcript.turns.at(-1);
  assert.equal(turn.text, 'how do you rotate the secrets?');
  assert.equal(session._analysisText(turn), `${open} how do you rotate the secrets?`, 'the unfinished sentence is put in front');
  assert.equal(session._analyse(turn).ask, `${open} how do you rotate the secrets?`);
  await until(() => events.card.length === 1);
  await sleep(500);
  assert.equal(events.card.filter((c) => c.auto).length, 1);
  assert.equal(events.card[0].quote, `${open} how do you rotate the secrets?`);
  assert.equal(llmMock.calls.length, 1);
  // A previous turn that ended its sentence adds nothing.
  const done = session.transcript.turns.at(-2);
  done.text = 'All finished.';
  assert.equal(session._analysisText(turn), 'how do you rotate the secrets?');
  await close();
});

test('session: the same question in a later turn is answered again; more talk in the same turn is not', async () => {
  const { session, events, llmMock, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', QUESTION]]);
  await until(() => events.card.length === 1);
  session._onFinal('them', 'We should know by the end of the week.', 'Speaker 1', '1.1'); // the same turn grows
  session._onFinal('them', 'Nobody has to decide today.', 'Speaker 1', '1.1');
  assert.equal(session.transcript.turns.length, 1);
  await sleep(1300);
  assert.equal(llmMock.calls.length, 1);
  feed(session, [['Speaker 1', QUESTION]]); // a later turn
  await until(() => events.card.length === 2);
  assert.equal(session.transcript.turns.length, 2);
  await close();
});

test('session: a question is remembered while its turn can grow, and forgotten once it cannot', async () => {
  const { session, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', QUESTION]]);
  await until(() => events.card.length === 1);
  assert.equal(session.recentAsks.size, 1);
  // Not forgotten by the passage of time (it used to be, after 90 seconds).
  for (const v of session.recentAsks.values()) v.at -= 3_600_000;
  for (let i = 0; i < 3; i++) feed(session, [['Speaker 2', `Okay moving on to item ${i} on the agenda.`]]);
  session._forgetOldAsks();
  assert.equal(session.recentAsks.size, 1);
  for (let i = 3; i < 8; i++) feed(session, [['Speaker 2', `Okay moving on to item ${i} on the agenda.`]]);
  session._forgetOldAsks();
  assert.equal(session.recentAsks.size, 0, 'the turn is far behind: its keys are gone');
  await close();
});

test('session: a question that was only offered can still be answered later', async () => {
  const { session, events, close } = await sessionFor(tmp(), { mode: 'mine' });
  feed(session, [['Speaker 2', 'Welcome everyone.'], ['Speaker 1', QUESTION]]); // to the room, not to the user: offered
  await until(() => events.passed.length === 1);
  const key = [...session.recentAsks.keys()];
  assert.equal(key.length, 1);
  assert.ok(key[0].startsWith('pass|'));
  session.setAutoMode('questions');
  session._onFinal('them', 'It matters before Friday.', 'Speaker 1', '1.1'); // same turn, now answerable
  await until(() => events.card.length === 1);
  assert.equal([...session.recentAsks.keys()].filter((k) => !k.startsWith('pass|')).length, 1);
  await close();
});

// ------------------------------------------------------------ the flood guard

test('session: the 7th question within a minute is offered, not answered; a minute later answers resume', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  assert.equal(session.autoLimit, 6);
  const ask = (n) => {
    fake += 5000;
    feed(session, [['Speaker 1', `What is the rollback plan for service number ${n}?`]]);
    session._fireAuto(session.transcript.turns.at(-1).id);
  };
  for (let n = 1; n <= 6; n++) ask(n);
  assert.equal(events.card.filter((c) => c.auto).length, 6);
  assert.equal(events.passed.length, 0);
  ask(7);
  assert.equal(events.card.filter((c) => c.auto).length, 6, 'no seventh answer');
  assert.equal(events.passed.length, 1, 'offered instead');
  assert.equal(events.passed[0].ask, 'What is the rollback plan for service number 7?');
  assert.equal(session.passed.id, events.passed[0].id);
  // Nothing is lost: the user can ask for it, and manual actions are never limited.
  const card = session.answerPassed(events.passed[0].id);
  assert.equal(card.auto, false);
  session.runAction('say', {}, { auto: false });
  assert.equal(events.card.length, 8);
  // A minute later it starts again.
  fake += 61000;
  ask(8);
  assert.equal(events.card.filter((c) => c.auto).length, 7);
  assert.equal(events.passed.length, 1);
  await close();
}));

test('session: the limit is an instance field and a lower one is obeyed', async () => {
  const { session, events, close } = await sessionFor(tmp());
  session.autoLimit = 1;
  feed(session, [['Speaker 1', 'What is our rollback plan if the scan fails?'], ['Speaker 2', 'How long will the failover test take on Friday?']]);
  session._fireAuto(session.transcript.turns[0].id);
  session._fireAuto(session.transcript.turns[1].id);
  assert.equal(events.card.filter((c) => c.auto).length, 1);
  assert.equal(events.passed.length, 1);
  assert.equal(events.passed[0].ask, 'How long will the failover test take on Friday?');
  await close();
});

// ------------------------------------------------------------ _targeting

test('session: _targeting keeps a running set of raw labels and does not scan the turns', async () => {
  const { session, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'We should start with the budget.']]);
  const one = session.transcript.turns.at(-1);
  assert.equal(session._targeting(one).context.oneToOne, true);
  session.renameSpeaker(one.speakerKey, 'Priya Shah');
  assert.equal(session._targeting(one).context.oneToOne, true, 'a rename changes the display name, not the label set');
  // Another connection numbers its voices afresh: the same raw label is still one voice, as before.
  session._onFinal('them', 'Back after the reconnect.', 'Speaker 1', '2.1');
  assert.equal(session._targeting(session.transcript.turns.at(-1)).context.oneToOne, true);
  feed(session, [['Speaker 2', 'And I have a question about it.']]);
  assert.equal(session._targeting(session.transcript.turns.at(-1)).context.oneToOne, false);
  assert.deepEqual([...session.transcript.themLabels].sort(), ['Speaker 1', 'Speaker 2']);
  // A new meeting starts from nothing.
  await session.stop();
  session.start({ title: 'again', channels: ['them'] });
  assert.equal(session.transcript.themLabels.size, 0);
  await close();
});

test('session: _targeting costs the same at 4,800 turns as at 50', async () => {
  const { session, close } = await sessionFor(tmp(), { mode: 'manual' });
  const time = (turn) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 2000; i++) session._targeting(turn); return Number(process.hrtime.bigint() - t0) / 2000 / 1e6; };
  let at = realNow() - 1e7;
  const add = (n) => { for (let i = 0; i < n; i++) { at += 1000; session.transcript.addFinal('them', `Point ${i} about the release and the plan.`, `Speaker ${1 + (i % 3)}`, at, '1.1'); } };
  add(50);
  const small = time(session.transcript.turns.at(-1));
  add(4750);
  assert.equal(session.transcript.turns.length, 4800);
  const big = time(session.transcript.turns.at(-1));
  assert.ok(big < small * 4 + 0.02, `50 turns: ${small.toFixed(4)} ms, 4800 turns: ${big.toFixed(4)} ms`);
  await close();
});

// ------------------------------------------------------------ the small things

test('session: names() never throws, whatever is in settings', async () => {
  const { session, close } = await sessionFor(tmp());
  const real = session.settings.get.bind(session.settings);
  const withMe = (me) => { session.settings.get = () => ({ ...real(), me }); };
  withMe({ name: 'Ade', aliases: 5 });
  assert.deepEqual(session.names(), ['Ade']);
  session._onFinal('them', 'Ade, what is the rollback plan?', 'Speaker 1', '1.1'); // used to throw on every result
  assert.equal(session.transcript.turns.length, 1);
  for (const [me, want] of [
    [{ name: 'Ade', aliases: null }, ['Ade']],
    [{ name: 'Ade', aliases: { a: 1 } }, ['Ade']],
    [{ name: 'Ade', aliases: ['A.', 3, null, {}, ' Dee '] }, ['Ade', 'A.', 'Dee']],
    [{ name: 'Ade', aliases: 'Dee, Del' }, ['Ade', 'Dee', 'Del']],
    [{ name: 7, aliases: ['A.'] }, ['A.']],
    [{}, []],
    [null, []],
    [undefined, []],
  ]) { withMe(me); assert.deepEqual(session.names(), want, JSON.stringify(me)); }
  await close();
});

test('session: runAction accepts only real actions; setPersonality ignores what is not a string', async () => {
  const { session, events, close } = await sessionFor(tmp());
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope', '', null, undefined, 7]) {
    assert.throws(() => session.runAction(bad, {}), /Unknown action/, String(bad));
  }
  assert.equal(session.cards.size, 0);
  assert.equal(events.card.length, 0, 'no broken visible card');
  const card = session.runAction('answer', { ask: 'What now?' });
  assert.equal(card.action, 'answer');
  session.setPersonality('sharp');
  assert.equal(session.personality, 'sharp');
  for (const bad of [5, null, undefined, {}, ['x']]) { session.setPersonality(bad); assert.equal(session.personality, 'sharp'); }
  await close();
});

test('session: switching to proactive while the meeting is stopping leaves no timer behind', async () => {
  const { session, close } = await sessionFor(tmp());
  const stopping = session.stop();
  assert.equal(session.stopping, true);
  session.setAutoMode('proactive');
  await stopping;
  assert.equal(session.proactiveTimer, null);
  await close();
});

test('session: words flushed while paused are kept and saved, but nothing is answered or checked for names', async () => {
  const { session, events, livePath, close } = await sessionFor(tmp());
  let nameChecks = 0;
  session._maybeSuggestNames = () => { nameChecks++; };
  await session.pause();
  session._onFinal('them', QUESTION, 'Speaker 1', '1.1'); // what a closing stream hands over
  assert.equal(session.transcript.turns.length, 1, 'kept');
  assert.ok(fs.readFileSync(livePath(), 'utf8').includes(QUESTION), 'and autosaved');
  assert.equal(session.pendingAuto.size, 0, 'no answer scheduled');
  assert.equal(nameChecks, 0);
  session.resume();
  await sleep(1300);
  assert.equal(events.card.length, 0, 'a quick resume does not answer it');
  feed(session, [['Speaker 1', 'How long will the failover test take on Friday?']]);
  assert.equal(nameChecks, 1, 'a live result still counts');
  await until(() => events.card.length === 1);
  await close();
});

// ------------------------------------------------------------ notices and gaps from the speech stream

const GAP = '[Transcription fell behind here, so about 12 seconds of speech was skipped.]';

test('transcript: a gap marker is a turn of its own, takes the default label and is not a voice', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  t.addFinal('them', 'We start with the budget', 'Speaker 1', 1000, '1.1');
  const gap = t.addFinal('them', GAP, 'Speaker 1', 1500, '1.1', { gap: true });
  assert.equal(gap.merged, false, 'does not merge into the turn before');
  assert.equal(gap.turn.speaker, 'Them', 'the channel default, not the speaker the stream named');
  assert.equal(gap.turn.gap, true);
  const next = t.addFinal('them', 'and then the plan.', 'Speaker 1', 2000, '1.1');
  assert.equal(next.merged, false, 'the next result does not merge into it either');
  assert.equal(t.turns.length, 3);
  // Not even by carrying on across it as an "interjection".
  const short = t.addFinal('them', 'ok', 'Speaker 1', 2500, '1.1', { gap: true });
  assert.equal(short.turn.gap, true);
  assert.equal(t.addFinal('them', 'carry on here', 'Speaker 1', 3000, '1.1').merged, false, 'a marker is not an interjection to carry on across');
  assert.deepEqual(t.speakerList().map((s) => s.key), ['1.1:Speaker 1']);
  assert.equal(t.speakerList()[0].turns, 3, 'only real turns are counted');
  assert.deepEqual(t.speakers(), ['Speaker 1']);
  assert.deepEqual([...t.themLabels], ['Speaker 1']);
  assert.throws(() => t.setName('gap:them', 'Bob'), /not in this meeting/);
  assert.ok(t.toMarkdown().includes(`**[`) && t.toMarkdown().includes(`Them:** ${GAP}`));
  // The user's own channel.
  const me = t.addFinal('me', '[Transcription fell behind here, so about 3 seconds of speech was skipped.]', null, 4000, '1.1', { gap: true });
  assert.equal(me.turn.speaker, 'Ade');
});

test('session: a gap marker is saved like a turn but never analysed, never counted, and never merged', async () => {
  const { session, events, livePath, close } = await sessionFor(tmp());
  let nameChecks = 0;
  session._maybeSuggestNames = () => { nameChecks++; };
  session.lastSpeechAt = 12345;
  // It arrives the way the stream sends it, as a final with gap: true.
  session.streams.them.emit('final', { text: 'What is our rollback plan if the scan fails?', speaker: 'Speaker 9', gap: true });
  const turn = session.transcript.turns[0];
  assert.equal(turn.gap, true);
  assert.equal(turn.speaker, 'Them');
  assert.equal(session.pendingAuto.size, 0, 'not analysed: it reads as a question, and is not one');
  assert.equal(nameChecks, 0);
  assert.equal(session.lastSpeechAt, 12345, 'not someone speaking');
  assert.ok(fs.readFileSync(livePath(), 'utf8').includes('"gap":true'), 'autosaved, so the saved file shows the gap');
  session.streams.them.emit('final', { text: 'Thanks everyone for joining.', speaker: 'Speaker 1' });
  assert.equal(session.transcript.turns.length, 2, 'the next result starts its own turn');
  assert.ok(session.lastSpeechAt > 12345);
  assert.equal(nameChecks, 1, 'speech does count');
  assert.deepEqual(session.transcript.speakers(), ['Speaker 1']);
  await sleep(1200);
  assert.equal(events.card.length, 0);
  await close();
});

test('session: a stream notice is a hint, never throttled; a real error is still an error, once per 20 seconds', async () => {
  const { session, events, close } = await sessionFor(tmp());
  const stream = session.streams.them;
  const notice = (m) => Object.assign(new Error(m), { notice: true });
  stream.emit('error', notice('Transcription is running behind, so some speech was skipped. The speech provider is slow or limiting requests.'));
  stream.emit('error', notice('Transcription has caught up.'));
  stream.emit('error', notice('Transcription has caught up.'));
  assert.deepEqual(events.hint, ['Transcription is running behind, so some speech was skipped. The speech provider is slow or limiting requests.', 'Transcription has caught up.', 'Transcription has caught up.']);
  assert.deepEqual(events.error, [], 'not shown as errors');
  stream.emit('error', new Error('boom'));
  stream.emit('error', new Error('boom again'));
  assert.deepEqual(events.error, ['boom'], 'real errors behave as before, throttled per channel');
  assert.equal(events.hint.length, 3);
  await close();
});
