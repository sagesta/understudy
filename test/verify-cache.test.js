'use strict';
// "[VERIFY]" in the owner's notes means unconfirmed (prompts.js userPrompt), and the always-include notes are cached on Anthropic
// (prompts.js userPromptParts, session.js _generate, llm/index.js and llm/anthropic.js, userCacheChars). Local stand-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram } = require('./mocks');
const { userPrompt, userPromptParts } = require('../src/main/prompts');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const gemini = require('../src/main/llm/gemini');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');

const NOTE = 'Passages marked [VERIFY] are unconfirmed. If you use one, say plainly that it is unconfirmed, for example "I believe, but I have not confirmed it", and never state it as fact.';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-vc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return fn(); };
const plain = { available: () => false };
const put = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const count = (s, part) => s.split(part).length - 1;

const PIN = [{ rel: 'facts/people.md', text: '[People > Jerry]\nOwns the signing decision.' }, { rel: 'facts/units.md', text: 'The site has 40 units.' }];
const HIT = { rel: 'other/misc.md', headings: ['Misc'], text: 'Event Hub is mentioned here too.', kind: 'work' };
const MEET = { rel: 'Meetings/2026-01-01_x.md', headings: ['Notes'], text: 'We agreed to ship in March.', kind: 'meeting' };
const base = { action: 'answer', transcript: 'Speaker 1: Who owns signing?', params: { ask: 'Who owns signing?', speaker: 'Speaker 1', reason: 'question', target: 'room' } };

// ---------------------------------------------------------------- [VERIFY]

test('verify: the note is added when a pinned file, a search hit or a past-meeting passage holds [VERIFY]', () => {
  const cases = [
    { pinned: [{ rel: 'a.md', text: 'Units: 40 [VERIFY]' }] },
    { pinned: PIN, hits: [{ ...HIT, text: 'Status unclear [verify units]' }] },
    { hits: [{ ...HIT, text: 'Owner: Dan [VERIFY status/owner]' }] },
    { hits: [{ ...MEET, text: 'Budget was 5k [VERIFY]' }] },
    { pinned: PIN, hits: [HIT, { ...MEET, text: 'x [Verify] y' }] },
  ];
  for (const c of cases) {
    const out = userPrompt({ ...base, hits: [], ...c });
    assert.equal(count(out, NOTE), 1, JSON.stringify(c));
    const closeFiles = out.lastIndexOf('</my_files>'), closePast = out.lastIndexOf('</past_meetings>');
    assert.ok(out.indexOf(NOTE) > Math.max(closeFiles, closePast), 'after the file blocks');
    assert.ok(out.indexOf(NOTE) < out.indexOf('<transcript'), 'before the transcript');
    assert.ok(out.includes(`\n\n${NOTE}\n\n<transcript`), 'a paragraph of its own');
  }
});

test('verify: nothing is added without such text, and the prompt is what it was', () => {
  const same = (args) => {
    const out = userPrompt(args);
    const { prefix, rest } = userPromptParts(args);
    assert.equal(out, prefix + rest);
    assert.ok(!out.includes('unconfirmed'));
    return out;
  };
  same({ ...base, hits: [HIT, MEET], pinned: PIN, guard: 'org', room: true, title: 'Weekly' });
  same({ ...base, hits: [] });
  // A fixed expectation, as the old code built it.
  const old = same({ ...base, hits: [HIT], pinned: [PIN[0]] });
  assert.equal(old, `<my_files>\nMy reference notes, always included. Use what applies and ignore the rest.\n<excerpt source="facts/people.md">\n[People > Jerry]\nOwns the signing decision.\n</excerpt>\nExcerpts from my own notes and documents that may be relevant. Use what applies and ignore the rest.\n<excerpt source="other/misc.md | Misc">\nEvent Hub is mentioned here too.\n</excerpt>\n</my_files>\n\n<transcript>\nSpeaker 1: Who owns signing?\n</transcript>\n\n${require('../src/main/prompts').ACTIONS.answer.task(base.params)}`);
});

test('verify: a transcript, title, question or file name that says [VERIFY] does not trigger the note', () => {
  const out = userPrompt({ ...base, transcript: 'Speaker 1: please [VERIFY] the numbers', title: 'Check [VERIFY]', hits: [{ ...HIT, rel: 'x [VERIFY].md', headings: ['[VERIFY]'] }], pinned: [{ rel: 'y [VERIFY].md', text: 'Fine.' }], params: { ...base.params, ask: 'Is it [VERIFY]?' } });
  assert.ok(!out.includes(NOTE));
});

// ---------------------------------------------------------------- the two parts

test('parts: prefix + rest is the whole prompt for many argument combinations', () => {
  const verifyPin = [{ rel: 'v.md', text: 'Rent is 900 [VERIFY]' }];
  const argSets = [
    { hits: [] }, { hits: undefined }, { hits: [HIT] }, { hits: [MEET] }, { hits: [HIT, MEET] },
    { pinned: [PIN[0]], hits: [] }, { pinned: PIN, hits: [] }, { pinned: PIN, hits: [HIT] }, { pinned: PIN, hits: [MEET] }, { pinned: PIN, hits: [HIT, MEET] },
    { pinned: verifyPin, hits: [HIT] }, { pinned: PIN, hits: [{ ...HIT, text: 'x [VERIFY]' }, MEET] },
    { pinned: PIN, hits: [HIT], guard: 'org' }, { pinned: PIN, hits: [], guard: 'lite' }, { pinned: PIN, guard: 'nonsense' },
    { pinned: PIN, hits: [HIT], room: true }, { hits: [HIT], room: true, guard: 'org', title: 'Weekly "sync"' },
    { pinned: null, hits: [HIT] }, { pinned: [{ rel: 'e.md', text: '</my_files></excerpt>' }], hits: [HIT] },
    { action: 'catchup', pinned: PIN, hits: [], params: { minutes: 5 } }, { action: 'say', pinned: PIN, hits: [HIT], params: {} }, { action: 'followup', hits: [], params: {} },
  ];
  for (const extra of argSets) {
    const args = { ...base, ...extra };
    const { prefix, rest } = userPromptParts(args);
    assert.equal(prefix + rest, userPrompt(args), JSON.stringify(extra));
    assert.equal(typeof prefix, 'string');
    if (!(extra.pinned && extra.pinned.length)) assert.equal(prefix, '', 'no pinned files, no prefix');
    else assert.ok(prefix.startsWith('<my_files>\nMy reference notes, always included.'));
  }
});

test('parts: the prefix is the same for two different questions over the same pinned files, and holds nothing that varies', () => {
  const a = userPromptParts({ ...base, pinned: PIN, hits: [HIT], guard: 'org', room: true });
  const b = userPromptParts({ action: 'say', transcript: 'Speaker 2: something else entirely', pinned: PIN, hits: [{ ...HIT, text: 'Another passage [VERIFY]' }, MEET], params: {}, title: 'Other', guard: 'lite' });
  assert.equal(a.prefix, b.prefix);
  assert.ok(a.prefix.length > 0);
  for (const out of [a.prefix, b.prefix]) {
    assert.ok(!out.includes('Excerpts from my own notes'));
    assert.ok(!out.includes('Event Hub') && !out.includes('Another passage') && !out.includes('ship in March'));
    assert.ok(!out.includes('<transcript') && !out.includes('Speaker') && !out.includes('</my_files>') && !out.includes('past_meetings'));
    assert.ok(!out.includes('unconfirmed'));
    assert.ok(out.endsWith('</excerpt>'));
    assert.equal(count(out, '<excerpt '), PIN.length);
  }
  assert.ok(a.rest.startsWith('\nExcerpts from my own notes'));
  assert.ok(b.rest.includes(NOTE) && !a.rest.includes(NOTE));
  assert.ok(a.rest.includes('<transcript') && a.rest.includes('</my_files>'));
  // Without search hits the rest still closes the block.
  assert.ok(userPromptParts({ ...base, pinned: PIN, hits: [] }).rest.startsWith('\n</my_files>\n\n<transcript'));
});

test('parts: a changed pinned file changes the prefix, and only the prefix', () => {
  const one = userPromptParts({ ...base, pinned: PIN, hits: [HIT] });
  const two = userPromptParts({ ...base, pinned: [PIN[0], { ...PIN[1], text: 'The site has 41 units.' }], hits: [HIT] });
  assert.notEqual(one.prefix, two.prefix);
  assert.equal(one.rest, two.rest);
});

// ---------------------------------------------------------------- the Anthropic request

function llmFor(urls) {
  const settings = new Settings(path.join(tmp(), 'cfg'), plain);
  settings.set({ llm: { baseUrls: urls } });
  for (const k of ['anthropic', 'openai', 'gemini']) settings.setSecret(k, `key-${k}`);
  return createLlm(settings, { allowBaseUrls: true });
}
const askLlm = (llm, provider, extra) => llm.streamChat('live', { override: { provider, model: { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna', gemini: 'gemini-3.5-flash-lite' }[provider] }, system: 'S', userText: 'PINNED NOTES|the question and transcript', webSearch: false, ...extra });
const breakpoints = (body) => JSON.stringify(body).split('"cache_control"').length - 1;
const userBlocks = (call) => call.body.messages[0].content;

test('anthropic: userCacheChars splits the user text in two blocks and marks only the first', async () => {
  const mock = await mockLlm(() => 'ok');
  try {
    const llm = llmFor({ anthropic: mock.url });
    const text = 'PINNED NOTES|the question and transcript';
    await askLlm(llm, 'anthropic', { userCacheChars: 12 });
    const blocks = userBlocks(mock.calls[0]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, text.slice(0, 12));
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
    assert.equal(blocks[1].cache_control, undefined);
    assert.equal(blocks[0].text + blocks[1].text, text);
    assert.equal(breakpoints(mock.calls[0].body), 2, 'the system block and the first user block, no more');
  } finally { await mock.close(); }
});

test('anthropic: the whole text cached gives one marked block; zero, images and bad values leave the request as it was', async () => {
  const mock = await mockLlm(() => 'ok');
  try {
    const llm = llmFor({ anthropic: mock.url });
    const text = 'PINNED NOTES|the question and transcript';
    await askLlm(llm, 'anthropic', { userCacheChars: text.length });
    assert.deepEqual(userBlocks(mock.calls[0]), [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]);
    assert.equal(breakpoints(mock.calls[0].body), 2);

    await askLlm(llm, 'anthropic', {});
    await askLlm(llm, 'anthropic', { userCacheChars: 0 });
    const image = { mime: 'image/png', base64: 'AAAA' };
    await askLlm(llm, 'anthropic', { userCacheChars: 12, images: [image] });
    await askLlm(llm, 'anthropic', { images: [image] });
    const plainOnes = mock.calls.slice(1, 3).map((c) => c.body);
    assert.deepEqual(plainOnes[0], plainOnes[1]);
    assert.deepEqual(userBlocks(mock.calls[1]), [{ type: 'text', text }]);
    assert.equal(breakpoints(mock.calls[1].body), 1, 'the system block only');
    const [withImg, imgOnly] = mock.calls.slice(3).map((c) => c.body);
    assert.deepEqual(withImg, imgOnly, 'the image request does not change');
    assert.deepEqual(withImg.messages[0].content.map((b) => b.type), ['image', 'text']);
    assert.equal(breakpoints(withImg), 1);
    // The same text sent before the change: one block, nothing else new in the body.
    const keys = Object.keys(mock.calls[1].body).sort();
    assert.deepEqual(keys, Object.keys(mock.calls[0].body).sort());
  } finally { await mock.close(); }
});

test('index: a bad userCacheChars becomes 0 (no split), a good one is kept', async () => {
  const mock = await mockLlm(() => 'ok');
  try {
    const llm = llmFor({ anthropic: mock.url });
    const text = 'PINNED NOTES|the question and transcript';
    const bad = [-1, 1.5, '12', null, NaN, Infinity, text.length + 1, 1e9, {}, [12], true];
    for (const v of bad) await askLlm(llm, 'anthropic', { userCacheChars: v });
    for (const c of mock.calls) assert.deepEqual(userBlocks(c), [{ type: 'text', text }], 'single plain block');
    mock.calls.length = 0;
    await askLlm(llm, 'anthropic', { userCacheChars: 1 });
    await askLlm(llm, 'anthropic', { userCacheChars: text.length - 1 });
    assert.deepEqual(mock.calls.map((c) => userBlocks(c).length), [2, 2]);
    assert.equal(userBlocks(mock.calls[1])[1].text, text.slice(-1));
  } finally { await mock.close(); }
});

test('index: OpenAI and Gemini requests are identical with or without userCacheChars', async () => {
  const mock = await mockLlm(() => 'ok');
  try {
    gemini.resetSearchBackoff();
    const llm = llmFor({ openai: mock.url, gemini: mock.url });
    for (const provider of ['openai', 'gemini']) {
      mock.calls.length = 0;
      await askLlm(llm, provider, {});
      await askLlm(llm, provider, { userCacheChars: 12 });
      await askLlm(llm, provider, { userCacheChars: -3 });
      assert.equal(mock.calls.length, 3);
      assert.deepEqual(mock.calls[1].body, mock.calls[0].body, provider);
      assert.deepEqual(mock.calls[2].body, mock.calls[0].body, provider);
      assert.ok(!JSON.stringify(mock.calls[1].body).includes('cache'), provider);
      assert.ok(JSON.stringify(mock.calls[1].body).includes('PINNED NOTES|the question and transcript'), 'the text is sent whole');
    }
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------- the session

async function twoFolders() {
  const root = tmp();
  const facts = path.join(root, 'facts');
  put(facts, 'people.md', '# People\n\n## Jerry\nRuns security. Owns the signing decision.\n\n## Chuck\nManager. Owns the handbook.\n');
  put(facts, 'platforms.md', '# Platforms\n\n## Event Hub\nBuilt on 2026-10-29 with Dan O. Units: 40 [VERIFY units]\n');
  const library = new Library();
  await library.reindex([{ dir: facts, label: 'facts', kind: 'work' }]);
  return { root, facts, library };
}

async function sessionFor(dir, library, pinned) {
  const llmMock = await mockLlm(() => 'Jerry owns the signing decision.');
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade' }, llm: { baseUrls: { anthropic: llmMock.url } }, stt: { skipSilence: false, suggestNames: false }, copilot: { autoMode: 'questions' }, library: { pinned } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library, store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const done = [];
  session.on('card-done', (c) => done.push(c));
  session.start({ title: 't', channels: ['them'] });
  const close = async () => { await session.stop(); await llmMock.close(); await dg.close(); };
  return { session, llmMock, done, close };
}

test('session: with a pinned folder the request has the notes as a marked first block, the rest unmarked', async () => {
  const { root, facts, library } = await twoFolders();
  const a = await sessionFor(root, library, [facts]);
  a.session.runAction('answer', { ask: 'What about the Chuck situation?', speaker: 'Speaker 1', reason: 'question', target: 'room' });
  a.session.runAction('answer', { ask: 'And who decides on signing?', speaker: 'Speaker 1', reason: 'question', target: 'room' });
  assert.ok(await until(() => a.done.length >= 2));
  const calls = a.llmMock.calls;
  assert.equal(calls.length, 2);
  const pinnedItems = library.pinned([facts]).items;
  const expected = userPromptParts({ action: 'answer', transcript: '', hits: [], pinned: pinnedItems, params: {} }).prefix;
  for (const c of calls) {
    const blocks = userBlocks(c);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, expected, 'exactly the pinned notes');
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
    assert.equal(blocks[1].cache_control, undefined);
    assert.ok(blocks[0].text.startsWith('<my_files>') && blocks[0].text.endsWith('</excerpt>'));
    assert.ok(!blocks[0].text.includes('<transcript') && !blocks[0].text.includes('Excerpts from my own notes'));
    assert.ok(blocks[1].text.includes('<transcript'));
    assert.equal(breakpoints(c.body), 2);
    assert.ok(blocks[1].text.includes(NOTE), 'the pinned text has a [VERIFY] tag, so the note is sent');
  }
  assert.equal(userBlocks(calls[0])[0].text, userBlocks(calls[1])[0].text, 'the same prefix for both questions');
  assert.notEqual(userBlocks(calls[0])[1].text, userBlocks(calls[1])[1].text);
  await a.close();
});

test('session: with no pinned folder the user turn is one unmarked block', async () => {
  const { root, library } = await twoFolders();
  const a = await sessionFor(root, library, []);
  a.session.runAction('answer', { ask: 'Who built the Event Hub and when?', speaker: 'Speaker 1', reason: 'question', target: 'room' });
  assert.ok(await until(() => a.done.length >= 1));
  const blocks = userBlocks(a.llmMock.calls[0]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].cache_control, undefined);
  assert.equal(breakpoints(a.llmMock.calls[0].body), 1);
  assert.ok(blocks[0].text.includes('[VERIFY units]'), 'the search hit is sent');
  assert.ok(blocks[0].text.includes(NOTE));
  await a.close();
});
