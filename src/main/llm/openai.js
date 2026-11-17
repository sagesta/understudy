'use strict';
// OpenAI Responses API over plain HTTP with Server-Sent Events.
const { readSse, LlmError, httpError, parseErrorBody, friendlyError, wrapFetchError } = require('./sse');

const DEFAULT_BASE = 'https://api.openai.com/v1';

// Lowest reasoning setting each model family accepts, for the live path.
function fastEffort(model) {
  const m = String(model).toLowerCase();
  if (/^gpt-4|^gpt-3|^chatgpt|-chat-latest$/.test(m)) return null; // not reasoning models
  if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(m)) return 'minimal';
  if (/^o\d|codex|astra|gpt-6\.1-sol|-pro\b/.test(m)) return 'low';
  return 'none';
}

function buildBody({ model, system, userText, images, webSearch, fast, maxTokens }, levelOrFlags = 0) {
  const flags = typeof levelOrFlags === 'number'
    ? { dropReasoning: levelOrFlags >= 1, dropSearch: levelOrFlags >= 2 }
    : (levelOrFlags || {});
  const content = [];
  for (const img of images || []) content.push({ type: 'input_image', image_url: `data:${img.mime};base64,${img.base64}` });
  content.push({ type: 'input_text', text: userText });
  const body = {
    model,
    stream: true,
    instructions: system,
    input: [{ role: 'user', content }],
    max_output_tokens: maxTokens || (fast ? 4000 : 32000),
  };
  const effort = fast ? fastEffort(model) : null;
  if (effort && !flags.dropReasoning) body.reasoning = { effort };
  if (webSearch && !flags.dropSearch) body.tools = [{ type: 'web_search' }];
  return body;
}

// Tracked independently per model so rejecting web_search never switches off fast low-effort reasoning (or vice versa).
const noFastReasoning = new Set();
const noWebSearch = new Set();
function resetModelCaps() { noFastReasoning.clear(); noWebSearch.clear(); }

async function streamChat(opts) {
  const { apiKey, baseUrl, signal, onText, onStatus, onActivity } = opts;
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/responses`;
  const notes = [];
  let res;
  let dropReasoning = noFastReasoning.has(opts.model);
  let dropSearch = noWebSearch.has(opts.model);
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = buildBody(opts, { dropReasoning, dropSearch });
    try {
      res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    } catch (e) { throw wrapFetchError(e, 'OpenAI'); }
    if (res.ok) {
      if (opts.webSearch && dropSearch) notes.push('Web search is not available with this model.');
      break;
    }
    if (res.status !== 400 || (!body.reasoning && !body.tools)) throw await httpError(res, 'OpenAI');
    // Only retry when the complaint is about an optional setting, dropping the one named.
    const parsed = parseErrorBody(await res.text().catch(() => ''));
    const detail = parsed.detail;
    if (body.tools && /\bweb_search\b|\btools?\b/i.test(detail)) {
      dropSearch = true; noWebSearch.add(opts.model); continue;
    }
    if (body.reasoning && /\breasoning\b|\beffort\b/i.test(detail)) {
      dropReasoning = true; noFastReasoning.add(opts.model); continue;
    }
    if (/unsupported|not supported|unknown parameter|unrecognized/i.test(detail)
      && !/max_output_tokens|max_tokens|token|input|context|api[ _-]?key|credit|quota|billing|model.*(?:not found|does not exist)/i.test(detail)) {
      if (body.reasoning) { dropReasoning = true; noFastReasoning.add(opts.model); continue; }
      if (body.tools) { dropSearch = true; noWebSearch.add(opts.model); continue; }
    }
    throw friendlyError('OpenAI', { status: 400, ...parsed });
  }
  if (!res.ok) throw await httpError(res, 'OpenAI');

  let text = '';
  const usage = { input: 0, output: 0, cached: 0 };
  const sources = [];
  let truncated = false;
  let finished = false;
  let refused = false;
  let servedBy = opts.model;
  try {
    for await (const { data } of readSse(res)) {
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (onActivity) onActivity();
      const type = ev.type || '';
      if (type === 'response.output_text.delta') {
        text += ev.delta || '';
        if (onText && ev.delta) onText(ev.delta);
      } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
        refused = true;
      } else if (type.startsWith('response.web_search_call')) {
        if (onStatus) onStatus(type.endsWith('completed') ? '' : 'Searching the web');
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const r = ev.response || {};
        const u = r.usage || {};
        const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
        usage.input = Math.max(0, (u.input_tokens || 0) - cached);
        usage.cached = cached;
        usage.output = u.output_tokens || 0;
        servedBy = r.model || servedBy;
        if (type === 'response.incomplete') {
          if (r.incomplete_details && r.incomplete_details.reason === 'content_filter') refused = true;
          else truncated = true;
        }
        finished = true;
        for (const item of r.output || []) {
          for (const part of item.content || []) {
            for (const a of part.annotations || []) if (a.type === 'url_citation' && a.url && !sources.some((s) => s.url === a.url)) sources.push({ title: a.title || a.url, url: a.url });
          }
        }
      } else if (type === 'response.failed') {
        const err = (ev.response && ev.response.error) || {};
        throw friendlyError('OpenAI', { code: err.code || '', detail: err.message || '', raw: `OpenAI could not complete the response: ${err.message || err.code || 'unknown error'}` });
      } else if (type === 'error') {
        throw friendlyError('OpenAI', { code: ev.code || '', detail: ev.message || '', raw: `OpenAI error: ${ev.message || ev.code || 'unknown error'}` });
      }
    }
  } catch (e) { throw wrapFetchError(e, 'OpenAI'); }
  if (!finished && text && !refused) { truncated = true; notes.push('The connection closed early, so this answer may be cut short.'); }
  if (refused && !text.trim()) throw new LlmError('The model declined to answer this one.', { kind: 'refusal', provider: 'OpenAI' });
  return { text, usage, sources, model: servedBy, truncated, notes };
}

async function listModels({ apiKey, baseUrl, signal } = {}) {
  const sig = signal || AbortSignal.timeout(15000);
  let res;
  try { res = await fetch(`${(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: sig }); } catch (e) {
    if (!signal && sig.aborted) throw new LlmError('No answer in time. Try again.', { kind: 'timeout', provider: 'OpenAI' });
    throw wrapFetchError(e, 'OpenAI');
  }
  if (!res.ok) throw await httpError(res, 'OpenAI');
  const j = await res.json();
  return (j.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|embedding|moderation|search-preview|instruct/i.test(id)).sort();
}

module.exports = { streamChat, listModels, fastEffort, buildBody, resetModelCaps };
