'use strict';
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const { LlmError, friendlyError } = require('./sse');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Per-model request settings. `fast` is the live-answer path, where the wait
// before the first visible word is what matters most.
function tuning(model, fast) {
  const m = String(model).toLowerCase();
  // Earlier generations take neither `effort` nor adaptive thinking.
  if (/claude-3|haiku-4-5|sonnet-4-[0256]|opus-4-[01256]/.test(m)) return {};
  const out = { output_config: { effort: fast ? 'low' : 'medium' } };
  if (fast) {
    // Models that accept thinking being switched off: no thinking before the first word.
    // Opus 5.5, Sonnet 5.5 and the Fable models reject "disabled"; low effort is their fastest setting.
    const canDisable = /haiku-5-5/.test(m) || /sonnet-5(?!-5)/.test(m) || /opus-4-[78]/.test(m);
    if (canDisable) { out.thinking = { type: 'disabled' }; out.output_config.effort = 'medium'; }
  }
  return out;
}

const noTuning = new Set();
function resetModelCaps() { noTuning.clear(); }

// Models for which a safety classifier can decline a request and the API can
// re-run it on another model within the same call.
function supportsServerFallback(model) {
  return /claude-(fable-5-[12]|opus-5-5|opus-5$|sonnet-5-5)/.test(String(model).toLowerCase());
}

function toLlmError(e) {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new LlmError('cancelled', { kind: 'aborted', provider: 'Anthropic' });
  if (e instanceof Anthropic.APIConnectionError) return new LlmError('Could not reach Anthropic. Check your connection and try again.', { kind: 'network', provider: 'Anthropic', detail: String(e.message) });
  // Every other API error: a plain sentence from the status (or, for an error event in the middle of a stream that has none, the
  // error type such as overloaded_error); the SDK's own text, which carries the provider's raw body, only goes into `detail`.
  if (e instanceof Anthropic.APIError) {
    const status = Number(e.status) || 0;
    // An error event in a stream is { type: 'error', error: { type: 'overloaded_error', ... } }: the inner type is the one that says why.
    const type = e.error && ((e.error.error && e.error.error.type) || e.error.type);
    return friendlyError('Anthropic', { status, code: type || '', detail: String(e.message), raw: `Anthropic error ${status || ''}: ${e.message}` });
  }
  return new LlmError(String(e && e.message ? e.message : e), { provider: 'Anthropic' });
}

function client({ apiKey, baseUrl }) {
  // The address is always given explicitly. Left unset, the SDK would take it
  // from the ANTHROPIC_BASE_URL environment variable, and the stored key would
  // follow whatever that variable happens to say on this machine.
  return new Anthropic({ apiKey, authToken: null, maxRetries: 1, baseURL: baseUrl || 'https://api.anthropic.com', defaultHeaders: {} });
}

async function streamChat({ apiKey, baseUrl, model, system, userText, userCacheChars = 0, images = [], webSearch = false, fast = false, maxTokens, signal, onText, onStatus, onActivity }) {
  const anthropic = client({ apiKey, baseUrl });
  const content = [];
  for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
  // The start of the user turn that repeats from one question to the next (the always-include notes) gets its own block and the
  // second cache marker (the system block has the first), so the next question reads it back at a tenth of the price. Not with
  // an image: the screen differs every time and the plain single block is what has always worked there.
  const n = Number.isInteger(userCacheChars) && userCacheChars > 0 && userCacheChars <= userText.length && !images.length ? userCacheChars : 0;
  const split = n && !/[\ud800-\udbff]/.test(userText[n - 1]); // never cut a pair of surrogate halves in two
  if (split) {
    content.push({ type: 'text', text: userText.slice(0, n), cache_control: { type: 'ephemeral' } });
    if (n < userText.length) content.push({ type: 'text', text: userText.slice(n) });
  } else content.push({ type: 'text', text: userText });
  const messages = [{ role: 'user', content }];

  const base = {
    model,
    max_tokens: maxTokens || (fast ? 4000 : 32000),
    // The system prompt (instructions + profile) is identical for every call
    // in a meeting, so it is cached; the per-question material goes after it.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    ...(noTuning.has(model) ? {} : tuning(model, fast)),
  };
  if (webSearch) base.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: fast ? 2 : 4 }];

  let useFallback = !baseUrl && supportsServerFallback(model);
  const usage = { input: 0, output: 0, cached: 0 };
  const sources = [];
  let text = '';
  let servedBy = model;
  let noSearch = false;

  for (let round = 0; round < 4; round++) {
    let message;
    let emitted = false;
    const run = async (withFallback) => {
      const params = { ...base, messages };
      const stream = withFallback
        ? anthropic.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
        : anthropic.messages.stream(params, { signal });
      for await (const event of stream) {
        if (onActivity && event.type !== 'ping') onActivity(); // any real event is a sign of life
        if (event.type === 'content_block_start') {
          const b = event.content_block;
          if (b.type === 'server_tool_use' && onStatus) onStatus('Searching the web');
          if (b.type === 'web_search_tool_result') {
            if (Array.isArray(b.content)) {
              for (const r of b.content) if (r.type === 'web_search_result' && r.url && !sources.some((s) => s.url === r.url)) sources.push({ title: r.title || r.url, url: r.url });
            }
            if (onStatus) onStatus('');
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emitted = true;
          text += event.delta.text;
          if (onText) onText(event.delta.text);
        }
      }
      return stream.finalMessage();
    };
    for (;;) {
      try {
        message = await run(useFallback);
        break;
      } catch (e) {
        // Drop optional beta fallback, unsupported thinking/output_config, or disabled account web search one at a time before giving up.
        const retryable = !emitted && (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.PermissionDeniedError);
        if (retryable && useFallback) { useFallback = false; continue; }
        if (!emitted && e instanceof Anthropic.BadRequestError && (base.thinking || base.output_config)
          && /thinking|output_config|effort|extra inputs|unsupported|not supported|unknown|extra_forbidden/i.test(String(e.message))) {
          delete base.thinking;
          delete base.output_config;
          noTuning.add(model);
          continue;
        }
        if (retryable && base.tools && /web.?search|tool/i.test(String(e.message))) {
          delete base.tools;
          noSearch = true;
          continue;
        }
        throw toLlmError(e);
      }
    }
    const u = message.usage || {};
    const cacheWrite = u.cache_creation_input_tokens || 0;
    usage.input += (u.input_tokens || 0) + cacheWrite;
    if (cacheWrite) usage.cacheCreation = (usage.cacheCreation || 0) + cacheWrite;
    usage.cached += u.cache_read_input_tokens || 0;
    usage.output += u.output_tokens || 0;
    servedBy = message.model || servedBy;

    if (message.stop_reason === 'pause_turn') {
      // A server-side tool is still working: hand the turn back to continue it.
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    if (message.stop_reason === 'refusal') {
      throw new LlmError('The model declined to answer this one.', { kind: 'refusal', provider: 'Anthropic' });
    }
    if (message.stop_reason === 'model_context_window_exceeded' && !text.trim()) {
      throw friendlyError('Anthropic', { status: 400, detail: 'model context window exceeded' });
    }
    return {
      text, usage, sources, model: servedBy,
      truncated: message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded',
      notes: noSearch ? ['Web search is not enabled for this Anthropic account.'] : [],
    };
  }
  // The provider kept pausing the turn: what there is may be incomplete.
  return { text, usage, sources, model: servedBy, truncated: true, notes: ['This answer may be incomplete.'] };
}

async function listModels({ apiKey, baseUrl, signal } = {}) {
  const sig = signal || AbortSignal.timeout(15000);
  try {
    const out = [];
    for await (const m of client({ apiKey, baseUrl }).models.list({}, { signal: sig })) out.push(m.id);
    return out;
  } catch (e) {
    if (!signal && sig.aborted) throw new LlmError('No answer in time. Try again.', { kind: 'timeout', provider: 'Anthropic' });
    throw toLlmError(e);
  }
}

module.exports = { streamChat, listModels, tuning, supportsServerFallback, resetModelCaps };
