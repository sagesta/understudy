'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://api.deepgram.com/v1/listen';

// What a listener says while someone else holds the floor. A one-word run of
// one of these between two stretches of the same voice is a real second voice;
// any other lone word there is diarization flicker. Compared after lowercasing
// and dropping everything that is not a letter or digit ("Mm-hmm." = "mmhmm").
const INTERJECTIONS = new Set([
  'yeah', 'yes', 'yep', 'yup', 'no', 'nope', 'right', 'okay', 'ok', 'alright', 'sure', 'mm', 'mhm', 'mmhmm', 'uhhuh', 'hmm',
  'exactly', 'true', 'really', 'wow', 'thanks', 'cool', 'great', 'nice', 'absolutely', 'definitely', 'correct', 'indeed',
  'agreed', 'gotcha', 'oh', 'ah', 'huh', 'sorry',
]);
const squash = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
const isInterjection = (w) => INTERJECTIONS.has(squash(w));

// Cut one utterance's words into runs of the same speaker, one run per turn.
// `words` is [{ text, speaker }] in order. A lone word that is not a listener's
// interjection is noise when it sits between two runs of the same voice or at
// either end of the utterance, and joins its neighbour.
function speakerRuns(words) {
  let runs = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === w.speaker) last.words.push(w); else runs.push({ speaker: w.speaker, words: [w] });
  }
  const lone = (r) => r.words.length === 1 && !isInterjection(r.words[0].text);
  for (let again = true; again && runs.length > 1;) {
    again = false;
    for (let i = 0; i < runs.length; i++) {
      if (!lone(runs[i])) continue;
      const prev = runs[i - 1], next = runs[i + 1];
      if (!prev && next) runs.splice(i, 2, { speaker: next.speaker, words: [...runs[i].words, ...next.words] });
      else if (prev && !next) runs.splice(i - 1, 2, { speaker: prev.speaker, words: [...prev.words, ...runs[i].words] });
      else if (prev && next && prev.speaker === next.speaker) runs.splice(i - 1, 3, { speaker: prev.speaker, words: [...prev.words, ...runs[i].words, ...next.words] });
      else continue;
      again = true;
      break;
    }
  }
  return runs;
}

// The text of one run. At a cut the speaker changes, so a comma or dash hanging
// off the end (or left at the start) belongs to the other voice's sentence and
// is dropped. Nothing is added: Deepgram has already capitalised and punctuated.
function runText(run) {
  return run.words.map((w) => w.text).join(' ').replace(/^[\s,;:\-\u2013\u2014]+/, '').replace(/[\s,;:\-\u2013\u2014]+$/, '');
}

// One live transcription stream (one audio channel).
// Events: 'partial' (text), 'final' ({ text, speaker, epoch }), 'state' (string), 'error' (Error)
// `epoch` counts successful connections. Deepgram numbers speakers afresh on
// each one, so "Speaker 1" in two epochs may be two different people.
class DeepgramStream extends EventEmitter {
  constructor({ apiKey, model = 'nova-3', language = 'en', diarize = false, keyterms = [], sampleRate = 16000, baseUrl }) {
    super();
    this.opts = { apiKey, model, language, diarize, keyterms, sampleRate, baseUrl };
    this.ws = null;
    this.closing = false;
    this.queue = []; // audio waiting for the socket to open
    this.queuedBytes = 0;
    this.segments = [];
    this.speakerVotes = new Map();
    this.words = [];          // [{ text, speaker }] of the final segments, to cut the utterance by voice
    this.wordsUsable = true;  // false when a segment came without per-word speaker numbers
    this.lastAudioAt = 0;
    this.sentAny = false;
    this.audioSeconds = 0;
    this.retry = 0;
    this.keepAlive = null;
    this.reconnectTimer = null;
    this.fatal = false;
    this.epoch = 0;
  }

  url() {
    const o = this.opts;
    const q = new URLSearchParams({
      model: o.model, encoding: 'linear16', sample_rate: String(o.sampleRate), channels: '1',
      interim_results: 'true', smart_format: 'true', endpointing: '300', utterance_end_ms: '1000',
    });
    if (o.language) q.set('language', o.language);
    if (o.diarize) q.set('diarize', 'true');
    const termParam = /^nova-3\b/i.test(String(o.model || '')) ? 'keyterm' : 'keywords';
    for (const k of (o.keyterms || []).slice(0, 80)) if (String(k).trim()) q.append(termParam, String(k).trim());
    return `${o.baseUrl || DEFAULT_URL}?${q.toString()}`;
  }

  start() {
    this.closing = false;
    this._connect();
    this.keepAlive = setInterval(() => {
      // Deepgram closes a stream that receives nothing for 10 seconds.
      // Sent from the start, so a channel nobody has spoken on yet stays connected.
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastAudioAt > 3000) {
        try { this.ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }
    }, 3000);
  }

  _connect() {
    this.emit('state', this.retry ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(this.url(), { headers: { Authorization: `Token ${this.opts.apiKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.epoch++;
      this.emit('state', 'listening');
      for (const buf of this.queue) {
        ws.send(buf);
        this.audioSeconds += (buf.length / 2) / this.opts.sampleRate;
      }
      if (this.queue.length) { this.sentAny = true; this.lastAudioAt = Date.now(); }
      this.queue = []; this.queuedBytes = 0;
    });
    // Only a connection that actually answers counts as healthy; one that opens
    // and is dropped straight away must keep backing off.
    ws.on('message', (raw, isBinary) => { this.retry = 0; if (!isBinary) this._onMessage(raw.toString()); });
    ws.on('unexpected-response', (_req, res) => {
      this.fatal = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 402 || res.statusCode === 400;
      const why = res.statusCode === 401 || res.statusCode === 403 ? 'Deepgram rejected the API key.' : res.statusCode === 402 ? 'Deepgram reports insufficient credit.' : `Deepgram refused the connection (HTTP ${res.statusCode}).`;
      this.emit('error', new Error(why));
      try { ws.terminate(); } catch {}
    });
    ws.on('error', (e) => { if (!this.fatal && !this.closing) this.emit('error', new Error(`Deepgram connection problem: ${e.message}`)); });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this._flush();
      if (code === 1008 || code === 4001 || code === 4003) { this.fatal = true; this.emit('error', new Error('Deepgram closed the connection: the API key was not accepted.')); }
      if (this.closing || this.fatal) { this.emit('state', 'closed'); return; }
      this.retry++;
      if (this.retry === 6) this.emit('error', new Error('Deepgram keeps dropping the connection. Still retrying; check the network and your Deepgram account.'));
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (!this.closing) this._connect(); }, Math.min(5000, 400 * 2 ** Math.min(this.retry, 4)));
    });
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'Results') {
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      const t = alt && alt.transcript ? alt.transcript.trim() : '';
      if (msg.is_final) {
        if (t) {
          this.segments.push(t);
          const ws = Array.isArray(alt.words) ? alt.words : [];
          for (const w of ws) if (typeof w.speaker === 'number') this.speakerVotes.set(w.speaker, (this.speakerVotes.get(w.speaker) || 0) + 1);
          // Splitting by voice needs a speaker on every word; otherwise the whole utterance is one final, as before.
          if (this.opts.diarize && ws.length && ws.every((w) => typeof w.speaker === 'number' && (w.punctuated_word || w.word))) {
            for (const w of ws) this.words.push({ text: String(w.punctuated_word || w.word), speaker: w.speaker });
          } else if (this.opts.diarize) this.wordsUsable = false;
        }
        if (msg.speech_final) this._flush();
        else if (this.segments.length) this.emit('partial', (this.lastPartial = this.segments.join(' ')));
      } else if (t) {
        this.emit('partial', (this.lastPartial = [...this.segments, t].join(' ')));
      }
    } else if (msg.type === 'UtteranceEnd') {
      this._flush();
    } else if (msg.type === 'Error' || msg.type === 'error') {
      this.emit('error', new Error(`Deepgram: ${msg.description || msg.message || 'stream error'}`));
    }
  }

  _flush() {
    if (!this.segments.length) {
      // An interim result that never became a final one must not stay on screen.
      if (this.lastPartial) { this.lastPartial = ''; this.emit('partial', ''); }
      return;
    }
    this.lastPartial = '';
    const text = this.segments.join(' ');
    const words = this.words, usable = this.wordsUsable;
    let speaker = null;
    let top = null;
    if (this.opts.diarize && this.speakerVotes.size) top = [...this.speakerVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    this.segments = [];
    this.speakerVotes = new Map();
    this.words = [];
    this.wordsUsable = true;
    // Each voice in the utterance gets its own final, in the order spoken.
    const runs = this.opts.diarize && usable && words.length ? speakerRuns(words) : [];
    if (runs.length > 1) {
      for (const run of runs) {
        const t = runText(run);
        if (t) this.emit('final', { text: t, speaker: `Speaker ${run.speaker + 1}`, epoch: this.epoch });
      }
      return;
    }
    // One voice (or no usable speaker numbers): the transcript as Deepgram wrote it.
    if (runs.length === 1) top = runs[0].speaker;
    if (top != null) speaker = `Speaker ${top + 1}`;
    this.emit('final', { text, speaker, epoch: this.epoch });
  }

  send(pcm) {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.audioSeconds += pcm.length / this.opts.sampleRate;
      this.ws.send(buf);
      this.sentAny = true;
      this.lastAudioAt = Date.now();
    } else if (!this.fatal && !this.closing) {
      // Hold up to about 15 seconds of audio while (re)connecting.
      this.queue.push(Buffer.from(buf));
      this.queuedBytes += buf.length;
      while (this.queuedBytes > this.opts.sampleRate * 2 * 15 && this.queue.length) this.queuedBytes -= this.queue.shift().length;
    }
  }

  finalize() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.closing) {
      try { this.ws.send(JSON.stringify({ type: 'Finalize' })); } catch {}
    }
  }

  async stop() {
    this.closing = true;
    clearInterval(this.keepAlive);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) { try { ws && ws.terminate(); } catch {} this._flush(); return; }
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} done(); }, 2000);
      ws.once('close', done);
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { done(); }
    });
    this._flush();
  }
}

module.exports = { DeepgramStream, speakerRuns, INTERJECTIONS };
