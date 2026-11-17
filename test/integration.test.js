'use strict';
// End-to-end checks of the pipeline against local stand-ins for the cloud
// services (see mocks.js). These prove the plumbing; they do not prove that a
// real provider accepts the requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { mockLlm, mockDeepgram, mockAssemblyAi } = require('./mocks');
const { Settings } = require('../src/main/settings');
const { createLlm } = require('../src/main/llm');
const anthropic = require('../src/main/llm/anthropic');
const openai = require('../src/main/llm/openai');
const gemini = require('../src/main/llm/gemini');
const { createStream } = require('../src/main/stt');
const { Library } = require('../src/main/knowledge/library');
const { MeetingStore } = require('../src/main/meetings/store');
const { MeetingSession } = require('../src/main/session');
const { generateNotes, transcriptMdToPlain } = require('../src/main/meetings/notes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { available: () => false };

function speech(seconds, rate = 16000) {
  return Int16Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 200 / rate) * 7000 * (0.6 + 0.4 * Math.sin(i / 300))));
}
async function play(send, pcm, { realtime = false } = {}) {
  for (let i = 0; i < pcm.length; i += 1600) { send(pcm.subarray(i, i + 1600)); if (realtime) await sleep(8); }
}

test('anthropic adapter: request shape, streaming, usage', async () => {
  const mock = await mockLlm(() => 'Yes, we rotate every thirty days.');
  let streamed = '';
  const r = await anthropic.streamChat({ apiKey: 'k', baseUrl: mock.url, model: 'claude-haiku-5-5', system: 'SYS', userText: 'Q', images: [{ mime: 'image/jpeg', base64: 'AAAA' }], webSearch: true, fast: true, onText: (d) => { streamed += d; } });
  assert.equal(r.text, 'Yes, we rotate every thirty days.');
  assert.equal(streamed, r.text);
  assert.equal(r.usage.cached, 900);
  const b = mock.calls[0].body;
  assert.equal(mock.calls[0].headers.authorization, 'Bearer k'); // SDK 1.x sends API keys as a bearer credential
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal(b.output_config.effort, 'medium');
  assert.equal(b.system[0].cache_control.type, 'ephemeral');
  assert.equal(b.messages[0].content[0].type, 'image');
  assert.equal(b.tools[0].type, 'web_search_20250305');
  assert.equal(b.temperature, undefined);
  assert.equal(b.stream, true);
  // Models that cannot switch thinking off get low effort instead, and no thinking field.
  assert.deepEqual(anthropic.tuning('claude-opus-5-5', true), { output_config: { effort: 'low' } });
  assert.deepEqual(anthropic.tuning('claude-sonnet-5-5', true), { output_config: { effort: 'low' } });
  assert.deepEqual(anthropic.tuning('claude-haiku-4-5', true), {});
  await mock.close();
});

test('anthropic adapter: errors are classified, cancel works', async () => {
  const bad = await mockLlm(() => ({ status: 401, error: 'invalid x-api-key' }));
  await assert.rejects(anthropic.streamChat({ apiKey: 'k', baseUrl: bad.url, model: 'claude-haiku-5-5', system: 's', userText: 'q' }), (e) => e.kind === 'auth');
  await bad.close();
  const slow = await mockLlm(() => ({ text: 'late', delayMs: 800 }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  await assert.rejects(anthropic.streamChat({ apiKey: 'k', baseUrl: slow.url, model: 'claude-haiku-5-5', system: 's', userText: 'q', signal: ac.signal }), (e) => e.kind === 'aborted');
  await slow.close();
});

test('openai adapter: request shape, streaming, sources, and dropping rejected options', async () => {
  const mock = await mockLlm((body, _url, n) => (n === 1 ? { status: 400, error: 'reasoning.effort none not supported' } : 'Use OIDC, not static keys.'));
  const r = await openai.streamChat({ apiKey: 'k', baseUrl: `${mock.url}/v1`, model: 'gpt-6-luna', system: 'SYS', userText: 'Q', images: [{ mime: 'image/png', base64: 'BBBB' }], webSearch: true, fast: true });
  assert.equal(r.text, 'Use OIDC, not static keys.');
  assert.deepEqual(mock.calls[0].body.reasoning, { effort: 'none' });
  assert.equal(mock.calls[1].body.reasoning, undefined, 'second attempt drops the rejected option');
  assert.equal(openai.fastEffort('gpt-5-mini-2025-08-07'), 'minimal');
  assert.equal(openai.fastEffort('o4-mini'), 'low');
  assert.equal(openai.fastEffort('gpt-4o'), null);
  const b = mock.calls[1].body;
  assert.equal(b.instructions, 'SYS');
  assert.equal(b.input[0].content[0].type, 'input_image');
  assert.equal(b.input[0].content[0].image_url, 'data:image/png;base64,BBBB');
  assert.deepEqual(b.tools, [{ type: 'web_search' }]);
  assert.equal(mock.calls[1].headers.authorization, 'Bearer k');
  assert.deepEqual(r.usage, { input: 150, output: 5, cached: 50 });
  assert.equal(r.sources[0].url, 'https://example.com/a');
  await mock.close();
  const bad = await mockLlm(() => ({ status: 429, error: 'slow down' }));
  await assert.rejects(openai.streamChat({ apiKey: 'k', baseUrl: `${bad.url}/v1`, model: 'm', system: 's', userText: 'q' }), (e) => e.kind === 'rate_limit');
  await bad.close();
});

test('gemini adapter: request shape, streaming, grounding sources', async () => {
  const mock = await mockLlm(() => 'Pin the action to a commit SHA.');
  const r = await gemini.streamChat({ apiKey: 'k', baseUrl: `${mock.url}/v1beta`, model: 'gemini-3.5-flash-lite', system: 'SYS', userText: 'Q', images: [{ mime: 'image/jpeg', base64: 'CCCC' }], webSearch: true, fast: true });
  assert.equal(r.text, 'Pin the action to a commit SHA.');
  const c = mock.calls[0];
  assert.ok(c.url.includes('/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse'));
  assert.equal(c.headers['x-goog-api-key'], 'k');
  assert.equal(c.body.system_instruction.parts[0].text, 'SYS');
  assert.equal(c.body.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  assert.deepEqual(c.body.tools, [{ google_search: {} }]);
  assert.deepEqual(c.body.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
  assert.equal(r.sources[0].url, 'https://example.com/g');
  assert.equal(r.usage.input, 300);
  assert.deepEqual(gemini.fastThinking('gemini-4-argon'), { thinkingLevel: 'LOW' });
  await mock.close();
});

test('deepgram stream: connects with the right options, skips silence, returns finals with speakers', async () => {
  const dg = await mockDeepgram(['How do we rotate secrets in the pipeline?']);
  const stream = createStream({ provider: 'deepgram', language: 'en', skipSilence: true, identifySpeakers: true, keyterms: ['Trivy', 'Argo CD'], models: {} }, () => 'dg-key', 'them', { baseUrlOverride: dg.url });
  const partials = [], finals = [];
  stream.on('partial', (t) => partials.push(t));
  stream.on('final', (f) => finals.push(f));
  stream.start();
  await play((p) => stream.send(p), new Int16Array(16000 * 4));            // 4 s of digital silence
  await sleep(150);
  assert.equal(dg.stats.bytes, 0, 'silence is not sent');
  await play((p) => stream.send(p), speech(1.5), { realtime: true });
  await play((p) => stream.send(p), new Int16Array(16000 * 2));
  await sleep(400);
  assert.deepEqual(finals, [{ text: 'How do we rotate secrets in the pipeline?', speaker: 'Speaker 1', epoch: 1 }]);
  assert.ok(partials.some((p) => p.startsWith('How do we')));
  const url = dg.stats.urls[0];
  for (const part of ['model=nova-3', 'encoding=linear16', 'sample_rate=16000', 'interim_results=true', 'diarize=true', 'keyterm=Trivy', 'keyterm=Argo+CD']) assert.ok(url.includes(part), `${part} in ${url}`);
  assert.equal(dg.stats.auth[0], 'Token dg-key');
  const sentSeconds = dg.stats.bytes / 32000;
  assert.ok(sentSeconds > 1.5 && sentSeconds < 3.2, `sent ${sentSeconds}s of the 7.5s fed`);
  await stream.stop();
  await dg.close();
});

test('deepgram stream: reconnects after a dropped connection', async () => {
  const dg = await mockDeepgram(['first line here', 'second line here']);
  const stream = createStream({ provider: 'deepgram', skipSilence: false, models: {} }, () => 'k', 'me', { baseUrlOverride: dg.url });
  const finals = [];
  stream.on('final', (f) => finals.push(f.text));
  stream.on('error', () => {});
  stream.start();
  await play((p) => stream.send(p), speech(0.5), { realtime: true });
  await sleep(300);
  stream.ws.terminate(); // simulate the network dropping
  await sleep(1200);
  await play((p) => stream.send(p), speech(0.5), { realtime: true });
  await sleep(400);
  assert.deepEqual(finals, ['first line here', 'second line here']);
  assert.equal(dg.stats.connections, 2);
  assert.equal(finals.length && finals[0] && stream.listenerCount('final') > 0, true);
  await stream.stop();
  await dg.close();
});

test('assemblyai stream: one final per turn, formatted text wins', async () => {
  const aai = await mockAssemblyAi(['What is the blast radius of that change?']);
  const stream = createStream({ provider: 'assemblyai', language: 'en', keyterms: ['Vault'], models: {} }, () => 'aai-key', 'them', { baseUrlOverride: aai.url });
  const finals = [];
  stream.on('final', (f) => finals.push(f.text));
  stream.start();
  await play((p) => stream.send(p), speech(1.2), { realtime: true });
  await sleep(300);
  assert.deepEqual(finals, ['What is the blast radius of that change?']);
  assert.equal(aai.stats.auth[0], 'aai-key');
  assert.ok(aai.stats.urls[0].includes('format_turns=true') && aai.stats.urls[0].includes('keyterms_prompt='));
  assert.ok(aai.stats.sizes.every((n) => n >= 1600 && n <= 32000), 'every message is 50 ms to 1 s of audio');
  await stream.stop();
  assert.equal(aai.stats.terminated, 1);
  await aai.close();
});

test('per-utterance provider: cuts on silence and transcribes each clip in order', async () => {
  const mock = await mockLlm((_b, _u, n) => (n === 1 ? 'First utterance.' : 'Second utterance.'));
  const stream = createStream({ provider: 'groq', language: 'en', models: {} }, () => 'gk', 'them', { baseUrlOverride: `${mock.url}/openai/v1` });
  const finals = [];
  stream.on('final', (f) => finals.push(f.text));
  stream.start();
  const gap = new Int16Array(16000 * 1.2);
  await play((p) => stream.send(p), new Int16Array(16000));
  await play((p) => stream.send(p), speech(1.4));
  await play((p) => stream.send(p), gap);
  await play((p) => stream.send(p), speech(1.1));
  await play((p) => stream.send(p), gap);
  await stream.stop();
  assert.deepEqual(finals, ['First utterance.', 'Second utterance.']);
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls[0].url.endsWith('/audio/transcriptions'));
  assert.equal(mock.calls[0].headers.authorization, 'Bearer gk');
  await mock.close();
});

test('a whole meeting: audio in, question detected, grounded answer streamed, notes and files written', async () => {
  const dir = tmp();
  const work = path.join(dir, 'work'); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'secrets-rotation.md'), '# Secrets rotation\nStatic secrets rotate every 30 days through the pipeline. Database credentials are dynamic, issued by Vault with a 24 hour TTL.\n');
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  const llmMock = await mockLlm((body) => {
    const user = JSON.stringify(body.messages);
    if (user.includes('Write the notes in Markdown')) return 'TITLE: Secrets rotation review\n\n## Summary\nDiscussed rotation.\n\n## Decisions\n- Keep 30 days.\n\n## Action items\n### Mine\n- [ ] Share the runbook (due: not stated)\n### Others\nNone.\n\n## Open questions\nNone.';
    if (user.includes('reply with exactly SKIP')) return 'SKIP';
    return 'We rotate static secrets every 30 days through the pipeline.\n\n- Database credentials are dynamic from Vault with a 24 hour TTL.';
  });
  const dg = await mockDeepgram(['Ade, how often do we rotate secrets in the pipeline?']);
  settings.set({ me: { name: 'Ade', role: 'DevSecOps engineer' }, llm: { baseUrls: { anthropic: llmMock.url } }, stt: { skipSilence: false } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const library = new Library();
  await library.reindex([{ dir: work, label: 'work', kind: 'work' }]);
  const store = new MeetingStore(path.join(dir, 'Meetings'), path.join(dir, 'live'));
  const llm = createLlm(settings, { allowBaseUrls: true });
  const session = new MeetingSession({ settings, library, store, llm, getProfile: () => '## Standing positions\nNo long-lived static keys.', getPersonality: () => '', sttBaseUrl: dg.url });
  const events = [];
  for (const ev of ['turn', 'card', 'card-delta', 'card-done', 'mention', 'error']) session.on(ev, (p) => events.push([ev, p]));

  session.start({ title: '', channels: ['them'] });
  assert.equal(fs.readdirSync(path.join(dir, 'live')).length, 1, 'autosave started');
  await play((p) => session.pushAudio('them', p), speech(1), { realtime: true });
  await sleep(1700); // provider final + the settle delay + the answer

  const of = (name) => events.filter((e) => e[0] === name).map((e) => e[1]);
  assert.deepEqual(of('error'), []);
  assert.equal(of('turn')[0].turn.text, 'Ade, how often do we rotate secrets in the pipeline?');
  assert.equal(of('mention').length, 1);
  const card = of('card')[0];
  assert.equal(card.action, 'answer');
  assert.equal(card.reason, 'question to you');
  const done = of('card-done')[0];
  assert.ok(done.text.startsWith('We rotate static secrets every 30 days'));
  assert.equal(done.status, 'done');
  assert.deepEqual(done.files, [path.join('work', 'secrets-rotation.md')]);
  assert.equal(of('card-delta').filter((d) => d.delta).map((d) => d.delta).join(''), done.text);
  // What the model was actually sent:
  const sent = llmMock.calls[0].body;
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.ok(sent.system[0].text.includes('No long-lived static keys.'));
  const userText = sent.messages[0].content.find((c) => c.type === 'text').text;
  assert.ok(userText.includes('Static secrets rotate every 30 days') && userText.includes('Speaker 1: Ade, how often do we rotate secrets'));

  // A manual action while the meeting runs.
  session.runAction('ask', { typed: 'what is our TTL for database credentials?' });
  await sleep(300);
  assert.equal(of('card-done').length, 2);

  const result = await session.stop();
  assert.equal(result.turns, 1);
  assert.ok(result.cost.llm > 0 && result.cost.sttMinutes > 0);
  assert.equal(fs.readdirSync(path.join(dir, 'live')).length, 0, 'autosave cleared');
  assert.ok(fs.readFileSync(result.file, 'utf8').includes('how often do we rotate secrets'));

  // Notes afterwards rewrite the same meeting under its real title.
  const notes = await generateNotes({ llm, name: 'Ade', meta: result.meta, transcriptPlain: result.transcriptPlain });
  assert.equal(notes.title, 'Secrets rotation review');
  assert.equal(llmMock.calls.at(-1).body.model, 'claude-opus-5-5');
  result.meta.title = notes.title;
  const file = store.save(result.meta, notes.notesMd, result.transcriptMd);
  assert.ok(path.basename(file).endsWith('-secrets-rotation-review.md'));
  assert.equal(store.list().length, 1);
  assert.ok(transcriptMdToPlain(store.find(result.meta.id).transcript).includes('] Speaker 1: Ade, how often'));
  await llmMock.close(); await dg.close();

  // The same library through the MCP server, as Claude would see it.
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], env: { ...process.env, UNDERSTUDY_MEETINGS_DIR: path.join(dir, 'Meetings') } });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['add_meeting_update', 'get_action_items', 'get_daily_digest', 'get_live_transcript', 'get_meeting', 'list_meetings', 'search_meetings', 'set_action_item']);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.ok((await call('list_meetings', {})).includes('Secrets rotation review'));
  assert.ok((await call('get_meeting', { id: result.meta.id, part: 'transcript' })).includes('how often do we rotate secrets'));
  assert.ok((await call('search_meetings', { query: 'rotate secrets' })).includes(result.meta.id));
  assert.ok((await call('get_daily_digest', { date: result.meta.date })).includes('Keep 30 days'));
  assert.ok((await call('get_action_items', { from: result.meta.date })).includes('Share the runbook'));
  await client.close();
});

test('proactive check that answers SKIP shows nothing', async () => {
  const dir = tmp();
  const settings = new Settings(path.join(dir, 'cfg'), plain);
  const llmMock = await mockLlm(() => 'SKIP');
  const dg = await mockDeepgram([]);
  settings.set({ llm: { baseUrls: { anthropic: llmMock.url } } });
  settings.setSecret('anthropic', 'ak'); settings.setSecret('deepgram', 'dk');
  const session = new MeetingSession({ settings, library: new Library(), store: new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live')), llm: createLlm(settings, { allowBaseUrls: true }), getProfile: () => '', getPersonality: () => '', sttBaseUrl: dg.url });
  const shown = [];
  session.on('card', (c) => shown.push(c));
  session.start({ channels: ['them'] });
  session.runAction('proactive', {}, { auto: true });
  await sleep(300);
  assert.equal(shown.length, 0);
  assert.equal(session.cards.size, 0);
  assert.equal(await session.stop().then((r) => r.file), null, 'an empty meeting writes no file');
  await llmMock.close(); await dg.close();
});
