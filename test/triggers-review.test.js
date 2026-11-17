'use strict';
// Reviewer findings on the question detector: housekeeping filters that
// swallowed real questions, names the matcher missed, other scripts, other ways
// of addressing someone, and "ask Ade" said as a plan rather than a hand-over.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTurn } = require('../src/main/triggers');

const ADE = { names: ['Ade'], mode: 'mine' };
const pick = (r) => [r.target, r.addressee, r.why];

// ------------------------------------------------------------ 1. logistics

test('1: real questions that only look like housekeeping are questions', () => {
  const real = [
    'Are we on track for Friday?',
    'Is this on the roadmap for Q3?',
    'Is the replica lagging behind the primary?',
    'Is the build frozen until Monday?',
    'Can you share your thoughts on the rollout?',
    'Do you see this error in the logs?',
    'Who dropped the ball on the migration?',
    'Ade, are we on track for Friday?',
    'Ade, is the replica lagging behind the primary?',
    'Ade, do you see this error in the logs?',
    // more that share words with housekeeping
    'Can we share the results with the customer?',
    'Should we wait for the audit?',
    'Should we start with the migration?',
    'Does that make sense for the Q3 budget?',
    'Is everyone ready to ship on Friday?',
    'Can you send me the postmortem?',
    'Are we good on the budget?',
    'Is the recording of the incident call stored in S3?',
    'Who left the bucket open to the public?',
    'Can you hear the difference in latency?',
  ];
  for (const s of real) {
    for (const mode of ['questions', 'mine']) {
      const r = analyzeTurn(s, { names: ['Ade'], mode });
      assert.equal(r.question, true, `${mode}: ${s}`);
    }
    assert.equal(analyzeTurn(s, { names: ['Ade'], mode: 'questions' }).fire, true, s);
  }
  for (const s of real.filter((x) => x.startsWith('Ade,'))) {
    assert.deepEqual(pick(analyzeTurn(s, ADE)), ['you', '', 'name'], s);
    assert.equal(analyzeTurn(s, ADE).fire, true, s);
  }
});

test('1: housekeeping stays ignored', () => {
  const chatter = [
    'Can you hear me?', 'Can everyone hear me okay?', 'Can you see my screen?', 'Can everyone see my screen?',
    'Can you see this?', 'Is this recording?', 'Are we live?', 'Is it on?', 'Is the recording on?', "You're frozen?", 'Am I lagging?',
    'Am I still muted?', 'Are you on mute?', 'Am I breaking up?', 'Are you sharing your screen?',
    'Can you share your screen?', 'Can you share the slides?', 'Can you scroll down?', 'Can you scroll down a bit?', 'Can you zoom in a bit?',
    'Can you speak up a little?', 'Can you turn your camera on?', 'Can you put the link in the chat?', 'Can you unmute?',
    'Can you repeat that?', 'Can you say that again?', 'Can you go back one slide?',
    'Who just joined?', 'Who dropped?', "Who's on the call?", 'Is Priya joining today?', 'Is everyone ready?', 'Are we waiting for anyone?',
    'Can I share my screen?', 'Can we get started?', 'Shall we take a five minute break?', 'Shall we wait a couple of minutes?',
    'Should we wait for everyone to join?', 'Is my audio okay?', 'Hello, can you hear me?', 'Sorry, what was that?', 'Does that make sense?',
    'Does this make sense to everyone?', 'How is everyone doing today?', 'How was your weekend?', 'Any questions?', 'Anything else?', 'Are we good?',
    'Is that the whole screen?',
  ].filter((s) => s !== 'Is that the whole screen?'); // not housekeeping we list: it is a real question about a screen
  assert.ok(chatter.length >= 45);
  for (const s of chatter) {
    const r = analyzeTurn(s, { names: ['Ade'], mode: 'questions' });
    assert.equal(r.question, false, s);
    assert.equal(r.fire, false, s);
  }
});

test('1: housekeeping spoken to the user by name is for the user', () => {
  for (const s of ['Ade, can you hear me?', 'Sorry Ade, can you repeat that?', 'Ade, can you share your screen?']) {
    const r = analyzeTurn(s, ADE);
    assert.deepEqual([r.question, r.target, r.fire], [true, 'you', true], s);
  }
  // Housekeeping put to someone else, or to nobody, is still ignored.
  assert.equal(analyzeTurn('Priya, can you hear me?', { ...ADE, others: ['Priya'] }).question, false);
  assert.equal(analyzeTurn('Can you hear me?', ADE).question, false);
});

// ------------------------------------------------------------ 2. full names

test('2: the first and the last word of a full name are the user too', () => {
  for (const s of ['Ade, what do you think?', 'Okoye, what do you think?', 'Ade Okoye, what do you think?', 'What do you think, Ade?']) {
    const r = analyzeTurn(s, { names: ['Ade Okoye'], mode: 'mine' });
    assert.deepEqual([...pick(r), r.fire, r.mentioned], ['you', '', 'name', true, true], s);
  }
  assert.equal(analyzeTurn('Ade what do you think?', { names: ['Ade Okoye'], mode: 'mine' }).target, 'you');
  assert.equal(analyzeTurn('Thanks Okoye, that was helpful.', { names: ['Ade Okoye'] }).mentioned, true);
  assert.deepEqual(pick(analyzeTurn('Let us ask Ade about it.', { names: ['Ade Okoye'] })), ['you', '', 'directed']);
});

test('2: a single initial is not a name, and a voice called Ade does not beat the user Ade Okoye', () => {
  const o = { names: ['Ade O.'], mode: 'mine' };
  assert.equal(analyzeTurn('O, what do you think?', o).target, 'room');
  assert.equal(analyzeTurn('Ade, what do you think?', o).target, 'you');
  const tie = analyzeTurn('Ade, what do you think?', { names: ['Ade Okoye'], others: ['Ade', 'Priya'], mode: 'mine' });
  assert.deepEqual([...pick(tie), tie.fire], ['you', '', 'name', true]);
  const second = analyzeTurn('Ade, what do you think? Priya, what about you?', { names: ['Ade Okoye'], others: ['Ade', 'Priya'], mode: 'mine' });
  assert.deepEqual(pick(second), ['you', '', 'name']);
  // Another person with the same first name keeps their own full name.
  const adeS = analyzeTurn('Ade Smith, what do you think?', { names: ['Ade Okoye'], others: ['Ade Smith'], mode: 'mine' });
  assert.deepEqual(pick(adeS), ['other', 'Ade Smith', '']);
});

// ------------------------------------------------------------ 3. non-ASCII names

test('3: names that end in a letter outside ASCII', () => {
  assert.deepEqual(pick(analyzeTurn("Let's ask José.", { names: ['José'], mode: 'mine' })), ['you', '', 'directed']);
  assert.deepEqual(pick(analyzeTurn("Let's hear from Zoë.", { names: ['Ade'], others: ['Zoë'] })), ['other', 'Zoë', '']);
  assert.deepEqual(pick(analyzeTurn("Let's ask Мария: what is the plan?", { names: ['Мария'], mode: 'mine' })), ['you', '', 'directed']);
  assert.deepEqual(pick(analyzeTurn('José, what is the plan?', { names: ['José'] })), ['you', '', 'name']);
  assert.deepEqual(pick(analyzeTurn('What is the plan, Zoë?', { names: ['Ade'], others: ['Zoë'] })), ['other', 'Zoë', '']);
  assert.equal(analyzeTurn('Let us ask Josés team about it.', { names: ['José'] }).mentioned, false, 'a longer word is not the name');
});

test('3: composed and decomposed spellings are the same name', () => {
  const decomposed = 'José';
  const composed = 'José';
  assert.deepEqual(pick(analyzeTurn(`Let's ask ${composed}.`, { names: [decomposed], mode: 'mine' })), ['you', '', 'directed']);
  assert.deepEqual(pick(analyzeTurn(`${decomposed}, what is the plan?`, { names: [composed] })), ['you', '', 'name']);
  assert.deepEqual(pick(analyzeTurn(`${decomposed}, what is the plan?`, { names: ['Ade'], others: [composed] })), ['other', composed, '']);
  assert.equal(analyzeTurn(`What is the plan, ${decomposed}?`, { names: [decomposed] }).target, 'you');
});

test('3: names with characters that mean something in a pattern', () => {
  for (const name of ['A.J.', 'Anne-Marie', "O'Brien", 'C++', 'Dr. (Ade)']) {
    const r = analyzeTurn(`${name}, what is the plan?`, { names: [name] });
    assert.equal(r.target, 'you', name);
  }
  assert.equal(analyzeTurn('Anne Marie, what is the plan?', { names: ['Anne Marie'] }).target, 'you');
  assert.equal(analyzeTurn("O’Brien, what is the plan?", { names: ["O'Brien"] }).target, 'you', 'a curly apostrophe is an apostrophe');
});

// ------------------------------------------------------------ 4. other scripts

test('4: question marks and sentence ends of other scripts', () => {
  const opt = { names: ['Ade'], mode: 'questions' };
  const asks = ['Ade, what do you think？', 'ما رأيك؟', '田中さん、どう思いますか?', '回滚计划是什么?', '回滚计划是什么？', '¿Cuál es el plan?', '¿Cuál es el plan', 'Τι θα κάνουμε τώρα;'];
  for (const s of asks) assert.equal(analyzeTurn(s, opt).question, true, s);
  // The Greek question mark is its own character; the ASCII semicolon is not a question mark.
  assert.equal(analyzeTurn('We deployed the fix; it went fine now', opt).question, false);
  const arabic = analyzeTurn('أحمد، ما رأيك؟', { names: ['أحمد'], mode: 'mine' });
  assert.deepEqual([...pick(arabic), arabic.fire], ['you', '', 'name', true]);
  const fullwidth = analyzeTurn('Ade, what do you think？', ADE);
  assert.deepEqual([...pick(fullwidth), fullwidth.ask], ['you', '', 'name', 'Ade, what do you think？'], 'the quote keeps the original character');
  const ideographic = analyzeTurn('田中、どう思いますか?', { names: ['田中'], mode: 'mine' });
  assert.deepEqual(pick(ideographic), ['you', '', 'name'], 'the ideographic comma is a comma');
  const san = analyzeTurn('田中さん、どう思いますか?', { names: ['田中'], mode: 'mine' });
  assert.deepEqual(pick(san), ['you', '', 'name'], 'the polite -san is part of the name');
});

test('4: short statements in other scripts are not questions', () => {
  const opt = { names: ['Ade'], mode: 'questions' };
  for (const s of ['回滚计划已经完成了。', '好。', '好?', 'Ade, hello.']) assert.equal(analyzeTurn(s, opt).question, false, s);
});

test('4: sentences split on the CJK full stop, and on a question mark glued to CJK text', () => {
  const r = analyzeTurn('我们昨天已经部署了修复。回滚计划是什么？谢谢。', { names: ['Ade'] });
  assert.equal(r.question, true);
  assert.equal(r.ask, '回滚计划是什么？');
  const { splitSentences } = require('../src/main/triggers');
  assert.deepEqual(splitSentences('我们部署了。回滚计划是什么?谢谢！Next one. Last?'), ['我们部署了。', '回滚计划是什么?', '谢谢！', 'Next one.', 'Last?']);
});

// ------------------------------------------------------------ 5. ways of addressing

test('5: no comma after the name', () => {
  for (const s of ['Ade what do you think?', 'Ade -- what\'s the ETA?', "Ade: what's the ETA?", "Ade - what's the ETA?", "Ade — what's the ETA?", "Ade, what's the ETA?", 'Ade can you walk us through the plan?', 'Ade is the build green?', 'Ade any blockers?']) {
    assert.deepEqual(pick(analyzeTurn(s, ADE)), ['you', '', 'name'], s);
  }
  // Said about Ade, not to Ade.
  for (const s of ['Ade is on holiday this week.', 'Ade did the migration last week.']) assert.equal(analyzeTurn(s, ADE).question, false, s);
  assert.equal(analyzeTurn('Ade is the owner of this service, right?', ADE).target === 'you', false, 'a tag question is not a question');
});

test('5: names that are ordinary words need a clear address', () => {
  const will = { names: ['Will'], mode: 'mine' };
  assert.equal(analyzeTurn('Will what we deployed break?', will).target, 'room');
  assert.equal(analyzeTurn('Will what we deployed break?', will).mentioned, false);
  assert.equal(analyzeTurn('Will what we deployed break?', { names: ['Ade'], others: ['Will'] }).target, 'room');
  assert.equal(analyzeTurn('Will the migration finish by Friday?', will).target, 'room');
  // A comma, a colon, a dash, or "can you" still make it an address; a bare question word does not.
  for (const s of ["Will, what's the ETA?", "Will: what's the ETA?", "Will -- what's the ETA?", 'Will can you take the rollout?', 'Will, what do you think?']) {
    assert.equal(analyzeTurn(s, will).target, 'you', s);
  }
  assert.equal(analyzeTurn("Will what's the ETA?", will).target, 'room', 'chosen: an ordinary-word name needs a comma, colon, dash or "can you"');
  // Names that are not ordinary words are an address with a bare question word.
  assert.equal(analyzeTurn("Priya what's the ETA?", { names: ['Ade'], others: ['Priya'] }).target, 'other');
});

test('5: more lead-ins before the name', () => {
  for (const s of [
    'Oh Ade, what do you think?', 'Sorry Ade, can you repeat that?', 'Excuse me Ade, what is the plan?', "Good morning Ade, what's the status?",
    'Yes Ade, what is the plan?', 'Yeah Ade, what is the plan?', 'So, um, Ade, what is the plan?', 'Right Ade, what is the plan?', 'Now Ade, what is the plan?',
    "Thanks Ade, what's next?", 'Hey, Ade, what do you think?',
  ]) {
    assert.deepEqual(pick(analyzeTurn(s, ADE)), ['you', '', 'name'], s);
  }
  assert.equal(analyzeTurn('Now Mark the ticket as done, what is next?', { names: ['Mark'], mode: 'mine' }).target, 'room');
  assert.equal(analyzeTurn('Now Mark, what is next?', { names: ['Mark'], mode: 'mine' }).target, 'you');
});

test('5: "a question for Ade"', () => {
  for (const s of ['Quick question for Ade: what is the ETA?', 'For Ade: what\'s the plan?', 'A question for Ade. What is the ETA?', 'This one is for Ade. What is the ETA?', 'Question for Ade, what is the ETA?']) {
    assert.deepEqual(pick(analyzeTurn(s, ADE)), ['you', '', 'name'], s);
  }
  assert.deepEqual(pick(analyzeTurn('A question for Priya. What is the ETA?', { ...ADE, others: ['Priya'] })), ['other', 'Priya', '']);
  const alone = analyzeTurn('This one is for Ade.', ADE);
  assert.deepEqual([alone.question, alone.mentioned], [false, true]);
});

test('5: several people addressed at once', () => {
  const o = { names: ['Ade'], others: ['Priya', 'Tom'], mode: 'mine' };
  for (const s of ['Ade and Priya, what do you think?', 'Priya, Ade, what do you think?', 'Priya and Ade, thoughts?', 'Priya, Tom and Ade, what do you think?', 'What do you think, Priya and Ade?', 'Ade, Priya: what do you think?']) {
    const r = analyzeTurn(s, o);
    assert.deepEqual([...pick(r), r.fire], ['you', '', 'name', true], s);
  }
  for (const s of ['Priya and Tom, what do you think?', 'Priya, Tom, what do you think?', 'What do you think, Priya and Tom?']) {
    const r = analyzeTurn(s, o);
    assert.deepEqual([...pick(r), r.fire, r.pass], ['other', 'Priya', '', false, true], s);
  }
  assert.deepEqual(pick(analyzeTurn('Tom and Priya, thoughts?', o)), ['other', 'Tom', '']);
  assert.deepEqual(pick(analyzeTurn('Priya and Tom. What do you think?', o)), ['other', 'Priya', '']);
  assert.deepEqual(pick(analyzeTurn('Priya and Ade. What do you think?', o)), ['you', '', 'name']);
});

test('5: if any asking sentence in the turn addresses the user, the user wins', () => {
  const o = { names: ['Ade'], others: ['Priya'], mode: 'mine' };
  const a = analyzeTurn('Ade, what do you think? Priya, what about you?', o);
  assert.deepEqual([...pick(a), a.ask, a.fire], ['you', '', 'name', 'Ade, what do you think?', true]);
  const b = analyzeTurn('Priya, what is the ETA? Ade, what do you think?', o);
  assert.deepEqual([...pick(b), b.ask], ['you', '', 'name', 'Ade, what do you think?']);
  const c = analyzeTurn('Priya, what is the ETA? Tom, what do you think?', { ...o, others: ['Priya', 'Tom'] });
  assert.deepEqual([...pick(c), c.ask], ['other', 'Tom', '', 'Tom, what do you think?'], 'with none for you, the last asking sentence is judged');
  const d = analyzeTurn('Ade. What do you think? Priya, what about you?', o);
  assert.deepEqual([...pick(d), d.ask], ['you', '', 'name', 'What do you think?']);
});

// ------------------------------------------------------------ 6. hand-overs

test('6: a plan or a report that names the user is not a hand-over', () => {
  for (const s of ["I'll ask Ade later.", "I'll check with Ade tomorrow.", "You'll hear from Ade tomorrow.", 'We can loop in Ade next week.', "I'll ask Ade after the call.", "I'll ask Ade offline.", 'I asked Ade yesterday.', "I'm going to check with Ade.", 'I will check with Ade on Friday.', "We'll hear from Ade next time."]) {
    for (const mode of ['mine', 'questions']) {
      const r = analyzeTurn(s, { names: ['Ade'], mode });
      assert.deepEqual([r.question, r.fire, r.pass, r.target, r.why], [false, false, false, '', ''], `${mode}: ${s}`);
    }
    assert.equal(analyzeTurn(s, ADE).mentioned, false, s);
  }
});

test('6: a hand-over that happens now is one', () => {
  for (const s of ['Over to Ade.', "Let's ask Ade.", "Let's hear from Ade.", 'Ade, over to you.', "I'll defer to Ade on that.", 'Maybe ask Ade?', 'Can we check with Ade?', 'We should ask Ade about it.', "Let's ask Ade: what is the plan?", "Let's ask Ade about next week's plan."]) {
    const r = analyzeTurn(s, ADE);
    assert.deepEqual([r.question, r.fire, r.target], [true, true, 'you'], s);
  }
  assert.equal(analyzeTurn('Over to Ade.', ADE).why, 'directed');
  assert.equal(analyzeTurn('Ade, over to you.', ADE).why, 'name');
  assert.equal(analyzeTurn('We should ask Ade about it', ADE).why, 'directed');
});

test('6: a possessive is not an address; a question is judged by the usual rules', () => {
  for (const s of ["I'll ask Ade's team.", "Let's ask Ade's manager.", "Let's ask Ade’s manager."]) {
    const r = analyzeTurn(s, ADE);
    assert.deepEqual([r.question, r.fire], [false, false], s);
  }
  const q = analyzeTurn("Let's ask Ade's team: what is the plan?", { names: ['Ade'], mode: 'questions' });
  assert.deepEqual([...pick(q), q.fire], ['room', '', '', true]);
  assert.equal(analyzeTurn("Let's ask Ade's team: what is the plan?", ADE).fire, false);
  assert.equal(analyzeTurn("Is Ade's team ready?", ADE).target, 'room');
});

test('6: the same reading for hand-overs to other people', () => {
  const o = { names: ['Ade'], others: ['Priya', 'Tom'], mode: 'questions' };
  const a = analyzeTurn("I'll ask Priya later. What's our budget?", o);
  assert.deepEqual([...pick(a), a.fire], ['room', '', '', true]);
  assert.equal(analyzeTurn("You'll hear from Priya tomorrow. What's our budget?", o).target, 'room');
  assert.equal(analyzeTurn("I'm going to check with Tom. What's our budget?", o).target, 'room');
  assert.equal(analyzeTurn("Let's ask Priya's team: what is the plan?", o).target, 'room');
  assert.deepEqual(pick(analyzeTurn("Let's ask Priya: what is the plan?", o)), ['other', 'Priya', '']);
  assert.deepEqual(pick(analyzeTurn('Can you ask Priya what the ETA is?', o)), ['other', 'Priya', '']);
  assert.deepEqual(pick(analyzeTurn("Let's hear from Tom.", o)), ['other', 'Tom', '']);
  assert.deepEqual(pick(analyzeTurn("Let's hear from Tom later. What's our budget?", o)), ['room', '', '']);
});

// ------------------------------------------------------------ speed

test('speed: a long turn with many names stays cheap', () => {
  const names = ['Ade', 'Adebodun', 'Okoye', 'Ade Okoye', 'A.'];
  const others = ['Priya Nair', 'Tom Hale', 'Sam Lee', 'Jo Park', 'Kim Wu', 'Lee Ann', 'Raj Patel', 'Mia Cho', 'Ben Ito', 'Zoe Fox'];
  const base = 'We looked at the deployment pipeline and the rollback plan yesterday, and it went fine overall. Priya mentioned the audit logs again. What do you think about the rotation? ';
  const make = (n) => base.repeat(Math.ceil(n / base.length)).slice(0, n);
  const time = (text, runs) => {
    for (let i = 0; i < 10; i++) analyzeTurn(text, { names, others });
    const t = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) analyzeTurn(text, { names, others });
    return Number(process.hrtime.bigint() - t) / 1e6 / runs;
  };
  assert.ok(time(make(2000), 100) < 2, '2,000 characters in under 2 ms');
  assert.ok(time(make(20000), 20) < 25, '20,000 characters in under 25 ms');
  const wall = 'Ade, Priya, '.repeat(1700);
  assert.ok(time(wall, 3) < 25, 'a wall of names does not blow up');
});

// ------------------------------------------------------------ 7. a name in the middle of a question

test('7: a name set off by commas inside a question is an address', () => {
  for (const s of [
    'What do you think, Ade, about the rollout?',
    'How long will the migration take, Ade, given the freeze?',
    'So, why did the build fail, Ade, on the second run?',
    'Do we have an owner, Ade, for the audit logs?',
    'Where are we, Ade, on the rollout plan?',
    'Can you walk us through it, Ade, before we move on?',
    'What do you think, Ade, about the rollout', // no question mark: the opener makes it a question
    'What do you think, Ade, about the rollout？', // fullwidth question mark
    'What do you think، Ade، about the rollout?', // Arabic commas
    'What do you think、Ade、about the rollout?', // ideographic commas
    'Thoughts, Ade, on the rollout plan?',
    'What do you think, Ade Okoye, about the rollout?',
  ]) {
    const r = analyzeTurn(s, { names: ['Ade', 'Ade Okoye'], mode: 'mine' });
    assert.deepEqual([...pick(r), r.fire], ['you', '', 'name', true], s);
  }
});

test('7: it is the same for ordinary-word names and for other people, with the usual precedence', () => {
  const will = analyzeTurn('What do you think, Will, about the rollout?', { names: ['Will'], mode: 'mine' });
  assert.deepEqual([...pick(will), will.fire], ['you', '', 'name', true]);
  const mark = analyzeTurn('Why did it fail, Mark, this time?', { names: ['Mark'], mode: 'mine' });
  assert.deepEqual(pick(mark), ['you', '', 'name']);
  const other = analyzeTurn('What do you think, Priya, about the rollout?', { names: ['Ade'], others: ['Priya'], mode: 'mine' });
  assert.deepEqual([...pick(other), other.fire, other.pass], ['other', 'Priya', '', false, true]);
  const pair = analyzeTurn('What do you think, Priya and Ade, about the rollout?', { names: ['Ade'], others: ['Priya'], mode: 'mine' });
  assert.deepEqual(pick(pair), ['you', '', 'name']);
  const userWins = analyzeTurn('What do you think, Priya, about the rollout? And Ade, what about the budget?', { names: ['Ade'], others: ['Priya'], mode: 'mine' });
  assert.deepEqual(pick(userWins), ['you', '', 'name']);
  // Nobody known is addressed: the room.
  assert.equal(analyzeTurn('What do you think, Tom, about the rollout?', { names: ['Ade'], mode: 'mine' }).target, 'room');
});

test('7: lists of things or people being talked about are not an address', () => {
  const o = { names: ['Ade'], others: ['Priya', 'Tom'], mode: 'questions' };
  for (const s of [
    'We invited Tom, Ade, and Priya to the review?', // not a question opener, and a list
    'Is it owned by platform, Ade, or security?', // followed by "or"
    'Is it owned by platform, Ade, security?', // a bare word after: a list of three
    'Who invited Tom, Ade, to the review?', // a capitalised item before the comma
    'Is it Ade, Priya, or Tom?',
    'Who should own it, Ade, Priya, or Tom?',
    'Did Tom, Ade, and Sam attend the review?',
    'Which of these is it, platform, Ade, and security?',
    'We talked to the vendor, Ade, about the rollout?', // not a question opener
    'Is it the vendor, Ade, but not Tom?',
    'What do you think of Tom, Ade, or Sam?',
    'Who owns it, Tom, Ade, Priya, or Sam?',
  ]) {
    const r = analyzeTurn(s, o);
    assert.notEqual(r.target, 'you', s);
    assert.equal(r.mentioned, false, s);
  }
  // A list that names only other people is not an address to them either.
  const tom = analyzeTurn('Is it owned by platform, Tom, or security?', o);
  assert.deepEqual(pick(tom), ['room', '', '']);
  // Said as a statement, even with an opener, the commas make no address.
  assert.equal(analyzeTurn('What we decided, Ade, was fine.', ADE).mentioned, false);
});

// ------------------------------------------------------------ 8. a question to the user with no punctuation

test('8: a name and a question opener with no punctuation is a question for that person', () => {
  const o = { names: ['Ade'], others: ['Priya'], mode: 'mine' };
  for (const s of [
    'Ade what do you think',
    'Ade how long will the migration take',
    'Ade can you take that one',
    'Ade, can you take that one',
    'Ade did you see the build',
    'Ade is it done',
    'Ade who owns the audit logs',
    'Hey Ade what is the plan',
    'Oh Ade can you walk us through the plan',
    'Ade where are we on the rollout',
  ]) {
    const r = analyzeTurn(s, o);
    assert.deepEqual([r.question, ...pick(r), r.fire], [true, 'you', '', 'name', true], s);
  }
  const priya = analyzeTurn('Priya what is the ETA', o);
  assert.deepEqual([priya.question, ...pick(priya), priya.fire, priya.pass], [true, 'other', 'Priya', '', false, true]);
  assert.deepEqual(pick(analyzeTurn('Priya can you take that one', o)), ['other', 'Priya', '']);
});

test('8: a name and an auxiliary that is not a question stays a statement', () => {
  const o = { names: ['Ade'], others: ['Priya'], mode: 'questions' };
  for (const s of [
    'Ade is on holiday',
    'Ade will handle that',
    'Ade can do it tomorrow',
    'Ade would know',
    'Ade did the rollout last week',
    'Ade does the reviews on Fridays',
    'Ade has the credentials for the account',
    'Ade should be back on Monday',
    'Ade is the owner of this service',
    'Priya can do it tomorrow',
    'Priya did the rollout last week',
    'Priya is on holiday',
  ]) {
    const r = analyzeTurn(s, o);
    assert.deepEqual([r.question, r.fire, r.target], [false, false, ''], s);
  }
  // Punctuation still decides first: a full stop makes a statement of anything.
  assert.equal(analyzeTurn('Ade what do you think.', ADE).question, false);
  assert.equal(analyzeTurn('Ade can you take that one.', ADE).question, false);
});

test('8: names that are ordinary words are not addressed in the bare position', () => {
  const will = { names: ['Will'], mode: 'mine' };
  const bare = analyzeTurn('will what we deployed break', will);
  assert.deepEqual([bare.target, bare.mentioned, bare.fire], ['', false, false], 'not a question by shape, and not an address');
  assert.equal(analyzeTurn('Will what we deployed break?', will).target, 'room');
  const mark = { names: ['Mark'], mode: 'mine' };
  const roomQuestion = analyzeTurn('mark what is the ETA', mark);
  assert.deepEqual([roomQuestion.question, roomQuestion.target, roomQuestion.mentioned, roomQuestion.fire, roomQuestion.pass], [true, 'room', false, false, true]);
  assert.equal(analyzeTurn('mark what is the ETA', { names: ['Mark'], mode: 'questions' }).fire, true, 'the user still gets it in every mode except mine');
  assert.equal(analyzeTurn('Mark is on holiday', mark).question, false);
  assert.equal(analyzeTurn('Mark did the migration last week', mark).question, false);
  // A comma or "can you" still makes an address, as before.
  assert.equal(analyzeTurn('Mark, what is the ETA', mark).target, 'you');
  assert.equal(analyzeTurn('Mark can you take that one', mark).target, 'you');
});

test('7 and 8: the new rules stay cheap', () => {
  const names = ['Ade', 'Ade Okoye'];
  const others = ['Priya Nair', 'Tom Hale', 'Sam Lee'];
  const base = 'What do you think, Ade, about the rotation? Who owns it, Priya, Tom, or Sam? Ade what do you think about it Priya can you take that one and Tom did the rollout ';
  const text = base.repeat(Math.ceil(2000 / base.length)).slice(0, 2000);
  const big = base.repeat(Math.ceil(20000 / base.length)).slice(0, 20000);
  const time = (t, runs) => {
    for (let i = 0; i < 10; i++) analyzeTurn(t, { names, others });
    const start = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) analyzeTurn(t, { names, others });
    return Number(process.hrtime.bigint() - start) / 1e6 / runs;
  };
  assert.ok(time(text, 100) < 2, '2,000 characters in under 2 ms');
  assert.ok(time(big, 20) < 25, '20,000 characters in under 25 ms');
  assert.ok(time('Ade what do you think about it '.repeat(700), 3) < 25, 'one long unpunctuated sentence');
});
