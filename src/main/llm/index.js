'use strict';
const { LlmError } = require('./sse');

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', secret: 'anthropic', impl: () => require('./anthropic'), suggested: { live: 'claude-haiku-5-5', notes: 'claude-opus-5-5' }, known: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] },
  openai: { label: 'OpenAI (ChatGPT models)', secret: 'openai', impl: () => require('./openai'), suggested: { live: 'gpt-6-luna', notes: 'gpt-6.1-sol' }, known: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'] },
  gemini: { label: 'Google Gemini', secret: 'gemini', impl: () => require('./gemini'), suggested: { live: 'gemini-3.5-flash-lite', notes: 'gemini-4-argon' }, known: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-4-argon'] },
};

// US dollars per million tokens (input, output). Used only for the running
// cost estimate shown in the app; the provider's invoice is the real figure.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-fable-5-2': [8, 40],
  'gpt-6-luna': [0.10, 0.50], 'gpt-6.1-terra': [1, 5], 'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50],
  'gemini-3.5-flash-lite': [0.30, 2.50], 'gemini-3.6-flash': [0.75, 3.75], 'gemini-3.8-flash': [0.75, 3.75], 'gemini-4-argon': [4, 20],
};

function priceFor(model) {
  const m = String(model || '');
  if (Object.hasOwn(PRICES, m)) return PRICES[m];
  const base = m.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return Object.hasOwn(PRICES, base) ? PRICES[base] : null;
}

function estimateCost(model, usage) {
  const p = priceFor(model);
  if (!p || !usage) return null;
  // usage.input already includes Anthropic cache_creation_input_tokens at 1.0x; usage.cacheCreation adds the remaining 0.25x for 1.25x total.
  return ((usage.input + (usage.cacheCreation || 0) * 0.25) * p[0] + usage.cached * p[0] * 0.1 + usage.output * p[1]) / 1e6;
}

// `settings` is the Settings instance. `role` is 'live' (answers during the
// meeting) or 'notes' (summaries and profile building).
// Sending keys to a host other than the provider's own is only possible when
// `allowBaseUrls` is set (development builds and tests), and then only over
// https or to this machine.
function overrideFor(settings, provider, allow) {
  if (!allow) return '';
  const url = (settings.get().llm.baseUrls || {})[provider] || '';
  if (!url) return '';
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) throw new LlmError(`The address override for ${provider} must use https.`);
  return url;
}

// How long a live answer may stay silent before it is given up on. The first
// word has 20 s, or 40 s while the model reports a web search in progress; once
// text is flowing, 30 s with nothing new means the stream has stalled. Each can be
// overridden per call (opts.firstTokenMs, opts.searchFirstTokenMs, opts.idleMs;
// 0 switches one off). Notes and profile building are long and legitimately slow,
// so they get generous limits (3 min to start, 90 s between stream events).
const LIVE_FIRST_TOKEN_MS = 20000;
const LIVE_SEARCH_FIRST_TOKEN_MS = 40000;
const LIVE_IDLE_MS = 30000;
const NOTES_FIRST_TOKEN_MS = 180000;
const NOTES_IDLE_MS = 90000;
const TIMEOUT_MESSAGE = 'No answer in time. Try again.';

// Runs `start(opts)` with a watchdog on the stream. Any text, status update or other
// event (opts.onActivity, which the adapters call for each event of the stream) counts as life. On a stall the request is aborted and the call fails with
// an LlmError of kind 'timeout'. The caller's own abort always wins and is never a timeout.
function withTimeouts(role, opts, start, label) {
  const live = role === 'live';
  const num = (v, dflt) => (v === undefined || v === null ? dflt : Number(v));
  const firstMs = num(opts.firstTokenMs, live ? LIVE_FIRST_TOKEN_MS : NOTES_FIRST_TOKEN_MS);
  const idleMs = num(opts.idleMs, live ? LIVE_IDLE_MS : NOTES_IDLE_MS);
  const searchMs = num(opts.searchFirstTokenMs, live ? LIVE_SEARCH_FIRST_TOKEN_MS : 0);
  const on = (ms) => Number.isFinite(ms) && ms > 0;
  if (!on(firstMs) && !on(idleMs)) return start(opts);
  const outer = opts.signal;
  if (outer && outer.aborted) return start(opts); // already cancelled: the adapter reports it
  const ac = new AbortController();
  let timer = null;
  let started = false;
  let searching = false; // the adapter reported a web search in progress
  let settled = false;
  let fail;
  const stop = new Promise((_, reject) => { fail = reject; });
  stop.catch(() => {});
  const arm = () => {
    clearTimeout(timer);
    timer = null;
    // A search can take several seconds before the first word; the longer deadline applies only until text starts.
    const ms = started ? idleMs : (searching && on(firstMs) ? Math.max(firstMs, searchMs) : firstMs);
    if (settled || !on(ms)) return;
    timer = setTimeout(() => {
      if (settled || (outer && outer.aborted)) return;
      settled = true;
      fail(new LlmError(TIMEOUT_MESSAGE, { kind: 'timeout', provider: label }));
      ac.abort();
    }, ms);
    if (timer.unref) timer.unref();
  };
  const onOuter = () => { clearTimeout(timer); timer = null; ac.abort(); };
  if (outer) outer.addEventListener('abort', onOuter, { once: true });
  const wrapped = {
    ...opts,
    signal: ac.signal,
    onText: (d) => { if (settled) return; if (d) started = true; arm(); if (opts.onText) opts.onText(d); },
    onStatus: (st) => { if (settled) return; searching = Boolean(st); arm(); if (opts.onStatus) opts.onStatus(st); },
    onActivity: () => { if (!settled) arm(); },
  };
  arm();
  let work; // started in this tick, as without a watchdog
  try { work = Promise.resolve(start(wrapped)); } catch (e) { work = Promise.reject(e); }
  work.catch(() => {}); // a stream that fails after the time is up has nobody waiting
  return Promise.race([work, stop]).finally(() => {
    settled = true;
    clearTimeout(timer);
    timer = null;
    if (outer) outer.removeEventListener('abort', onOuter);
  });
}

// A whole number from 0 to the length of the text; anything else means "no cache marker".
function cacheChars(n, text) {
  return typeof text === 'string' && Number.isInteger(n) && n >= 0 && n <= text.length ? n : 0;
}

function createLlm(settings, { allowBaseUrls = false } = {}) {
  const resolve = (role, override) => {
    const cfg = { ...settings.get().llm[role], ...(override || {}) };
    const def = typeof cfg.provider === 'string' && Object.hasOwn(PROVIDERS, cfg.provider) ? PROVIDERS[cfg.provider] : null;
    if (!def) throw new LlmError(`Unknown AI provider: ${cfg.provider}`);
    const apiKey = settings.getSecret(def.secret);
    if (!apiKey) throw new LlmError(`No API key saved for ${def.label}. Add one in Settings.`, { kind: 'auth', provider: def.label });
    return { def, cfg, apiKey, baseUrl: overrideFor(settings, cfg.provider, allowBaseUrls) };
  };
  return {
    async streamChat(role, opts) {
      const { def, cfg, apiKey, baseUrl } = resolve(role, opts.override);
      // userCacheChars: how much of the start of userText is the same from one request to the next. Only Anthropic needs it marked
      // (OpenAI and Gemini cache a repeated prefix on their own), so the others never see the field.
      const n = cacheChars(opts.userCacheChars, opts.userText);
      const result = await withTimeouts(role, opts, (o) => {
        const { userCacheChars, ...rest } = o;
        return def.impl().streamChat({ ...rest, ...(cfg.provider === 'anthropic' ? { userCacheChars: n } : {}), apiKey, baseUrl, model: cfg.model, fast: role === 'live' });
      }, def.label.split(' (')[0]);
      if (!String(result.text || '').trim()) throw new LlmError('The model returned no answer. Try again.', { kind: 'empty', provider: def.label });
      result.provider = cfg.provider;
      result.cost = estimateCost(result.model || cfg.model, result.usage) ?? estimateCost(cfg.model, result.usage);
      return result;
    },
    async listModels(provider, opts) {
      const def = typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
      if (!def) throw new LlmError(`Unknown AI provider: ${provider}`);
      const apiKey = settings.getSecret(def.secret);
      if (!apiKey) throw new LlmError(`No API key saved for ${def.label}.`, { kind: 'auth' });
      return def.impl().listModels({ apiKey, baseUrl: overrideFor(settings, provider, allowBaseUrls), ...(opts && opts.signal ? { signal: opts.signal } : {}) });
    },
    describe(role) { const c = settings.get().llm[role]; return `${c.provider}/${c.model}`; },
  };
}

module.exports = { createLlm, PROVIDERS, PRICES, estimateCost, LlmError, LIVE_FIRST_TOKEN_MS, LIVE_SEARCH_FIRST_TOKEN_MS, LIVE_IDLE_MS, NOTES_FIRST_TOKEN_MS, NOTES_IDLE_MS };
