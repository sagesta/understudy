'use strict';
// Energy-based voice gate over 16-bit mono PCM.
//
// Two uses: (1) skip silence so a streaming speech-to-text provider is only
// billed for audio that has speech in it, and (2) cut utterances for
// providers that transcribe one clip at a time.
//
// It errs towards letting audio through: a pre-roll keeps the start of each
// word, a hangover keeps trailing syllables, and the threshold follows the
// room's noise floor rather than a fixed level.

class VoiceGate {
  constructor({ sampleRate = 16000, frameMs = 20, preRollMs = 400, hangoverMs = 1000, minDb = -66, marginDb = 9 } = {}) {
    this.frame = Math.round(sampleRate * frameMs / 1000);
    this.frameMs = frameMs;
    this.preRollFrames = Math.ceil(preRollMs / frameMs);
    this.hangoverFrames = Math.ceil(hangoverMs / frameMs);
    this.minDb = minDb;
    this.marginDb = marginDb;
    // The room's noise floor is the quietest half-second seen in the last ten
    // seconds. A steady fan or hold music sets it, so it stops counting as
    // speech; and because it is a minimum, speech does not raise it much.
    this.noiseDb = -60;
    this.bucketFrames = Math.max(1, Math.round(500 / frameMs));
    this.ring = new Array(20).fill(Infinity);
    this.ringAt = 0;
    this.bucketMin = Infinity;
    this.bucketN = 0;
    this.open = false;
    this.quiet = 0;
    this.recent = []; // last 5 frame decisions
    this.preRoll = [];
    this.carry = new Int16Array(0);
  }

  static frameDb(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) { const s = frame[i] / 32768; sum += s * s; }
    const rms = Math.sqrt(sum / frame.length);
    return rms > 0 ? 20 * Math.log10(rms) : -100;
  }

  // Feed PCM; returns { audio: Int16Array|null, opened, closed }.
  // `audio` is what should be forwarded (includes pre-roll when the gate opens).
  process(pcm) {
    let data = pcm;
    if (this.carry.length) {
      data = new Int16Array(this.carry.length + pcm.length);
      data.set(this.carry, 0); data.set(pcm, this.carry.length);
    }
    const out = [];
    let opened = false, closed = false;
    let off = 0;
    for (; off + this.frame <= data.length; off += this.frame) {
      const frame = data.subarray(off, off + this.frame);
      const db = VoiceGate.frameDb(frame);
      const threshold = Math.max(this.minDb, this.noiseDb + this.marginDb);
      const loud = db > threshold;
      if (db < this.bucketMin) this.bucketMin = db;
      if (++this.bucketN >= this.bucketFrames) {
        this.ring[this.ringAt] = this.bucketMin;
        this.ringAt = (this.ringAt + 1) % this.ring.length;
        this.bucketMin = Infinity; this.bucketN = 0;
        this.noiseDb = Math.min(-42, Math.max(-80, Math.min(...this.ring)));
      }

      this.recent.push(loud); if (this.recent.length > 5) this.recent.shift();
      if (!this.open) {
        this.preRoll.push(frame.slice());
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        if (this.recent.filter(Boolean).length >= 3) {
          this.open = true; opened = true; this.quiet = 0;
          out.push(...this.preRoll); this.preRoll = [];
        }
      } else {
        out.push(frame.slice());
        this.quiet = loud ? 0 : this.quiet + 1;
        if (this.quiet >= this.hangoverFrames) { this.open = false; closed = true; this.recent = []; }
      }
    }
    this.carry = data.slice(off);
    if (!out.length) return { audio: null, opened, closed };
    const total = out.reduce((n, f) => n + f.length, 0);
    const audio = new Int16Array(total);
    let p = 0; for (const f of out) { audio.set(f, p); p += f.length; }
    return { audio, opened, closed };
  }
}

module.exports = { VoiceGate };
