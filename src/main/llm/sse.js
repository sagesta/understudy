'use strict';

class LlmError extends Error {
  constructor(message, { kind = 'error', status = 0, provider = '', detail = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // auth | not_found | rate_limit | bad_request | network | refusal | aborted | timeout | server | empty | error
    this.status = status;
    this.provider = provider;
    // The provider's own words, kept for troubleshooting but never shown on a card.
    this.detail = String(detail || '').slice(0, DETAIL_MAX);
  }
}

const DETAIL_MAX = 300;
const isServerStatus = (status) => status >= 500 && status <= 599;
// What the person sees when a provider has an outage; the raw text goes in `detail`.
const serverMessage = (provider) => `${provider} is having trouble. Try again.`;

// The plain sentences a person reads, for every place an AI error is shown (cards, notices, Settings). The
// provider's own wording never goes into `message`, only into `detail`.
const MESSAGES = {
  auth: (p) => `${p} rejected the API key (or the key lacks access to this model).`,
  not_found: (p) => `${p} does not have that model for your key. Choose another model in Settings > Answers.`,
  rate_limit: (p) => `${p}: rate limit or credit reached. Try again in a moment.`,
  too_large: (p) => `${p} says the request is too large for this model.`,
  bad_request: (p) => `${p} could not use that request. Try another model.`,
  server: serverMessage,
  error: (p) => `${p} did not answer. Try again.`,
};
// Kept in step with TOO_LARGE in meetings/notes.js, which reads `message` to decide to write the notes in stages.
// Output-cap rejections ("max_tokens: 32000 > 8192", "max_output_tokens exceeds maximum") are not input-size errors unless input/prompt/context is also named.
const TOO_LARGE = /context[ _-]?(length|window)|too (long|large|big)|maximum (context|number of tokens|input|prompt)|exceeds? (the )?(maximum|max|limit|context)|token limit|input token count|request.{0,20}(too|exceed)|payload too large/i;
const OUTPUT_CAP = /\bmax(?:_output)?_tokens\b|\bmaxOutputTokens\b|\b(?:output|completion)[ _-]tokens?\b/i;
const INPUT_CAP = /\b(?:input|prompt|context)\b/i;
const isInputTooLarge = (text) => TOO_LARGE.test(text) && (!OUTPUT_CAP.test(text) || INPUT_CAP.test(text));
const BAD_KEY = /api[ _-]?key[^.]{0,20}(not valid|invalid|expired|incorrect)|api_key_invalid|invalid[^.]{0,20}api[ _-]?key|incorrect api key|authentication_error|invalid x-api-key/i;
const OVER_LIMIT = /rate[ _-]?limit|quota|credit balance|insufficient[ _]?(quota|funds|credit)|billing|resource[ _]exhausted|too many requests/i;
const NO_MODEL = /model[^.]{0,80}(not found|does not exist|not supported for|do(es)? not have access)|model_not_found|unknown model|no such model|invalid model|not found for api version/i;
const SERVER_CODE = /^(overloaded_error|api_error|server_error|unavailable|internal|service_unavailable)$/i;

// Builds the LlmError for a failed request from what the provider said: `status` (HTTP, or 0), `code` (its own
// error type or status word, when it gives one) and `detail` (its text). Decided from the status first, then the text.
function friendlyError(provider, { status = 0, code = '', detail = '', raw = '' } = {}) {
  const text = `${code} ${detail}`;
  let kind = 'error';
  let key = 'error';
  if (isServerStatus(status) || SERVER_CODE.test(String(code))) { kind = 'server'; key = 'server'; }
  else if (status === 401 || status === 403 || BAD_KEY.test(text)) { kind = 'auth'; key = 'auth'; }
  else if (status === 429 || status === 402 || OVER_LIMIT.test(text)) { kind = 'rate_limit'; key = 'rate_limit'; }
  else if (status === 413 || isInputTooLarge(text)) { kind = 'bad_request'; key = 'too_large'; }
  else if (status === 404 || NO_MODEL.test(text)) { kind = 'not_found'; key = 'not_found'; }
  else if (status === 400 || status === 422) { kind = 'bad_request'; key = 'bad_request'; }
  return new LlmError(MESSAGES[key](provider), { kind, status, provider, detail: raw || `${provider} returned ${status || 'an error'}: ${String(detail).slice(0, 400)}` });
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 422) return 'bad_request';
  if (isServerStatus(status)) return 'server'; // 500, 502, 503, 529 (overloaded) and the rest
  return 'error';
}

const MAX_SSE_BUFFER = 16 * 1024 * 1024;

// Parses a fetch() Response carrying Server-Sent Events into { event, data } records.
async function* readSse(response) {
  if (!response || !response.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  const parseBlock = (block) => {
    let event = '';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  // \r(?!\n) matches a lone CR without letting {2} split a single \r\n into \r + \n.
  const boundary = /(?:\r\n|\r(?!\n)|\n){2}/;
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > MAX_SSE_BUFFER) throw new LlmError('The stream response was too large to read.', { kind: 'error' });
    for (;;) {
      const m = boundary.exec(buf);
      // A trailing \r may be the first half of a \r\n that the next chunk completes.
      if (!m || (m.index + m[0].length === buf.length && buf.endsWith('\r'))) break;
      const rec = parseBlock(buf.slice(0, m.index).replace(/\r\n?/g, '\n'));
      buf = buf.slice(m.index + m[0].length);
      if (rec) yield rec;
    }
  }
  buf += decoder.decode();
  if (buf.length > MAX_SSE_BUFFER) throw new LlmError('The stream response was too large to read.', { kind: 'error' });
  const rec = parseBlock(buf.replace(/\r\n?/g, '\n'));
  if (rec) yield rec;
}

function parseErrorBody(text) {
  let detail = text;
  let code = '';
  try {
    const j = JSON.parse(text);
    const err = j && typeof j.error === 'object' && j.error ? j.error : null;
    const parts = err ? [typeof err.code === 'string' ? err.code : '', typeof err.type === 'string' ? err.type : '', typeof err.status === 'string' ? err.status : ''].filter(Boolean) : [];
    code = parts.find((p) => SERVER_CODE.test(p)) || parts.join(' ');
    detail = (err && err.message) || (j && typeof j.error === 'string' ? j.error : '') || (j && j.message) || text;
  } catch {}
  return { code, detail: String(detail || '') };
}

async function httpError(res, provider) {
  let parsed = { code: '', detail: '' };
  try { parsed = parseErrorBody(await res.text()); } catch {}
  return friendlyError(provider, { status: res.status, ...parsed });
}

function wrapFetchError(e, provider) {
  if (e instanceof LlmError) return e;
  if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return new LlmError('cancelled', { kind: 'aborted', provider });
  if (e && e.name === 'TimeoutError') return new LlmError('No answer in time. Try again.', { kind: 'timeout', provider, detail: String(e.message || e) });
  return new LlmError(`Could not reach ${provider}. Check your connection and try again.`, { kind: 'network', provider, detail: String(e && e.message ? e.message : e) });
}

module.exports = { readSse, LlmError, httpError, parseErrorBody, friendlyError, wrapFetchError, kindForStatus, isServerStatus, serverMessage, MAX_SSE_BUFFER };
