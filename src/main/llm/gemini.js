'use strict';
// Google Gemini API (generateContent, streamed as Server-Sent Events).
const crypto = require('node:crypto');
const { readSse, LlmError, httpError, parseErrorBody, friendlyError, wrapFetchError } = require('./sse');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Lowest thinking setting each model family accepts, for the live path.
function fastThinking(model) {
  const m = String(model).toLowerCase();
  if (/gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/gemini-2\.5|gemini-2\.0|gemini-1\./.test(m)) return null;
  // The API's own enum is upper case.
  if (/flash-lite|3\.6-flash|3\.8-flash|3-flash|3\.5-flash/.test(m)) return { thinkingLevel: 'MINIMAL' };
  return { thinkingLevel: 'LOW' };
}

function buildBody({ system, userText, images, webSearch, fast, maxTokens, model }, levelOrFlags = 0) {
  const flags = typeof levelOrFlags === 'number'
    ? { dropReasoning: levelOrFlags >= 1, dropSearch: levelOrFlags >= 2 }
    : (levelOrFlags || {});
  const parts = [];
  for (const img of images || []) parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
  parts.push({ text: userText });
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: maxTokens || (fast ? 4000 : 32000) },
  };
  const thinking = fast ? fastThinking(model) : null;
  if (thinking && !flags.dropReasoning) body.generationConfig.thinkingConfig = thinking;
  if (webSearch && !flags.dropSearch) body.tools = [{ google_search: {} }];
  return body;
}

const noFastReasoning = new Set();
const noWebSearch = new Set();
function resetModelCaps() { noFastReasoning.clear(); noWebSearch.clear(); }

// A free-tier key answers HTTP 429 (RESOURCE_EXHAUSTED) to every request that declares google_search, while the same
// models answer normally without it. When the request succeeds once the tool is left out, the tool was the cause, and it
// stays out for this long, so the next answers do not each pay a failed round trip first. A 429 that the retry also gets
// is the key's own limit, not the tool's: no window then. Keyed by SHA-256 of the API key, in memory only.
const SEARCH_BACKOFF_MS = 10 * 60 * 1000;
const searchBlockedUntil = new Map();
const keyHash = (apiKey) => crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');
function resetSearchBackoff() { searchBlockedUntil.clear(); }

const RPM_TPM_LIMIT = /\b(?:requests|tokens) per (?:minute|second)\b|\b(?:rpm|tpm)\b|too many requests|rate[ _-]limit/i;
const SEARCH_MENTION = /google_search|grounding|\bsearch\b|\btools?\b/i;

async function streamChat(opts) {
  const { apiKey, baseUrl, model, signal, onText, onStatus, onActivity } = opts;
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const notes = [];
  let res;
  const kid = keyHash(apiKey);
  let keyNoSearch = Boolean(opts.webSearch) && (searchBlockedUntil.get(kid) || 0) > Date.now();
  let dropReasoning = noFastReasoning.has(model);
  let dropSearch = noWebSearch.has(model);
  let retriedWithoutSearch = false; // this call got a 429/403 on the search tool and is trying again without it
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = buildBody(opts, { dropReasoning, dropSearch: dropSearch || keyNoSearch });
    try {
      res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
    } catch (e) { throw wrapFetchError(e, 'Gemini'); }
    if (res.ok) {
      if (retriedWithoutSearch) searchBlockedUntil.set(kid, Date.now() + SEARCH_BACKOFF_MS); // the tool was the cause
      // The cause of a missing search is the key's quota/permission (a 429/403, or the window that follows one), or the model (it rejected the tool).
      if (opts.webSearch && keyNoSearch) notes.push('Web search is not available right now.');
      else if (opts.webSearch && dropSearch) notes.push('Web search is not available with this model.');
      break;
    }
    if ((res.status === 429 || res.status === 403) && body.tools && !retriedWithoutSearch) {
      const parsed = parseErrorBody(await res.text().catch(() => ''));
      const skipRetry = res.status === 403
        ? !SEARCH_MENTION.test(parsed.detail)
        : (RPM_TPM_LIMIT.test(parsed.detail) && !SEARCH_MENTION.test(parsed.detail));
      if (skipRetry) throw friendlyError('Gemini', { status: res.status, ...parsed });
      retriedWithoutSearch = true;
      keyNoSearch = true;
      continue;
    }
    if (res.status !== 400 || (!body.generationConfig.thinkingConfig && !body.tools)) throw await httpError(res, 'Gemini');
    const parsed = parseErrorBody(await res.text().catch(() => ''));
    const detail = parsed.detail;
    if (body.tools && /\bgoogle_search\b|\btools?\b|\bsearch\b/i.test(detail)) {
      dropSearch = true; noWebSearch.add(model); continue;
    }
    if (body.generationConfig.thinkingConfig && /\bthinking|invalid.*(?:level|budget)/i.test(detail)) {
      dropReasoning = true; noFastReasoning.add(model); continue;
    }
    if (/unsupported|not supported|unknown name/i.test(detail)
      && !/payload|size|token|api[ _-]?key|credit|quota|billing|model.*(?:not found|does not exist)/i.test(detail)) {
      if (body.generationConfig.thinkingConfig) { dropReasoning = true; noFastReasoning.add(model); continue; }
      if (body.tools) { dropSearch = true; noWebSearch.add(model); continue; }
    }
    throw friendlyError('Gemini', { status: 400, ...parsed });
  }
  if (!res.ok) throw await httpError(res, 'Gemini');

  let text = '';
  const usage = { input: 0, output: 0, cached: 0 };
  const sources = [];
  const queries = [];
  let truncated = false;
  let finished = false;
  let blocked = '';
  try {
    for await (const { data } of readSse(res)) {
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (onActivity) onActivity();
      if (ev.error) throw friendlyError('Gemini', { status: Number(ev.error.code) || 0, code: ev.error.status || '', detail: ev.error.message || '', raw: `Gemini error: ${ev.error.message || ev.error.status || 'unknown error'}` });
      if (ev.promptFeedback && ev.promptFeedback.blockReason) blocked = ev.promptFeedback.blockReason;
      const cand = (ev.candidates || [])[0];
      if (cand) {
        for (const p of (cand.content && cand.content.parts) || []) {
          if (p.thought || typeof p.text !== 'string' || !p.text) continue;
          text += p.text;
          if (onText) onText(p.text);
        }
        const g = cand.groundingMetadata;
        if (g) {
          if (onStatus) onStatus('');
          for (const q of g.webSearchQueries || []) if (typeof q === 'string' && q && !queries.includes(q)) queries.push(q);
          for (const c of g.groundingChunks || []) if (c.web && c.web.uri && !sources.some((s) => s.url === c.web.uri)) sources.push({ title: c.web.title || c.web.uri, url: c.web.uri });
        }
        if (cand.finishReason) finished = true;
        if (cand.finishReason === 'MAX_TOKENS') truncated = true;
        if (cand.finishReason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) blocked = cand.finishReason;
      }
      const u = ev.usageMetadata;
      if (u) {
        usage.cached = u.cachedContentTokenCount || 0;
        usage.input = Math.max(0, (u.promptTokenCount || 0) - usage.cached);
        usage.output = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
      }
    }
  } catch (e) { throw wrapFetchError(e, 'Gemini'); }
  if (!finished && text && !blocked) { truncated = true; notes.push('The connection closed early, so this answer may be cut short.'); }
  if (!text && blocked) throw new LlmError(`The model did not answer (${String(blocked).toLowerCase().replace(/_/g, ' ')}).`, { kind: 'refusal', provider: 'Gemini' });
  const out = { text, usage, sources, model, truncated, notes };
  if (queries.length) out.searchQueries = queries.slice(0, 5);
  return out;
}

async function listModels({ apiKey, baseUrl, signal } = {}) {
  const sig = signal || AbortSignal.timeout(15000);
  let res;
  try { res = await fetch(`${(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey }, signal: sig }); } catch (e) {
    if (!signal && sig.aborted) throw new LlmError('No answer in time. Try again.', { kind: 'timeout', provider: 'Gemini' });
    throw wrapFetchError(e, 'Gemini');
  }
  if (!res.ok) throw await httpError(res, 'Gemini');
  const j = await res.json();
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, '')).filter((id) => /^gemini/.test(id) && !/tts|image|embedding|audio|live/.test(id)).sort();
}

module.exports = { streamChat, listModels, fastThinking, buildBody, SEARCH_BACKOFF_MS, resetSearchBackoff, resetModelCaps };
