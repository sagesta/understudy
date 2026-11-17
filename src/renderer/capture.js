'use strict';
// Hidden window that owns the audio devices. Two independent inputs:
//   me   - the chosen microphone (built-in, USB, headset...)
//   them - everything the computer plays (Zoom, Teams, Meet, a browser tab...)
// Each is resampled to 16 kHz mono by the AudioContext and sent to the main
// process in 100 ms blocks.

let ctx = null;
let active = [];          // [{ channel, stream, source, node }]
let levels = { me: 0, them: 0 };
let levelTimer = null;
let wanted = null;
const retryTimers = {};   // one per channel: both can drop at the same moment
const retries = { me: 0, them: 0 };
const opening = { me: false, them: false };
let outputLabel = null;   // the default playback device when capture started
let themPeak = 0;
let hintTimer = null;
let deviceTimer = null;

function report(channels, message) { window.api.captureStatus({ channels, message }); }

async function micStream(deviceId) {
  // No processing: automatic gain in particular can move the Windows input
  // level, which the meeting app is using too.
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  if (deviceId && deviceId !== 'default') {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } }, video: false }); }
    catch (e) { if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e; /* that device is gone: fall back to the default */ }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
}

async function systemStream() {
  let stream;
  try {
    // The main process answers this request with "first screen + computer audio".
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (first) {
    // Older capture path, kept as a second attempt.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop' } },
    }).catch(() => { throw first; });
  }
  // Only the sound is wanted; stop capturing the picture straight away.
  for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
  if (!stream.getAudioTracks().length) throw new Error('the system returned no audio track');
  return stream;
}

function attach(channel, stream) {
  for (const old of active.filter((a) => a.channel === channel)) detach(old);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-collector', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  node.port.onmessage = (e) => {
    if (e.data.peak > levels[channel]) levels[channel] = e.data.peak;
    if (channel === 'them' && e.data.peak > themPeak) themPeak = e.data.peak;
    window.api.sendAudio(channel, new Uint8Array(e.data.pcm));
  };
  // A silent path to the output keeps the graph running.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node); node.connect(mute); mute.connect(ctx.destination);
  const entry = { channel, stream, source, node, mute };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      // Headset unplugged, device disabled, output device changed...
      if (!active.includes(entry)) return;
      detach(entry);
      report({ [channel]: 'lost' }, channel === 'me' ? 'The microphone was disconnected. Trying the default microphone.' : 'Computer audio capture stopped. Trying to restart it.');
      retries[channel] = 0;
      scheduleRetry(channel, 1200);
    });
  }
  active.push(entry);
}

function detach(entry) {
  active = active.filter((a) => a !== entry);
  try { entry.node.port.postMessage('stop'); } catch {}
  try { entry.source.disconnect(); entry.node.disconnect(); entry.mute.disconnect(); entry.node.port.onmessage = null; } catch {}
  for (const t of entry.stream.getTracks()) { try { t.stop(); } catch {} }
}

function scheduleRetry(channel, delay, gen = startGen) {
  clearTimeout(retryTimers[channel]);
  retryTimers[channel] = setTimeout(() => open(channel, true, gen), delay);
}

async function defaultOutputLabel() {
  try {
    const out = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const def = out.find((d) => d.deviceId === 'default') || out[0];
    return def ? def.label || def.deviceId : '';
  } catch { return ''; }
}

async function open(channel, fallback, gen = startGen) {
  if (!wanted || !ctx || gen !== startGen || opening[channel]) return;
  opening[channel] = true;
  try {
    const stream = channel === 'me' ? await micStream(fallback ? 'default' : wanted.micDeviceId) : await systemStream();
    if (!wanted || !ctx || gen !== startGen) { for (const t of stream.getTracks()) { try { t.stop(); } catch {} } return; } // stopped while opening
    attach(channel, stream);
    retries[channel] = 0;
    if (channel === 'them') outputLabel = await defaultOutputLabel();
    if (gen === startGen && wanted) report({ [channel]: 'on' });
  } catch (e) {
    if (gen !== startGen || !wanted) return;
    // After a device change the system can take a few seconds to settle.
    if (fallback && retries[channel] < 4) { retries[channel] += 1; scheduleRetry(channel, 1500 * retries[channel], gen); return; }
    const what = channel === 'me' ? 'The microphone could not be opened' : 'Computer audio could not be captured';
    const hint = channel === 'me' ? ' Check that a microphone is connected and that Windows allows desktop apps to use it (Settings > Privacy & security > Microphone).' : '';
    report({ [channel]: 'error' }, `${what}: ${e.message || e.name}.${hint}`);
  } finally {
    if (gen === startGen) opening[channel] = false;
  }
}

let startGen = 0;   // a newer start or a stop makes an older, still-starting one give up
window.startCapture = async function startCapture(opts) {
  await window.stopCapture();   // also invalidates any start that is still in progress
  const gen = ++startGen;
  wanted = opts;
  const mine = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  ctx = mine;
  await mine.audioWorklet.addModule('pcm-worklet.js');
  if (gen !== startGen) { try { await mine.close(); } catch {} return false; }
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  if (gen !== startGen) { try { await mine.close(); } catch {} return false; }
  report({ me: opts.mic ? 'starting' : 'off', them: opts.system ? 'starting' : 'off' });
  await Promise.all([opts.mic ? open('me', false, gen) : null, opts.system ? open('them', false, gen) : null]);
  if (gen !== startGen || wanted !== opts) return false; // stopped while opening
  levelTimer = setInterval(() => { window.api.captureStatus({ levels }); levels = { me: 0, them: 0 }; }, 250);
  // Computer audio is taken from the Windows default playback device. If a
  // meeting app plays somewhere else, this stays at absolute zero.
  themPeak = 0;
  clearTimeout(hintTimer);
  if (opts.system) hintTimer = setTimeout(() => {
    if (wanted && themPeak === 0 && active.some((a) => a.channel === 'them')) window.api.captureStatus({ hint: "No sound has come from the computer yet. If people are talking, set your meeting app's speaker to the Windows default output device (or change the Windows default to the device you are listening on)." });
  }, 75000);
  return true;
};

window.stopCapture = async function stopCapture() {
  startGen += 1;
  wanted = null;
  opening.me = false;
  opening.them = false;
  clearInterval(levelTimer); clearTimeout(hintTimer); clearTimeout(deviceTimer);
  for (const k of Object.keys(retryTimers)) clearTimeout(retryTimers[k]);
  for (const entry of [...active]) detach(entry);
  if (ctx) { try { await ctx.close(); } catch {} ctx = null; }
  return true;
};

// The default playback device changed (headset plugged in, output switched in
// Windows): computer audio has to be reopened to follow it, and a missing mic is retried.
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearTimeout(deviceTimer);
  const gen = startGen;
  deviceTimer = setTimeout(async () => {
    if (!wanted || !ctx || gen !== startGen) return;
    if (wanted.mic && !active.some((a) => a.channel === 'me') && !opening.me) {
      retries.me = 0;
      scheduleRetry('me', 300, gen);
    }
    if (!wanted.system) return;
    const now = await defaultOutputLabel();
    if (!wanted || !wanted.system || !ctx || gen !== startGen) return;
    const entry = active.find((a) => a.channel === 'them');
    if (!entry) { if (!opening.them) { retries.them = 0; scheduleRetry('them', 300, gen); } return; }
    if (now && outputLabel != null && now !== outputLabel) { detach(entry); retries.them = 0; scheduleRetry('them', 300, gen); }
  }, 1500);
});
