'use strict';
// Question targeting: who a question is for (you / someone else / the room),
// which modes answer it on their own, and the question the app passes over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram } = require('./mocks');
const { analyzeTurn } = require('../src/main/triggers');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const { ACTIONS, systemPrompt } = require('../src/main/prompts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-tgt-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for something that is going to happen (a card, a passed question, a model request) by looking for it, up to a
// generous deadline: on a cold start the first model request can arrive half a second late. A wait that checks that
// something did NOT happen still has to be a fixed sleep (see the tests that use sleep(1300) alone).
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return fn(); };
const plain = { available: () => false };

const NAMES = ['Ade', 'Adebodun'];
const OTHERS = ['Priya Nair', 'Tom'];
const run = (text, extra = {}) => analyzeTurn(text, { names: NAMES, others: OTHERS, mode: 'questions', ...extra });
const pick = (r) => [r.target, r.addressee, r.why];

// ------------------------------------------------------------ analyzeTurn: the seven rules

test('target rule 1: the asking sentence addresses the user, or the sentence before it is only the name', () => {
  assert.deepEqual(pick(run("Ade, what's the ETA on the migration?")), ['you', '', 'name']);
  assert.deepEqual(pick(run("What's the ETA on the migration, Ade?")), ['you', '', 'name']);
  assert.deepEqual(pick(run('Ade can you walk us through the rollback plan?')), ['you', '', 'name']);
  assert.deepEqual(pick(run('Adebodun, thoughts?')), ['you', '', 'name']);
  assert.deepEqual(pick(run('Ade. What do you think about the rollout?')), ['you', '', 'name']);
  assert.deepEqual(pick(run('Hey Ade, what is the plan for the failover?')), ['you', '', 'name']);
  assert.equal(run("Ade, what's the ETA?").reason, 'question to you');
});

test('target rule 2: directed at the user ("over to Ade", "let\'s ask Ade")', () => {
  assert.deepEqual(pick(run('We should probably ask Ade about the IAM policy for that bucket.')), ['you', '', 'directed']);
  assert.deepEqual(pick(run("Okay, let's ask Ade: what is the plan for the failover?")), ['you', '', 'directed']);
  assert.deepEqual(pick(run('Over to Ade.')), ['you', '', 'directed']);
});

test('target rule 3: put to another person by name', () => {
  assert.deepEqual(pick(run("Priya, what's the ETA on the migration?")), ['other', 'Priya Nair', '']);
  assert.deepEqual(pick(run("What's the ETA on the migration, Priya?")), ['other', 'Priya Nair', '']);
  assert.deepEqual(pick(run('Priya can you take the rollout plan?')), ['other', 'Priya Nair', '']);
  assert.deepEqual(pick(run('Priya Nair, what is the plan for the failover?')), ['other', 'Priya Nair', '']);
  assert.deepEqual(pick(run('Can you ask Priya what the ETA is?')), ['other', 'Priya Nair', '']);
  assert.deepEqual(pick(run("Let's hear from Tom.")), ['other', 'Tom', '']);
  assert.deepEqual(pick(run('Tom. What is the plan for the failover?')), ['other', 'Tom', ''], 'the sentence before it is only the name');
  assert.deepEqual(pick(run('Hey, Priya. What is the plan for the failover?')), ['other', 'Priya Nair', '']);
  const r = run("Priya, what's the ETA?");
  assert.equal(r.reason, 'question to someone else');
  assert.equal(r.fire, false);
  assert.equal(r.pass, true);
});

test('a name that is only talked about is not an address', () => {
  for (const s of ["Is Priya's migration done?", 'What did Priya say about the rollout?', 'Did Tom finish the migration yet?', 'Has Priya Nair signed off on this plan?']) {
    const r = run(s);
    assert.equal(r.question, true, s);
    assert.deepEqual(pick(r), ['room', '', ''], s);
    assert.equal(r.fire, true, s);
  }
});

test('a multi-word name also matches on its first word', () => {
  assert.equal(run('Priya, what is the plan for the failover?').addressee, 'Priya Nair');
  assert.equal(run('Nair, what is the plan for the failover?').target, 'room', 'the second word alone is not a name');
});

test('the user and another person both addressed: the user wins', () => {
  assert.deepEqual(pick(run('Ade, ask Priya what the ETA is?')), ['you', '', 'name']);
  assert.deepEqual(pick(run('Priya, over to Ade, what is the plan for the failover?')), ['you', '', 'directed']);
});

test('target rule 4: the user is addressed elsewhere in the turn and nobody else is', () => {
  assert.deepEqual(pick(run('Ade, quick one. What is the ETA on the migration?')), ['you', '', 'name']);
  // An address to someone else in the asking sentence still beats it.
  assert.deepEqual(pick(run('Ade, quick one. Priya, what is the ETA?')), ['other', 'Priya Nair', '']);
});

test('target rules 5, 6 and 7: one-to-one, straight after you, otherwise the room', () => {
  const q = 'What is the ETA on the migration?';
  assert.deepEqual(pick(run(q, { context: { oneToOne: true } })), ['you', '', 'one-to-one']);
  assert.deepEqual(pick(run(q, { context: { afterMe: true } })), ['you', '', 'after-you']);
  assert.deepEqual(pick(run(q, { context: { oneToOne: true, afterMe: true } })), ['you', '', 'one-to-one'], 'one-to-one is judged first');
  assert.deepEqual(pick(run(q)), ['room', '', '']);
  assert.equal(run(q).reason, 'question');
  // A name still beats the context.
  assert.deepEqual(pick(run("Priya, what's the ETA?", { context: { oneToOne: true } })), ['other', 'Priya Nair', '']);
});

test('names that are ordinary words only count as an address', () => {
  const o = { others: ['Will', 'Mark', 'May'] };
  for (const s of ['Will the migration finish by Friday?', 'We will see. Can you mark the ticket as done?', 'It may take a few days. What did Mark say?', 'Do you think we will get the grant approved?']) {
    assert.deepEqual(pick(run(s, o)), ['room', '', ''], s);
  }
  assert.deepEqual(pick(run('Will, what do you think about the rollout?', o)), ['other', 'Will', '']);
  assert.deepEqual(pick(run('Mark can you check the ticket?', o)), ['other', 'Mark', '']);
  assert.deepEqual(pick(run('What do you think about the rollout, May?', o)), ['other', 'May', '']);
  // ...and the same goes for the user's own name.
  const me = { names: ['Will'], others: ['Priya'] };
  assert.equal(analyzeTurn('Will the migration finish by Friday?', me).target, 'room');
  assert.deepEqual(pick(analyzeTurn('Will, what do you think about the rollout?', me)), ['you', '', 'name']);
});

test('others that are the user are ignored', () => {
  const r = analyzeTurn("Ade, what's the ETA?", { names: NAMES, others: ['ade', 'ADEBODUN', 'Priya'] });
  assert.deepEqual(pick(r), ['you', '', 'name']);
  const q = analyzeTurn('What is the ETA on the migration?', { names: NAMES, others: ['Ade'], context: {} });
  assert.equal(q.target, 'room');
});

test('no question: no target, never a pass', () => {
  for (const mode of ['manual', 'mine', 'questions', 'proactive']) {
    const r = run('We deployed the fix yesterday and it went fine.', { mode });
    assert.deepEqual([r.question, r.fire, r.pass, r.target, r.addressee, r.why], [false, false, false, '', '', ''], mode);
    assert.equal(r.reason, mode === 'manual' ? 'manual mode' : 'statement');
  }
  const m = run('Thanks Ade, that was really helpful today.');
  assert.deepEqual([m.question, m.mentioned, m.target, m.pass, m.reason], [false, true, '', false, 'mentioned']);
  const n = run('Ade, I posted an update on Slack.');
  assert.deepEqual([n.question, n.mentioned, n.target, n.reason], [false, true, '', 'mentioned']);
});

// ------------------------------------------------------------ analyzeTurn: modes

test('fire and pass in each of the four modes', () => {
  const cases = { you: "Ade, what's the ETA?", room: 'What is the ETA on the migration?', other: "Priya, what's the ETA?" };
  const expect = {
    manual: { you: [false, false], room: [false, false], other: [false, false] },
    mine: { you: [true, false], room: [false, true], other: [false, true] },
    questions: { you: [true, false], room: [true, false], other: [false, true] },
    proactive: { you: [true, false], room: [true, false], other: [false, true] },
  };
  for (const [mode, byTarget] of Object.entries(expect)) {
    for (const [target, [fire, pass]] of Object.entries(byTarget)) {
      const r = run(cases[target], { mode });
      assert.equal(r.target, target, `${mode}/${target}`);
      assert.deepEqual([r.fire, r.pass], [fire, pass], `${mode}/${target}`);
    }
  }
  assert.equal(run(cases.you, { mode: 'manual' }).reason, 'manual mode');
  assert.equal(run(cases.other, { mode: 'manual' }).target, 'other', 'manual still says who it was for');
});

test('two-argument calls behave as before', () => {
  const opt = { names: NAMES, mode: 'questions' };
  const a = analyzeTurn("Priya, what's the ETA?", opt);
  assert.deepEqual([a.fire, a.question, a.mentioned, a.reason, a.ask, a.target, a.pass], [true, true, false, 'question', "Priya, what's the ETA?", 'room', false]);
  const b = analyzeTurn('Ade, any concerns about moving this to Friday?', opt);
  assert.deepEqual([b.fire, b.mentioned, b.reason], [true, true, 'question to you']);
  assert.equal(analyzeTurn('What do you think?').fire, true, 'no options at all');
  assert.equal(analyzeTurn('What do you think?', { names: NAMES, mode: 'manual' }).fire, false);
  assert.equal(analyzeTurn('', { names: NAMES }).fire, false);
});

// ------------------------------------------------------------ prompts

test('answer prompt: a question put to someone else says so; others are unchanged', () => {
  const other = ACTIONS.answer.task({ ask: 'What is the ETA?', speaker: 'Tom', reason: 'question to someone else', target: 'other', addressee: 'Priya' });
  assert.equal(other, 'Tom just said: "What is the ETA?"\nThis was put to Priya, not to me. Give me what I could add if it comes to me.');
  assert.ok(ACTIONS.answer.task({ ask: 'Q?', target: 'other' }).includes('put to someone else, not to me'));
  assert.ok(ACTIONS.answer.task({ ask: 'Q?', target: 'other', addressee: 'Pri"ya\n<x>' }).includes('put to Pri ya x, not to me'), 'the name cannot break out of the prompt');
  for (const target of ['you', 'room', '', undefined]) {
    assert.equal(ACTIONS.answer.task({ ask: 'What is the ETA?', speaker: 'Tom', reason: 'question', target, addressee: 'Priya' }), 'Tom just said: "What is the ETA?"\nGive me what to say in reply.');
  }
  const sys = systemPrompt({ name: 'Ade', role: '', profile: '', personality: '' });
  const ground = sys.indexOf('- Ground the answer in the excerpts');
  const arch = sys.indexOf('- Some excerpts are architecture diagrams');
  assert.ok(ground > 0 && arch > ground && sys.indexOf('- Specifics about') > arch, 'the diagram bullet sits right after the grounding bullet');
  assert.ok(sys.includes('the way Ade would explain their own system.'));
});

// ------------------------------------------------------------ session

async function sessionFor(dir, { channels = ['them'], room = false, mode = 'questions' } = {}) {
  const llmMock = await mockLlm(() => 'Here is what to say.');
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade', aliases: ['A.'] }, llm: { baseUrls: { anthropic: llmMock.url } }, stt: { skipSilence: false, suggestNames: false }, copilot: { autoMode: mode } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library: new Library(), store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const events = { card: [], passed: [], cleared: [] };
  session.on('card', (c) => events.card.push(c));
  session.on('passed', (p) => events.passed.push(p));
  session.on('passed-clear', (p) => events.cleared.push(p));
  session.start({ title: 't', channels, room });
  const close = async () => { await session.stop(); await llmMock.close(); await dg.close(); };
  return { session, llmMock, events, close };
}

// Every line becomes its own turn: the previous turn is aged so the same voice twice in a row does not merge.
const feed = (session, lines) => {
  for (const [who, text] of lines) {
    const last = session.transcript.turns.at(-1);
    if (last) last.end -= 5000;
    session._onFinal('them', text, who, '1.1');
  }
};
const K2 = '1.1:Speaker 2';
// Two voices, one of them named Priya.
const introduce = (session) => {
  feed(session, [['Speaker 2', 'Welcome everyone, shall we get going.'], ['Speaker 1', 'Hi all, glad to be here today.']]);
  session.renameSpeaker(K2, 'Priya');
};

test('session: a question put to a named voice makes no card and is passed; answerPassed answers it', async () => {
  const { session, llmMock, events, close } = await sessionFor(tmp());
  introduce(session);
  feed(session, [['Speaker 1', "Priya, what's the ETA on the migration?"]]);
  assert.ok(await until(() => events.passed.length >= 1), 'the question was passed');
  await sleep(1000); // and no card follows it (a fixed wait: this checks that nothing happens)
  assert.equal(events.card.length, 0, 'no automatic card');
  assert.equal(llmMock.calls.length, 0, 'and no model call');
  assert.equal(events.passed.length, 1);
  const p = events.passed[0];
  assert.deepEqual([p.ask, p.speaker, p.target, p.addressee], ["Priya, what's the ETA on the migration?", 'Speaker 1', 'other', 'Priya']);
  assert.equal(typeof p.id, 'number'); assert.equal(typeof p.turnId, 'number'); assert.equal(typeof p.at, 'number');
  assert.deepEqual(session.snapshot().passed, p);

  const card = session.answerPassed(p.id);
  assert.deepEqual([card.target, card.addressee, card.auto, card.quote, card.reason], ['other', 'Priya', false, p.ask, 'question to someone else']);
  assert.deepEqual(events.cleared, [{ id: p.id }]);
  assert.equal(session.snapshot().passed, null);
  assert.equal(events.card.length, 1);
  assert.deepEqual([events.card[0].target, events.card[0].addressee], ['other', 'Priya'], 'the public card carries them');
  assert.ok(await until(() => llmMock.calls.length >= 1), 'the model was asked');
  const sent = JSON.stringify(llmMock.calls[0].body.messages);
  assert.ok(sent.includes('This was put to Priya, not to me. Give me what I could add if it comes to me.'));
  assert.throws(() => session.answerPassed(p.id), /That question is no longer waiting\./);
  assert.throws(() => session.answerPassed(9999), /no longer waiting/);
  await close();
});

test('session: a newer passed question replaces the older one; a fired answer clears it', async () => {
  const { session, events, close } = await sessionFor(tmp());
  introduce(session);
  feed(session, [['Speaker 1', "Priya, what's the ETA on the migration?"]]);
  assert.ok(await until(() => events.passed.length >= 1));
  feed(session, [['Speaker 1', 'Priya, how long will the failover test take?']]);
  assert.ok(await until(() => events.passed.length >= 2));
  assert.equal(events.passed.length, 2);
  assert.equal(events.passed[1].id, events.passed[0].id + 1);
  assert.equal(events.cleared.length, 0, 'a replacement needs no clear');
  assert.equal(session.passed.id, events.passed[1].id);
  // A question the app does answer takes the older one off the table.
  feed(session, [['Speaker 1', 'What is our rollback plan if the scan fails?']]);
  assert.ok(await until(() => events.card.length >= 1));
  assert.equal(events.card.length, 1);
  assert.equal(events.card[0].target, 'room');
  assert.deepEqual(events.cleared, [{ id: events.passed[1].id }]);
  assert.equal(session.passed, null);
  await close();
});

test('session: the passed question expires, and is cleared on pause and stop', async () => {
  const { session, events, close } = await sessionFor(tmp());
  session.passedLifeMs = 300;
  introduce(session);
  feed(session, [['Speaker 1', "Priya, what's the ETA on the migration?"]]);
  while (!events.passed.length) await sleep(20);
  const first = events.passed[0];
  assert.ok(session.passed && session.passed.id === first.id, 'on offer straight away');
  assert.ok(await until(() => session.passed === null), 'it expired');
  assert.deepEqual(events.cleared, [{ id: first.id }]);
  assert.throws(() => session.answerPassed(first.id), /no longer waiting/);

  session.passedLifeMs = 30000;
  feed(session, [['Speaker 1', 'Priya, how long will the failover test take?']]);
  assert.ok(await until(() => events.passed.length >= 2));
  const second = events.passed[1];
  await session.pause();
  assert.equal(session.passed, null);
  assert.deepEqual(events.cleared.at(-1), { id: second.id });
  session.resume();

  feed(session, [['Speaker 1', "Priya, what's the plan for the audit?"]]);
  assert.ok(await until(() => events.passed.length >= 3));
  const third = events.passed[2];
  assert.ok(session.passed);
  await close();
  assert.equal(session.passed, null);
  assert.deepEqual(events.cleared.at(-1), { id: third.id });
});

test("session: mode 'mine' passes a room question and answers a named one", async () => {
  const { session, events, close } = await sessionFor(tmp(), { mode: 'mine' });
  assert.equal(session.snapshot().autoMode, 'mine');
  introduce(session);
  feed(session, [['Speaker 1', 'What is our rollback plan if the scan fails?']]);
  assert.ok(await until(() => events.passed.length >= 1));
  assert.equal(events.card.length, 0);
  assert.deepEqual(events.passed.map((p) => [p.target, p.addressee]), [['room', '']]);
  // It can still be answered on request; the card says it was asked to the room.
  const card = session.answerPassed(events.passed[0].id);
  assert.equal(card.target, 'room');
  assert.equal(card.reason, 'question');
  feed(session, [['Speaker 1', "Ade, what's the plan for the audit?"]]);
  assert.ok(await until(() => events.card.some((c) => c.auto)));
  const auto = events.card.filter((c) => c.auto);
  assert.equal(auto.length, 1);
  assert.deepEqual([auto[0].target, auto[0].reason], ['you', 'question to you']);
  assert.equal(events.passed.length, 1, 'a question for you is never passed');
  await close();
});

test("session: mode 'manual' neither answers nor passes", async () => {
  const { session, events, llmMock, close } = await sessionFor(tmp(), { mode: 'manual' });
  introduce(session);
  feed(session, [['Speaker 1', "Ade, what's the plan for the audit?"], ['Speaker 2', "Tom, what's the ETA?"]]);
  await sleep(1300);
  assert.equal(events.card.length + events.passed.length + llmMock.calls.length, 0);
  await close();
});

test('session: unknown modes fall back to questions', async () => {
  const { session, close } = await sessionFor(tmp(), { mode: 'wild' });
  assert.equal(session.autoMode, 'questions');
  for (const m of ['manual', 'mine', 'questions', 'proactive']) { session.setAutoMode(m); assert.equal(session.autoMode, m); }
  session.setAutoMode('nonsense');
  assert.equal(session.autoMode, 'questions');
  session.setAutoMode('proactive'); // leave no timer behind
  session.setAutoMode('manual');
  await close();
});

test('session: one-to-one needs speaker separation and exactly one voice', async () => {
  const { session, close } = await sessionFor(tmp());
  const ctx = (turn) => session._targeting(turn).context;
  // No speaker separation: every turn is "Them".
  feed(session, [[undefined, 'Hello there, how are you today.']]);
  assert.equal(ctx(session.transcript.turns.at(-1)).oneToOne, false, 'the app cannot know how many people are on the call');
  // One real label: one-to-one.
  const a = await sessionFor(tmp());
  feed(a.session, [['Speaker 1', 'Hello there, how are you today.'], ['Speaker 1', 'I wanted to ask you about the plan.']]);
  assert.equal(a.session._targeting(a.session.transcript.turns.at(-1)).context.oneToOne, true);
  // A second voice appears: no longer one-to-one, for any turn.
  feed(a.session, [['Speaker 2', 'Sorry I am late everyone.']]);
  for (const t of a.session.transcript.turns) assert.equal(a.session._targeting(t).context.oneToOne, false);
  // A different epoch with the same raw label is still the same label.
  const b = await sessionFor(tmp());
  b.session._onFinal('them', 'First thing said in the call.', 'Speaker 1', '1.1');
  b.session.transcript.turns.at(-1).end -= 5000;
  b.session._onFinal('them', 'Second thing, after a reconnect.', 'Speaker 1', '1.2');
  assert.equal(b.session._targeting(b.session.transcript.turns.at(-1)).context.oneToOne, true);
  // Labelled turns mixed with unlabelled ones are not one voice either.
  feed(b.session, [[undefined, 'And now there is no label at all.']]);
  assert.equal(b.session._targeting(b.session.transcript.turns.at(-1)).context.oneToOne, false);
  await a.close(); await b.close(); await close();
});

test('session: a question in a one-to-one call is for you, and fires in mine mode', async () => {
  const { session, events, close } = await sessionFor(tmp(), { mode: 'mine' });
  feed(session, [['Speaker 1', 'What is our rollback plan if the scan fails?']]);
  assert.ok(await until(() => events.card.length >= 1));
  assert.equal(events.passed.length, 0);
  assert.equal(events.card.length, 1);
  assert.deepEqual([events.card[0].target, events.card[0].reason], ['you', 'question to you']);
  await close();
});

test('session: afterMe means the user spoke within 20 s before this turn began', async () => {
  const { session, close } = await sessionFor(tmp(), { channels: ['them', 'me'] });
  const ctx = (turn) => session._targeting(turn).context;
  feed(session, [['Speaker 2', 'Welcome everyone, shall we get going.'], ['Speaker 3', 'Glad to be here today as well.']]);
  session._onFinal('me', 'Let me explain how the pipeline handles the rotation of secrets.');
  const mine = session.transcript.turns.at(-1);
  assert.equal(mine.channel, 'me');
  session._onFinal('them', 'And what happens if the scan fails.', 'Speaker 2', '1.1');
  const next = session.transcript.turns.at(-1);
  assert.equal(next.channel, 'them');
  assert.equal(ctx(next).afterMe, true);
  assert.equal(ctx(session.transcript.turns[0]).afterMe, false, 'the first turn has nothing before it');
  assert.equal(ctx(session.transcript.turns[1]).afterMe, false, 'the turn before it is another voice');
  // More than 20 s of gap.
  mine.end = next.t - 20001;
  assert.equal(ctx(next).afterMe, false);
  mine.end = next.t - 20000;
  assert.equal(ctx(next).afterMe, true, 'exactly 20 s still counts');
  // Someone else spoke in between.
  feed(session, [['Speaker 3', 'I have a question about that too.']]);
  const third = session.transcript.turns.at(-1);
  assert.equal(ctx(third).afterMe, false);
  await close();
});

test('session: neither one-to-one nor afterMe in an in-person (room) meeting', async () => {
  const { session, close } = await sessionFor(tmp(), { channels: ['them', 'me'], room: true });
  feed(session, [['Speaker 1', 'Hello there, how are you today.']]);
  session._onFinal('me', 'Let me explain how the pipeline handles the rotation of secrets.');
  session._onFinal('them', 'And what happens if the scan fails.', 'Speaker 1', '1.1');
  const t = session.transcript.turns.at(-1);
  assert.equal(session.transcript.turns.at(-2).channel, 'me');
  assert.deepEqual(session._targeting(t).context, { oneToOne: false, afterMe: false });
  await close();
});

test('session: the others are the names given to voices', async () => {
  const { session, close } = await sessionFor(tmp());
  introduce(session);
  session.renameSpeaker('1.1:Speaker 1', 'Tom Hale');
  assert.deepEqual(session._targeting(session.transcript.turns.at(-1)).others.sort(), ['Priya', 'Tom Hale']);
  await close();
});

test('session: a question after the user spoke is answered as for them, even without a name', async () => {
  const { session, events, close } = await sessionFor(tmp(), { channels: ['them', 'me'], mode: 'mine' });
  introduce(session);
  session._onFinal('me', 'Let me explain how the pipeline handles the rotation of secrets.');
  session._onFinal('them', 'And what happens if the scan fails?', 'Speaker 1', '1.1');
  assert.ok(await until(() => events.card.length >= 1));
  assert.equal(events.passed.length, 0);
  assert.equal(events.card.length, 1);
  assert.equal(events.card[0].target, 'you');
  await close();
});
