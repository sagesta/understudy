'use strict';
// The model speed test, run against local stand-ins for the three providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mockLlm } = require('./mocks');
const { Settings } = require('../src/main/settings');
const { createLlm, PROVIDERS } = require('../src/main/llm');
const { runSpeedTest, defaultCandidates, SYSTEM } = require('../src/main/llm/speedtest');

const ANSWER = 'We return everything within thirty days and then delete it. You will get written confirmation.';
const modelOf = (body, url) => body.model || decodeURIComponent((String(url).match(/models\/([^:]+):/) || [])[1] || '');
// table: model -> reply object (or string); anything not listed answers at once.
const byModel = (table) => (body, url, n) => { const r = table[modelOf(body, url)]; return typeof r === 'function' ? r(n) : (r || ANSWER); };

// One stand-in per provider, wired to a Settings that holds a key for each.
async function rig(tables = {}) {
  const mocks = {
    anthropic: await mockLlm(byModel(tables.anthropic || {})),
    openai: await mockLlm(byModel(tables.openai || {})),
    gemini: await mockLlm(byModel(tables.gemini || {})),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-speed-'));
  const settings = new Settings(dir, { available: () => false });
  for (const k of Object.keys(mocks)) settings.setSecret(k, `key-${k}`);
  settings.set({ llm: { baseUrls: Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.url])) } });
  return { mocks, llm: createLlm(settings, { allowBaseUrls: true }), close: () => Promise.all(Object.values(mocks).map((m) => m.close())) };
}

test('ranks models by the median wait for the first word, and keeps going past a model that fails', async () => {
  const r = await rig({
    // Timing margins: the gaps between the three models are wide (15, 90 and 600 ms), so that a busy machine, which
    // adds the same few tens of milliseconds to each, cannot reorder them or push haiku past the 190 ms bound below.
    anthropic: { 'claude-haiku-5-5': { text: ANSWER, delayMs: 90 }, 'claude-sonnet-5-5': { text: ANSWER, delayMs: 600 }, 'claude-opus-5-5': { status: 404, error: 'model: claude-opus-5-5' } },
    gemini: { 'gemini-3.5-flash-lite': { text: ANSWER, delayMs: 15 } },
  });
  try {
    const candidates = [
      { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'anthropic', model: 'claude-haiku-5-5' },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
    ];
    const out = await runSpeedTest({ llm: r.llm, candidates, rounds: 2, timeoutMs: 5000 });
    assert.equal(out.cancelled, false);
    assert.ok(out.ranAt > 0);
    assert.deepEqual(out.results.map((x) => x.model), ['gemini-3.5-flash-lite', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(out.results.map((x) => x.fastest), [true, false, false, false]);
    const [g, h, s, o] = out.results;
    assert.ok(g.ok && g.rounds === 2 && g.error === '');
    assert.ok(h.firstMs >= 55 && h.firstMs < 190, `haiku ${h.firstMs}`);
    assert.ok(s.firstMs >= 190, `sonnet ${s.firstMs}`);
    assert.ok(h.bestMs <= h.firstMs && h.firstMs <= h.totalMs);
    assert.equal(typeof h.cost, 'number'); // priced model
    assert.equal(typeof g.cost, 'number');
    assert.ok(g.charsPerSec === null || g.charsPerSec > 0);
    assert.equal(o.ok, false);
    assert.equal(o.firstMs, null);
    assert.equal(o.rounds, 0);
    assert.equal(o.error, 'Not available with your key.');
    assert.match(o.detail, /Anthropic error 404.*model: claude-opus-5-5/); // the provider's own words, from the error's `detail`
    assert.equal(g.detail, '');
    // The failing model was asked once only; the others twice each, one model at a time within a provider.
    const seq = r.mocks.anthropic.calls.map((c) => c.body.model);
    assert.deepEqual(seq, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);
  } finally { await r.close(); }
});

test('providers are timed side by side, so the run takes about as long as the slowest provider', async () => {
  const slow = { text: ANSWER, delayMs: 150 };
  const r = await rig({ anthropic: { 'claude-haiku-5-5': slow, 'claude-sonnet-5-5': slow }, openai: { 'gpt-6-luna': slow, 'gpt-6.1-terra': slow }, gemini: { 'gemini-3.5-flash-lite': slow, 'gemini-3.6-flash': slow } });
  try {
    const candidates = ['claude-haiku-5-5', 'claude-sonnet-5-5'].map((model) => ({ provider: 'anthropic', model }))
      .concat(['gpt-6-luna', 'gpt-6.1-terra'].map((model) => ({ provider: 'openai', model })), ['gemini-3.5-flash-lite', 'gemini-3.6-flash'].map((model) => ({ provider: 'gemini', model })));
    const t0 = Date.now();
    const out = await runSpeedTest({ llm: r.llm, candidates, rounds: 1, timeoutMs: 5000 });
    const took = Date.now() - t0;
    assert.equal(out.results.filter((x) => x.ok).length, 6);
    assert.ok(took < 6 * 150, `took ${took} ms, one after another would be over 900`);
  } finally { await r.close(); }
});

test('a model that goes quiet times out with a plain message, and the others still finish', async () => {
  const r = await rig({ anthropic: { 'claude-sonnet-5-5': { text: ANSWER, delayMs: 3000 } } });
  try {
    const t0 = Date.now();
    const out = await runSpeedTest({ llm: r.llm, candidates: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-haiku-5-5' }], rounds: 3, timeoutMs: 400 });
    assert.ok(Date.now() - t0 < 2000, 'a timed-out model is not retried or waited for');
    assert.equal(out.results[0].model, 'claude-haiku-5-5');
    assert.equal(out.results[0].rounds, 3);
    const bad = out.results[1];
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'No answer in time.');
    assert.match(bad.detail, /^No answer within 0\.4 seconds\.$/);
    assert.equal(r.mocks.anthropic.calls.filter((c) => c.body.model === 'claude-sonnet-5-5').length, 1);
  } finally { await r.close(); }
});

test('a failure after the first round keeps the earlier measurements', async () => {
  const r = await rig({ gemini: { 'gemini-3.6-flash': (n) => (n === 1 ? { text: ANSWER, delayMs: 20 } : { status: 400, error: 'quota' }) } });
  try {
    const out = await runSpeedTest({ llm: r.llm, candidates: [{ provider: 'gemini', model: 'gemini-3.6-flash' }], rounds: 3, timeoutMs: 5000 });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].rounds, 1);
    assert.equal(out.results[0].error, '');
    assert.equal(r.mocks.gemini.calls.length, 2, 'stops after the failed round');
  } finally { await r.close(); }
});

test('cancelling returns quickly with what has finished', async () => {
  const r = await rig({ anthropic: { 'claude-haiku-5-5': { text: ANSWER, delayMs: 5000 } }, gemini: { 'gemini-3.5-flash-lite': { text: ANSWER, delayMs: 10 } } });
  try {
    const ac = new AbortController();
    const events = [];
    const run = runSpeedTest({
      llm: r.llm, rounds: 1, timeoutMs: 20000, signal: ac.signal,
      candidates: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'gemini', model: 'gemini-3.5-flash-lite' }],
      onProgress: (p) => { events.push(p); if (p.provider === 'gemini' && p.state === 'done') setTimeout(() => ac.abort(), 30); },
    });
    const t0 = Date.now();
    const out = await run;
    assert.ok(Date.now() - t0 < 1500, 'cancel must not wait for the slow model');
    assert.equal(out.cancelled, true);
    assert.deepEqual(out.results.map((x) => x.model), ['gemini-3.5-flash-lite']);
    assert.ok(!events.some((e) => e.model === 'claude-sonnet-5-5'), 'models after the cancel are never started');
    // Already cancelled before it starts: nothing is sent.
    const before = r.mocks.gemini.calls.length;
    const none = await runSpeedTest({ llm: r.llm, rounds: 1, signal: ac.signal, candidates: [{ provider: 'gemini', model: 'gemini-3.6-flash' }] });
    assert.deepEqual([none.cancelled, none.results.length, r.mocks.gemini.calls.length], [true, 0, before]);
  } finally { await r.close(); }
});

test('progress: a start, one event per round, then done; failures say why; a throwing listener is harmless', async () => {
  const r = await rig({ openai: { 'gpt-6-luna': { text: ANSWER, delayMs: 10 }, 'gpt-6.1-sol': { status: 401, error: 'bad key' } } });
  try {
    const events = [];
    const out = await runSpeedTest({
      llm: r.llm, rounds: 2, timeoutMs: 5000,
      candidates: [{ provider: 'openai', model: 'gpt-6-luna' }, { provider: 'openai', model: 'gpt-6.1-sol' }],
      onProgress: (p) => { events.push(p); throw new Error('listener bug'); },
    });
    assert.equal(out.results[0].ok, true);
    const luna = events.filter((e) => e.model === 'gpt-6-luna');
    assert.deepEqual(luna.map((e) => [e.state, e.round]), [['running', 0], ['running', 1], ['running', 2], ['done', 2]]);
    assert.ok(luna.every((e) => e.provider === 'openai' && e.rounds === 2));
    assert.equal(typeof luna[1].firstMs, 'number');
    assert.equal(luna[3].firstMs, out.results[0].firstMs);
    const sol = events.filter((e) => e.model === 'gpt-6.1-sol');
    assert.deepEqual(sol.map((e) => e.state), ['running', 'failed']);
    assert.equal(sol[1].error, 'Your key was not accepted.');
    // The luna events all come before sol starts (one provider, one model at a time).
    assert.ok(events.indexOf(luna[3]) < events.indexOf(sol[0]));
  } finally { await r.close(); }
});

test('the system prompt is realistic in size and identical on every request', async () => {
  const r = await rig();
  try {
    const words = SYSTEM.split(/\s+/).length;
    assert.ok(words >= 1200 && words <= 1500, `${words} words`);
    await runSpeedTest({ llm: r.llm, rounds: 3, timeoutMs: 5000, candidates: [{ provider: 'anthropic', model: 'claude-haiku-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }] });
    const calls = r.mocks.anthropic.calls;
    assert.equal(calls.length, 6);
    assert.ok(calls.every((c) => c.body.system[0].text === SYSTEM));
    assert.ok(calls.every((c) => c.body.max_tokens === 1200 && !c.body.tools));
    const user = calls[0].body.messages[0].content[0].text;
    assert.ok(calls.every((c) => c.body.messages[0].content[0].text === user));
    assert.match(user, /two sentences/);
  } finally { await r.close(); }
});

test('every kind of failure shows one plain sentence, and the original text is kept as a capped detail', async () => {
  const { LlmError } = require('../src/main/llm/sse');
  // model -> [what the fake call does, the sentence expected on the result]
  const cases = {
    'gpt-6-astra': [new LlmError('OpenAI returned 404: model: gpt-6-astra', { kind: 'not_found', status: 404, provider: 'OpenAI' }), 'Not available with your key.'],
    'claude-opus-5-5': [new Error('Anthropic does not recognise this model: claude-opus-5-5'), 'Not available with your key.'],
    'gemini-x-model': [new Error('model gemini-x-model does not exist'), 'Not available with your key.'],
    'key-401': [new LlmError('OpenAI returned 401: bad key', { kind: 'auth', status: 401, provider: 'OpenAI' }), 'Your key was not accepted.'],
    'key-403': [new LlmError('Anthropic rejected the API key', { kind: 'auth', status: 403, provider: 'Anthropic' }), 'Your key was not accepted.'],
    'limit-429': [new LlmError('Anthropic rate limit reached. Try again in a moment.', { kind: 'rate_limit', status: 429, provider: 'Anthropic' }), 'Rate limit or credit reached.'],
    'limit-text': [new Error('You exceeded your current quota, please check your billing details.'), 'Rate limit or credit reached.'],
    'net-kind': [new LlmError('Could not reach Gemini: fetch failed', { kind: 'network', provider: 'Gemini' }), 'Could not connect.'],
    'net-text': [new Error('connect ECONNREFUSED 127.0.0.1:443'), 'Could not connect.'],
    'refused': [new LlmError('The model declined to answer this one.', { kind: 'refusal', provider: 'OpenAI' }), 'Did not work.'],
    'long': [new Error('x'.repeat(500)), 'Did not work.'],
    'silent': ['empty', 'Did not work.'],
    'hangs': ['hang', 'No answer in time.'],
  };
  // A fake llm: each model fails in its own way, without touching a real provider.
  const llm = {
    streamChat: (_scope, opts) => {
      const [how] = cases[opts.override.model];
      if (how === 'hang') return new Promise(() => {});
      if (how === 'empty') return Promise.resolve({ text: '', cost: null });
      return Promise.reject(how);
    },
  };
  const candidates = Object.keys(cases).map((model) => ({ provider: 'openai', model }));
  const out = await runSpeedTest({ llm, candidates, rounds: 1, timeoutMs: 100 });
  const by = Object.fromEntries(out.results.map((x) => [x.model, x]));
  for (const [model, [, sentence]] of Object.entries(cases)) {
    assert.equal(by[model].ok, false, model);
    assert.equal(by[model].error, sentence, model);
    assert.equal(typeof by[model].detail, 'string', model);
    assert.ok(by[model].detail.length > 0 && by[model].detail.length <= 200, `${model} detail length`);
  }
  assert.equal(by['gpt-6-astra'].detail, 'OpenAI returned 404: model: gpt-6-astra');
  assert.equal(by.long.detail, 'x'.repeat(200));
  assert.equal(by.silent.detail, 'The model returned no answer. Try again.');
  assert.match(by.hangs.detail, /^No answer within 0\.1 seconds\.$/);
});

test('defaultCandidates: every known model of each provider with a key, plus a custom live model', () => {
  const known = (p) => PROVIDERS[p].known.map((model) => ({ provider: p, model }));
  const current = { provider: 'anthropic', model: 'claude-haiku-5-5' };
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: {}, current }), []);
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: { deepgram: true }, current }), []);
  // Only the providers with a key; the live model is already in the list, so no duplicate.
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: { gemini: true, anthropic: true }, current }), [...known('anthropic'), ...known('gemini')]);
  // A model typed in by hand is added after its provider's own list.
  const custom = { provider: 'openai', model: 'gpt-7-preview' };
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: { anthropic: true, openai: true, gemini: true }, current: custom }),
    [...known('anthropic'), ...known('openai'), custom, ...known('gemini')]);
  // No key for the custom model's provider: it is left out.
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: { anthropic: true }, current: custom }), known('anthropic'));
  assert.deepEqual(defaultCandidates({ providers: PROVIDERS, secretsPresent: { anthropic: true }, current: undefined }), known('anthropic'));
});
