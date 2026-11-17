'use strict';
// Fixes from the live test against a real key (stand-in servers only, never the network):
// 1. every AI error reads as a plain sentence, the provider's own words only in `detail`;
// 2. a 429 on a request with web search starts the no-search window only if dropping the tool fixed it;
// 3. the "Web search is not available" note has two wordings and is shown once per meeting;
// 4. the file chip on a card names only files that really matched;
// 5. the key check tries the model the person chose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram } = require('./mocks');
const gemini = require('../src/main/llm/gemini');
const { Settings } = require('../src/main/settings');
const { createLlm, PROVIDERS, LlmError } = require('../src/main/llm');
const { explainFailure } = require('../src/main/llm/speedtest');
const { isTooLarge } = require('../src/main/meetings/notes');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const K = require('../src/main/keycheck');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-livefix-'));
const plain = { available: () => false };
const rejection = async (p) => { try { await p; } catch (e) { return e; } return null; };
const MODELS = { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna', gemini: 'gemini-3.5-flash-lite' };
const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

function llmFor(urls) {
  const settings = new Settings(tmp(), plain);
  for (const k of Object.keys(NAMES)) settings.setSecret(k, `key-${k}`);
  settings.set({ llm: { baseUrls: urls } });
  return createLlm(settings, { allowBaseUrls: true });
}
const ask = (llm, provider, extra = {}) => llm.streamChat('live', { override: { provider, model: extra.model || MODELS[provider] }, system: 's', userText: 'u', ...extra });

test.beforeEach(() => gemini.resetSearchBackoff());

// ---------------------------------------------------------------- 1. plain sentences

const SENTENCE = {
  auth: (n) => `${n} rejected the API key (or the key lacks access to this model).`,
  not_found: (n) => `${n} does not have that model for your key. Choose another model in Settings > Answers.`,
  rate_limit: (n) => `${n}: rate limit or credit reached. Try again in a moment.`,
  too_large: (n) => `${n} says the request is too large for this model.`,
  bad_request: (n) => `${n} could not use that request. Try another model.`,
  server: (n) => `${n} is having trouble. Try again.`,
  error: (n) => `${n} did not answer. Try again.`,
};
// What the live test saw, and the other ways the three providers word the same failures.
const CASES = [
  ['a missing model (404)', 404, 'models/gemini-9-does-not-exist is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.', 'not_found', 'not_found'],
  ['a rate limit (429)', 429, 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. generate_content_free_tier_requests, limit: 0', 'rate_limit', 'rate_limit'],
  ['a rejected key (401)', 401, 'invalid x-api-key', 'auth', 'auth'],
  ['a key without access (403)', 403, 'Permission denied for this key', 'auth', 'auth'],
  ['a bad key sent as a 400 (Gemini does this)', 400, 'API key not valid. Please pass a valid API key.', 'auth', 'auth'],
  ['no credit, sent as a 400 (Anthropic does this)', 400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', 'bad_request', 'rate_limit'],
  ['a model that does not exist, sent as a 400', 400, 'The model `gpt-9` does not exist or you do not have access to it.', 'bad_request', 'not_found'],
  ['a request that is too large (400)', 400, 'prompt is too long: 210000 tokens > 200000 maximum', 'bad_request', 'too_large'],
  ['any other 400', 400, 'Something is wrong with the request body.', 'bad_request', 'bad_request'],
  ['an outage (503)', 503, 'The service is overloaded, try later.', 'server', 'server'],
  ['something unknown (418)', 418, 'I am a teapot', 'error', 'error'],
];

test('each error class reads as one plain sentence, for all three providers, with the raw text only in detail', async () => {
  for (const [what, status, text, , key] of CASES) {
    const mock = await mockLlm(() => ({ status, error: text }));
    try {
      const llm = llmFor({ anthropic: mock.url, openai: mock.url, gemini: mock.url });
      for (const provider of Object.keys(NAMES)) {
        const name = NAMES[provider];
        const e = await rejection(ask(llm, provider));
        assert.ok(e instanceof LlmError, `${what} / ${provider}`);
        assert.equal(e.message, SENTENCE[key](name), `${what} / ${provider}`);
        assert.equal(e.status, status, `${what} / ${provider}`);
        assert.doesNotMatch(e.message, /returned|\{|"type"|http|quota|ListModels|aistudio/i, `${what} / ${provider}: no raw text in the message`);
        assert.ok(e.message.length < 120, e.message);
        assert.ok(e.detail.includes(text.slice(0, 40)), `${what} / ${provider}: the provider's words are kept in detail (${e.detail})`);
        // The decision the rest of the app makes from it.
        const expectedKind = { not_found: 'not_found', rate_limit: 'rate_limit', auth: 'auth', too_large: 'bad_request', bad_request: 'bad_request', server: 'server', error: 'error' }[key];
        assert.equal(e.kind, expectedKind, `${what} / ${provider}`);
      }
    } finally { await mock.close(); }
  }
});

test('detail is capped at 300 characters however long the provider\'s text is', async () => {
  const mock = await mockLlm(() => ({ status: 404, error: `not found ${'y'.repeat(2000)}` }));
  try {
    const llm = llmFor({ anthropic: mock.url, openai: mock.url, gemini: mock.url });
    for (const provider of Object.keys(NAMES)) {
      const e = await rejection(ask(llm, provider));
      assert.ok(e.detail.length > 100 && e.detail.length <= 300, `${provider} ${e.detail.length}`);
      assert.equal(e.message, SENTENCE.not_found(NAMES[provider]));
    }
  } finally { await mock.close(); }
});

test('a request that is too large still tells the notes code to write in stages', async () => {
  const mock = await mockLlm(() => ({ status: 400, error: 'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.' }));
  try {
    const llm = llmFor({ anthropic: mock.url, openai: mock.url, gemini: mock.url });
    for (const provider of Object.keys(NAMES)) {
      const e = await rejection(ask(llm, provider));
      assert.equal(e.message, SENTENCE.too_large(NAMES[provider]));
      assert.equal(isTooLarge(e), true, provider);
    }
  } finally { await mock.close(); }
  // ...and a plain rate limit or a missing model is not mistaken for it
  for (const [status, text] of [[429, 'Request too large for tokens per minute (TPM)'], [404, 'model not found']]) {
    const m = await mockLlm(() => ({ status, error: text }));
    try { assert.equal(isTooLarge(await rejection(ask(llmFor({ openai: m.url }), 'openai'))), false, String(status)); } finally { await m.close(); }
  }
});

test('the speed test and the key check still explain every one of them from kind and status', async () => {
  const REASON = { not_found: 'Not available with your key.', rate_limit: 'Rate limit or credit reached.', auth: 'Your key was not accepted.', server: null, bad_request: 'Did not work.', too_large: 'Did not work.', error: 'Did not work.' };
  for (const [what, status, text, , key] of CASES) {
    const mock = await mockLlm(() => ({ status, error: text }));
    try {
      const e = await rejection(ask(llmFor({ openai: mock.url }), 'openai'));
      const want = key === 'server' ? 'OpenAI is having trouble.' : REASON[key];
      const got = explainFailure(e);
      assert.equal(got.error, want, what);
      assert.ok(got.detail.includes(text.slice(0, 40)), `${what}: the provider's words are the detail`);
    } finally { await mock.close(); }
  }
  // the key check shows only fixed sentences
  const bad = await mockLlm(() => ({ status: 401, error: 'invalid x-api-key' }));
  try {
    const llm = llmFor({ anthropic: bad.url });
    const check = K.createKeyChecker({ hasKey: () => true, meetingActive: () => false, testLlm: (name, signal, model) => ask(llm, name, { signal, model: model || MODELS[name] }), testStt: async () => {} });
    assert.deepEqual(await check('anthropic'), { ok: false, message: 'Anthropic rejected it.' });
  } finally { await bad.close(); }
});

test('an error in the middle of a stream is a plain sentence too, for each provider', async () => {
  const sseServer = (records) => new Promise((resolve) => {
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(records(req.url)); }); });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
  });
  const stream = await sseServer((url) => {
    if (url.includes(':streamGenerateContent')) return `data: ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, check billing' } })}\n\n`;
    if (url.includes('/responses')) return `data: ${JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-6-luna in organization org-1' })}\n\n`;
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;
  });
  try {
    const llm = llmFor({ anthropic: stream.url, openai: stream.url, gemini: stream.url });
    const g = await rejection(ask(llm, 'gemini'));
    assert.equal(g.message, SENTENCE.rate_limit('Gemini'));
    assert.match(g.detail, /current quota/);
    const o = await rejection(ask(llm, 'openai'));
    assert.equal(o.message, SENTENCE.rate_limit('OpenAI'));
    assert.match(o.detail, /Rate limit reached for gpt-6-luna/);
    const a = await rejection(ask(llm, 'anthropic'));
    assert.equal(a.message, SENTENCE.server('Anthropic'));
    assert.equal(a.kind, 'server');
  } finally { await stream.close(); }
});

test('a provider that cannot be reached says so in a sentence, with the system\'s words in detail', async () => {
  const dead = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const url = `http://127.0.0.1:${dead}`;
  const llm = llmFor({ anthropic: url, openai: url, gemini: url });
  for (const provider of Object.keys(NAMES)) {
    const e = await rejection(ask(llm, provider));
    assert.equal(e.kind, 'network', provider);
    assert.equal(e.message, `Could not reach ${NAMES[provider]}. Check your connection and try again.`);
    assert.ok(e.detail.length > 0, provider);
    assert.equal(explainFailure(e).error, 'Could not connect.');
  }
});

test('the model list and the picker show the same sentence (listModels uses the same errors)', async () => {
  const mock = await mockLlm(() => ({ status: 404, error: 'models/none is not found for API version v1beta' }));
  try {
    const llm = llmFor({ gemini: mock.url, openai: mock.url });
    // mockLlm answers 404 to a models list for any provider
    for (const provider of ['gemini', 'openai']) {
      const e = await rejection(llm.listModels(provider));
      assert.ok(e, provider);
      assert.equal(e.message, SENTENCE.not_found(NAMES[provider]));
    }
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------- 2. a 429 is not always the search tool

const hasTool = (call) => Boolean(call.body.tools);
const geminiAsk = (mock, extra = {}) => gemini.streamChat({ apiKey: 'k', baseUrl: `${mock.url}/v1beta`, model: 'gemini-3.5-flash-lite', system: 'S', userText: 'Q', webSearch: true, fast: true, ...extra });

test('a model that answers 429 even without search: one retry, the plain sentence, no window, no third request', async () => {
  const mock = await mockLlm(() => ({ status: 429, error: 'You exceeded your current quota, generate_content_free_tier_requests, limit: 0' }));
  try {
    const e = await rejection(geminiAsk(mock));
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.message, SENTENCE.rate_limit('Gemini'));
    assert.match(e.detail, /free_tier_requests/);
    assert.equal(mock.calls.length, 2, 'the tool, then once without it, and no more');
    assert.ok(hasTool(mock.calls[0]) && !hasTool(mock.calls[1]));
    // no window was started: the next request declares the tool again
    const again = await rejection(geminiAsk(mock));
    assert.ok(again);
    assert.equal(mock.calls.length, 4);
    assert.ok(hasTool(mock.calls[2]), 'search is still tried: it was not the cause');
  } finally { await mock.close(); }
});

test('the window starts only when the retry without the tool worked', async () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  const mock = await mockLlm((body) => (body.tools ? { status: 429, error: 'quota' } : 'Fine.'));
  try {
    await geminiAsk(mock);
    await geminiAsk(mock); // inside the window: straight to no tool
    assert.deepEqual(mock.calls.map(hasTool), [true, false, false]);
    clock += gemini.SEARCH_BACKOFF_MS + 1000;
    await geminiAsk(mock);
    assert.ok(hasTool(mock.calls[3]), 'tried again when the window is over');
  } finally { Date.now = realNow; await mock.close(); }
});

// ---------------------------------------------------------------- 3. the search note

test('the note names the quota for a 429 and the window, and the model for a 400', async () => {
  const quota = await mockLlm((body) => (body.tools ? { status: 429, error: 'quota' } : 'Fine.'));
  try {
    const first = await geminiAsk(quota);
    assert.deepEqual(first.notes, ['Web search is not available right now.']);
    const inWindow = await geminiAsk(quota);
    assert.deepEqual(inWindow.notes, ['Web search is not available right now.']);
  } finally { await quota.close(); }
  gemini.resetSearchBackoff(); // the window above would otherwise be what leaves the tool out
  const model = await mockLlm((body) => (body.tools ? { status: 400, error: 'Unsupported tool: google_search' } : 'Fine.'));
  try {
    const r = await geminiAsk(model, { model: 'gemini-live-fixes-no-tool' });
    assert.deepEqual(r.notes, ['Web search is not available with this model.']);
  } finally { await model.close(); }
});

// A meeting with a stand-in AI that returns the notes it is told to, and a library it can be given.
async function meetingWith({ notesFor, library = { chunkCount: 0, search: () => [] } }) {
  const dir = tmp();
  const dg = await mockDeepgram([]);
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade' }, stt: { skipSilence: false, suggestNames: false }, copilot: { autoMode: 'manual' } });
  settings.setSecret('deepgram', 'dk');
  const calls = [];
  const llm = { describe: () => 'fake', async streamChat(role, opts) {
    calls.push(opts);
    if (opts.onText) opts.onText('Here is what to say.');
    return { text: 'Here is what to say.', usage: { input: 10, output: 5, cached: 0 }, sources: [], model: 'fake', truncated: false, notes: notesFor(calls.length), provider: 'anthropic', cost: 0 };
  } };
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library, store, llm, getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const done = [];
  session.on('card-done', (c) => done.push(c));
  session.start({ title: 't', channels: ['them'] });
  const run = async (action, params) => { const n = done.length; session.runAction(action, params); for (let i = 0; i < 400 && done.length === n; i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(done.length > n, 'the card finished'); return done.at(-1); };
  return { session, calls, run, close: async () => { await session.stop(); await dg.close(); } };
}

test('a search note is shown on the first card that carries it, once per meeting, and again in the next meeting', async () => {
  const NOW = 'Web search is not available right now.';
  const MODEL = 'Web search is not available with this model.';
  const CUT = 'The connection closed early, so this answer may be cut short.';
  const m = await meetingWith({ notesFor: (n) => (n === 4 ? [MODEL, CUT] : n === 5 ? [CUT] : [NOW]) });
  try {
    const c1 = await m.run('ask', { typed: 'First question' });
    assert.equal(c1.note, NOW, 'the first card says it');
    const c2 = await m.run('ask', { typed: 'Second question' });
    const c3 = await m.run('ask', { typed: 'Third question' });
    assert.equal(c2.note, undefined, 'not repeated');
    assert.equal(c3.note, undefined);
    // the other wording is a different note: shown once as well; other notes are never held back
    const c4 = await m.run('ask', { typed: 'Fourth question' });
    assert.equal(c4.note, `${MODEL} ${CUT}`);
    const c5 = await m.run('ask', { typed: 'Fifth question' });
    assert.equal(c5.note, CUT, 'a note about one answer is shown every time');
    // a new meeting starts again
    await m.session.stop();
    m.session.start({ title: 't2', channels: ['them'] });
    const c6 = await m.run('ask', { typed: 'Sixth question' });
    assert.equal(c6.note, NOW);
  } finally { await m.close(); }
});

// ---------------------------------------------------------------- 4. the file chip

const put = (dir, rel, text) => fs.writeFileSync(path.join(dir, rel), text);
async function libraryOf(files) {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  const lib = new Library();
  await lib.reindex([{ dir, label: 'work', kind: 'work' }]);
  return lib;
}
const FILES = {
  'deploy-token-rotation.md': '# Deploy token rotation runbook\n\nTo rotate the deploy token: revoke the old token in Vault, create a new token, update the pipeline variable and confirm the next deploy picks it up. Rotate the deploy token every thirty days.\n',
  'team-offsite.md': '# Team offsite\n\nThe offsite is in March. Book the venue and the train. The pipeline was slow on Tuesday and nobody minded.\n',
  'wiki-notes.md': '# Wiki notes\n\nThe wiki migration happened last year and nobody has touched it since.\n',
  'coffee.md': '# Coffee\n\nThe coffee machine on the second floor is broken again.\n',
};

test('library hits say how many distinct query terms the passage matched', async () => {
  const lib = await libraryOf(FILES);
  const hits = lib.search('how do we rotate the deploy token');
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(typeof h.matched, 'number');
  assert.equal(hits[0].rel, path.join('work', 'deploy-token-rotation.md'));
  assert.ok(hits[0].matched >= 3, `rotate, deploy, token: ${hits[0].matched}`);
  const loose = lib.search('when will the database migration finish this quarter').find((h) => h.rel.endsWith('wiki-notes.md'));
  assert.equal(loose.matched, 1, 'only "migration"');
  // what the knowledge page and the prompt read is unchanged
  assert.ok(hits[0].text && hits[0].headings && hits[0].kind && typeof hits[0].score === 'number');
});

test('a card lists a file only when a passage of it matched at least two of the question\'s terms and scored well', async () => {
  const lib = await libraryOf(FILES);
  const m = await meetingWith({ notesFor: () => [], library: lib });
  try {
    const runbook = await m.run('ask', { typed: 'How do we rotate the deploy token in the pipeline?' });
    assert.deepEqual(runbook.files, [path.join('work', 'deploy-token-rotation.md')]);
    // The model still gets every hit, as before: the chip is stricter than the prompt.
    const sent = m.calls[0].userText;
    assert.ok(sent.includes('rotate the deploy token'));

    // Only a loosely related note ("migration" and nothing else): nothing is listed, but the prompt still has it.
    const loose = await m.run('ask', { typed: 'When will the database migration finish this quarter?' });
    assert.deepEqual(loose.files, []);
    assert.ok(m.calls[1].userText.includes('wiki migration happened last year'), 'the loose hit is still sent to the model');

    // A question of two terms is too thin to say "from your files".
    const thin = await m.run('ask', { typed: 'Deploy token?' });
    assert.deepEqual(thin.files, []);
  } finally { await m.close(); }
});

test('only the actions that answer something list files, and the transcript counts toward the question', async () => {
  const lib = await libraryOf(FILES);
  const m = await meetingWith({ notesFor: () => [], library: lib });
  try {
    m.session._onFinal('them', 'How do we rotate the deploy token in the pipeline?', 'Speaker 1', '1.1');
    const say = await m.run('say', {});
    assert.deepEqual(say.files, [path.join('work', 'deploy-token-rotation.md')], 'what to say: the last talk is the question');
    const followup = await m.run('followup', {});
    assert.deepEqual(followup.files, [], 'questions to ask are not answered from a file');
    const catchup = await m.run('catchup', {});
    assert.deepEqual(catchup.files, []);
  } finally { await m.close(); }
});

// ---------------------------------------------------------------- 5. the key check tests the chosen model

test('a key check tries the live model the person chose when the key is the live provider\'s, else the suggested one', async () => {
  const seen = [];
  const make = (live) => K.createKeyChecker({
    hasKey: () => true, meetingActive: () => false,
    liveModel: (name) => (live.provider === name ? live.model : ''),
    testLlm: async (name, signal, model) => { seen.push([name, model || PROVIDERS[name].suggested.live]); },
    testStt: async () => {},
  });
  const check = make({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  await check('anthropic');
  await check('openai');
  await check('gemini');
  assert.deepEqual(seen, [['anthropic', 'claude-sonnet-5-5'], ['openai', 'gpt-6-luna'], ['gemini', 'gemini-3.5-flash-lite']]);
  // nothing chosen, a throwing lookup, or no lookup at all: the suggested model, and the check still runs
  seen.length = 0;
  for (const liveModel of [() => '', () => { throw new Error('no settings'); }, undefined, () => 7]) {
    await K.createKeyChecker({ hasKey: () => true, meetingActive: () => false, liveModel, testLlm: async (name, signal, model) => { seen.push(model); }, testStt: async () => {} })('openai');
  }
  assert.deepEqual(seen, ['', '', '', '']);
  assert.equal(K.chosenModel(() => '  gpt-6.1-terra ', 'openai'), 'gpt-6.1-terra');
});

test('Works. is only said for a key that can use the chosen model', async () => {
  // The stand-in knows one model only; asking for another is a 404, as at a real provider.
  const mock = await mockLlm((body) => (body.model === 'claude-sonnet-5-5' ? 'ready' : { status: 404, error: `model: ${body.model}` }));
  try {
    const llm = llmFor({ anthropic: mock.url, openai: mock.url, gemini: mock.url });
    // The wiring main.js gives the checker: the chosen model when the provider is the live one, else the suggested one.
    const wire = (live) => K.createKeyChecker({
      hasKey: () => true, meetingActive: () => false,
      liveModel: (name) => (live.provider === name ? live.model : ''),
      testLlm: (name, signal) => ask(llm, name, { signal, model: K.chosenModel((n) => (live.provider === n ? live.model : ''), name) || PROVIDERS[name].suggested.live, maxTokens: 50 }),
      testStt: async () => {},
    });
    assert.deepEqual(await wire({ provider: 'anthropic', model: 'claude-sonnet-5-5' })('anthropic'), { ok: true, message: 'Works.' });
    // the suggested model (haiku) is the one that would have been tried before: it is "not available", the chosen one is
    assert.deepEqual(await wire({ provider: 'anthropic', model: 'claude-no-such-model' })('anthropic'), { ok: false, message: 'Not available with your key.' });
    assert.deepEqual(mock.calls.map((c) => c.body.model), ['claude-sonnet-5-5', 'claude-no-such-model']);
  } finally { await mock.close(); }
});
