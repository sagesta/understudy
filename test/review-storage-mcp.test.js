'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { redactSecrets } = require('../src/main/knowledge/redact');
const { scrub: scrubCrash } = require('../src/main/crashlog');
const { Settings, writeAtomic } = require('../src/main/settings');
const claude = require('../src/main/claude-connect');
const liveCopy = require('../src/main/live-copy');
const { MeetingStore, newMeta, parse, scanTasks } = require('../src/main/meetings/store');
const { carryOver, rewriteSaved, doneTaskTexts } = require('../src/main/meetings/carry-over');
const inbox = require('../src/main/notes-inbox');
const issues = require('../src/main/issues');
const shared = require('../src/main/shared-folder');
const { Bm25Index, tokenize } = require('../src/main/knowledge/bm25');
const { chunkMarkdown, stripFrontmatter } = require('../src/main/knowledge/chunker');
const { Library } = require('../src/main/knowledge/library');
const { convertDiagram, shutdownDiagramWorker } = require('../src/main/knowledge/diagrams');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-batch3-'));
const SERVER = path.join(__dirname, '..', 'src', 'mcp', 'server.js');

function tryJunction(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

async function withMcp(env, fn) {
  const cleanEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: cleanEnv, stderr: 'pipe' });
  const client = new Client({ name: 'batch3-test', version: '0.1.0' });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

// ---------------------------------------------------------------- 1. Redaction & Crashlog

test('redactSecrets: Groq keys, HTTP Authorization schemes, standalone Bearer, and O(N) JWT scan', () => {
  const groq = 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  const r1 = redactSecrets(`Key=${groq}\nAuthorization: Bearer my-super-secret-session-token-99\nAuthorization: Token tok_9876543210abcdef\nAuthorization: Basic dXNlcjpwYXNzd29yZDEyMw==\ncurl -H "Bearer xyZ9876543210abcdefGHIJ"`);
  assert.ok(!r1.text.includes('gsk_'), r1.text);
  assert.ok(r1.text.includes('[removed: Groq API key]'), r1.text);
  assert.ok(!r1.text.includes('my-super-secret-session-token-99'), r1.text);
  assert.ok(!r1.text.includes('tok_9876543210abcdef'), r1.text);
  assert.ok(!r1.text.includes('dXNlcjpwYXNzd29yZDEyMw=='), r1.text);
  assert.ok(!r1.text.includes('xyZ9876543210abcdefGHIJ'), r1.text);
  assert.ok(r1.count >= 5);

  // Harmless prose with "Bearer" is untouched.
  const prose = 'The standard uses a Bearer token header in HTTP requests.';
  assert.equal(redactSecrets(prose).text, prose);

  // Pathological 400 KB input with thousands of "eyJ" candidates runs in linear time.
  const realJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const pathological = 'eyJ-not-a-jwt-'.repeat(29000) + ' ' + realJwt;
  assert.ok(pathological.length >= 400000);
  const t0 = performance.now();
  const r2 = redactSecrets(pathological);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `removeJwts took ${elapsed.toFixed(1)} ms on 400 KB`);
  assert.equal(r2.count, 1);
  assert.ok(!r2.text.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
  assert.ok(r2.text.endsWith('[removed: JWT]'));

  // CrashLog scrub removes sk- without leaking an 8-char prefix, and scrubs gsk_ and Bearer headers.
  const scrubbed = scrubCrash(`err sk-proj-SECRET1234567890abcdef and ${groq} and Authorization: Bearer secret_bearer_token_12345`);
  assert.ok(!scrubbed.includes('SECRET12') && !scrubbed.includes('sk-proj-'), scrubbed);
  assert.ok(!scrubbed.includes(groq), scrubbed);
  assert.ok(!scrubbed.includes('secret_bearer_token_12345'), scrubbed);
});

// ---------------------------------------------------------------- 2. Atomic writes, Settings, Claude Connect & Live Copy

test('writeAtomic & Settings: unique temp names, cleanup on failure, opt-in requireEncryption', () => {
  const dir = tmp();
  const target = path.join(dir, 'settings.json');
  writeAtomic(target, '{"ok":true}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);

  // Default Settings fallback works when OS encryption is unavailable; opt-in requireEncryption refuses.
  const plainCfg = new Settings(path.join(dir, 'plain'), { available: () => false });
  plainCfg.setSecret('openai', 'sk-test');
  assert.equal(plainCfg.getSecret('openai'), 'sk-test');

  const strictCfg = new Settings(path.join(dir, 'strict'), { available: () => false }, { requireEncryption: true });
  assert.throws(() => strictCfg.setSecret('openai', 'sk-test'), /Secret encryption is not available/);

  // Refuses directory/junction target and cleans up its unique .tmp file.
  const sub = path.join(dir, 'folder-in-the-way');
  fs.mkdirSync(sub);
  assert.throws(() => writeAtomic(sub, 'nope'));
  assert.ok(fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')), 'no stray .tmp left behind');
});

test('claude-connect: shq strips CR/LF, neutralises trailing backslashes, preserves PS escaping, and keeps first backup', () => {
  assert.equal(claude.shq('C:\\Users\\a\\Docs\\$(calc)\\it\'s'), '"C:\\Users\\a\\Docs\\`$(calc)\\it\'s"');
  const trailing = claude.shq('C:\\Users\\a\\Folder\\');
  assert.ok(trailing.endsWith('\\\\"'), `trailing backslash cannot escape quote: ${trailing}`);
  assert.ok(!/[\r\n]/.test(claude.shq('C:\\a\r\nInvoke-Expression calc')));

  const dir = tmp();
  const cfgPath = path.join(dir, 'claude_desktop_config.json');
  fs.writeFileSync(cfgPath, '{"mcpServers":{"existing":{"command":"node"}}}');
  const opts = { execPath: 'C:\\App\\Understudy.exe', serverPath: SERVER, meetingsDir: path.join(dir, 'M'), notesDir: path.join(dir, 'N'), configPath: cfgPath };
  claude.install(opts);
  const firstBak = fs.readFileSync(`${cfgPath}.before-understudy.bak`, 'utf8');
  assert.ok(firstBak.includes('"existing"'));
  claude.install({ ...opts, notesDir: path.join(dir, 'N2') });
  assert.equal(fs.readFileSync(`${cfgPath}.before-understudy.bak`, 'utf8'), firstBak, 'COPYFILE_EXCL keeps original backup');
});

test('live-copy: transient write lock on ended() is retried by close(), and async periodic flush works', async () => {
  const files = new Map();
  let failEndedOnce = true;
  const state = { active: false, paused: false, title: 'Sync check', startedAt: Date.UTC(2026, 10, 15, 14, 0, 0), transcript: { turns: [] } };
  let scheduled = null;
  const copy = liveCopy.createLiveCopy({
    getState: () => state,
    getDir: () => 'C:\\Meetings',
    pcName: 'Desk-PC',
    now: () => Date.UTC(2026, 10, 15, 14, 0, 0),
    setTimer: (fn) => { scheduled = fn; return 1; },
    clearTimer: () => { scheduled = null; },
    io: {
      read: (f) => { if (!files.has(f)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(f); },
      write: (f, text) => {
        if (failEndedOnce && text.includes('status: ended')) {
          failEndedOnce = false;
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        files.set(f, text);
      },
      writeAsync: async (f, text) => { files.set(f, text); return true; },
    },
  });

  state.active = true;
  copy.stateChanged();
  const liveFile = path.join('C:\\Meetings', '_live-Desk-PC.md');
  assert.match(files.get(liveFile), /status: listening/);

  // Periodic transcript flush uses non-blocking writeAsync.
  state.transcript.turns = [{ speaker: 'Ade', text: 'Async update line', t: Date.UTC(2026, 10, 15, 14, 1, 0), final: true }];
  copy.changed();
  assert.equal(typeof scheduled, 'function');
  scheduled();
  await new Promise((r) => setImmediate(r));
  assert.match(files.get(liveFile), /Async update line/);

  // Meeting ends while Google Drive transiently locks the file.
  state.active = false;
  copy.ended({ title: 'Sync check', file: 'C:\\Meetings\\2026-11-15\\1400-sync-check.md', turns: 1 });
  assert.match(files.get(liveFile), /status: listening/, 'first ended() failed on EBUSY');

  // App shutdown calls close(), which retries pendingEnded so the file is not left stuck at listening.
  copy.close();
  assert.match(files.get(liveFile), /status: ended/);
});

// ---------------------------------------------------------------- 3. MeetingStore & Carry-over

test('MeetingStore: junction confinement, YAML speakers, EOF front matter, fences, DONE_MARK, Unicode speaker rename', () => {
  const root = tmp();
  const meetingsDir = path.join(root, 'Meetings');
  const outsideDir = path.join(root, 'Outside');
  fs.mkdirSync(meetingsDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, '1000-secret.md'), '---\nid: 20261115-100000\ntitle: "Outside Secret"\ndate: 2026-11-15\nstart: "10:00"\n---\n\n# Outside Secret\n\nTop secret.\n\n## Transcript\n\n**[10:00:01] A:** Secret.\n');

  const store = new MeetingStore(meetingsDir, path.join(root, 'live'));
  const dayDir = path.join(meetingsDir, '2026-11-14');
  fs.mkdirSync(dayDir, { recursive: true });

  // Unquoted + single-quoted speakers, uppercase .MD, lock/dot files ignored, single-line fence, spaced done mark.
  fs.writeFileSync(path.join(dayDir, '.hidden.md'), '---\nid: hidden1\n---\n');
  fs.writeFileSync(path.join(dayDir, '~$lock.md'), '---\nid: lock1\n---\n');
  const validPath = path.join(dayDir, '0900-design.MD');
  fs.writeFileSync(validPath, [
    '---',
    'id: 20261114-090000',
    'title: "Design Review"',
    'date: 2026-11-14',
    'start: "09:00"',
    "speakers: [Élodie, 'Bob Smith']",
    '---',
    '',
    '# Design Review',
    '',
    'Run ```npm test``` before merging.',
    '~~~',
    '- [ ] inside tilde fence (not a task)',
    '~~~',
    '- [x] Real task after inline backticks (done:   2026-11-14 )',
    '',
    'Élodie2 is a test handle, while Élodie spoke.',
    '',
    '## Transcript',
    '',
    '**[09:00:05] Élodie:** Bonjour.',
  ].join('\n'));

  // Junction inside Meetings pointing outside is ignored by list/find/search and refused on save.
  const plantedJunction = tryJunction(outsideDir, path.join(meetingsDir, '2026-11-15'));
  const listed = store.list();
  assert.deepEqual(listed.map((m) => m.id), ['20261114-090000']);
  assert.deepEqual(listed[0].speakers, ['Élodie', 'Bob Smith']);
  if (plantedJunction) {
    assert.equal(store.find('20261115-100000'), null);
    assert.equal(store.search('Outside').length, 0);
    const badMeta = { id: '20261115-110000', title: 'Escape', date: '2026-11-15', start: '11:00', startMs: 1, speakers: [] };
    assert.throws(() => store.save(badMeta, 'notes', 'tx'), /outside the Meetings folder/i);
  }

  // Tasks after inline ```npm test``` are found, tilde-fenced tasks are skipped, spaced DONE_MARK is parsed.
  const tasks = store.actionItems('20261114-090000');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, 'Real task after inline backticks');
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].doneOn, '2026-11-14');

  // Closing "---" at EOF with no trailing newline still parses as ok frontMatter.
  const eofParsed = parse('---\nid: 20261114-120000\ntitle: "EOF"\n---', 'eof.md');
  assert.equal(eofParsed.frontMatter, 'ok');
  assert.equal(eofParsed.meta.id, '20261114-120000');

  // Unicode word boundary in renameSpeaker notesMentionOld.
  const ren = store.renameSpeaker('20261114-090000', 'Élodie', 'Claire');
  assert.equal(ren.notesMentionOld, true);
});

test('carryOver & rewriteSaved: Marked done earlier survives multiple rewrites and concurrent edits are kept', () => {
  const notes0 = '## Action items\n- [x] Order the cake (done: 2026-11-10)\n- [ ] Book the room\n';
  // First rewrite drops "Order the cake" from Action items -> preserved under Updates.
  const rewrite1 = carryOver(notes0, '## Summary\nShort.\n\n## Action items\n- [ ] Book the room\n', { today: '2026-11-15' });
  assert.match(rewrite1, /- 2026-11-10: Marked done earlier: Order the cake/);
  assert.deepEqual(doneTaskTexts(rewrite1), ['Order the cake']);

  // Second rewrite brings "Order the cake" back -> re-ticked with original date and removed from Marked done earlier.
  const rewrite2 = carryOver(rewrite1, '## Summary\nFull.\n\n## Action items\n- [ ] Order the cake\n- [ ] Book the room\n', { today: '2026-11-16' });
  assert.match(rewrite2, /- \[x\] Order the cake \(done: 2026-11-10\)/);
  assert.ok(!rewrite2.includes('Marked done earlier: Order the cake'), rewrite2);

  // rewriteSaved keeps concurrent title, speaker and transcript edits made while LLM notes were generating.
  const dir = tmp();
  const store = new MeetingStore(path.join(dir, 'M'), path.join(dir, 'live'));
  const meta = newMeta('Initial Title', new Date(2026, 10, 14, 10, 0, 0));
  meta.speakers = ['Speaker 1'];
  store.save(meta, '## Action items\n- [ ] Draft memo', '**[10:00:01] Speaker 1:** Hello.');
  const staleSnap = store.find(meta.id);

  // User renames speaker and title while LLM is generating new notes.
  store.renameSpeaker(meta.id, 'Speaker 1', 'Priya');
  store.renameMeeting(meta.id, 'Renamed During Generation');
  rewriteSaved(store, { ...staleSnap.meta, autoTitle: false }, '## Summary\nFresh notes.\n\n## Action items\n- [ ] Draft memo', staleSnap.transcript, { today: '2026-11-15' });

  const final = store.find(meta.id);
  assert.equal(final.meta.title, 'Renamed During Generation');
  assert.deepEqual(final.meta.speakers, ['Priya']);
  assert.ok(final.transcript.includes('] Priya:** Hello.'));
  assert.ok(final.notes.includes('Fresh notes.'));
});

// ---------------------------------------------------------------- 4. notes-inbox, issues & shared-folder

test('notes-inbox: >6 rapid updates in the same second keep newest 5 versions, long paths hash cleanly, horizontal rules stay prose', () => {
  const dir = tmp();
  const now = new Date(2026, 10, 15, 12, 0, 0).getTime();
  const saved = inbox.saveNote(dir, { title: 'Rapid', text: 'v0', now });
  for (let i = 1; i <= 8; i++) {
    inbox.updateNote(dir, saved.rel, { text: `v${i}`, now });
  }
  const vDir = path.join(dir, '.versions');
  const kept = fs.readdirSync(vDir).sort();
  assert.equal(kept.length, 5);
  const bodies = kept.map((f) => fs.readFileSync(path.join(vDir, f), 'utf8').trim().split('\n').pop()).sort();
  assert.deepEqual(bodies, ['v3', 'v4', 'v5', 'v6', 'v7'], `newest 5 pre-update versions kept, got ${bodies.join(',')}`);
  assert.ok(fs.readFileSync(saved.file, 'utf8').endsWith('\nv8\n'));

  // Deep path with rel > 100 chars keeps backup filename short.
  const deepSub = path.join(dir, 'sub1', 'sub2', 'sub3');
  fs.mkdirSync(deepSub, { recursive: true });
  const longName = `${'very-long-architecture-note-segment-'.repeat(3)}end.md`;
  fs.writeFileSync(path.join(deepSub, longName), '# Deep Note\n\nInitial.\n');
  const deepRel = `sub1/sub2/sub3/${longName}`;
  assert.ok(deepRel.length > 110);
  inbox.updateNote(dir, deepRel, { text: '# Deep Note\n\nUpdated.', now });
  assert.ok(fs.readdirSync(vDir).every((f) => f.length < 160));

  // Markdown starting with "---" horizontal rule + prose is NOT misparsed as YAML front matter.
  const hrFile = path.join(dir, 'hr-prose.md');
  const hrContent = '---\nThis document opens with a horizontal rule banner, not YAML.\n---\n\n# Real Heading\n\nBody text.\n';
  fs.writeFileSync(hrFile, hrContent);
  const readBack = inbox.readNote(dir, 'hr-prose.md');
  assert.ok(readBack.text.startsWith('---\nThis document opens with a horizontal rule banner'), readBack.text);
  inbox.updateNote(dir, 'hr-prose.md', { text: 'Appended paragraph.', mode: 'append', now });
  const afterAppend = fs.readFileSync(hrFile, 'utf8');
  assert.ok(!afterAppend.includes('updated:'), 'no fake YAML updated key injected into prose');
  assert.ok(afterAppend.startsWith('---\nThis document opens with a horizontal rule banner'));
  assert.ok(afterAppend.endsWith('\n\nAppended paragraph.\n'));
});

test('issues & shared-folder: dirty reopen recovery, bare file:/// stacks, UNC path scrubbing, empty notesDir, junction refusal & CopyStopped count', async () => {
  // empty notesDir falls back safely to absolute Documents/Understudy/Issues.
  const fallbackIssues = issues.issuesDirFor({ notesDir: '' });
  assert.ok(path.isAbsolute(fallbackIssues) && fallbackIssues.endsWith(path.join('Understudy', 'Issues')), fallbackIssues);

  // UNC path scrubbing & bare file:/// renderer stack frames.
  const cleaner = issues.makeCleaner('C:\\Users\\Alice');
  const cleanedMsg = cleaner.oneLine('ENOENT opening "\\\\corp-fs\\TeamShare\\Meetings\\2026-11-15\\1400-layoff-plan.md" and \\\\srv\\share\\secret.md', 300);
  assert.ok(!cleanedMsg.includes('layoff-plan') && !cleanedMsg.includes('secret'), cleanedMsg);
  assert.ok(cleanedMsg.includes('<file>.md'), cleanedMsg);

  const frames = issues.stackLines('renderView@file:///C:/Users/Alice/AppData/Local/Programs/Understudy/resources/app.asar/src/renderer/app.js:88:12\nfile:///C:/Users/Alice/PROJECTS/understudy/src/renderer/ui.js:14:3', cleaner);
  assert.deepEqual(frames, ['renderView@src/renderer/app.js:88:12', 'src/renderer/ui.js:14:3']);
  assert.equal(issues.firstFrame(frames), 'renderView@src/renderer/app.js:88:12');

  // Reopen survives a transient write lock via entry.dirty = true on next flush(true).
  const root = tmp();
  const issDir = path.join(root, 'Issues');
  let clock = Date.UTC(2026, 10, 15, 10, 0, 0);
  let blockWrites = false;
  const fsProxy = {
    ...fs,
    renameSync(a, b) {
      if (blockWrites) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.renameSync(a, b);
    },
  };
  const rep = issues.createReporter({ dir: issDir, now: () => clock, fs: fsProxy, sleep: () => {} });
  const sameSiteError = () => new TypeError('boom in widget');
  const created = rep.report(sameSiteError(), 'main');
  assert.ok(created && created.created);
  const issFile = path.join(issDir, created.rel);
  fs.writeFileSync(issFile, issues.setFront(fs.readFileSync(issFile, 'utf8'), { status: 'resolved', fixed: '2026-11-15 test fix' }));

  clock += 120000;
  blockWrites = true;
  assert.equal(rep.report(sameSiteError(), 'main'), null, 'transient EPERM swallowed');
  assert.equal(issues.parseIssue(fs.readFileSync(issFile, 'utf8')).status, 'resolved');

  blockWrites = false;
  clock += 120000;
  assert.equal(rep.flush(true), 1, 'dirty entry flushed once lock clears');
  assert.equal(issues.parseIssue(fs.readFileSync(issFile, 'utf8')).status, 'open');

  // shared-folder junction refusal & CopyStopped meetingsCopied total.
  const sysTarget = path.join(root, 'FakeWindows');
  const appData = path.join(root, 'AppData');
  fs.mkdirSync(sysTarget, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const juncSys = path.join(root, 'DriveLinkSys');
  const juncApp = path.join(root, 'DriveLinkApp');
  if (tryJunction(sysTarget, juncSys)) {
    assert.match(shared.refusal(juncSys, { system: [sysTarget], appData }), /system folder/);
  }
  if (tryJunction(appData, juncApp)) {
    assert.match(shared.refusal(juncApp, { system: [sysTarget], appData }), /own data folder/);
  }

  const curM = path.join(root, 'cur', 'Meetings'), curN = path.join(root, 'cur', 'Notes'), dest = path.join(root, 'SyncDrive');
  fs.mkdirSync(curM, { recursive: true });
  fs.mkdirSync(curN, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(curM, 'm1.md'), 'm1');
  fs.writeFileSync(path.join(curM, 'm2.md'), 'm2');
  fs.writeFileSync(path.join(curN, 'n1.md'), 'n1');
  let copyCount = 0;
  const enospcFs = {
    ...fs.promises,
    async copyFile(src, dst, mode) {
      if (++copyCount === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return fs.promises.copyFile(src, dst, mode);
    },
  };
  const sf = shared.createSharedFolder({
    current: () => ({ meetingsDir: curM, notesDir: curN }),
    defaults: () => ({ meetingsDir: curM, notesDir: curN }),
    guards: () => ({ home: path.join(root, 'home'), appData, system: [sysTarget] }),
    commit: () => {},
    fs: enospcFs,
  });
  await sf.choose(dest);
  await assert.rejects(() => sf.apply({ copy: true }), /2 files were copied before that/);
});

// ---------------------------------------------------------------- 5. BM25, Chunker, Library & Diagrams

test('Bm25Index: live df stays accurate across repeated remove/add, and tokenize supports Unicode & CJK', () => {
  const idx = new Bm25Index();
  idx.add(tokenize('alpha unique_target'));
  idx.add(tokenize('bravo filler words'));
  idx.add(tokenize('charlie filler words'));
  // Simulate 40 edits of another doc containing unique_target so dead postings outnumber N.
  for (let i = 0; i < 40; i++) {
    const d = idx.add(tokenize(`edit ${i} unique_target`));
    idx.remove(d);
  }
  assert.equal(idx.df.get(tokenize('unique_target')[0]), 1);
  const hits = idx.search(tokenize('unique_target'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].doc, 0);
  assert.ok(hits[0].score > 0.5, `IDF must not collapse to 0 (got score=${hits[0].score})`);

  // Unicode diacritic folding, Cyrillic, Greek and CJK bigrams.
  const uIdx = new Bm25Index();
  const dDe = uIdx.add(tokenize('Dr. Müller reviewed the Zürich deployment'));
  const dRu = uIdx.add(tokenize('Сервер Москва активен'));
  const dGr = uIdx.add(tokenize('Σύστημα Αθήνα βάση'));
  const dZh = uIdx.add(tokenize('支付系统的分布式缓存架构设计'));
  assert.equal(uIdx.search(tokenize('Muller Zurich'))[0].doc, dDe);
  assert.equal(uIdx.search(tokenize('Москва'))[0].doc, dRu);
  assert.equal(uIdx.search(tokenize('Αθηνα'))[0].doc, dGr);
  assert.equal(uIdx.search(tokenize('缓存架构'))[0].doc, dZh);
});

test('chunker & Library: horizontal rule preservation, surrogate-safe splits, cumulative caps, and search exclude', async () => {
  const hrDoc = '---\nIntroductory callout between horizontal rules\n---\n\n# Architecture\n\nMain body.';
  assert.equal(stripFrontmatter(hrDoc).title, null);
  assert.equal(stripFrontmatter(hrDoc).body, hrDoc);

  // Surrogate pair ("🚀" = \uD83D\uDE80) at exact maxChars boundary is never split into lone surrogates.
  const emojiLine = 'a'.repeat(99) + '🚀' + 'b'.repeat(50);
  const chunks = chunkMarkdown(emojiLine, { maxChars: 100 });
  assert.equal(chunks.map((c) => c.text).join(''), emojiLine);
  for (const c of chunks) {
    assert.equal(Buffer.from(c.text, 'utf8').toString('utf8'), c.text, 'no lone UTF-16 surrogate');
  }

  // Library cumulative cap & search({ exclude }).
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), '# Alpha\n\nShared keywordzephyr in alpha file.\n');
  fs.writeFileSync(path.join(dir, 'b.md'), '# Beta\n\nShared keywordzephyr in beta file.\n');
  fs.writeFileSync(path.join(dir, 'c.md'), '# Gamma\n\n' + 'Overflow text paragraph. '.repeat(80));

  const cappedLib = new Library({ maxLibraryChars: 160 });
  const stats = await cappedLib.reindex([{ dir, label: 'docs', kind: 'work' }]);
  assert.ok(stats.skipped.some((s) => s.reason === 'library size limit reached'));

  const fullLib = new Library();
  await fullLib.reindex([{ dir, label: 'docs', kind: 'work' }]);
  const allHits = fullLib.search('keywordzephyr');
  assert.equal(allHits.length, 2);
  const filteredHits = fullLib.search('keywordzephyr', { exclude: new Set([path.join(dir, 'a.md')]) });
  assert.equal(filteredHits.length, 1);
  assert.ok(filteredHits[0].file.endsWith('b.md'));
});

test('diagrams: PlantUML <<service>>/<<sqs>>, multi-word/quoted Mermaid sequenceDiagram, and >300-char secret label redaction', () => {
  const puml = convertDiagram([
    '@startuml',
    'component "Order Worker" as ow <<service>>',
    'queue "Events Queue" as eq <<sqs>>',
    'ow -> eq : publish',
    '@enduml',
  ].join('\n'), 'plantuml').markdown;
  assert.ok(puml.includes('- Order Worker (component, service)'), puml);
  assert.ok(puml.includes('- Events Queue (queue, sqs)'), puml);

  const seq = convertDiagram([
    'sequenceDiagram',
    '  autonumber',
    '  participant Web Browser',
    '  actor End User as Customer',
    '  Customer->>"Web Browser": Open checkout',
    '  "Web Browser"->>"Auth Service": Validate session',
    '  Auth Service<<->>Token Store: Sync keys',
    '  loop Health check',
    '    activate Auth Service',
    '    Auth Service-->>Web Browser: 200 OK',
    '    deactivate Auth Service',
    '  end',
    '  destroy Web Browser',
  ].join('\n'), 'mermaid').markdown;
  assert.ok(seq.includes('- Web Browser (participant)'), seq);
  assert.ok(seq.includes('- Customer (actor)'), seq);
  assert.ok(seq.includes('- Customer -> Web Browser: Open checkout'), seq);
  assert.ok(seq.includes('- Web Browser -> Auth Service: Validate session'), seq);
  assert.ok(seq.includes('- Auth Service <-> Token Store: Sync keys'), seq);
  assert.ok(seq.includes('- Auth Service -> Web Browser: 200 OK'), seq);

  // Secret straddling the 300-character label clip in plain() is redacted BEFORE clipping.
  const longSecretLabel = 'x'.repeat(285) + ' sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const flow = convertDiagram(`flowchart LR\n  A["${longSecretLabel}"] --> B[End]`, 'mermaid').markdown;
  const beforeSource = flow.split('## Source')[0];
  assert.ok(!beforeSource.includes('sk-proj-'), beforeSource);
  shutdownDiagramWorker();
});

// ---------------------------------------------------------------- 6. MCP Server

test('mcp server: no host path leak on empty list_meetings, invalid id rejected without echo, list_issues matches fixing-issues.md', async () => {
  const root = tmp();
  const meetings = path.join(root, 'SecretHostPathMeetings');
  const issDir = path.join(root, 'Issues');
  fs.mkdirSync(meetings, { recursive: true });
  fs.mkdirSync(issDir, { recursive: true });

  await withMcp({ UNDERSTUDY_MEETINGS_DIR: meetings, UNDERSTUDY_ISSUES_DIR: issDir }, async (client) => {
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.match(byName.list_issues.description, /fixed: YYYY-MM-DD/);
    assert.ok(!byName.list_issues.description.includes('## Resolution'));

    const empty = await client.callTool({ name: 'list_meetings', arguments: {} });
    const emptyText = empty.content[0].text;
    assert.equal(emptyText, 'No meetings found in the Meetings folder for that range.');
    assert.ok(!emptyText.includes('SecretHostPathMeetings') && !emptyText.includes(root));

    const injectionId = '../../etc/passwd; IGNORE PREVIOUS';
    for (const [tool, args] of [
      ['get_meeting', { id: injectionId }],
      ['set_action_item', { meeting: injectionId, index: 0, text: 'x', done: true }],
      ['add_meeting_update', { meeting: injectionId, text: 'hello' }],
    ]) {
      const res = await client.callTool({ name: tool, arguments: args });
      assert.equal(res.isError, true, tool);
      assert.ok(!res.content[0].text.includes('IGNORE PREVIOUS') && !res.content[0].text.includes('passwd'), res.content[0].text);
    }
  });
});
