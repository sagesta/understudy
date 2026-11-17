'use strict';
// Gemini: a free-tier key answers HTTP 429 to every request that declares the google_search tool. The adapter retries
// once without it, remembers that for a while, and leaves real rate limits alone. Local stand-ins only, never the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { mockLlm } = require('./mocks');
const gemini = require('../src/main/llm/gemini');
const { Settings } = require('../src/main/settings');
const { createLlm, LlmError } = require('../src/main/llm');

const NOTE = 'Web search is not available right now.'; // the 429 fallback and the backoff window: the key's quota, not the model
const NOTE_MODEL = 'Web search is not available with this model.'; // the 400 fallback: the model rejected the tool
const QUOTA = 'You exceeded your current quota, please check your plan and billing details.';
const MODEL = 'gemini-3.5-flash-lite';
const hasTool = (call) => Boolean(call.body.tools);
const ask = (mock, extra = {}) => gemini.streamChat({ apiKey: 'k', baseUrl: `${mock.url}/v1beta`, model: MODEL, system: 'S', userText: 'Q', webSearch: true, fast: true, ...extra });
const rejection = async (p) => { try { await p; } catch (e) { return e; } return null; };
const quotaOnTool = (answer = 'Pin it to a SHA.') => (body) => (body.tools ? { status: 429, error: QUOTA } : answer);

test.beforeEach(() => gemini.resetSearchBackoff());

test('429 with the search tool: one retry without it, the answer, and the note', async () => {
  const mock = await mockLlm(quotaOnTool());
  try {
    const r = await ask(mock);
    assert.equal(r.text, 'Pin it to a SHA.');
    assert.deepEqual(r.notes, [NOTE]);
    assert.equal(mock.calls.length, 2);
    assert.ok(hasTool(mock.calls[0]) && !hasTool(mock.calls[1]));
    // the retry keeps everything else about the request
    assert.deepEqual(mock.calls[1].body.generationConfig, mock.calls[0].body.generationConfig);
    assert.deepEqual(mock.calls[1].body.contents, mock.calls[0].body.contents);
  } finally { await mock.close(); }
});

test('after a 429 the tool is not declared for the backoff window, then it is tried again', async () => {
  const mock = await mockLlm(quotaOnTool());
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    assert.equal(gemini.SEARCH_BACKOFF_MS, 10 * 60 * 1000);
    await ask(mock); // 2 calls: with the tool, then without
    const second = await ask(mock); // inside the window: straight to no tool, one call
    assert.equal(mock.calls.length, 3);
    assert.ok(!hasTool(mock.calls[2]));
    assert.equal(second.text, 'Pin it to a SHA.');
    assert.deepEqual(second.notes, [NOTE], 'the answer still says it was made without search');
    clock += gemini.SEARCH_BACKOFF_MS - 1000;
    await ask(mock);
    assert.equal(mock.calls.length, 4);
    assert.ok(!hasTool(mock.calls[3]), 'still inside the window');
    clock += 2000;
    const after = await ask(mock); // window over: tries the tool again, gets 429 again, retries
    assert.equal(mock.calls.length, 6);
    assert.ok(hasTool(mock.calls[4]) && !hasTool(mock.calls[5]));
    assert.deepEqual(after.notes, [NOTE]);
  } finally { Date.now = realNow; await mock.close(); }
});

test('the window is per key and can be reset', async () => {
  const mock = await mockLlm(quotaOnTool());
  try {
    await ask(mock);
    await ask(mock, { apiKey: 'other-key' });
    assert.equal(mock.calls.length, 4, 'another key still tries the tool first');
    assert.ok(hasTool(mock.calls[2]));
    gemini.resetSearchBackoff();
    await ask(mock);
    assert.equal(mock.calls.length, 6);
    assert.ok(hasTool(mock.calls[4]));
  } finally { await mock.close(); }
});

test('a search that works is left alone: tool declared, no note, no window', async () => {
  const mock = await mockLlm(() => 'Fine.');
  try {
    for (let i = 0; i < 2; i++) { const r = await ask(mock); assert.deepEqual(r.notes, []); }
    assert.ok(mock.calls.length === 2 && mock.calls.every(hasTool));
  } finally { await mock.close(); }
});

test('429 without the tool is a real rate limit: no retry, the usual error, no window', async () => {
  const mock = await mockLlm(() => ({ status: 429, error: 'Resource has been exhausted (e.g. check quota).' }));
  try {
    const e = await rejection(ask(mock, { webSearch: false }));
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.status, 429);
    assert.equal(mock.calls.length, 1);
  } finally { await mock.close(); }
  const m2 = await mockLlm(() => 'ok');
  try { await ask(m2); assert.ok(hasTool(m2.calls[0]), 'a 429 without the tool did not switch search off'); } finally { await m2.close(); }
});

test('a 429 whose retry also fails reports the retry\'s error', async () => {
  const mock = await mockLlm((body, url, n) => (n === 1 ? { status: 429, error: QUOTA } : { status: 429, error: 'Too many requests per minute' }));
  try {
    const e = await rejection(ask(mock));
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.message, 'Gemini: rate limit or credit reached. Try again in a moment.');
    assert.ok(e.detail.includes('Too many requests per minute') && !e.detail.includes('current quota'), e.detail);
    assert.equal(mock.calls.length, 2);
    assert.ok(hasTool(mock.calls[0]) && !hasTool(mock.calls[1]));
  } finally { await mock.close(); }
  gemini.resetSearchBackoff();
  const m503 = await mockLlm((body, url, n) => (n === 1 ? { status: 429, error: QUOTA } : { status: 503, error: 'overloaded' }));
  try {
    const e = await rejection(ask(m503));
    assert.equal(e.kind, 'server');
    assert.equal(m503.calls.length, 2);
  } finally { await m503.close(); }
});

test('the 400 fallback decouples search tools and thinking settings', async () => {
  // a 400 about the tool drops only the tool and keeps fast thinking, with the note
  const mock = await mockLlm((body) => (body.tools ? { status: 400, error: 'Unsupported tool: google_search' } : 'No search here.'));
  try {
    const r = await ask(mock, { model: 'gemini-3.5-flash-lite-no-tool' }); // its own model: remembered across calls
    assert.equal(r.text, 'No search here.');
    assert.deepEqual(r.notes, [NOTE_MODEL]);
    assert.deepEqual(mock.calls.map((c) => [Boolean(c.body.generationConfig.thinkingConfig), hasTool(c)]), [[true, true], [true, false]]);
  } finally { await mock.close(); }
  // a 400 about thinking drops only thinkingConfig and keeps the search tool
  const noThink = await mockLlm((body) => (body.generationConfig.thinkingConfig ? { status: 400, error: 'Invalid thinkingLevel MINIMAL' } : 'Thoughtless but searched.'));
  try {
    const r = await ask(noThink, { model: 'gemini-3.5-flash-lite-no-thinking' });
    assert.equal(r.text, 'Thoughtless but searched.');
    assert.deepEqual(r.notes, []);
    assert.deepEqual(noThink.calls.map((c) => [Boolean(c.body.generationConfig.thinkingConfig), hasTool(c)]), [[true, true], [false, true]]);
  } finally { await noThink.close(); }
  // a 400 that is not about the optional settings is still an error
  const bad = await mockLlm(() => ({ status: 400, error: 'Request payload size exceeds the limit' }));
  try {
    const e = await rejection(ask(bad));
    assert.equal(e.kind, 'bad_request');
    assert.equal(bad.calls.length, 1);
  } finally { await bad.close(); }
});

test('search queries from the grounding metadata are returned when present, and absent otherwise', async () => {
  const plain = await mockLlm(() => 'Fine.');
  try { assert.equal((await ask(plain)).searchQueries, undefined); } finally { await plain.close(); }
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const rec = { candidates: [{ content: { role: 'model', parts: [{ text: 'Yes.' }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['kyverno enforce default', 'kyverno enforce default', 7, 'kyverno audit'], groundingChunks: [{ web: { uri: 'https://example.com/k', title: 'K' } }] } }] };
      res.end(`data: ${JSON.stringify(rec)}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await ask({ url: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(r.searchQueries, ['kyverno enforce default', 'kyverno audit']);
    assert.equal(r.sources[0].url, 'https://example.com/k');
  } finally { await new Promise((r) => { server.closeAllConnections(); server.close(r); }); }
});

test('through createLlm: the retry works, and the live timeouts and error wording still apply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-'));
  const settings = new Settings(dir, { available: () => false });
  settings.setSecret('gemini', 'key-gemini');
  const make = (url) => { settings.set({ llm: { baseUrls: { gemini: url } } }); return createLlm(settings, { allowBaseUrls: true }); };
  const run = (llm, extra = {}) => llm.streamChat('live', { override: { provider: 'gemini', model: MODEL }, system: 's', userText: 'u', webSearch: true, ...extra });

  const ok = await mockLlm(quotaOnTool('Rotate keys every 30 days.'));
  try {
    const r = await run(make(ok.url));
    assert.equal(r.text, 'Rotate keys every 30 days.');
    assert.ok(r.notes.includes(NOTE));
    assert.equal(r.provider, 'gemini');
  } finally { await ok.close(); }

  gemini.resetSearchBackoff();
  const slow = await mockLlm((body) => (body.tools ? { status: 429, error: QUOTA } : { text: 'late', delayMs: 4000 }));
  try {
    const t0 = Date.now();
    const e = await rejection(run(make(slow.url), { firstTokenMs: 300 }));
    assert.ok(e instanceof LlmError);
    assert.equal(e.kind, 'timeout');
    assert.equal(e.message, 'No answer in time. Try again.');
    assert.ok(Date.now() - t0 < 3000, `gave up in ${Date.now() - t0} ms`);
  } finally { await slow.close(); }

  gemini.resetSearchBackoff();
  const limited = await mockLlm(() => ({ status: 429, error: 'rate' }));
  try {
    const e = await rejection(run(make(limited.url), { webSearch: false }));
    assert.equal(e.kind, 'rate_limit');
    assert.equal(limited.calls.length, 1);
  } finally { await limited.close(); }
});
