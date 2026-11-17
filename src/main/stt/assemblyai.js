'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://streaming.assemblyai.com/v3/ws';

// AssemblyAI Universal-Streaming (v3). Same events as DeepgramStream.
class AssemblyAiStream extends EventEmitter {
  constructor({ apiKey, model = 'universal-streaming-english', language = 'en', keyterms = [], sampleRate = 16000, baseUrl }) {
    super();
    if (model === 'universal-streaming-english' && language && !/^en/i.test(language)) model = 'universal-streaming-multilingual';
    this.opts = { apiKey, model, keyterms, sampleRate, baseUrl };
    this.ws = null;
    this.closing = false;
    this.fatal = false;
    this.retry = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.pending = new Int16Array(0);
    this.doneTurns = new Set();
    this.unformatted = null; // { order, text, timer }
    this.audioSeconds = 0;
    this.openedAt = 0;
    this.sessionSeconds = 0;
    this.reconnectTimer = null;
    this.hasPartial = false;
  }

  url() {
    const o = this.opts;
    const q = new URLSearchParams({ sample_rate: String(o.sampleRate), encoding: 'pcm_s16le', speech_model: o.model });
    // The Universal-Streaming models format on request; the Pro models always format.
    if (/^universal-streaming/.test(o.model)) q.set('format_turns', 'true');
    const terms = (o.keyterms || []).map((k) => String(k).trim()).filter((k) => k && k.length <= 50).slice(0, 100);
    if (terms.length) q.set('keyterms_prompt', JSON.stringify(terms));
    return `${o.baseUrl || DEFAULT_URL}?${q.toString()}`;
  }

  start() { this.closing = false; this._connect(); }

  _connect() {
    this.emit('state', this.retry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url(), { headers: { Authorization: this.opts.apiKey } });
    this.ws = ws;
    ws.on('open', () => {
      this.doneTurns.clear(); // turn numbers start again from 0 in every session
      this.openedAt = Date.now();
      this.emit('state', 'listening');
      for (const buf of this.queue) ws.send(buf);
      this.queue = []; this.queuedBytes = 0;
    });
    ws.on('message', (raw, isBinary) => { if (!isBinary) this._onMessage(raw.toString()); });
    ws.on('unexpected-response', (_req, res) => {
      this.fatal = [400, 401, 402, 403].includes(res.statusCode);
      this.emit('error', new Error(res.statusCode === 401 || res.statusCode === 403 ? 'AssemblyAI rejected the API key.' : `AssemblyAI refused the connection (HTTP ${res.statusCode}).`));
      try { ws.terminate(); } catch {}
    });
    ws.on('error', (e) => { if (!this.fatal && !this.closing) this.emit('error', new Error(`AssemblyAI connection problem: ${e.message}`)); });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      if (this.openedAt) { this.sessionSeconds += (Date.now() - this.openedAt) / 1000; this.openedAt = 0; }
      this._settleUnformatted();
      if (this.hasPartial) { this.hasPartial = false; this.emit('partial', ''); }
      if (this.closing || this.fatal) { this.emit('state', 'closed'); return; }
      // Close codes as published in AssemblyAI's own SDK.
      const FATAL = { 1008: 'the API key was not accepted', 4001: 'the API key was not accepted', 4002: 'the account has no credit', 4003: 'streaming is not available on this plan', 3009: 'too many sessions are open at once' };
      if (FATAL[code]) {
        this.fatal = true;
        this.emit('error', new Error(`AssemblyAI closed the stream: ${FATAL[code]}.`));
        this.emit('state', 'closed');
        return;
      }
      // 3008 is a session reaching its maximum length: reconnect quietly.
      if (code >= 3000 && code < 5000 && code !== 3008) this.emit('error', new Error(`AssemblyAI closed the stream (${code}${reason && reason.length ? `: ${reason}` : ''}). Reconnecting.`));
      this.retry++;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.closing) this._connect(); }, Math.min(5000, 400 * 2 ** Math.min(this.retry, 4)));
    });
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.retry = 0; // the service is answering
    if (msg.type === 'Begin') this.emit('state', 'ready');
    if (msg.type !== 'Turn') {
      if (msg.type === 'Error' || msg.error) this.emit('error', new Error(`AssemblyAI: ${msg.error || msg.message || 'stream error'}`));
      return;
    }
    const order = msg.turn_order;
    const t = (msg.transcript || '').trim();
    if (this.doneTurns.has(order)) return;
    if (msg.end_of_turn && (msg.turn_is_formatted || !/^universal-streaming/.test(this.opts.model))) {
      this._final(order, t);
    } else if (msg.end_of_turn) {
      // The formatted version of this turn normally follows; if it does not, use this one.
      this._settleUnformatted();
      this.unformatted = { order, text: t, timer: setTimeout(() => this._settleUnformatted(), 1500) };
      if (t) { this.hasPartial = true; this.emit('partial', t); }
    } else if (t) {
      this.hasPartial = true;
      this.emit('partial', t);
    }
  }

  _settleUnformatted() {
    const u = this.unformatted;
    if (!u) return;
    this.unformatted = null;
    clearTimeout(u.timer);
    if (!this.doneTurns.has(u.order)) this._final(u.order, u.text);
  }

  _final(order, text) {
    if (this.unformatted && this.unformatted.order === order) { clearTimeout(this.unformatted.timer); this.unformatted = null; }
    this.doneTurns.add(order);
    const hadPartial = this.hasPartial;
    this.hasPartial = false;
    if (text) this.emit('final', { text, speaker: null });
    else if (hadPartial) this.emit('partial', '');
  }

  send(pcm) {
    if (this.closing || this.fatal) return;
    this.audioSeconds += pcm.length / this.opts.sampleRate;
    // The service requires 50 ms to 1000 ms of audio per message.
    const min = Math.round(this.opts.sampleRate * 0.05);
    let data = pcm;
    if (this.pending.length) { data = new Int16Array(this.pending.length + pcm.length); data.set(this.pending, 0); data.set(pcm, this.pending.length); }
    if (data.length < min) { this.pending = data.slice(); return; }
    this.pending = new Int16Array(0);
    const max = Math.round(this.opts.sampleRate * 0.8);
    for (let off = 0; off < data.length; off += max) {
      let end = Math.min(data.length, off + max);
      if (data.length - end > 0 && data.length - end < min) end = data.length; // never leave a too-short tail
      const part = data.subarray(off, end);
      const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
      else if (!this.fatal && !this.closing) {
        this.queue.push(Buffer.from(buf)); this.queuedBytes += buf.length;
        while (this.queuedBytes > this.opts.sampleRate * 2 * 15 && this.queue.length) this.queuedBytes -= this.queue.shift().length;
      }
      if (end === data.length) break;
    }
  }

  async stop() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { try { ws && ws.terminate(); } catch {} this._settleUnformatted(); return; }
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} done(); }, 2500);
      ws.once('close', done);
      try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { done(); }
    });
    this._settleUnformatted();
  }
}

module.exports = { AssemblyAiStream };
