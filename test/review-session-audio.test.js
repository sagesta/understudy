'use strict';
// Batch 1 regressions: VoiceGate 0 dBFS ceiling, STT streams, session lifecycle and company-fact
// guardrails, transcript/recall/triggers edge cases, Tailscale-only remote scope, and IPC validators.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { VoiceGate } = require('../src/main/stt/vad');
const { pcm16ToWav, wavToPcm16 } = require('../src/main/stt/wav');
const { PROVIDERS: STT_PROVIDERS, GatedStream, createStream, billedMinutes } = require('../src/main/stt');
const { DeepgramStream } = require('../src/main/stt/deepgram');
const { AssemblyAiStream } = require('../src/main/stt/assemblyai');
const { ChunkedStream } = require('../src/main/stt/chunked');
const { Transcript, MeetingRecall, wordCount } = require('../src/main/transcript');
const { buildNamePrompt, parseNameSuggestions } = require('../src/main/speaker-names');
const { analyzeTurn, splitSentences } = require('../src/main/triggers');
const { MeetingSession } = require('../src/main/session');
const { Settings } = require('../src/main/settings');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { isTailscaleOrLoopback } = require('../src/main/network-detect');
const { createListener } = require('../src/main/remote-link');
const V = require('../src/main/validate');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-rev-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const plainCrypto = { available: () => false };
const tone = (seconds, db, rate = 16000) => {
  const amp = Math.min(32767, Math.round(Math.pow(10, db / 20) * 32768 * Math.SQRT2));
  return Int16Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * amp));
};

test('isTailscaleOrLoopback accepts only Tailscale and loopback addresses and listener refuses wildcard/LAN binds', async () => {
  const valid = [
    '100.64.0.0', '100.64.1.2', '100.101.44.9', '100.127.255.255',
    'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:ab12:4843:cd96:6258:b240',
    '127.0.0.1', '127.0.0.0', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1',
    '::ffff:100.64.1.2', '::ffff:127.0.0.1',
  ];
  for (const ip of valid) assert.equal(isTailscaleOrLoopback(ip), true, ip);

  const rejected = [
    '', '0.0.0.0', '::', '0:0:0:0:0:0:0:0',
    '192.168.1.10', '10.0.0.5', '172.16.0.1', '8.8.8.8', '255.255.255.255',
    '100.63.255.255', '100.128.0.0', '::ffff:192.168.1.10', '::127.0.0.1',
    'fd7a:115c:a1e1::1', '2001:db8::1', 'fe80::1', 'fe80::1%eth0', 'example.com',
  ];
  for (const ip of rejected) assert.equal(isTailscaleOrLoopback(ip), false, ip);

  for (const host of ['0.0.0.0', '::', '192.168.1.10', '8.8.8.8']) {
    const link = createListener({ token: 't'.repeat(24), host, port: 47615 });
    await assert.rejects(link.listen(), /Tailscale or loopback/);
  }
});

test('VoiceGate: 0 dBFS clipping and loud audio never push threshold above -33 dBFS', () => {
  const rate = 16000;
  const gate = new VoiceGate({ sampleRate: rate });
  // Feed 12 seconds of full-scale 0 dBFS clipping (-32768) to fill all 20 half-second buckets.
  const fullScale = new Int16Array(rate * 12).fill(-32768);
  gate.process(fullScale);
  assert.ok(gate.noiseDb <= -42, `noiseDb capped at -42, got ${gate.noiseDb}`);
  // Feed 2 seconds of silence so the gate closes cleanly.
  gate.process(new Int16Array(rate * 2));
  assert.equal(gate.open, false);
  // Speech at -24 dBFS (above -33 dBFS threshold) must still open the gate immediately.
  const res = gate.process(tone(0.5, -24, rate));
  assert.equal(res.opened, true);
  assert.ok(res.audio && res.audio.length > 0);
});

test('wavToPcm16 handles undersized or truncated fmt chunks without throwing RangeError', () => {
  const valid = pcm16ToWav(Int16Array.from([100, -100, 200, -200]), 16000);
  assert.equal(wavToPcm16(valid).pcm.length, 4);

  // Build a WAV with an 8-byte fmt chunk followed by a valid data chunk.
  const buf = Buffer.alloc(12 + 8 + 8 + 8 + 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(8, 16);
  buf.write('data', 28);
  buf.writeUInt32LE(4, 32);
  buf.writeInt16LE(42, 36);
  buf.writeInt16LE(-42, 38);
  const parsed = wavToPcm16(buf);
  assert.deepEqual([...parsed.pcm], [42, -42]);
  assert.equal(parsed.sampleRate, 16000);
});

test('DeepgramStream, GatedStream, AssemblyAiStream, ChunkedStream and stt index hardening', async () => {
  assert.equal(STT_PROVIDERS.openai.perMinute, 0.0045);
  assert.throws(() => createStream({ provider: 'toString' }, () => 'k', 'me'), /Unknown speech-to-text provider/);

  const dg3 = new DeepgramStream({ apiKey: 'k', model: 'nova-3', keyterms: ['Kyverno'] });
  assert.match(dg3.url(), /[?&]keyterm=Kyverno/);
  const dg2 = new DeepgramStream({ apiKey: 'k', model: 'nova-2', keyterms: ['Kyverno'] });
  assert.match(dg2.url(), /[?&]keywords=Kyverno/);

  // GatedStream calls inner.finalize() when the gate closes after speech.
  let finalized = 0;
  const inner = Object.assign(new EventEmitter(), {
    audioSeconds: 0,
    start() {},
    send(pcm) { this.audioSeconds += pcm.length / 16000; },
    finalize() { finalized++; },
    async stop() {},
  });
  const gated = new GatedStream(inner, 16000);
  gated.send(tone(0.4, -20));
  gated.send(new Int16Array(16000 * 2));
  assert.equal(finalized, 1);

  // DeepgramStream finalize() sends { type: 'Finalize' } on an open socket, and queued audio counts toward audioSeconds.
  const sentMsgs = [];
  dg3.send(new Int16Array(8000)); // 0.5s queued before open
  assert.equal(dg3.audioSeconds, 0);
  dg3.ws = { readyState: 1, send(d) { sentMsgs.push(d); }, once() {}, terminate() {} };
  for (const b of dg3.queue) { dg3.ws.send(b); dg3.audioSeconds += (b.length / 2) / 16000; }
  dg3.queue = [];
  assert.equal(dg3.audioSeconds, 0.5);
  dg3.finalize();
  assert.equal(sentMsgs.at(-1), JSON.stringify({ type: 'Finalize' }));

  // AssemblyAiStream billedMinutes uses sessionSeconds + active openedAt, ignores send() after closing, and clears partial on close.
  const aai = new AssemblyAiStream({ apiKey: 'k' });
  aai.sessionSeconds = 30;
  aai.openedAt = 0;
  assert.equal(billedMinutes(Object.assign(aai, { providerId: 'assemblyai' }), 600), 0.5);
  aai.closing = true;
  aai.send(new Int16Array(3200));
  assert.equal(aai.audioSeconds, 0);

  // ChunkedStream ignores prompt-echo phantoms and drops late deliveries once stopped.
  const ch = new ChunkedStream({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9', model: 'm' });
  const finals = [];
  ch.on('final', (f) => finals.push(f.text));
  ch.order.push({ state: 'done', seconds: 3.2, res: { text: 'Terms that may be spoken: Kyverno, Cosign.' } });
  ch._deliver();
  assert.deepEqual(finals, []);
  ch.stopped = true;
  ch.order.push({ state: 'done', seconds: 1.5, res: { text: 'Too late.' } });
  ch._deliver();
  assert.deepEqual(finals, []);
});

test('Transcript, MeetingRecall and speaker-names edge cases', () => {
  // CJK wordCount counts CJK characters so Chinese/Japanese sentences are not 1-word interjections.
  assert.equal(wordCount('はい。'), 2);
  assert.ok(wordCount('金曜日の夜にデプロイします。') >= 8);

  // 'Them' does not pollute themLabels, and 3-person meetings across reconnects are not oneToOne.
  const tr = new Transcript({ echoFilter: false, myNames: ["D'Arcy"] });
  tr.addFinal('them', 'Unlabelled startup clip.', null, 1000, '1.1');
  tr.addFinal('them', 'Hi, Priya here.', 'Speaker 1', 5000, '1.1');
  assert.equal(tr.isOneToOne(), true);
  tr.setName('1.1:Speaker 1', 'Priya');
  tr.addFinal('them', 'Hi, Tom here after reconnect.', 'Speaker 1', 10000, '1.2');
  assert.equal(tr.isOneToOne(), true);
  tr.setName('1.2:Speaker 1', 'Tom');
  assert.equal(tr.isOneToOne(), false);

  // Curly apostrophe in setName matches user's own ASCII apostrophe name.
  assert.throws(() => tr.setName('1.1:Speaker 1', 'D\u2019Arcy'), /your own name/);

  // _beforeInterjections never jumps backwards over a short question.
  const qTr = new Transcript({ echoFilter: false });
  qTr.addFinal('them', 'We are ready to deploy', 'Speaker 1', 1000, '1.1');
  qTr.addFinal('them', 'When is that?', 'Speaker 2', 1300, '1.1');
  const ans = qTr.addFinal('them', 'Friday night.', 'Speaker 1', 1800, '1.1');
  assert.equal(ans.merged, false);
  assert.deepEqual(qTr.turns.map((x) => x.text), ['We are ready to deploy', 'When is that?', 'Friday night.']);

  // MeetingRecall excludes dead doc IDs when computing df after a turn grows and refreshes.
  // With 13 indexed turns (16 total - 3 settled), df=1 gives idf=2.16 >= RECALL_COMMON (2), whereas stale df=2 gives 1.72 < 2.
  const recTr = new Transcript({ echoFilter: false });
  const r0 = recTr.addFinal('them', 'We agreed on the xylophone77 quorum threshold.', 'Speaker 1', 1000, '1.1');
  for (let i = 1; i <= 15; i++) recTr.addFinal('them', `Filler discussion turn number ${i} about schedules.`, 'Speaker 2', 1000 + i * 5000, '1.1');
  const recall = new MeetingRecall(recTr);
  recall.sync(100000);
  // Mutate turn 0 so _refresh marks doc 0 dead and re-indexes it; xylophone77 still lives in only 1 live turn.
  r0.turn.text += ' Confirmed by security.';
  const picked = recall.select({ query: 'What was the xylophone77 quorum threshold?', first: 10 });
  assert.ok(picked && picked.text.includes('xylophone77'));

  // speaker-names normalises curly vs straight apostrophes and honours dismissedNames.
  const prompt = buildNamePrompt({
    turns: [{ channel: 'them', label: 'Speaker 1', speakerKey: '1.1:Speaker 1', text: 'Hi everyone, O\u2019Neil here from platform.' }],
    names: new Map(), myLabel: 'Ade', userNames: ['Ade'],
  });
  const s1 = parseNameSuggestions('{"suggestions":[{"tag":"A","name":"O\'Neil","evidence":"O\'Neil here"}]}', {
    tags: prompt.tags, windowText: prompt.windowText, userNames: ['Ade'],
  });
  assert.equal(s1.length, 1);
  const s2 = parseNameSuggestions('{"suggestions":[{"tag":"A","name":"O\'Neil","evidence":"O\'Neil here"}]}', {
    tags: prompt.tags, windowText: prompt.windowText, userNames: ['Ade'], dismissedNames: new Set(["1.1:Speaker 1|o'neil"]),
  });
  assert.equal(s2.length, 0);
});

test('triggers: honorifics, abbreviations in sentenceSpans, and floor handover after an earlier question', () => {
  assert.equal(splitSentences('Should we use e.g. Vault vs. KMS for Dr. Patel?').length, 1);
  assert.equal(splitSentences('Should we rotate keys, certs, etc. in production?').length, 1);

  // "Dr." in "Dr. Ade Okoye" must not turn "Dr. Patel, what is the ETA?" into a question for you.
  const drOther = analyzeTurn('Dr. Patel, what is the ETA?', { names: ['Dr. Ade Okoye'], others: ['Dr. Patel'], mode: 'mine' });
  assert.equal(drOther.target, 'other');
  assert.equal(drOther.addressee, 'Dr. Patel');
  assert.equal(drOther.fire, false);

  const drYou = analyzeTurn('Dr. Ade Okoye, what is the ETA?', { names: ['Dr. Ade Okoye'], others: ['Dr. Patel'], mode: 'mine' });
  assert.equal(drYou.target, 'you');
  assert.equal(drYou.fire, true);

  // An earlier question to someone else does not suppress a later floor handover to the user.
  const hand = analyzeTurn("Priya, what is the ETA on the migration? Actually, let's defer to Ade on that.", {
    names: ['Ade'], others: ['Priya'], mode: 'mine',
  });
  assert.equal(hand.target, 'you');
  assert.equal(hand.why, 'directed');
  assert.equal(hand.fire, true);
});

test('MeetingSession: beginLive failure recovery, reasoning maxTokens, passed/rename sync, and pinned holding-note rules', async (t) => {
  const dir = tmp(t);
  const settings = new Settings(path.join(dir, 'cfg'), plainCrypto);
  settings.set({ me: { name: 'Ade' }, llm: { live: { provider: 'openai', model: 'gpt-5-mini' } }, stt: { suggestNames: true } });
  settings.setSecret('openai', 'ok');
  settings.setSecret('deepgram', 'dk');

  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  let failBegin = true;
  const origBegin = store.beginLive.bind(store);
  store.beginLive = (meta) => { if (failBegin) throw new Error('disk full'); return origBegin(meta); };

  const llmCalls = [];
  let llmReply = 'We rotate keys every 90 days in Vault.';
  const fakeLlm = {
    async streamChat(role, opts) {
      llmCalls.push({ role, opts });
      if (opts.onText) opts.onText(llmReply);
      return { text: llmReply, model: 'gpt-5-mini', provider: 'openai', usage: { input: 10, output: 10, cached: 0 }, cost: 0.001, sources: [], notes: [] };
    },
  };
  const library = new Library();
  const pinnedDir = path.join(dir, 'pinned');
  const unpinnedDir = path.join(dir, 'work');
  const staleDir = path.join(dir, 'stale');
  fs.mkdirSync(pinnedDir); fs.mkdirSync(unpinnedDir); fs.mkdirSync(staleDir);
  fs.writeFileSync(path.join(pinnedDir, 'policy.md'), '# Policy\nAlways included policy reference.\n');
  fs.writeFileSync(path.join(unpinnedDir, 'runbook.md'), '# Runbook\nDetailed rotation procedure for production clusters.\n');
  fs.writeFileSync(path.join(staleDir, 'old.md'), '# Old\nRemoved secret folder that should not be pinned.\n');
  await library.reindex([
    { dir: pinnedDir, label: 'pinned', kind: 'work' },
    { dir: unpinnedDir, label: 'work', kind: 'work' },
    { dir: staleDir, label: 'stale', kind: 'work' },
  ]);
  settings.set({ library: { folders: [pinnedDir, unpinnedDir], pinned: [pinnedDir, staleDir] } });

  const session = new MeetingSession({ settings, library, store, llm: fakeLlm, getProfile: () => '', getPersonality: () => '' });
  // Prevent real WebSocket opening in sandbox by stubbing _openStreams.
  const fakeStream = Object.assign(new EventEmitter(), { providerId: 'deepgram', audioSeconds: 0, async stop() {} });
  session._openStreams = function () { this.sttStartedAt = Date.now(); this.streams = { them: fakeStream }; };

  assert.throws(() => session.start({ title: 'Fail', channels: ['them'] }), /disk full/);
  assert.equal(session.active, false);

  failBegin = false;
  session.start({ title: 'Live', channels: ['them'] });
  assert.equal(session.active, true);

  // Placeholder '…' partial does not move lastSpeechAt.
  session.lastSpeechAt = 12345;
  session._onPartial('them', '…');
  assert.equal(session.lastSpeechAt, 12345);

  // Reasoning model gets 1500 maxTokens in _runNameCheck.
  for (let i = 0; i < 4; i++) {
    const prev = session.transcript.turns.at(-1);
    if (prev) prev.end -= 5000;
    session._onFinal('them', `Turn ${i} from Priya here on the call.`, 'Speaker 1', '1.1');
  }
  await new Promise((r) => setTimeout(r, 30));
  const nameCall = llmCalls.find((c) => c.opts.system.includes('label speakers'));
  assert.ok(nameCall);
  assert.equal(nameCall.opts.maxTokens, 1500);

  // Passed question updates speaker on renameSpeaker and records askKey on answerPassed.
  session._setPassed({ turnId: session.transcript.turns[0].id, ask: 'What is the ETA?', speaker: 'Speaker 1', target: 'other', addressee: 'Tom', askKey: '1|what is the eta', speakerKey: '1.1:Speaker 1' });
  session.renameSpeaker('1.1:Speaker 1', 'Priya');
  assert.equal(session.passed.speaker, 'Priya');
  session.answerPassed(session.passed.id);
  assert.equal(session.recentAsks.has('1|what is the eta'), true);
  await new Promise((r) => setTimeout(r, 20));

  // Org question with pinned folder: staleDir excluded, no false HOLDING_NOTE when answered, HOLDING_NOTE shown when deferred.
  const doneCards = [];
  session.on('card-done', (c) => doneCards.push(c));
  llmReply = 'We rotate keys every 90 days in Vault.';
  session.runAction('ask', { typed: 'How do we rotate keys in our setup?' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!llmCalls.at(-1).opts.userText.includes('Removed secret folder'));
  assert.ok(llmCalls.at(-1).opts.userText.includes('Always included policy reference.'));
  assert.equal(doneCards.at(-1).note, undefined);

  llmReply = "I don't have that in front of me, let me check and come back to you.";
  session.runAction('ask', { typed: 'Who owns the vendor risk exceptions?' });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(doneCards.at(-1).note || '', /holding line/);

  // Stream listeners are removed on stop().
  fakeStream.on('partial', () => {});
  await session.stop();
  assert.equal(fakeStream.listenerCount('partial'), 0);
});

test('validate.js cleaners enforce strict bounds and Object.hasOwn checks', () => {
  assert.equal(V.cleanExternalUrl('https://example.com/docs?q=1'), 'https://example.com/docs?q=1');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'https://user:pass@example.com/', '', null, 'https://example.com/\n']) {
    assert.throws(() => V.cleanExternalUrl(bad));
  }
  assert.equal(V.cleanProfileSave('hello'), 'hello');
  assert.throws(() => V.cleanProfileSave(123));
  assert.throws(() => V.cleanProfileSave('x'.repeat(50001)));

  assert.equal(V.cleanCopyText('abc'), 'abc');
  assert.throws(() => V.cleanCopyText(null));
  assert.throws(() => V.cleanCopyText('x'.repeat(500001)));

  assert.equal(V.cleanLibrarySearch('a'.repeat(800)).length, 500);
  assert.equal(V.cleanLibrarySearch(null), '');

  assert.equal(V.meetingId('20261117-120000'), '20261117-120000');
  assert.throws(() => V.meetingId('../escape'));

  assert.deepEqual(V.cleanProviderTest('llm', 'notes', STT_PROVIDERS), { kind: 'llm', role: 'notes' });
  assert.deepEqual(V.cleanProviderTest('stt', 'deepgram', STT_PROVIDERS), { kind: 'stt', id: 'deepgram' });
  assert.throws(() => V.cleanProviderTest('stt', 'toString', STT_PROVIDERS));
  assert.throws(() => V.cleanProviderTest('other', 'deepgram', STT_PROVIDERS));

  assert.equal(V.cleanAudioChunk({ byteLength: 100 }), null);
  assert.equal(V.cleanAudioChunk(new Uint8Array(640001)), null);
  assert.equal(V.cleanAudioChunk(new Uint8Array(3200)).byteLength, 3200);

  assert.deepEqual(V.cleanCaptureStatus({ channels: { me: 'on', toString: 'on', them: 'bogus' } }), { channels: { me: 'on' }, message: '' });
  assert.equal(V.cleanCaptureStatus({ channels: { them: 'bogus' } }), null);
});
