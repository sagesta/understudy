'use strict';
// Three fixes found by walking through the app:
//   B1  the flood guard must not silence (or mislabel) a question put to the user
//   B6  a question with a pause in the middle is one question, not two halves
//   B11 a loose recall (an action with no question) brings the correction along with the old reply
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram } = require('./mocks');
const { analyzeTurn, classify } = require('../src/main/triggers');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const { Transcript, MeetingRecall, clock, RECALL_MAX_TURNS, RECALL_MAX_CHARS } = require('../src/main/transcript');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-qafix-'));
const realNow = Date.now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { available: () => false };
const until = async (fn, ms = 6000) => { const end = realNow() + ms; while (!fn()) { if (realNow() > end) throw new Error('timed out waiting'); await sleep(10); } };

// A controlled clock for the tests that need minutes to pass.
let fake = 0;
const useClock = (start = 1_700_000_000_000) => { fake = start; Date.now = () => fake; };
const restoreClock = () => { Date.now = realNow; };
const clocked = (fn) => async () => { useClock(); try { await fn(); } finally { restoreClock(); } };

async function sessionFor(dir, { channels = ['them'], mode = 'questions', library = new Library() } = {}) {
  const llmMock = await mockLlm(() => 'Here is what to say.');
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade', aliases: ['A.'] }, llm: { baseUrls: { anthropic: llmMock.url } }, stt: { skipSilence: false, suggestNames: false }, copilot: { autoMode: mode } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library, store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const events = { card: [], passed: [], cleared: [] };
  session.on('card', (c) => events.card.push(c));
  session.on('passed', (p) => events.passed.push(p));
  session.on('passed-clear', (p) => events.cleared.push(p));
  session.start({ title: 't', channels });
  const close = async () => { await session.stop(); await llmMock.close(); await dg.close(); };
  return { session, llmMock, events, close };
}

// Every line becomes its own turn: the previous turn is aged so the same voice twice in a row does not merge.
const feed = (session, lines, ageMs = 5000) => {
  for (const [who, text] of lines) {
    const last = session.transcript.turns.at(-1);
    if (last) last.end -= ageMs;
    session._onFinal('them', text, who, '1.1');
  }
};
const fire = (session) => session._fireAuto(session.transcript.turns.at(-1).id);
const autoCards = (events) => events.card.filter((c) => c.auto);

// ============================================================ B1: the flood guard and questions for the user

test('B1: after the guard tripped on room questions, a question put to the user still gets a card, labelled for the user', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  assert.equal(session.autoLimit, 6);
  assert.equal(session.autoLimitYou, 12, 'its own, higher cap, an instance field');
  const room = ['What is the retention period for the audit logs?', 'How many replicas does the ledger database have?', 'Which region do we fail over to?', 'Who owns the deploy pipeline now?', 'When does the support contract end?', 'Where are the dashboards for the gateway?', 'Why did the last deploy take so long?'];
  room.forEach((q, i) => { fake += 2600; feed(session, [[`Speaker ${1 + (i % 2)}`, q]], 2600); fire(session); });
  assert.equal(autoCards(events).length, 6, 'six answered');
  assert.equal(events.passed.length, 1, 'the seventh is offered');
  assert.equal(events.passed[0].target, 'room');
  // The repro: the question to the user, straight after.
  fake += 2600; feed(session, [['Speaker 1', 'Ade, what is your view on the timeline?']], 2600); fire(session);
  assert.equal(autoCards(events).length, 7, 'a card for the question to the user');
  assert.deepEqual([autoCards(events)[6].target, autoCards(events)[6].reason], ['you', 'question to you']);
  assert.equal(events.passed.length, 1, 'and nothing was passed for it');
  assert.equal(session.passed, null, 'answering it took the offered room question off the table, as any answer does');
  await close();
}));

test('B1: a question straight after the user spoke (after-you) also gets its card once the guard has tripped', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'Thanks, glad to be here.']], 2600);
  for (let i = 0; i < 7; i++) { fake += 2600; feed(session, [[`Speaker ${1 + (i % 2)}`, `What is the status of workstream number ${i}?`]], 2600); fire(session); }
  assert.equal(autoCards(events).length, 6);
  fake += 2600;
  session._onFinal('me', 'I think Thursday works for me, let me check the calendar.', undefined, '1.1');
  fake += 2000;
  session._onFinal('them', 'And what about the budget?', 'Speaker 2', '1.1');
  fire(session);
  const last = autoCards(events).at(-1);
  assert.equal(autoCards(events).length, 7);
  assert.deepEqual([last.quote, last.target], ['And what about the budget?', 'you']);
  await close();
}));

test('B1: the 13th question to the user within a minute is passed, labelled you; the 12th is answered', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  const ask = (n) => { fake += 2000; feed(session, [[`Speaker ${1 + (n % 2)}`, `Ade, what is your view on item number ${n}?`]], 2000); fire(session); };
  for (let n = 1; n <= 12; n++) ask(n);
  assert.equal(autoCards(events).length, 12);
  assert.equal(events.passed.length, 0);
  ask(13);
  assert.equal(autoCards(events).length, 12, 'no thirteenth answer');
  assert.equal(events.passed.length, 1, 'offered instead');
  assert.deepEqual([events.passed[0].target, events.passed[0].ask], ['you', 'Ade, what is your view on item number 13?']);
  assert.equal(session.passed.target, 'you');
  // The user can still ask for it, and manual actions are never limited.
  const card = session.answerPassed(events.passed[0].id);
  assert.deepEqual([card.auto, card.target, card.reason], [false, 'you', 'question to you']);
  session.runAction('say', {}, { auto: false });
  // A minute later it starts again.
  fake += 61000;
  ask(14);
  assert.equal(autoCards(events).length, 13);
  await close();
}));

test('B1: the two caps are counted apart: six room questions and twelve to the user in one minute', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  let n = 0;
  const say = (text) => { n++; fake += 1500; feed(session, [[`Speaker ${1 + (n % 2)}`, text]], 1500); fire(session); };
  for (let i = 1; i <= 12; i++) say(`Ade, how is item ${i} going?`);
  for (let i = 1; i <= 7; i++) say(`What is the plan for workstream ${i}?`);
  assert.equal(autoCards(events).filter((c) => c.target === 'you').length, 12);
  assert.equal(autoCards(events).filter((c) => c.target === 'room').length, 6, 'room questions still stop at six');
  assert.equal(events.passed.length, 1);
  assert.equal(events.passed[0].target, 'room');
  assert.equal(events.passed[0].ask, 'What is the plan for workstream 7?');
  await close();
}));

test('B1: the cap for questions to the user is a field, and a lower one is obeyed; the room cap is untouched', async () => {
  const { session, events, close } = await sessionFor(tmp());
  session.autoLimitYou = 1;
  feed(session, [['Speaker 1', 'Ade, what is your view on the timeline?'], ['Speaker 2', 'Ade, how long will the failover test take?']]);
  session._fireAuto(session.transcript.turns[0].id);
  session._fireAuto(session.transcript.turns[1].id);
  assert.equal(autoCards(events).length, 1);
  assert.equal(events.passed.length, 1);
  assert.equal(events.passed[0].target, 'you');
  await close();
});

test('B1: a question that is "for you" only because one person is on the call keeps the ordinary cap', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  for (let n = 1; n <= 7; n++) { fake += 5000; feed(session, [['Speaker 1', `What is the rollback plan for service number ${n}?`]]); fire(session); }
  assert.equal(events.card.filter((c) => c.auto).length, 6);
  assert.equal(events.passed.length, 1);
  assert.equal(events.passed[0].target, 'you');
  await close();
}));

test('B1: the overlay keeps "you" (and room, and other) when it takes a passed question', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay.js'), 'utf8');
  // The mapping, run on its own: the function is small and has no dependencies.
  const m = /function takePassed\(m\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'takePassed found');
  const take = (msg) => { const state = { passed: null, arrival: 0, msg }; new Function('state', `let passed = state.passed; let arrival = state.arrival; const renderStrip = () => {}; ${m[0]}; takePassed(state.msg); state.passed = passed;`)(state); return state.passed; };
  assert.equal(take({ id: 1, ask: 'Ade, what is your view?', target: 'you' }).target, 'you');
  assert.equal(take({ id: 2, ask: 'Anyone?', target: 'room' }).target, 'room');
  assert.equal(take({ id: 3, ask: 'Priya, ETA?', target: 'other', addressee: 'Priya' }).target, 'other');
  assert.equal(take({ id: 4, ask: 'Something?' }).target, 'other', 'anything unknown stays as before');
  assert.equal(take({ passed: { id: 5, ask: 'Nested?', target: 'you' } }).target, 'you');
});

// ============================================================ B6: unpunctuated fragments

const FRAGMENTS = [
  'What do you think about', 'Can you walk me through the', 'Who is going to', 'What is the plan for', 'How long will it take to',
  'Do you want to go with', 'So what I wanted to ask is', 'What are the', 'Why did the deploy fail and', 'Ade, what do you think about',
  'Ade what do you think about', 'Is the migration blocked by', 'How many of the', 'Where is the', 'Which of these would', 'What happens if', 'What should we do with the',
  'what do you think about,', 'What do you think about…', 'Does anyone have a',
];
const WHOLE = [
  'What should we do', 'What is this', 'Who is that', 'What are you talking about', 'What is going on', 'How long does the migration take', 'when does the call start',
  'How many people are on the call', 'Where could it be', 'What did you do', 'Do you see this error in the logs', 'Who owns the deploy pipeline now',
];

test('B6: an unpunctuated sentence that stops on a word that cannot end a sentence is not a question', () => {
  for (const f of FRAGMENTS) {
    assert.equal(classify(f, ['Ade']).asking, false, `classify: ${f}`);
    const r = analyzeTurn(f, { names: ['Ade'], mode: 'questions', others: ['Priya'] });
    assert.deepEqual([r.question, r.fire, r.pass], [false, false, false], `analyzeTurn: ${f}`);
  }
});

test('B6: unpunctuated questions that can end on those words, and every punctuated sentence, are as before', () => {
  for (const q of WHOLE) assert.equal(classify(q, ['Ade']).asking, true, q);
  for (const q of ['What do you think about?', 'What do you think about it?', 'So what is the plan for?', 'Ade, what do you think about?']) assert.equal(classify(q, ['Ade']).asking, true, q);
  // A fragment that ends with a full stop is a statement, as before.
  for (const s of ['What do you think about.', 'We should talk about the deploy.', 'That is what I was looking for.']) assert.equal(classify(s, ['Ade']).asking, false, s);
  // The whole of the repro sentence is one question with the room as its target.
  const whole = analyzeTurn('What do you think about moving the deploy to Thursday?', { names: ['Ade'], mode: 'questions' });
  assert.deepEqual([whole.fire, whole.target, whole.ask], [true, 'room', 'What do you think about moving the deploy to Thursday?']);
});

test('B6: a fragment alone fires nothing and passes nothing', async () => {
  const { session, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'What do you think about']]);
  const frag = session.transcript.turns.at(-1);
  assert.equal(session._analyse(frag).question, false);
  await sleep(1300);
  assert.equal(events.card.length, 0);
  assert.equal(events.passed.length, 0);
  await close();
});

test('B6: a fragment, then its tail from the same voice 4 s later, is one question and one card, with the whole sentence as the ask', async () => {
  const { session, llmMock, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'What do you think about']]);
  const frag = session.transcript.turns.at(-1);
  await sleep(300);
  feed(session, [['Speaker 2', 'moving the deploy to Thursday?']], 4000);
  const turns = session.transcript.turns;
  assert.equal(turns.length, 3, 'the transcript keeps the two turns apart');
  assert.deepEqual(turns.slice(1).map((t) => t.text), ['What do you think about', 'moving the deploy to Thursday?']);
  const tail = turns.at(-1);
  assert.equal(session._analysisText(tail), 'What do you think about moving the deploy to Thursday?');
  const a = session._analyse(tail);
  assert.deepEqual([a.question, a.target, a.ask], [true, 'room', 'What do you think about moving the deploy to Thursday?']);
  await until(() => events.card.length === 1);
  await sleep(500);
  assert.equal(events.card.length, 1, 'one card, not two');
  assert.equal(events.card[0].quote, 'What do you think about moving the deploy to Thursday?');
  assert.equal(events.card[0].target, 'room');
  assert.equal(events.passed.length, 0);
  await until(() => llmMock.calls.length === 1);
  assert.ok(JSON.stringify(llmMock.calls[0].body.messages).includes('What do you think about moving the deploy to Thursday?'));
  assert.equal(frag.text, 'What do you think about', 'the first turn itself was not changed');
  await close();
});

test('B6: Mine mode and the user\'s name: the two halves make one hint, to the user', async () => {
  const { session, events, close } = await sessionFor(tmp(), { mode: 'mine' });
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'Ade what do you think about']]);
  await sleep(1300);
  assert.equal(events.card.length + events.passed.length, 0, 'the half alone is nothing');
  feed(session, [['Speaker 2', 'moving the deploy to Thursday?']], 4000);
  await until(() => events.card.length === 1);
  assert.equal(events.card[0].quote, 'Ade what do you think about moving the deploy to Thursday?');
  assert.equal(events.card[0].target, 'you');
  assert.equal(events.passed.length, 0);
  await close();
});

test('B6: Mine mode, a question to the room: one offer for the whole sentence, none for the half', async () => {
  const { session, events, close } = await sessionFor(tmp(), { mode: 'mine' });
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'What do you think about']]);
  await sleep(1300);
  assert.equal(events.passed.length, 0);
  feed(session, [['Speaker 2', 'moving the deploy to Thursday?']], 4000);
  await until(() => events.passed.length === 1);
  await sleep(300);
  assert.equal(events.passed.length, 1);
  assert.deepEqual([events.passed[0].ask, events.passed[0].target], ['What do you think about moving the deploy to Thursday?', 'room']);
  assert.equal(events.card.length, 0);
  await close();
});

test('B6: a tail from a different voice is not joined to the fragment', clocked(async () => {
  const { session, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'What do you think about']], 3000);
  fake += 4000;
  feed(session, [['Speaker 3', 'moving the deploy to Thursday?']], 4000);
  const tail = session.transcript.turns.at(-1);
  assert.equal(session._analysisText(tail), 'moving the deploy to Thursday?');
  fire(session);
  assert.equal(events.card.length, 1);
  assert.equal(events.card[0].quote, 'moving the deploy to Thursday?');
  await close();
}));

test('B6: nor is a tail that comes more than eight seconds later, or one that follows a finished sentence', clocked(async () => {
  const { session, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'What do you think about']], 3000);
  feed(session, [['Speaker 2', 'moving the deploy to Thursday?']], 9000);
  assert.equal(session._analysisText(session.transcript.turns.at(-1)), 'moving the deploy to Thursday?', '9 s is too long');
  feed(session, [['Speaker 3', 'We should talk about the deploy.']], 3000);
  feed(session, [['Speaker 3', 'moving it to Thursday?']], 4000);
  assert.equal(session._analysisText(session.transcript.turns.at(-1)), 'moving it to Thursday?', 'a finished sentence is not carried');
  // 7.5 s is inside the window.
  feed(session, [['Speaker 1', 'What do you think about']], 3000);
  feed(session, [['Speaker 1', 'moving the deploy to Friday?']], 7500);
  assert.equal(session._analysisText(session.transcript.turns.at(-1)), 'What do you think about moving the deploy to Friday?');
  await close();
}));

test('B6: only the last unfinished sentence of the earlier turn is carried', clocked(async () => {
  const { session, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'We looked at the numbers. They look fine. What do you think about']], 3000);
  feed(session, [['Speaker 2', 'moving the deploy to Thursday?']], 4000);
  assert.equal(session._analysisText(session.transcript.turns.at(-1)), 'What do you think about moving the deploy to Thursday?');
  await close();
}));

test('B6: a fragment that ends a thought with a full stop behaves as before', async () => {
  const { session, events, close } = await sessionFor(tmp());
  feed(session, [['Speaker 1', 'Welcome everyone.'], ['Speaker 2', 'I wanted to ask you about the deploy.']]);
  await sleep(1300);
  assert.equal(events.card.length + events.passed.length, 0);
  // And a complete unpunctuated question is still answered on its own.
  feed(session, [['Speaker 1', 'How long does the migration take']]);
  await until(() => events.card.length === 1);
  assert.equal(events.card[0].quote, 'How long does the migration take');
  await close();
});

// ============================================================ B11: recall with no question

const SUBJ = ['the deploy pipeline', 'the Kubernetes upgrade', 'the Terraform modules', 'the on-call handover', 'the Grafana dashboards', 'the cost report', 'the cloud budget for next quarter', 'the Postgres upgrade to version sixteen', 'the Redis cluster', 'the ingress controller', 'the audit findings', 'the hiring plan', 'the load test', 'the staging environment', 'the image scanner', 'the feature flags', 'the mobile release', 'the Kafka consumers', 'the secrets rotation', 'the vendor contract for monitoring'];
const VERB = ['is still blocked on', 'needs another week because of', 'went better than expected despite', 'slipped again thanks to', 'is waiting for sign-off on', 'got reviewed alongside', 'should be finished once we sort out', 'depends heavily on', 'was discussed with security together with', 'is mostly done apart from'];
const TAIL = ['so I will follow up on Thursday.', 'and I think we can live with that.', 'which nobody was surprised by.', 'but the numbers look fine so far.', 'and we will revisit it next sprint.', 'so please shout if that is a problem.', 'and the ticket has all the details.', 'which is roughly what we planned.', 'although the estimate is a bit soft.', 'and I have asked the team to confirm.'];
let seed = 7;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const pick = (a) => a[rnd(a.length)];
const sentence = () => { const a = pick(SUBJ); const b = pick(SUBJ); return `${a[0].toUpperCase()}${a.slice(1)} ${pick(VERB)} ${b}, ${pick(TAIL)}`; };
const talk = (n) => Array.from({ length: n }, sentence).join(' ');
const SP = ['Speaker 1', 'Speaker 2', 'Speaker 3'];
const FACT = 'The Postgres failover budget we agreed is forty five seconds, measured from the primary going dark to writes resuming.';
const REPLY = 'Agreed, forty five seconds goes in the SLO document.';
const RESTATE = 'After the incident review we changed the Postgres failover budget to thirty seconds, not forty five.';
const STATE1 = 'Let us come back to the Postgres failover budget for a moment, I want to hear the numbers.';
const STATE2 = 'Yes, the failover budget for Postgres matters for the SLO document.';
const EARLIER = '[Earlier in this meeting, selected because it relates to the question]';
const RECENT = '[Most recent part of the meeting]';
const earlierOf = (s) => { const a = s.indexOf(EARLIER); return a < 0 ? null : s.slice(a + EARLIER.length, s.indexOf(RECENT)).trim().split('\n'); };
const old = (session) => session.transcript.forPrompt({ maxChars: 24000 });

async function longMeeting({ plant, results = 1211, every = 6000 } = {}) {
  const ctx = await sessionFor(tmp(), { mode: 'manual', library: { chunkCount: 0, search: () => [] } });
  for (let i = 0; i < results; i++) {
    fake += every;
    const [who, text] = plant[i] || [SP[i % 3], talk(1 + rnd(2))];
    ctx.session._onFinal('them', text, who, '1.1');
  }
  return ctx;
}
const REPRO = { 60: ['Speaker 2', FACT], 61: ['Speaker 3', REPLY], 700: ['Speaker 1', RESTATE], 1209: ['Speaker 3', STATE1], 1210: ['Speaker 1', STATE2] };

test('B11: the repro: two statements about the failover budget at minute 121, then "say", bring the minute-70 correction as well as the old reply', clocked(async () => {
  seed = 7;
  const { session, close } = await longMeeting({ plant: REPRO });
  assert.ok((fake - 1_700_000_000_000) / 60000 > 120);
  const out = session._transcriptFor('say', {}, 0);
  const lines = earlierOf(out);
  assert.ok(lines, 'an earlier block');
  const text = lines.join('\n');
  assert.ok(text.includes('Agreed, forty five seconds goes in the SLO document.'), 'the reply');
  assert.ok(text.includes('we changed the Postgres failover budget to thirty seconds, not forty five'), 'the correction');
  assert.ok(text.includes('The Postgres failover budget we agreed is forty five seconds'), 'and the figure they refer to');
  assert.equal(lines.length, 3);
  // In time order, once each.
  assert.deepEqual(lines.map((l) => l.slice(l.indexOf('] ') + 2)), [`Speaker 2: ${FACT}`, `Speaker 3: ${REPLY}`, `Speaker 1: ${RESTATE}`]);
  // Nothing from the recent part is repeated, and the request stays within its budget.
  const win = session.transcript.window({ maxChars: 24000 });
  for (const l of lines) assert.equal(win.text.includes(l), false, l);
  assert.ok(out.length <= 24000, `${out.length} chars`);
  assert.ok(lines.length <= RECALL_MAX_TURNS && lines.join('\n').length <= RECALL_MAX_CHARS);
  // A direct question has always found all three.
  const direct = earlierOf(session._transcriptFor('ask', { typed: 'What failover budget did we agree for Postgres?' }, 0)).join(String.fromCharCode(10));
  for (const t of [FACT, REPLY, RESTATE]) assert.ok(direct.includes(t), t);
  await close();
}));

test('B11: nothing is added when nothing clears the bar, and a single related turn stays alone', clocked(async () => {
  seed = 7;
  const { session, close } = await longMeeting({ plant: { 60: ['Speaker 2', FACT], 61: ['Speaker 3', 'Noted.'], 1209: ['Speaker 3', STATE1], 1210: ['Speaker 1', 'I think so too, the weather is nice today.'] } });
  // Ordinary recent talk: nothing.
  for (const a of ['say', 'take', 'followup', 'screen']) assert.equal(session._transcriptFor(a, {}, 0), old(session), a);
  await close();
  seed = 7;
  const two = await longMeeting({ plant: { 60: ['Speaker 2', 'The quokka licence renewal is due in May with Zorbex.'], 1209: ['Speaker 3', 'Let us talk about the quokka licence renewal with Zorbex again.'], 1210: ['Speaker 1', 'Yes the quokka licence renewal with Zorbex needs a decision.'] } });
  const lines = earlierOf(two.session._transcriptFor('say', {}, 0));
  assert.deepEqual(lines && lines.length, 1, 'the one old turn on the matter, and nothing else');
  assert.ok(lines[0].includes('quokka licence renewal is due in May'));
  await two.close();
}));

test('B11: a turn that clears the ordinary bar on a word the picked turn does not share is not added', clocked(async () => {
  seed = 7;
  const plant = {
    60: ['Speaker 2', 'The quokka rollout needs the zorbex licence before launch.'],
    90: ['Speaker 3', 'The vandelay contract is separate and signed.'],
    1209: ['Speaker 3', 'Back to the quokka rollout and the zorbex licence and the vandelay contract.'],
    1210: ['Speaker 1', 'Yes the quokka rollout, the zorbex licence and the vandelay contract all matter.'],
  };
  const { session, close } = await longMeeting({ plant });
  const lines = earlierOf(session._transcriptFor('say', {}, 0));
  assert.ok(lines, 'a selection');
  assert.ok(lines.join('\n').includes('quokka rollout needs the zorbex licence'));
  assert.equal(lines.join('\n').includes('vandelay contract is separate'), false, 'it shares no rare word with the picked turn');
  await close();
}));

test('B11: the budgets hold: at most four turns and the character limit, the newest of them kept', clocked(async () => {
  seed = 7;
  const plant = { 1209: ['Speaker 3', STATE1], 1210: ['Speaker 1', STATE2] };
  const figures = ['forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  figures.forEach((f, i) => { plant[100 + i * 100] = [SP[i % 3], `Postgres failover budget revision ${i}: we set it to ${f} seconds for the SLO document.`]; });
  const { session, close } = await longMeeting({ plant });
  const out = session._transcriptFor('say', {}, 0);
  const lines = earlierOf(out);
  assert.ok(lines && lines.length <= RECALL_MAX_TURNS, `${lines && lines.length} lines`);
  assert.ok(lines.join('\n').length <= RECALL_MAX_CHARS);
  assert.ok(lines.join('\n').includes('revision 5'), 'the newest is in');
  assert.equal(lines.join('\n').includes('revision 0'), false, 'the oldest gave way');
  assert.ok(out.length <= 24000);
  const revs = lines.map((l) => Number(/revision (\d)/.exec(l)[1]));
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b), 'in time order');
  await close();
}));

test('B11: with a loose query the extra pass costs nothing noticeable at 4,800 turns', clocked(async () => {
  seed = 7;
  const plant = { 60: REPRO[60], 61: REPRO[61], 700: REPRO[700], 4798: ['Speaker 3', STATE1], 4799: ['Speaker 1', STATE2] };
  const { session, close } = await longMeeting({ plant, results: 4800 });
  const time = (fn, n = 40) => { fn(); const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(); return Number(process.hrtime.bigint() - t0) / n / 1e6; };
  const withExtra = time(() => session._transcriptFor('say', {}, 0));
  assert.ok(earlierOf(session._transcriptFor('say', {}, 0)).length >= 3);
  assert.ok(withExtra < 25, `${withExtra.toFixed(2)} ms per answer with related turns`);
  await close();
}));

test('B11: a direct question (not loose) is selected exactly as before', clocked(async () => {
  const t = new Transcript({ myLabel: 'Ade' });
  const rec = new MeetingRecall(t);
  let at = 1_700_000_000_000;
  seed = 7;
  const planted = { 10: FACT, 11: REPLY, 200: RESTATE };
  for (let i = 0; i < 400; i++) { at += 6000; t.addFinal('them', planted[i] || talk(1), SP[i % 3], at, '1.1'); rec.sync(at); }
  const got = rec.select({ query: 'What failover budget did we agree for Postgres?', first: 380 });
  const lines = got.text.split(String.fromCharCode(10)).map((l) => l.slice(l.indexOf('] ') + 2));
  assert.deepEqual(lines.slice(0, 2), [`Speaker 2: ${FACT}`, `Speaker 3: ${REPLY}`]);
  assert.ok(lines.includes(`Speaker 3: ${RESTATE}`) || lines.some((l) => l.endsWith(RESTATE)));
  assert.ok(got.turns <= RECALL_MAX_TURNS);
}));
