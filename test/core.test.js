'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chunkMarkdown } = require('../src/main/knowledge/chunker');
const { tokenize, Bm25Index } = require('../src/main/knowledge/bm25');
const { Library } = require('../src/main/knowledge/library');
const { analyzeTurn } = require('../src/main/triggers');
const { Transcript, isEcho } = require('../src/main/transcript');
const { VoiceGate } = require('../src/main/stt/vad');
const { pcm16ToWav, wavToPcm16 } = require('../src/main/stt/wav');
const { MeetingStore, newMeta, parse, section } = require('../src/main/meetings/store');
const { Settings } = require('../src/main/settings');
const { systemPrompt, userPrompt } = require('../src/main/prompts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-'));

test('chunker keeps heading paths and does not split on # inside code', () => {
  const md = `---\ntitle: Runbook\n---\n# Deploy\nIntro text.\n\n## Rollback\nRun this:\n\n\`\`\`bash\n# not a heading\nkubectl rollout undo deploy/api\n\`\`\`\n\n## Secrets\nVault rotates every 30 days.\n`;
  const chunks = chunkMarkdown(md);
  const rollback = chunks.find((c) => c.text.includes('kubectl'));
  assert.deepEqual(rollback.headings, ['Runbook', 'Deploy', 'Rollback']);
  assert.ok(rollback.text.includes('# not a heading'));
  assert.deepEqual(chunks.find((c) => c.text.includes('Vault')).headings, ['Runbook', 'Deploy', 'Secrets']);
});

test('chunker splits long sections without losing text', () => {
  const para = 'word '.repeat(120).trim();
  const md = `# Big\n${Array.from({ length: 12 }, (_, i) => `${para} p${i}`).join('\n\n')}`;
  const chunks = chunkMarkdown(md, { maxChars: 1400 });
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.text.length <= 1400);
  for (let i = 0; i < 12; i++) assert.ok(chunks.some((c) => c.text.includes(`p${i}`)));
});

test('tokenizer keeps technical compounds and their parts', () => {
  const t = tokenize('We run CI/CD on k8s with node.js and Argo-CD pipelines');
  for (const w of ['ci/cd', 'ci', 'cd', 'k8s', 'node.js', 'argo-cd', 'argo', 'pipeline']) assert.ok(t.includes(w), `missing ${w}`);
  assert.ok(!t.includes('we') && !t.includes('with'));
});

test('library indexes a folder and finds the right file', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'runbooks'));
  fs.writeFileSync(path.join(dir, 'runbooks', 'secrets-rotation.md'), '# Secrets rotation\nWe rotate Vault dynamic database credentials every 24 hours using the Vault agent sidecar. Static secrets are rotated every 30 days through the pipeline.\n');
  fs.writeFileSync(path.join(dir, 'image-scanning.md'), '# Image scanning\nEvery container image is scanned with Trivy in the build stage. Critical CVEs fail the pipeline; highs need a waiver.\n');
  fs.writeFileSync(path.join(dir, 'lunch.md'), '# Lunch\nThe canteen is closed on Fridays.\n');
  fs.writeFileSync(path.join(dir, 'ignore.png'), 'x');
  const lib = new Library();
  const stats = await lib.reindex([{ dir, label: 'work', kind: 'work' }]);
  assert.equal(stats.files, 3);
  const hits = lib.search('how often do we rotate secrets in the pipeline');
  assert.ok(hits[0].rel.endsWith('secrets-rotation.md'), hits[0].rel);
  assert.ok(lib.search('what happens when trivy finds a critical CVE')[0].rel.endsWith('image-scanning.md'));
  const sample = await lib.sampleForProfile(100000);
  assert.equal(sample.files, 3);
  assert.equal(sample.chunksIncluded, sample.chunksTotal);
  assert.ok(sample.text.includes('Trivy'));
});

test('bm25 ranks the document with the rarer matching term first', () => {
  const idx = new Bm25Index();
  idx.add(tokenize('terraform state locking with dynamodb'));
  idx.add(tokenize('terraform modules and versions'));
  idx.add(tokenize('general notes about locking doors'));
  assert.equal(idx.search(tokenize('terraform dynamodb lock'))[0].doc, 0);
});

test('triggers: real questions fire, logistics and filler do not', () => {
  const opt = { names: ['Ade', 'Adebodun'], mode: 'questions' };
  const fire = [
    'Can you walk us through how the deployment pipeline handles secrets rotation?',
    'what is our plan if the scanner blocks the release',
    'Ade, any concerns about moving this to Friday?',
    'So how long would the migration take',
    "I'm wondering whether we need a WAF in front of this.",
    'We should probably ask Ade about the IAM policy for that bucket',
    'Thoughts on using OIDC instead of static keys?',
  ];
  const quiet = [
    'Can everyone see my screen?',
    'Can you hear me okay?',
    'Right?',
    'Okay.',
    'We deployed the fix yesterday and it went fine.',
    'How is everyone doing today?',
    'Does that make sense?',
    'You know?',
  ];
  for (const s of fire) assert.ok(analyzeTurn(s, opt).fire, `should fire: ${s}`);
  for (const s of quiet) assert.ok(!analyzeTurn(s, opt).fire, `should stay quiet: ${s}`);
  assert.equal(analyzeTurn(fire[2], opt).reason, 'question to you');
  assert.ok(!analyzeTurn(fire[0], { ...opt, mode: 'manual' }).fire);
  assert.ok(!analyzeTurn('The grade was fine.', { names: ['Ade'], mode: 'questions' }).mentioned, 'name must match whole words');
  const multi = analyzeTurn('We looked at the logs yesterday. What do you think caused the spike?', opt);
  assert.equal(multi.ask, 'What do you think caused the spike?');
});

test('transcript merges continuous speech and drops microphone echo', () => {
  const t = new Transcript({ myLabel: 'Ade' });
  const t0 = Date.now();
  t.addFinal('them', 'Can you walk us through the rollback plan?', 'Speaker 1', t0);
  assert.equal(t.addFinal('me', 'can you walk us through the rollback plan', null, t0 + 300), null, 'echo dropped');
  const mine = t.addFinal('me', 'Sure, we keep the previous image tagged and roll back with Argo.', null, t0 + 2000);
  assert.equal(mine.turn.speaker, 'Ade');
  const more = t.addFinal('me', 'It takes about two minutes.', null, t0 + 3000);
  assert.ok(more.merged);
  assert.equal(t.turns.length, 2);
  assert.ok(t.forPrompt().includes('Speaker 1: Can you walk us through'));
  assert.ok(t.toMarkdown().includes('**['));
  assert.ok(!isEcho('I disagree with that completely', ['we should ship on friday']));
});

test('voice gate passes speech with pre-roll and blocks silence', () => {
  const rate = 16000;
  const noise = (n, amp) => Int16Array.from({ length: n }, () => Math.round((Math.random() * 2 - 1) * amp));
  const tone = (n, amp) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * amp * (0.6 + 0.4 * Math.sin(i / 400))));
  const gate = new VoiceGate({ sampleRate: rate });
  let out = 0, opened = 0, closed = 0;
  const feed = (pcm) => { for (let i = 0; i < pcm.length; i += 1600) { const r = gate.process(pcm.subarray(i, i + 1600)); if (r.audio) out += r.audio.length; if (r.opened) opened++; if (r.closed) closed++; } };
  feed(noise(rate * 3, 40));          // 3 s of room noise
  assert.equal(out, 0, 'silence must not pass');
  feed(tone(rate * 2, 6000));         // 2 s of speech-level sound
  feed(noise(rate * 3, 40));          // 3 s of room noise
  assert.equal(opened, 1); assert.equal(closed, 1);
  const seconds = out / rate;
  assert.ok(seconds > 2.9 && seconds < 3.8, `forwarded ${seconds}s (speech + pre-roll + tail)`);
});

test('voice gate keeps all of a real spoken sentence', () => {
  const { pcm, sampleRate } = wavToPcm16(fs.readFileSync(path.join(__dirname, 'fixtures', 'question.wav')));
  assert.equal(sampleRate, 16000);
  const lead = new Int16Array(16000 * 2), tail = new Int16Array(16000 * 3);
  const all = new Int16Array(lead.length + pcm.length + tail.length); all.set(pcm, lead.length);
  const gate = new VoiceGate({ sampleRate });
  let out = 0, firstOpenAt = -1;
  for (let i = 0; i < all.length; i += 1600) { const r = gate.process(all.subarray(i, i + 1600)); if (r.opened && firstOpenAt < 0) firstOpenAt = i; if (r.audio) out += r.audio.length; }
  // Loudness of the speech itself, to find where it really starts and ends.
  let first = -1, last = -1;
  for (let i = 0; i + 320 <= pcm.length; i += 320) if (VoiceGate.frameDb(pcm.subarray(i, i + 320)) > -40) { if (first < 0) first = i; last = i + 320; }
  const speech = last - first;
  assert.ok(out >= speech, `forwarded ${out} samples for ${speech} samples of speech`);
  assert.ok(out < all.length - 16000 * 2.5, 'most of the silence was skipped');
});

test('wav round trip', () => {
  const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const back = wavToPcm16(pcm16ToWav(pcm, 16000));
  assert.deepEqual([...back.pcm], [...pcm]);
  assert.equal(back.sampleRate, 16000);
});

test('meeting store: save, rename on new title, list, search, digest, crash recovery', () => {
  const dir = tmp();
  const store = new MeetingStore(dir, path.join(dir, '.live'));
  const meta = newMeta('', new Date(2026, 10, 14, 14, 30, 5));
  assert.equal(meta.id, '20261114-143005');
  meta.end = '15:10'; meta.durationMin = 40; meta.speakers = ['Ade', 'Speaker 1'];
  const transcript = '**[14:30:09] Speaker 1:** Can we move the "release" to Friday?\n\n**[14:30:15] Ade:** Only if the Trivy scan is green.';
  const f1 = store.save(meta, '', transcript);
  assert.ok(f1.endsWith(path.join('2026-11-14', '1430-meeting-14-30.md')));
  meta.title = 'Release date: "Friday" cutover';
  const notes = '## Summary\nAgreed to release on Friday if the scan passes.\n\n## Decisions\n- Release Friday.\n\n## Action items\n### Mine\n- [ ] Confirm scan (due: Thursday)\n### Others\n- [ ] Speaker 1: update the calendar (due: not stated)\n\n## Open questions\nNone.';
  const f2 = store.save(meta, notes, transcript);
  assert.ok(!fs.existsSync(f1), 'old file removed after retitle');
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Release date: "Friday" cutover');
  assert.deepEqual(list[0].speakers, ['Ade', 'Speaker 1']);
  assert.ok(list[0].summary.startsWith('Agreed to release'));
  const got = store.find(meta.id);
  assert.ok(got.transcript.includes('Trivy scan'));
  assert.ok(section(got.notes, 'Action items').includes('Confirm scan'));
  assert.equal(store.search('trivy friday')[0].id, meta.id);
  assert.equal(store.actionItems({ from: '2026-11-01' }).length, 1);
  const daily = fs.readFileSync(path.join(dir, '2026-11-14', '_daily.md'), 'utf8');
  assert.ok(daily.includes('### Summary') && daily.includes('#### Mine') && !daily.includes('Trivy scan is green'));
  assert.equal(parse(fs.readFileSync(f2, 'utf8'), f2).meta.durationMin, 40);

  // A meeting that never reached "stop" is recovered from its autosave.
  const m2 = newMeta('Standup', new Date(2026, 10, 15, 9, 0, 0));
  store.beginLive(m2);
  store.appendLive(m2.id, { type: 'turn', turn: { id: 1, t: m2.startMs + 1000, end: m2.startMs + 2000, speaker: 'Ade', text: 'Morning all.' } });
  store.appendLive(m2.id, { type: 'turn', turn: { id: 1, t: m2.startMs + 1000, end: m2.startMs + 4000, speaker: 'Ade', text: 'Morning all. Two things from me.' } });
  const rec = store.recoverOrphans(null);
  assert.equal(rec.length, 1);
  assert.ok(fs.readFileSync(rec[0], 'utf8').includes('Morning all. Two things from me.'));
  assert.equal(fs.readdirSync(path.join(dir, '.live')).length, 0);
});

test('settings merge defaults, persist, and keep secrets out of settings.json', () => {
  const dir = tmp();
  const crypto = { available: () => true, encrypt: (s) => Buffer.from(s.split('').reverse().join('')), decrypt: (b) => b.toString().split('').reverse().join('') };
  const s = new Settings(dir, crypto);
  assert.equal(s.get().stt.provider, 'deepgram');
  assert.equal(s.get().remote.enabled, false);
  assert.equal(s.get().remote.micFrom, 'recorder');
  s.set({ me: { name: 'Ade' }, llm: { live: { model: 'x' } } });
  s.setSecret('deepgram', 'dg-secret-123');
  const again = new Settings(dir, crypto);
  assert.equal(again.get().remote.micFrom, 'recorder');
  assert.equal(again.get().me.name, 'Ade');
  assert.equal(again.get().llm.live.provider, 'anthropic');
  assert.equal(again.get().llm.live.model, 'x');
  assert.equal(again.getSecret('deepgram'), 'dg-secret-123');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('dg-secret'));
  assert.ok(!fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8').includes('dg-secret-123'));
  again.setSecret('deepgram', '');
  assert.equal(again.getSecret('deepgram'), '');
});

test('prompts carry the profile, the excerpts and the question', () => {
  const sys = systemPrompt({ name: 'Ade', role: 'DevSecOps engineer', profile: '## Standing positions\nNo static keys.', personality: 'Keep it to one sentence.' });
  assert.ok(sys.includes("Ade's real-time meeting copilot") && sys.includes('No static keys.') && sys.includes('Keep it to one sentence.'));
  const user = userPrompt({ action: 'answer', transcript: '[10:00:00] Speaker 1: How do we rotate secrets?', hits: [{ rel: 'work/secrets.md', headings: ['Rotation'], text: 'Every 30 days.', kind: 'work' }], params: { ask: 'How do we rotate secrets?', speaker: 'Speaker 1' } });
  assert.ok(user.includes('<excerpt source="work/secrets.md | Rotation">') && user.includes('Speaker 1 just said: "How do we rotate secrets?"'));
});

test('claude connector: merges into an existing config, keeps a backup, refuses broken JSON', () => {
  const claude = require('../src/main/claude-connect');
  const dir = tmp();
  const cfg = path.join(dir, 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(cfg));
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  const opts = { execPath: 'C:\\Apps\\Understudy\\Understudy.exe', serverPath: 'C:\\Apps\\Understudy\\resources\\app.asar\\src\\mcp\\server.js', meetingsDir: 'C:\\Users\\a\\Documents\\Understudy\\Meetings' };
  claude.install(opts, cfg);
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.equal(after.mcpServers.other.command, 'x');
  assert.deepEqual(after.mcpServers.understudy, { command: opts.execPath, args: [opts.serverPath], env: { ELECTRON_RUN_AS_NODE: '1', UNDERSTUDY_MEETINGS_DIR: opts.meetingsDir } });
  assert.ok(fs.existsSync(`${cfg}.before-understudy.bak`));
  fs.writeFileSync(cfg, '{ not json');
  assert.throws(() => claude.install(opts, cfg), /not valid JSON/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not json', 'a broken file is left exactly as it was');
  const win = claude.configCandidates('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: path.join(dir, 'nolocal') }, 'C:\\Users\\a');
  assert.ok(win.at(-1).endsWith('claude_desktop_config.json') && win.at(-1).includes('Roaming'));
});

test('SSE reader survives events split anywhere, including inside a CRLF', async () => {
  const { readSse } = require('../src/main/llm/sse');
  const wire = 'event: a\r\ndata: {"n":1}\r\n\r\nevent: b\r\ndata: {"n":2,"t":"h\u00e9llo"}\r\n\r\ndata: {"n":3}\n\ndata: {"n":4}';
  const bytes = Buffer.from(wire, 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const body = (async function* () { yield bytes.subarray(0, cut); yield bytes.subarray(cut); })();
    const got = [];
    for await (const rec of readSse({ body })) got.push(JSON.parse(rec.data).n);
    assert.deepEqual(got, [1, 2, 3, 4], `cut at byte ${cut}`);
  }
});

test('triggers: realistic meeting speech (short asks, unpunctuated text, statements that start with question words)', () => {
  const { analyzeTurn } = require('../src/main/triggers');
  const opt = { names: ['Ade', 'Adebodun'], mode: 'questions' };
  const FIRE = [
 'Ade, thoughts?','Any blockers?','Any concerns?','Ade?','Thoughts?','Rollback plan?',
 'How are you handling secrets rotation in the pipeline?','Should we wait for the audit before we deploy this?','Can we start the key rotation this sprint?','Are we all on the same Terraform version?','Do we have anything else blocking the release?','Is it safe to rotate during business hours?',
 'Can you hear me? What is the rollback plan?',
 'okay great and what is the rollback plan if the scan fails','right so who owns the incident response runbook','yeah but why are we still using static keys','i was wondering how we rotate the database credentials','sorry what was the retention period for the audit logs','so how long would the migration take','what is our plan if the scanner blocks the release',
 "I'd like to hear from security on whether this is acceptable.",'It would help to know what the blast radius is here.',"I'm wondering whether we need a WAF in front of this.",'Walk us through the pipeline stages.',
 'We should probably ask Ade about the IAM policy for that bucket','Over to you, Ade.','Thoughts on using OIDC instead of static keys?','What do you think caused the spike?',
];
  const QUIET = [
 'When we deployed last week it broke the ingress.','What I mean is we should ship it behind a flag.','Have a good weekend everyone.','Do not merge that until Friday.','May fifth is the deadline for the audit.','Will do, I will send it over.',
 'The problem is that we do not have budget for it.','It depends on how much traffic we get on launch day.','How it works today is the cluster pulls the secret at boot.',
 'I posted an update on Slack about the outage.','Thanks for your feedback on the pull request.','I do not have any concerns with that approach.',
 'Thanks Ade, that was really helpful today.',"I'll sync with Ade after this call.",
 'That makes sense, right?','You know what I mean?','Who knows, maybe it will just work.',
 'Sorry, what was that?','Can you go back one slide?','Can you scroll down a bit?','Is Bob joining us today?','Shall we take a five minute break?','Who just joined?','Can everyone see my screen?','Can you hear me okay?','Right?','Okay.','Does that make sense?','How is everyone doing today?','Are we recording?',
 'We deployed the fix yesterday and it went fine.','What is left is the security sign-off and the load test.','When I looked yesterday there were still two highs open.','Okay, so actions. Ade owns the sign-off and the waiver decision by Thursday.',
];
  const missed = FIRE.filter((s) => !analyzeTurn(s, opt).fire);
  const alarms = QUIET.filter((s) => analyzeTurn(s, opt).fire);
  assert.deepEqual(missed, [], 'questions that were missed');
  assert.deepEqual(alarms, [], 'statements that fired');
  // Names that are also ordinary words only count when used as a name.
  for (const name of ['Will', 'Mark', 'May', 'Grant', 'Dev', 'Art']) {
    const o = { names: [name], mode: 'questions' };
    for (const s of ['We will deploy the fix on Friday afternoon.', 'Please mark the ticket as done before you leave.', 'It may take a few days to get the grant approved.']) {
      const r = analyzeTurn(s, o);
      assert.ok(!r.fire && !r.mentioned, `${name}: ${s}`);
    }
    assert.equal(analyzeTurn(`${name}, what do you think about the rollout?`, o).reason, 'question to you');
  }
});
