'use strict';
// Regression tests for the findings of the adversarial reliability review.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const { mockLlm, mockAssemblyAi } = require('./mocks');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore, newMeta, render } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const { Transcript } = require('../src/main/transcript');
const { VoiceGate } = require('../src/main/stt/vad');
const { wavToPcm16 } = require('../src/main/stt/wav');
const { ChunkedStream } = require('../src/main/stt/chunked');
const { createStream } = require('../src/main/stt');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-rel-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { available: () => false };
const speech = (s, rate = 16000) => Int16Array.from({ length: Math.round(s * rate) }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 200 / rate) * 7000 * (0.6 + 0.4 * Math.sin(i / 300))));

// A Deepgram-shaped server that only returns the end of an utterance when the
// client closes the stream, as the real service does for the words in flight.
async function slowCloseDeepgram({ closeDelayMs = 0 } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const result = (ws, transcript, final) => ws.send(JSON.stringify({ type: 'Results', is_final: final, speech_final: final, channel: { alternatives: [{ transcript, words: [] }] } }));
  wss.on('connection', (ws) => {
    let bytes = 0, sentInterim = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        bytes += data.length;
        if (bytes > 6400 && !sentInterim) { sentInterim = true; result(ws, 'and the action item for Ade is to rotate the', false); }
        return;
      }
      if (JSON.parse(data.toString()).type === 'CloseStream') {
        setTimeout(() => { result(ws, 'and the action item for Ade is to rotate the production keys', true); ws.close(); }, closeDelayMs);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}/v1/listen`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); }) };
}

function sessionFor(dir, { sttUrl, llmUrl } = {}) {
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  settings.set({ me: { name: 'Ade' }, stt: { skipSilence: false }, llm: { baseUrls: llmUrl ? { anthropic: llmUrl } : {} } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const session = new MeetingSession({ settings, library: new Library(), store, llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: sttUrl });
  return { settings, store, session };
}

test('the last words of a meeting reach the saved file when it is stopped', async () => {
  const dir = tmp();
  const dg = await slowCloseDeepgram({ closeDelayMs: 150 });
  const { session, store } = sessionFor(dir, { sttUrl: dg.url });
  session.start({ channels: ['them'] });
  for (let i = 0; i < 20; i++) { session.pushAudio('them', speech(0.1)); await sleep(10); }
  await sleep(100);
  const result = await session.stop();
  assert.equal(result.turns, 1);
  assert.ok(fs.readFileSync(result.file, 'utf8').includes('rotate the production keys'));
  assert.equal(result.saveError, '');
  await dg.close();
});

test('a new meeting cannot start, or mix with the old one, while the old one is being saved', async () => {
  const dir = tmp();
  const dg = await slowCloseDeepgram({ closeDelayMs: 500 });
  const { session, store } = sessionFor(dir, { sttUrl: dg.url });
  const first = session.start({ title: 'First', channels: ['them'] });
  for (let i = 0; i < 20; i++) { session.pushAudio('them', speech(0.1)); await sleep(5); }
  const stopping = session.stop();
  assert.throws(() => session.start({ title: 'Second', channels: ['them'] }), /still being saved/);
  assert.throws(() => session.runAction('say'), /No meeting is running/);
  const result = await stopping;
  assert.equal(result.meta.title, 'First');
  assert.equal(result.meta.id, first.id);
  assert.ok(path.basename(result.file).includes('first'));
  assert.equal(session.active, false);
  await dg.close();
});

test('a speech provider that never answers cannot block stopping or lose the meeting', async () => {
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stream = new ChunkedStream({ apiKey: 'k', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'm', timeoutMs: 400, stopWaitMs: 800 });
  const partials = [], errors = [];
  stream.on('partial', (t) => partials.push(t));
  stream.on('error', (e) => errors.push(e.message));
  stream.start();
  for (let i = 0; i < 40; i++) stream.send(speech(0.1));
  const t0 = Date.now();
  await stream.stop();
  assert.ok(Date.now() - t0 < 2500, `stop took ${Date.now() - t0} ms`);
  await sleep(1300); // the timed-out request is reported
  assert.ok(errors.length >= 1, 'the failure is reported');
  assert.equal(partials.at(-1), '', 'the "…" marker is cleared');
  server.closeAllConnections(); server.close();
});

test('a busy speech server gets one retry, and at most two requests run at once', async () => {
  let calls = 0, live = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    const n = ++calls; live++; peak = Math.max(peak, live);
    await sleep(120);
    live--;
    if (n === 1) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: `clip ${n}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stream = new ChunkedStream({ apiKey: 'k', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'm' });
  const finals = [];
  stream.on('final', (f) => finals.push(f.text));
  stream.start();
  for (let clip = 0; clip < 4; clip++) { for (let i = 0; i < 12; i++) stream.send(speech(0.1)); for (let i = 0; i < 14; i++) stream.send(new Int16Array(1600)); }
  await stream.stop();
  await sleep(300);
  assert.equal(finals.length, 4, `finals: ${finals}`);
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
  assert.ok(calls >= 5, 'the 503 was retried');
  server.closeAllConnections(); server.close();
});

test('AssemblyAI keeps delivering turns after it reconnects', async () => {
  const aai = await mockAssemblyAi(['How do we rotate the secrets?']);
  const stream = createStream({ provider: 'assemblyai', language: 'en', models: {} }, () => 'k', 'them', { baseUrlOverride: aai.url });
  const finals = [];
  stream.on('final', (f) => finals.push(f.text));
  stream.on('error', () => {});
  stream.start();
  const play = async () => { for (let i = 0; i < 30; i++) { stream.send(speech(0.1)); await sleep(15); } await sleep(200); };
  await play();
  stream.ws.terminate();           // the network drops; the service starts numbering turns from 0 again
  await sleep(1300);
  await play();
  assert.deepEqual(finals, ['How do we rotate the secrets?', 'How do we rotate the secrets?']);
  await stream.stop(); await aai.close();
});

test('the same words asked again in a later turn are answered again, but one turn only once', async () => {
  const dir = tmp();
  const llm = await mockLlm(() => 'My view.');
  const dg = await slowCloseDeepgram();
  const { session } = sessionFor(dir, { sttUrl: dg.url, llmUrl: llm.url });
  session.start({ channels: ['them'] });
  const cards = [];
  session.on('card', (c) => cards.push(c));
  const heard = (text, atOffset) => { session.transcript.addFinal('them', text, 'Speaker 1', Date.now() + atOffset); };
  // Drive the internals the way the speech stream does.
  session._onFinal('them', 'What do you think?', 'Speaker 1');
  await sleep(1300);
  session._onFinal('them', 'Moving on to the budget now.', 'Speaker 2'); // a different speaker: a new turn
  session._onFinal('them', 'What do you think?', 'Speaker 2');
  await sleep(1300);
  assert.equal(cards.length, 2, 'asked twice in two turns, answered twice');
  // A long turn that contains one question is answered once, with the whole sentence quoted.
  const long = `${'Some background about the migration plan and what happened last quarter. '.repeat(10)}So, how do we rotate the database credentials without downtime?`;
  session._onFinal('them', long, 'Speaker 3');
  await sleep(1300);
  session._onFinal('them', 'And that is the part I wanted clarified.', 'Speaker 3'); // merges into the same turn
  await sleep(1300);
  const longCards = cards.slice(2);
  assert.equal(longCards.length, 1);
  assert.equal(longCards[0].quote, 'So, how do we rotate the database credentials without downtime?');
  // A failed answer can be asked for again.
  await session.stop();
  await llm.close(); await dg.close();
});

test('the user\'s own short replies are not mistaken for echo of the meeting audio', () => {
  const t = new Transcript({ myLabel: 'Ade', echoFilter: true });
  const t0 = 1_000_000;
  t.addFinal('them', 'Should we use Terraform or Pulumi for the new infrastructure?', 'Speaker 1', t0);
  assert.ok(t.addFinal('me', 'We should use Terraform.', null, t0 + 1500), 'a short answer sharing words is kept');
  assert.ok(t.addFinal('me', 'Yes, Terraform for the new infrastructure.', null, t0 + 6000), 'and so is one a few seconds later');
  // Genuine echo (the speakers) is still removed.
  t.addFinal('them', 'Can you walk us through the rollback plan for Friday night?', 'Speaker 1', t0 + 20000);
  assert.equal(t.addFinal('me', 'can you walk us through the rollback plan for friday night', null, t0 + 20400), null);
  // Five minutes later the other side is silent and the user repeats a sentence they heard long ago.
  assert.ok(t.addFinal('me', 'Can you walk us through the rollback plan for Friday night', null, t0 + 320000));
});

test('the voice gate follows the room: very quiet speech passes, and steady noise does not keep it open', () => {
  const { pcm } = wavToPcm16(fs.readFileSync(path.join(__dirname, 'fixtures', 'question.wav')));
  const rate = 16000;
  const noise = (len, db) => { const a = Math.pow(10, db / 20) * 32768 * Math.sqrt(3); return Int16Array.from({ length: len }, () => Math.round((Math.random() * 2 - 1) * a)); };
  const feed = (gate, x) => { let out = 0, closes = 0; for (let i = 0; i < x.length; i += 1600) { const r = gate.process(x.subarray(i, i + 1600)); if (r.audio) out += r.audio.length; if (r.closed) closes++; } return { sec: out / rate, closes }; };
  // Speech 45 dB down in a silent room: used to be dropped entirely.
  const quiet = Int16Array.from(pcm, (v) => Math.round(v * Math.pow(10, -45 / 20)));
  const g1 = new VoiceGate({ sampleRate: rate });
  const all = new Int16Array(rate * 3 + quiet.length + rate * 4); all.set(quiet, rate * 3);
  const r1 = feed(g1, all);
  assert.ok(r1.sec >= quiet.length / rate * 0.95, `forwarded ${r1.sec} s of ${quiet.length / rate} s of speech`);
  // 60 s of a steady fan at -45 dBFS: must settle and stop sending.
  const g2 = new VoiceGate({ sampleRate: rate });
  const r2 = feed(g2, noise(rate * 60, -45));
  assert.ok(r2.sec < 4, `a steady fan was sent for ${r2.sec} s`);
  // Speech over that fan still gets through.
  const over = Int16Array.from(pcm, (v, i) => v + Math.round((Math.random() * 2 - 1) * Math.pow(10, -45 / 20) * 32768 * Math.sqrt(3)));
  const r3 = feed(g2, over);
  assert.ok(r3.sec >= pcm.length / rate * 0.95, `speech over noise: ${r3.sec} s forwarded`);
});

test('meeting files: same-minute meetings keep both, titles cannot break the front matter, a damaged autosave is rebuilt', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const a = newMeta('', new Date(2026, 10, 14, 14, 30, 5));
  const b = newMeta('', new Date(2026, 10, 14, 14, 30, 40));
  store.save(a, 'notes A', '**[14:30:09] Speaker 1:** first');
  store.save(b, 'notes B', '**[14:30:45] Speaker 1:** second');
  assert.ok(store.find(a.id).transcript.includes('first') && store.find(b.id).transcript.includes('second'));
  assert.equal(store.list().length, 2);
  // Same title in non-Latin script: slugs collide, ids keep them apart.
  const c = newMeta('セキュリティレビュー', new Date(2026, 10, 14, 16, 0, 1));
  const d = newMeta('🔥🔥', new Date(2026, 10, 14, 16, 0, 2));
  store.save(c, 'c', ''); store.save(d, 'd', '');
  assert.equal(store.list().filter((m) => m.start === '16:00').length, 2);
  // A title with a newline cannot inject another field.
  const e = newMeta('inject\nid: 20200101-000000', new Date(2026, 10, 14, 17, 0, 0));
  store.save(e, 'e', '');
  assert.ok(store.find(e.id), 'found by its real id');
  assert.ok(!store.find('20200101-000000'));
  // A torn first line in the autosave: the turns are still recovered.
  const live = path.join(dir, '.live'); fs.mkdirSync(live, { recursive: true });
  const t = new Date(2026, 10, 15, 9, 0, 0).getTime();
  fs.writeFileSync(path.join(live, '20261115-090000.jsonl'), `{"type":"meta","meta":{"id":"20261115-09\n${JSON.stringify({ type: 'turn', turn: { id: 1, t: t + 1000, end: t + 2000, speaker: 'Ade', text: 'Morning all.' } })}\n`);
  const rec = store.recoverOrphans(null);
  assert.equal(rec.length, 1);
  assert.ok(fs.readFileSync(rec[0], 'utf8').includes('Morning all.'));
  // Nothing usable: set aside, not deleted.
  fs.writeFileSync(path.join(live, '20261116-090000.jsonl'), 'garbage\n');
  assert.equal(store.recoverOrphans(null).length, 0);
  assert.ok(fs.existsSync(path.join(live, 'corrupt', '20261116-090000.jsonl')));
});

test('a failed save keeps the autosave and says where the meeting is', async () => {
  const dir = tmp();
  const dg = await slowCloseDeepgram();
  const { session, store } = sessionFor(dir, { sttUrl: dg.url });
  session.start({ channels: ['them'] });
  for (let i = 0; i < 20; i++) { session.pushAudio('them', speech(0.1)); await sleep(5); }
  await sleep(100);
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  store.dir = path.join(dir, 'blocker', 'cannot-be-a-folder');   // a path under a file
  const result = await session.stop();
  assert.equal(result.file, null);
  assert.match(result.saveError, /recovered the next time/);
  assert.ok(fs.readdirSync(path.join(dir, 'live')).some((f) => f.endsWith('.jsonl')), 'the autosave is still there');
  store.dir = path.join(dir, 'M');
  assert.equal(store.recoverOrphans(null).length, 1);
  await dg.close();
});

test('the library finishes a pass requested while another is running, and skips binary files', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'a')); fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'a', 'one.md'), '# One\nalpha content here\n');
  fs.writeFileSync(path.join(dir, 'b', 'two.md'), '# Two\nbeta content here\n');
  fs.writeFileSync(path.join(dir, 'b', 'blob.txt'), Buffer.concat([Buffer.from('x'), Buffer.alloc(300, 0), Buffer.from('y')]));
  fs.writeFileSync(path.join(dir, 'b', 'only-title.md'), '# Quarterly planning\n');
  const lib = new Library();
  const stats = await lib.reindex([{ dir: path.join(dir, 'a'), label: 'a', kind: 'work' }, { dir: path.join(dir, 'b'), label: 'b', kind: 'work' }]);
  assert.equal(stats.files, 3);
  assert.ok(stats.skipped.some((s) => /blob\.txt$/.test(s.file) && /not a text file/.test(s.reason)));
  assert.ok(lib.search('quarterly planning')[0].rel.endsWith('only-title.md'), 'a note that is only a title can be found');
});
