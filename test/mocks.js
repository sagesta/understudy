'use strict';
// Local stand-ins for the cloud services, speaking each provider's wire format.
const http = require('node:http');
const { WebSocketServer } = require('ws');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
}

function sse(res, records) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const r of records) res.write(`${r.event ? `event: ${r.event}\n` : ''}data: ${JSON.stringify(r.data)}\n\n`);
  res.end();
}

// reply: (requestJson, path) => string | { text, status, error, delayMs }
async function mockLlm(reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw.toString() || '{}'); } catch {}
    calls.push({ url: req.url, headers: req.headers, body });
    let r = reply(body, req.url, calls.length);
    if (typeof r === 'string') r = { text: r };
    if (r.status && r.status !== 200) {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: r.error || 'bad request' } }));
      return;
    }
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    const words = r.text.split(/(?<= )/);
    if (req.url.includes('/v1/messages')) {
      const recs = [{ event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }];
      for (const w of words) recs.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } } });
      recs.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
      recs.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: r.stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: words.length } } });
      recs.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return sse(res, recs);
    }
    if (req.url.includes('/responses')) {
      const recs = [{ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } }];
      for (const w of words) recs.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: w } });
      recs.push({ event: 'response.completed', data: { type: 'response.completed', response: { model: body.model, usage: { input_tokens: 200, output_tokens: words.length, input_tokens_details: { cached_tokens: 50 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: r.text, annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'Example' }] }] }] } } });
      return sse(res, recs);
    }
    if (req.url.includes(':streamGenerateContent')) {
      const recs = words.map((w) => ({ data: { candidates: [{ content: { role: 'model', parts: [{ text: w }] } }] } }));
      recs.push({ data: { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/g', title: 'G' } }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: words.length, thoughtsTokenCount: 2 } } });
      return sse(res, recs);
    }
    if (req.url.includes('/audio/transcriptions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ text: r.text }));
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

// A Deepgram-shaped live endpoint. After `silenceMs` without audio it emits
// the next scripted line as an interim result, a final result and speech_final.
async function mockDeepgram(lines, { silenceMs = 120, speaker = 0 } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const stats = { connections: 0, bytes: 0, keepAlives: 0, urls: [], auth: [] };
  let next = 0;
  wss.on('connection', (ws, req) => {
    stats.connections++; stats.urls.push(req.url); stats.auth.push(req.headers.authorization);
    let timer = null;
    let got = 0;
    const result = (transcript, isFinal, speechFinal) => ws.send(JSON.stringify({ type: 'Results', is_final: isFinal, speech_final: speechFinal, channel: { alternatives: [{ transcript, words: transcript.split(' ').map((w) => ({ word: w, speaker })) }] } }));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString());
        if (m.type === 'KeepAlive') stats.keepAlives++;
        if (m.type === 'CloseStream') ws.close();
        return;
      }
      stats.bytes += data.length; got += data.length;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (got < 6400 || next >= lines.length) return; // need at least 200 ms of audio
        got = 0;
        const line = lines[next++];
        const half = line.split(' ').slice(0, Math.ceil(line.split(' ').length / 2)).join(' ');
        result(half, false, false);
        result(line, true, true);
      }, silenceMs);
    });
    ws.on('close', () => clearTimeout(timer));
  });
  const port = await listen(server);
  return { url: `ws://127.0.0.1:${port}/v1/listen`, stats, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); }) };
}

async function mockAssemblyAi(lines) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const stats = { urls: [], auth: [], sizes: [], terminated: 0 };
  wss.on('connection', (ws, req) => {
    stats.urls.push(req.url); stats.auth.push(req.headers.authorization);
    ws.send(JSON.stringify({ type: 'Begin', id: 's1', expires_at: 0 }));
    let n = 0, order = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { const m = JSON.parse(data.toString()); if (m.type === 'Terminate') { stats.terminated++; ws.send(JSON.stringify({ type: 'Termination', audio_duration_seconds: 1, session_duration_seconds: 1 })); ws.close(); } return; }
      stats.sizes.push(data.length);
      if (++n % 5 === 0 && order < lines.length) {
        const line = lines[order];
        ws.send(JSON.stringify({ type: 'Turn', turn_order: order, transcript: line.toLowerCase().replace(/[?.,]/g, ''), end_of_turn: false, turn_is_formatted: false }));
        ws.send(JSON.stringify({ type: 'Turn', turn_order: order, transcript: line.toLowerCase().replace(/[?.,]/g, ''), end_of_turn: true, turn_is_formatted: false }));
        ws.send(JSON.stringify({ type: 'Turn', turn_order: order, transcript: line, end_of_turn: true, turn_is_formatted: true }));
        order++;
      }
    });
  });
  const port = await listen(server);
  return { url: `ws://127.0.0.1:${port}/v3/ws`, stats, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); }) };
}

module.exports = { mockLlm, mockDeepgram, mockAssemblyAi };
