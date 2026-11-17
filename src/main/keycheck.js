'use strict';
// Checking a saved key against its provider (keys:test), and the page where a new one is made (keys:link).
// No Electron import: main.js hands in what touches the outside world, so the tests can run all of it.
const { explainFailure } = require('./llm/speedtest');

// Fixed here and never taken from a window. `side` says which test runs: 'llm' tries the provider's suggested
// live model (the chosen one when the key serves the live provider), 'stt' the speech test of a provider that uses the key. The OpenAI key serves both sides and is
// tested on the AI side. `name` is the short name used in a sentence.
const KEYS = {
  anthropic: { name: 'Anthropic', side: 'llm', url: 'https://console.anthropic.com/settings/keys' },
  openai: { name: 'OpenAI', side: 'llm', url: 'https://platform.openai.com/api-keys' },
  gemini: { name: 'Gemini', side: 'llm', url: 'https://aistudio.google.com/apikey' },
  deepgram: { name: 'Deepgram', side: 'stt', url: 'https://console.deepgram.com' },
  assemblyai: { name: 'AssemblyAI', side: 'stt', url: 'https://www.assemblyai.com/dashboard' },
  groq: { name: 'Groq', side: 'stt', url: 'https://console.groq.com/keys' },
};
// Own keys only: 'constructor' or '__proto__' from a window is not a key name.
const known = (name) => (typeof name === 'string' && Object.hasOwn(KEYS, name) ? KEYS[name] : null);

const LIMIT_MS = 10000;
const NO_KEY = 'No key saved.';
const BUSY = 'Not checked during a meeting.';
const WORKS = 'Works.';
const FAILED = 'Did not work.';

// Only a fixed sentence ever leaves here, never the provider's own words: explainFailure (the speed test's
// own reasons) picks it, and the one about the key names the provider.
const KEY_REJECTED = explainFailure({ kind: 'auth' }).error;
function sentence(e, name) {
  try {
    const { error } = explainFailure(e);
    return error === KEY_REJECTED ? `${name} rejected it.` : error;
  } catch { return FAILED; }
}

// A throwing or odd liveModel is "none chosen": the check still runs, on the suggested model.
function chosenModel(liveModel, name) {
  try { const m = typeof liveModel === 'function' ? liveModel(name) : ''; return typeof m === 'string' ? m.trim() : ''; } catch { return ''; }
}

// hasKey(name): a key is saved. meetingActive(): a meeting is running (a check would compete with it).
// testLlm(provider, signal, model) and testStt(provider, signal): resolve when the key works, reject otherwise.
// liveModel(provider): the live-answers model the person chose when this key's provider is the live provider, else
// ''. testLlm gets it as `model` and tries it, so "Works." means it works for the model they will use; with none (or
// no liveModel) it is the provider's suggested one.
// Returns check(name) -> Promise<{ ok, message }>, which never rejects.
function createKeyChecker({ hasKey, meetingActive, testLlm, testStt, liveModel, timeoutMs = LIMIT_MS }) {
  const running = new Map(); // a second click while a check runs shares it
  async function run(name, k) {
    const ac = new AbortController();
    let timer;
    try {
      const limit = new Promise((_, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error('No answer in time.'), { timeout: true })); }, timeoutMs);
        if (timer.unref) timer.unref();
      });
      limit.catch(() => {});
      const work = Promise.resolve().then(() => (k.side === 'llm' ? testLlm(name, ac.signal, chosenModel(liveModel, name)) : testStt(name, ac.signal)));
      work.catch(() => {}); // a test that fails after the time is up has nobody waiting
      await Promise.race([work, limit]);
      return { ok: true, message: WORKS };
    } catch (e) {
      return { ok: false, message: sentence(e, k.name) };
    } finally { clearTimeout(timer); }
  }
  return function check(name) {
    try {
      const k = known(name);
      if (!k || !hasKey(name)) return Promise.resolve({ ok: false, message: NO_KEY });
      if (meetingActive()) return Promise.resolve({ ok: false, message: BUSY });
      if (running.has(name)) return running.get(name);
      const p = run(name, k).finally(() => running.delete(name));
      running.set(name, p);
      return p;
    } catch { return Promise.resolve({ ok: false, message: FAILED }); }
  };
}

// keys:link. Opens the provider's page for making a key and says whether it did. An unknown name does nothing.
async function openKeyPage(name, open) {
  const k = known(name);
  if (!k) return false;
  try { await open(k.url); return true; } catch { return false; }
}

// The cheapest real request for a provider that has no live stream (Groq): list its models with the key.
// Rejects with the status (or kind 'network') so explainFailure can say why.
async function probeKey({ baseUrl, apiKey, signal, fetchImpl = fetch }) {
  let res;
  try { res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal }); } catch (e) {
    if (signal && signal.aborted) throw e;
    throw Object.assign(new Error('Could not connect.'), { kind: 'network' });
  }
  try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* the answer is already known */ }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
}

module.exports = { KEYS, known, chosenModel, createKeyChecker, openKeyPage, probeKey, LIMIT_MS, NO_KEY, BUSY };
