'use strict';
const { EventEmitter } = require('node:events');
const { VoiceGate } = require('./vad');

// perMinute: rough US dollars per minute of audio billed, for the cost estimate.
// billing: 'audio' = billed for audio sent; 'session' = billed while connected.
const PROVIDERS = {
  deepgram: { label: 'Deepgram (live streaming)', secret: 'deepgram', streaming: true, billing: 'audio', perMinute: 0.0077, speakers: true, defaultModel: 'nova-3' },
  assemblyai: { label: 'AssemblyAI (live streaming)', secret: 'assemblyai', streaming: true, billing: 'session', perMinute: 0.0025, speakers: false, defaultModel: 'universal-streaming-english' },
  groq: { label: 'Groq Whisper (per utterance)', secret: 'groq', streaming: false, billing: 'audio', perMinute: 0.00067, speakers: false, defaultModel: 'whisper-large-v3-turbo', baseUrl: 'https://api.groq.com/openai/v1' },
  openai: { label: 'OpenAI transcription (per utterance)', secret: 'openai', streaming: false, billing: 'audio', perMinute: 0.0045, speakers: false, defaultModel: 'gpt-transcribe', baseUrl: 'https://api.openai.com/v1' },
};

// Wraps a streaming provider so that silence is not sent (and not billed).
// The gate keeps a pre-roll and a one-second tail, so the provider still sees
// enough trailing silence to close each utterance normally.
class GatedStream extends EventEmitter {
  constructor(inner, sampleRate) {
    super();
    this.inner = inner;
    this.gate = new VoiceGate({ sampleRate, hangoverMs: 1000, preRollMs: 400 });
    for (const ev of ['partial', 'final', 'state', 'error']) inner.on(ev, (...a) => this.emit(ev, ...a));
  }
  start() { this.inner.start(); }
  send(pcm) {
    const r = this.gate.process(pcm);
    if (r.audio) this.inner.send(r.audio);
    if (r.closed && this.inner.finalize) this.inner.finalize();
  }
  stop() { return this.inner.stop(); }
  get audioSeconds() { return this.inner.audioSeconds; }
}

// channel: 'me' (microphone) or 'them' (computer audio).
function createStream(sttSettings, getSecret, channel, { baseUrlOverride } = {}) {
  const id = sttSettings.provider;
  const def = typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!def) throw new Error(`Unknown speech-to-text provider: ${id}`);
  const apiKey = getSecret(def.secret);
  if (!apiKey) throw new Error(`No API key saved for ${def.label}. Add one in Settings.`);
  const model = (sttSettings.models && sttSettings.models[id]) || def.defaultModel;
  const common = { apiKey, model, language: sttSettings.language || 'en', keyterms: sttSettings.keyterms || [], sampleRate: 16000 };
  let stream;
  if (id === 'deepgram') {
    const { DeepgramStream } = require('./deepgram');
    // Speaker separation only matters for the meeting audio; the microphone is one person.
    stream = new DeepgramStream({ ...common, diarize: channel === 'them' && sttSettings.identifySpeakers !== false, baseUrl: baseUrlOverride });
    if (sttSettings.skipSilence !== false) stream = new GatedStream(stream, 16000);
  } else if (id === 'assemblyai') {
    const { AssemblyAiStream } = require('./assemblyai');
    stream = new AssemblyAiStream({ ...common, baseUrl: baseUrlOverride });
  } else {
    const { ChunkedStream } = require('./chunked');
    stream = new ChunkedStream({ ...common, baseUrl: baseUrlOverride || def.baseUrl, providerName: def.label.split(' (')[0] });
  }
  stream.providerId = id;
  return stream;
}

function billedMinutes(stream, elapsedSeconds) {
  const id = stream && stream.providerId;
  const def = typeof id === 'string' && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!def) return 0;
  if (def.billing === 'session') {
    const secs = stream.sessionSeconds !== undefined
      ? (stream.sessionSeconds || 0) + (stream.openedAt ? (Date.now() - stream.openedAt) / 1000 : 0)
      : elapsedSeconds;
    return secs / 60;
  }
  return (stream.audioSeconds || 0) / 60;
}

module.exports = { createStream, PROVIDERS, GatedStream, billedMinutes };
