'use strict';
const { EventEmitter } = require('node:events');
const { VoiceGate } = require('./vad');
const { pcm16ToWav } = require('./wav');

// For providers that transcribe one clip at a time through an
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq). The voice
// gate cuts the stream into utterances; each is sent as soon as it ends, and
// results are delivered in the order they were spoken.
//
// Whisper-family models tend to invent a stock phrase when handed a clip with
// no speech in it. Those are dropped for very short clips.
const PHANTOMS = new Set(['thank you.', 'thank you', 'thanks for watching.', 'thanks for watching!', 'you', 'bye.', '.', 'thank you for watching.', 'okay.', 'so']);
const isPhantom = (text, seconds) => /^terms that may be spoken:/i.test(text) || (seconds < 2 && PHANTOMS.has(text.toLowerCase()));

// What to do when the provider cannot keep up with speech. In a live meeting
// the most recent speech, in order, is worth more than a complete record that
// arrives minutes late, so the delay behind the speaker is capped rather than
// allowed to grow:
//   1. A backlog (3 clips or 8 s waiting) lets up to 4 requests run at once
//      instead of 2 (while under MAX_INFLIGHT_S of audio is out), and adjacent
//      waiting clips are sent as one longer request (up to 12 s), which costs
//      one round trip instead of several.
//   2. If more than 10 s of audio or 6 clips are still waiting, the OLDEST
//      waiting clips are dropped, never the newest. A dropped stretch becomes
//      a visible gap marker in its place in the transcript.
//   3. The user is told once when this starts and once when it has passed,
//      not on every dropped clip.
//   4. A 429 pauses sending for the time the provider asks (Retry-After) and
//      drops to one request at a time for a while; the same limits above keep
//      the waiting audio, and therefore memory, bounded while paused.
// Memory is bounded too: waiting audio is at most MAX_QUEUED_S plus the newest
// clip (20 s at the very most), and what is in flight is two clips plus at most
// MAX_INFLIGHT_S of extra requests: about 2.5 MB at the very worst, typically 0.5 MB.
// With a provider 30% slower than speech the transcript settles about 15-22 s
// behind, where it used to fall further behind for as long as the meeting ran.
const MAX_QUEUED_S = 10;
const MAX_QUEUED_JOBS = 6;
const BACKLOG_S = 8;
const BACKLOG_JOBS = 3;
const MERGE_MAX_S = 12;
const MAX_INFLIGHT_S = 10;              // extra requests only start while less than this much audio is out
const BASE_INFLIGHT = 2;
const MAX_INFLIGHT = 4;
const RATE_LIMIT_ATTEMPTS = 3;          // a clip that keeps being refused is reported as an error
const RATE_LIMIT_SLOW_MS = 30000;       // one request at a time for this long after a 429
const RATE_LIMIT_DEFAULT_MS = 2000;     // when a 429 carries no Retry-After
const RATE_LIMIT_MAX_MS = 120000;
const RECOVER_MS = 5000;                // caught up and no drops for this long = recovered
const BEHIND_MESSAGE = 'Transcription is running behind, so some speech was skipped. The speech provider is slow or limiting requests.';
const RECOVERED_MESSAGE = 'Transcription has caught up.';

class ChunkedStream extends EventEmitter {
  // `clock` is for tests: { now, setTimeout, clearTimeout }.
  constructor({ apiKey, baseUrl, model, language = 'en', keyterms = [], sampleRate = 16000, providerName = 'Speech-to-text', timeoutMs = 15000, stopWaitMs = 6000, clock = null }) {
    super();
    this.opts = { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model, language, keyterms, sampleRate, providerName };
    this.gate = new VoiceGate({ sampleRate, hangoverMs: 700, preRollMs: 300 });
    this.clock = clock || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.parts = [];
    this.samples = 0;
    this.audioSeconds = 0;
    this.closing = false;
    this.stopped = false;
    this.failures = 0;
    this.timeoutMs = timeoutMs;
    this.stopWaitMs = stopWaitMs;
    this.inflight = 0;
    this.order = [];          // every clip not yet delivered, oldest first: queued | running | done
    this.pausedUntil = 0;     // a 429 told us to wait until then
    this.limitedUntil = 0;
    this.pumpTimer = null;
    this.behind = false;      // inside an episode of skipping speech
    this.lastDropAt = 0;
    this.recoverTimer = null;
    this.idleWaiters = [];
    this.aborts = new Set();
  }

  start() { this.emit('state', 'listening'); }

  send(pcm) {
    const r = this.gate.process(pcm);
    if (r.audio) { this.parts.push(r.audio); this.samples += r.audio.length; }
    if (r.opened || (this.gate.open && this.samples)) this.emit('partial', '…');
    const tooLong = this.samples > this.opts.sampleRate * 20;
    if ((r.closed || tooLong) && this.samples) this._cut();
  }

  _cut() {
    const pcm = new Int16Array(this.samples);
    let p = 0; for (const a of this.parts) { pcm.set(a, p); p += a.length; }
    this.parts = []; this.samples = 0;
    const seconds = pcm.length / this.opts.sampleRate;
    if (seconds < 0.35) { this.emit('partial', ''); return; }
    this.order.push({ pcm, seconds, at: this.clock.now(), state: 'queued', attempts: 0, billed: false, res: null });
    this._enforceLimits();
    this._pump();
  }

  // Drops the oldest waiting clips until the backlog is within limits. The
  // newest clip always stays, however long it is.
  _enforceLimits() {
    const q = this.order.filter((j) => j.state === 'queued');
    let secs = q.reduce((n, j) => n + j.seconds, 0);
    while (q.length > 1 && (q.length > MAX_QUEUED_JOBS || secs > MAX_QUEUED_S)) {
      const old = q.shift();
      secs -= old.seconds;
      const at = this.order.indexOf(old);
      const before = this.order[at - 1];
      if (before && before.gap) { before.seconds += old.seconds; this.order.splice(at, 1); } // one marker per unbroken run
      else this.order[at] = { gap: true, state: 'done', seconds: old.seconds, res: null };
      this._noteDrop();
    }
  }

  _noteDrop() {
    this.lastDropAt = this.clock.now();
    if (this.behind) return;
    this.behind = true;
    this.emit('state', 'behind');
    this._notice(BEHIND_MESSAGE);
  }

  // Travels as a non-fatal 'error', the one channel the overlay already shows.
  // `notice` lets the session skip its repeat-error throttle for these.
  _notice(message) {
    if (!this.listenerCount('error')) return;
    this.emit('error', Object.assign(new Error(message), { notice: true }));
  }

  _checkRecovered() {
    if (!this.behind || this.closing || this.order.length) return;
    const wait = RECOVER_MS - (this.clock.now() - this.lastDropAt);
    if (wait > 0) {
      if (this.recoverTimer) return;
      this.recoverTimer = this.clock.setTimeout(() => { this.recoverTimer = null; this._checkRecovered(); }, wait);
      if (this.recoverTimer && this.recoverTimer.unref) this.recoverTimer.unref();
      return;
    }
    this.behind = false;
    this.emit('state', 'listening');
    this._notice(RECOVERED_MESSAGE);
  }

  _pump() {
    if (this.stopped) return;
    for (;;) {
      const now = this.clock.now();
      if (now < this.pausedUntil) {
        if (!this.pumpTimer) {
          this.pumpTimer = this.clock.setTimeout(() => { this.pumpTimer = null; this._pump(); }, this.pausedUntil - now);
          if (this.pumpTimer && this.pumpTimer.unref) this.pumpTimer.unref();
        }
        return;
      }
      const queued = this.order.filter((j) => j.state === 'queued');
      if (!queued.length) return;
      const backlog = queued.length >= BACKLOG_JOBS || queued.reduce((n, j) => n + j.seconds, 0) >= BACKLOG_S;
      const limit = now < this.limitedUntil ? 1 : backlog ? MAX_INFLIGHT : BASE_INFLIGHT;
      if (this.inflight >= limit) return;
      // Beyond the usual two, more requests only help a provider that serves them in parallel;
      // one that does not would just make every answer wait behind all the others.
      if (this.inflight >= BASE_INFLIGHT && this.order.reduce((n, j) => n + (j.state === 'running' ? j.seconds : 0), 0) >= MAX_INFLIGHT_S) return;
      const job = queued[0];
      if (backlog) this._mergeFrom(job);
      job.state = 'running';
      this.inflight++;
      this._run(job);
    }
  }

  // Folds the clips queued right behind `job` into it, up to MERGE_MAX_S.
  _mergeFrom(job) {
    const at = this.order.indexOf(job) + 1;
    while (at < this.order.length) {
      const next = this.order[at];
      if (next.state !== 'queued' || job.seconds + next.seconds > MERGE_MAX_S) break;
      const pcm = new Int16Array(job.pcm.length + next.pcm.length);
      pcm.set(job.pcm, 0); pcm.set(next.pcm, job.pcm.length);
      job.pcm = pcm; job.seconds += next.seconds; job.at = next.at; // `at`: when the newest speech in it ended
      this.order.splice(at, 1);
    }
  }

  async _run(job) {
    if (!job.billed) { job.billed = true; this.audioSeconds += job.seconds; }
    let res;
    try { res = await this._transcribe(job.pcm, job); } catch (e) { res = { error: e }; }
    this.inflight--;
    const wait = res.error && res.error.retryAfterMs;
    if (wait != null && !this.stopped && job.attempts++ < RATE_LIMIT_ATTEMPTS - 1) {
      // Rate limited: hold everything for as long as the provider asked, then
      // try this clip again first. Newer speech keeps queueing meanwhile, and
      // the limits above decide what is too old to be worth sending.
      const now = this.clock.now();
      this.pausedUntil = Math.max(this.pausedUntil, now + wait);
      this.limitedUntil = now + RATE_LIMIT_SLOW_MS;
      job.state = 'queued';
      this._enforceLimits();
    } else {
      job.state = 'done'; job.res = res; job.pcm = null;
    }
    this._deliver();
    this._pump();
  }

  _deliver() {
    if (this.stopped) return;
    while (this.order.length && this.order[0].state === 'done') {
      const job = this.order.shift();
      if (job.gap) {
        const s = Math.max(1, Math.round(job.seconds));
        this.emit('final', { text: `[Transcription fell behind here, so about ${s} second${s === 1 ? '' : 's'} of speech was skipped.]`, speaker: null, gap: true });
        continue;
      }
      const res = job.res;
      if (res.error) {
        this.failures++;
        this.emit('partial', ''); // do not leave the "…" marker on screen
        if (this.listenerCount('error')) this.emit('error', res.error);
      } else {
        this.failures = 0;
        const text = (res.text || '').trim();
        if (text && !isPhantom(text, job.seconds)) this.emit('final', { text, speaker: null });
        else this.emit('partial', '');
      }
    }
    if (!this.order.length) {
      const waiters = this.idleWaiters; this.idleWaiters = [];
      for (const w of waiters) w();
      this._checkRecovered();
    }
  }

  async _transcribe(pcm) {
    const o = this.opts;
    const form = new FormData();
    form.append('file', new Blob([pcm16ToWav(pcm, o.sampleRate)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', o.model);
    if (o.language && o.language !== 'multi') form.append('language', o.language.slice(0, 2));
    if (o.keyterms && o.keyterms.length) form.append('prompt', `Terms that may be spoken: ${o.keyterms.slice(0, 60).join(', ')}.`);
    // A request that never answers must not hold up everything behind it:
    // it times out after 15 s, and a failing server gets one retry. A 429 is
    // not retried here: the caller waits as long as Retry-After says and
    // decides whether the clip is still worth sending.
    let res = null;
    let failure = null;
    const stopAbort = new AbortController();
    this.aborts.add(stopAbort);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (stopAbort.signal.aborted) break;
        try {
          res = await fetch(`${o.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${o.apiKey}` },
            body: form,
            signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), stopAbort.signal]),
          });
          failure = null;
          if (res.status === 429 || res.status < 500) break;
          if (attempt === 0) await res.arrayBuffer().catch(() => {});
        } catch (e) {
          failure = e;
          res = null;
        }
        if (stopAbort.signal.aborted) break;
        if (attempt === 0) {
          await new Promise((r) => {
            const t = this.clock.setTimeout(r, 800);
            stopAbort.signal.addEventListener('abort', () => { this.clock.clearTimeout(t); r(); }, { once: true });
          });
        }
      }
    } finally {
      this.aborts.delete(stopAbort);
    }
    if (failure) {
      const timedOut = failure.name === 'TimeoutError' || (stopAbort.signal.aborted && stopAbort.signal.reason && stopAbort.signal.reason.name === 'TimeoutError');
      throw new Error(`Could not reach ${o.providerName}: ${timedOut ? 'no answer in time' : failure.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body;
      try { const j = JSON.parse(body); detail = (j.error && j.error.message) || body; } catch {}
      if (res.status === 401 || res.status === 403) throw new Error(`${o.providerName} rejected the API key.`);
      const err = new Error(`${o.providerName} returned ${res.status}: ${String(detail).slice(0, 200)}`);
      if (res.status === 429) err.retryAfterMs = retryAfterMs(res.headers.get('retry-after'), this.clock.now());
      throw err;
    }
    const j = await res.json();
    return { text: j.text || '' };
  }

  _idle() { return this.order.length ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve(); }

  async stop() {
    this.closing = true;
    if (this.samples) this._cut();
    // Wait for what is already in flight, but never for long. Whatever has not
    // been sent by then is dropped: a clip that has not even started is not
    // worth holding the end of the meeting for.
    let timer;
    await Promise.race([this._idle(), new Promise((r) => { timer = this.clock.setTimeout(r, this.stopWaitMs); })]);
    this.clock.clearTimeout(timer);
    if (this.aborts.size) {
      const reason = Object.assign(new Error('no answer in time'), { name: 'TimeoutError' });
      for (const ac of [...this.aborts]) ac.abort(reason);
      let drain;
      await Promise.race([this._idle(), new Promise((r) => { drain = this.clock.setTimeout(r, 50); })]);
      this.clock.clearTimeout(drain);
    }
    this.stopped = true;
    this.order = this.order.filter((j) => j.state !== 'queued');
    for (const t of [this.pumpTimer, this.recoverTimer]) if (t) this.clock.clearTimeout(t);
    this.pumpTimer = this.recoverTimer = null;
    this.emit('state', 'closed');
  }
}

// Retry-After is seconds or an HTTP date; a missing or unreadable one gets a short default.
function retryAfterMs(value, now) {
  let ms = RATE_LIMIT_DEFAULT_MS;
  if (value != null && String(value).trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) ms = n * 1000;
    else { const d = Date.parse(value); if (Number.isFinite(d)) ms = d - now; }
  }
  return Math.min(RATE_LIMIT_MAX_MS, Math.max(0, ms));
}

module.exports = { ChunkedStream, LIMITS: { MAX_QUEUED_S, MAX_QUEUED_JOBS, BACKLOG_S, BACKLOG_JOBS, MERGE_MAX_S, BASE_INFLIGHT, MAX_INFLIGHT, MAX_INFLIGHT_S, RECOVER_MS }, BEHIND_MESSAGE, RECOVERED_MESSAGE };
