'use strict';
// The main-process side of the UX round: checking a saved key (keys:test), the page for making one (keys:link),
// the main window remembering its size and place, the hint when it is closed during a meeting, and app:show
// opening a page. The logic is in keycheck.js, window-state.js and validate.js; the glue in main.js cannot be
// required outside Electron, so it is cut out of its text and run against stubs (as in notes-wiring.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { mockLlm, mockDeepgram, mockAssemblyAi } = require('./mocks');
const { Settings, DEFAULTS } = require('../src/main/settings');
const { createLlm, PROVIDERS: LLM_PROVIDERS } = require('../src/main/llm');
const { PROVIDERS: STT_PROVIDERS, createStream } = require('../src/main/stt');
const { MODES } = require('../src/main/triggers');
const V = require('../src/main/validate');
const K = require('../src/main/keycheck');
const W = require('../src/main/window-state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-ux-'));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('src/main/main.js');
const between = (a, b) => { const i = mainSrc.indexOf(a), j = mainSrc.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} .. ${b} found in main.js`); return mainSrc.slice(i, j); };
const SETTABLE = new Function(`return ${mainSrc.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();

const NAMES = ['anthropic', 'openai', 'gemini', 'deepgram', 'assemblyai', 'groq'];
const SENTENCES = new Set(['Works.', 'No key saved.', 'Not checked during a meeting.', 'Anthropic rejected it.', 'OpenAI rejected it.', 'Gemini rejected it.', 'Deepgram rejected it.', 'AssemblyAI rejected it.', 'Groq rejected it.',
  'Could not connect.', 'Rate limit or credit reached.', 'No answer in time.', 'Not available with your key.', 'Did not work.']);
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// ---------------------------------------------------------------- C1: keys:test

// The real wiring in main.js (the speech test and the key checker), run against real Settings, the real AI
// and speech code, and stand-in servers. `state.stt` is the address the speech test uses (a test run's override).
async function rig({ reply = {}, keys = NAMES, meetingActive = false, llmUrls, timeoutMs = 4000 } = {}) {
  const mocks = {};
  for (const k of ['anthropic', 'openai', 'gemini']) mocks[k] = await mockLlm(typeof reply[k] === 'function' ? reply[k] : () => reply[k] || 'ready');
  const dir = tmp();
  const settings = new Settings(dir, { available: () => false });
  for (const k of keys) settings.setSecret(k, `key-for-${k}`);
  settings.set({ llm: { baseUrls: llmUrls || Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.url])) } });
  const state = { stt: undefined };
  const make = new Function('settings', 'meeting', 'llm', 'LLM_PROVIDERS', 'STT_PROVIDERS', 'createStream', 'sttOverride', 'createKeyChecker', 'probeKey',
    `${between('// Speech-to-text: open a stream', 'function handle(channel')}; return { sttConnectionTest, keyChecker };`);
  const llm = createLlm(settings, { allowBaseUrls: true });
  const meeting = { active: meetingActive };
  const real = make(settings, meeting, llm, LLM_PROVIDERS, STT_PROVIDERS, createStream, () => state.stt, (o) => K.createKeyChecker({ ...o, timeoutMs }), K.probeKey);
  return { mocks, state, meeting, settings, check: real.keyChecker(), close: () => Promise.all(Object.values(mocks).map((m) => m.close())) };
}
const total = (r) => Object.values(r.mocks).reduce((n, m) => n + m.calls.length, 0);

test('keys:test: a working AI key says Works, using that provider\'s suggested live model and its own key', async () => {
  const r = await rig();
  try {
    for (const name of ['anthropic', 'openai', 'gemini']) assert.deepEqual(await r.check(name), { ok: true, message: 'Works.' }, name);
    const call = (n) => r.mocks[n].calls[0];
    assert.equal(r.mocks.anthropic.calls.length, 1, 'one request each');
    assert.equal(call('anthropic').body.model, LLM_PROVIDERS.anthropic.suggested.live);
    assert.equal(call('openai').body.model, LLM_PROVIDERS.openai.suggested.live);
    assert.ok(call('gemini').url.includes(LLM_PROVIDERS.gemini.suggested.live));
    assert.ok(JSON.stringify(call('anthropic').headers).includes('key-for-anthropic'), 'the saved key is the one sent');
    assert.ok(!JSON.stringify(call('openai').headers).includes('key-for-anthropic'), 'and no other provider\'s key');
  } finally { await r.close(); }
});

test('keys:test: a rejected key names the provider, in a fixed sentence that carries nothing of what the provider said', async () => {
  const secret = 'sk-live-SECRET-1234 is not a valid key for org_77';
  const r = await rig({ reply: Object.fromEntries(['anthropic', 'openai', 'gemini'].map((k) => [k, { status: 401, error: secret }])) });
  try {
    assert.deepEqual(await r.check('anthropic'), { ok: false, message: 'Anthropic rejected it.' });
    assert.deepEqual(await r.check('openai'), { ok: false, message: 'OpenAI rejected it.' });
    assert.deepEqual(await r.check('gemini'), { ok: false, message: 'Gemini rejected it.' });
  } finally { await r.close(); }
});

test('keys:test: a rate limit, a model the key cannot use and a server that is not there each get their plain sentence', async () => {
  const r = await rig({ reply: { anthropic: { status: 429, error: 'slow down' }, openai: { status: 404, error: 'model gpt-x does not exist' } } });
  try {
    assert.deepEqual(await r.check('anthropic'), { ok: false, message: 'Rate limit or credit reached.' });
    assert.deepEqual(await r.check('openai'), { ok: false, message: 'Not available with your key.' });
  } finally { await r.close(); }
  const port = await freePort();
  const gone = await rig({ llmUrls: { anthropic: `http://127.0.0.1:${port}`, openai: `http://127.0.0.1:${port}`, gemini: `http://127.0.0.1:${port}` } });
  try {
    for (const name of ['anthropic', 'openai', 'gemini']) assert.deepEqual(await gone.check(name), { ok: false, message: 'Could not connect.' }, name);
  } finally { await gone.close(); }
});

test('keys:test: a provider that does not answer is given up on at the time limit, and its late answer harms nothing', async () => {
  assert.equal(K.LIMIT_MS, 10000, 'ten seconds');
  const r = await rig({ reply: { anthropic: { text: 'ready', delayMs: 2500 } }, timeoutMs: 300 });
  try {
    const t0 = Date.now();
    assert.deepEqual(await r.check('anthropic'), { ok: false, message: 'No answer in time.' });
    assert.ok(Date.now() - t0 < 1500, 'it did not wait for the slow answer');
    await new Promise((x) => setTimeout(x, 2400)); // the abandoned request ends meanwhile; no unhandled rejection may follow
  } finally { await r.close(); }
});

test('keys:test: no key saved, an unknown name, or a meeting running is answered without any request', async () => {
  const r = await rig({ keys: ['openai'] });
  try {
    assert.deepEqual(await r.check('anthropic'), { ok: false, message: 'No key saved.' });
    assert.deepEqual(await r.check('deepgram'), { ok: false, message: 'No key saved.' });
    for (const bad of ['', 'nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'OPENAI', 'openai ', 5, null, undefined, {}, ['openai'], true]) {
      assert.deepEqual(await r.check(bad), { ok: false, message: 'No key saved.' }, String(bad));
    }
    assert.equal(total(r), 0, 'nothing was sent anywhere');
  } finally { await r.close(); }
  const busy = await rig({ meetingActive: true });
  try {
    for (const name of NAMES) assert.deepEqual(await busy.check(name), { ok: false, message: 'Not checked during a meeting.' }, name);
    assert.equal(total(busy), 0, 'a meeting is never competed with');
    busy.meeting.active = false;
    assert.equal((await busy.check('anthropic')).ok, true, 'and the check works again once it ends');
  } finally { await busy.close(); }
});

test('keys:test: it can never throw, and never returns anything but one of the fixed sentences', async () => {
  const weird = [null, undefined, 'a string', 42, {}, [], Symbol('s'), new Error(''), new Error('sk-ant-SECRET exploded at C:\\Users\\me\\key.json'),
    { get message() { throw new Error('getter'); } }, Object.assign(new Error('x'), { status: 401 }), Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { kind: 'network' }),
    Object.create(null), new Proxy({}, { get() { throw new Error('proxy'); } })];
  for (const w of weird) {
    for (const how of ['reject', 'throw', 'sync']) {
      const thrower = () => { if (how === 'sync') throw w; return Promise.reject(w); };
      const check = K.createKeyChecker({ hasKey: () => true, meetingActive: () => false, testLlm: thrower, testStt: thrower, timeoutMs: 500 });
      for (const name of NAMES) {
        let r;
        await assert.doesNotReject(async () => { r = await check(name); }, `${how} ${weird.indexOf(w)}`);
        assert.equal(r.ok, false);
        assert.ok(SENTENCES.has(r.message), `fixed sentence: ${r.message}`);
        assert.ok(!/SECRET|Users|key\.json/.test(r.message));
      }
    }
  }
  // The checker's own inputs failing.
  for (const bad of [{ hasKey: () => { throw new Error('x'); }, meetingActive: () => false }, { hasKey: () => true, meetingActive: () => { throw new Error('x'); } }]) {
    const check = K.createKeyChecker({ ...bad, testLlm: async () => {}, testStt: async () => {} });
    const r = await check('anthropic');
    assert.equal(r.ok, false);
    assert.ok(SENTENCES.has(r.message));
  }
  const good = K.createKeyChecker({ hasKey: () => true, meetingActive: () => false, testLlm: async () => ({ text: 'secret provider text' }), testStt: async () => ({ text: 'Connected.' }) });
  assert.deepEqual(await good('deepgram'), { ok: true, message: 'Works.' }, 'a result is never passed on');
  assert.deepEqual(await good('openai'), { ok: true, message: 'Works.' });
});

test('keys:test: two checks of one key at once share a single request', async () => {
  const r = await rig({ reply: { anthropic: { text: 'ready', delayMs: 150 } } });
  try {
    const [a, b] = await Promise.all([r.check('anthropic'), r.check('anthropic')]);
    assert.deepEqual(a, b);
    assert.equal(r.mocks.anthropic.calls.length, 1);
    assert.equal((await r.check('anthropic')).ok, true);
    assert.equal(r.mocks.anthropic.calls.length, 2, 'a later check asks again');
  } finally { await r.close(); }
});

test('keys:test: Deepgram and AssemblyAI keys are tried with the speech test, and a rejected one names the provider', async () => {
  const dg = await mockDeepgram(['Hello there.']);
  const aai = await mockAssemblyAi(['Hello there.']);
  const r = await rig();
  const refuse = http.createServer();
  refuse.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise((x) => refuse.listen(0, '127.0.0.1', x));
  try {
    r.state.stt = dg.url;
    assert.deepEqual(await r.check('deepgram'), { ok: true, message: 'Works.' });
    assert.ok(dg.stats.auth.some((a) => /key-for-deepgram/.test(a || '')), 'it connected with the saved key');
    r.state.stt = aai.url;
    assert.deepEqual(await r.check('assemblyai'), { ok: true, message: 'Works.' });
    r.state.stt = `ws://127.0.0.1:${refuse.address().port}/v1/listen`;
    assert.deepEqual(await r.check('deepgram'), { ok: false, message: 'Deepgram rejected it.' });
    assert.deepEqual(await r.check('assemblyai'), { ok: false, message: 'AssemblyAI rejected it.' });
    const port = await freePort();
    r.state.stt = `ws://127.0.0.1:${port}/v1/listen`;
    assert.deepEqual(await r.check('deepgram'), { ok: false, message: 'Could not connect.' });
    assert.equal(total(r), 0, 'no AI request for a speech key');
  } finally { refuse.close(); refuse.closeAllConnections(); await dg.close(); await aai.close(); await r.close(); }
});

test('keys:test: the Groq key lists the models with the key (it has no live stream); the OpenAI key is tested on the AI side', async () => {
  let status = 200;
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'sk-secret-in-body' } })); });
  await new Promise((x) => server.listen(0, '127.0.0.1', x));
  const base = `http://127.0.0.1:${server.address().port}/openai/v1`;
  const r = await rig();
  try {
    r.state.stt = base;
    assert.deepEqual(await r.check('groq'), { ok: true, message: 'Works.' });
    assert.deepEqual(seen[0], { url: '/openai/v1/models', auth: 'Bearer key-for-groq' });
    status = 401;
    assert.deepEqual(await r.check('groq'), { ok: false, message: 'Groq rejected it.' });
    status = 429;
    assert.deepEqual(await r.check('groq'), { ok: false, message: 'Rate limit or credit reached.' });
    status = 500;
    assert.deepEqual(await r.check('groq'), { ok: false, message: 'Did not work.' });
    r.state.stt = `http://127.0.0.1:${await freePort()}/v1`;
    assert.deepEqual(await r.check('groq'), { ok: false, message: 'Could not connect.' });
    const before = seen.length;
    assert.equal((await r.check('openai')).ok, true);
    assert.equal(r.mocks.openai.calls.length, 1, 'the OpenAI key went to the AI provider');
    assert.equal(seen.length, before, 'and not to the speech address');
  } finally { server.close(); server.closeAllConnections(); await r.close(); }
});

test('keys:test: the table matches the app\'s providers and secrets, and the channels are wired', () => {
  assert.deepEqual(Object.keys(K.KEYS).sort(), [...NAMES].sort());
  for (const [id, p] of Object.entries(LLM_PROVIDERS)) { assert.equal(K.KEYS[p.secret].side, 'llm', id); assert.equal(p.secret, id); }
  for (const [id, p] of Object.entries(STT_PROVIDERS)) assert.ok(K.KEYS[p.secret], `${id} has a key entry`);
  for (const name of ['deepgram', 'assemblyai', 'groq']) assert.equal(K.KEYS[name].side, 'stt');
  assert.deepEqual(Object.values(K.KEYS).map((k) => k.name), ['Anthropic', 'OpenAI', 'Gemini', 'Deepgram', 'AssemblyAI', 'Groq']);
  for (const [id, p] of Object.entries({ ...LLM_PROVIDERS, ...STT_PROVIDERS })) if (K.KEYS[id]) assert.notEqual(K.KEYS[id].name, p.label, 'the short name, not the long label');
  const secretsSet = mainSrc.match(/handle\('secrets:set'[\s\S]*?includes\(name\)/)[0];
  for (const name of NAMES) assert.ok(secretsSet.includes(`'${name}'`));
  const preload = read('src/preload.js');
  const invoke = new Set([...preload.match(/const INVOKE = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const ch of ['keys:test', 'keys:link', 'app:show']) { assert.ok(invoke.has(ch), `${ch} is callable`); assert.ok(mainSrc.includes(`handle('${ch}'`), `${ch} is handled`); }
});

// ---------------------------------------------------------------- C2: keys:link

test('keys:link: a fixed table of https pages, opened with the system browser; anything else does nothing and says false', async () => {
  const table = {
    anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys', gemini: 'https://aistudio.google.com/apikey',
    deepgram: 'https://console.deepgram.com', assemblyai: 'https://www.assemblyai.com/dashboard', groq: 'https://console.groq.com/keys',
  };
  const opened = [];
  for (const [name, url] of Object.entries(table)) {
    assert.equal(K.KEYS[name].url, url);
    assert.equal(await K.openKeyPage(name, async (u) => { opened.push(u); }), true, name);
  }
  assert.deepEqual(opened, Object.values(table));
  const none = [];
  for (const bad of ['', 'nope', 'constructor', '__proto__', 'toString', 'https://evil.example', 5, null, undefined, {}, ['anthropic'], true]) {
    assert.equal(await K.openKeyPage(bad, async (u) => { none.push(u); }), false, String(bad));
  }
  assert.deepEqual(none, [], 'nothing was opened');
  assert.equal(await K.openKeyPage('groq', async () => { throw new Error('no browser'); }), false, 'a browser that fails is not an error');
  assert.equal(await K.openKeyPage('groq', () => { throw new Error('no browser'); }), false);
  assert.match(mainSrc, /handle\('keys:link', \(name\) => openKeyPage\(name, \(url\) => shell\.openExternal\(url\)\)\)/, 'main.js opens it with shell.openExternal and takes no URL from the window');
});

// ---------------------------------------------------------------- C3: the main window's size and place

const ONE = [{ x: 0, y: 0, width: 1920, height: 1040 }];
const TWO = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 2560, height: 1400 }];
const saved = (bounds, maximized = false) => ({ bounds, maximized });

test('window bounds: a window still on a screen comes back exactly where it was', () => {
  const b = { x: 100, y: 80, width: 1200, height: 800 };
  assert.deepEqual(W.restoreWindow(saved(b), ONE), { bounds: b, maximized: false });
  assert.deepEqual(W.restoreWindow(saved({ x: 2000, y: 100, width: 1500, height: 900 }), TWO).bounds, { x: 2000, y: 100, width: 1500, height: 900 }, 'on the second screen');
  assert.deepEqual(W.restoreWindow(saved({ x: 100.4, y: 80.6, width: 1200.2, height: 800.5 }), ONE).bounds, { x: 100, y: 81, width: 1200, height: 801 }, 'whole pixels');
});

test('window bounds: after a screen is unplugged the window opens with its size and the system chooses the place', () => {
  const away = saved({ x: 2500, y: 100, width: 1500, height: 900 });
  assert.deepEqual(W.restoreWindow(away, TWO).bounds, { x: 2500, y: 100, width: 1500, height: 900 });
  assert.deepEqual(W.restoreWindow(away, ONE).bounds, { width: 1500, height: 900 });
  assert.deepEqual(W.restoreWindow(saved({ x: -1900, y: 20, width: 1000, height: 700 }), ONE).bounds, { width: 1000, height: 700 }, 'a screen that was to the left');
  assert.deepEqual(W.restoreWindow(away, []).bounds, { width: 1500, height: 900 }, 'no screens known');
  assert.deepEqual(W.restoreWindow(away, null).bounds, { width: 1500, height: 900 });
});

test('window bounds: partly visible counts only with 100 px of it on a screen and the title bar reachable', () => {
  const at = (x, y) => W.restoreWindow(saved({ x, y, width: 1200, height: 800 }), ONE).bounds;
  assert.equal(at(820, 100).x, 820, '1100 px visible');
  assert.equal(at(1820, 100).x, 1820, 'exactly 100 px visible');
  assert.equal(at(1821, 100).x, undefined, '99 px visible');
  assert.equal(at(-1100, 100).x, -1100, '100 px visible at the left');
  assert.equal(at(-1101, 100).x, undefined);
  assert.equal(at(100, 940).y, 940, '100 px visible at the bottom');
  assert.equal(at(100, 941).y, undefined);
  assert.equal(at(100, -10).y, -10, 'a title bar just above the edge is still reachable');
  assert.equal(at(100, -11).y, undefined, 'one that is not is moved');
  assert.equal(at(100, -400).y, undefined);
});

test('window bounds: never below the minimum size, never bigger than the biggest screen', () => {
  assert.deepEqual(W.restoreWindow(saved({ x: 10, y: 10, width: 500, height: 300 }), ONE).bounds, { x: 10, y: 10, width: 960, height: 620 });
  assert.deepEqual(W.restoreWindow(saved({ x: 10, y: 10, width: 959, height: 10000 }), ONE).bounds, { x: 10, y: 10, width: 960, height: 1040 });
  assert.deepEqual(W.restoreWindow(saved({ x: 0, y: 0, width: 4000, height: 3000 }), ONE).bounds, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(W.restoreWindow(saved({ x: 0, y: 0, width: 4000, height: 3000 }), TWO).bounds, { x: 0, y: 0, width: 2560, height: 1400 }, 'the biggest of the screens');
  // A screen smaller than the minimum cannot push the window below it.
  assert.deepEqual(W.restoreWindow(saved({ x: 0, y: 0, width: 1200, height: 800 }), [{ x: 0, y: 0, width: 800, height: 500 }]).bounds, { x: 0, y: 0, width: 960, height: 620 });
});

test('window bounds: maximised is restored with the size it had before it was maximised', () => {
  const b = { x: 100, y: 80, width: 1200, height: 800 };
  assert.deepEqual(W.restoreWindow(saved(b, true), ONE), { bounds: b, maximized: true });
  assert.deepEqual(W.restoreWindow({ maximized: true }, ONE), { bounds: { width: 1180, height: 800 }, maximized: true });
  for (const m of ['yes', 1, 'true', null, undefined, {}, []]) assert.equal(W.restoreWindow({ bounds: b, maximized: m }, ONE).maximized, false, String(m));
});

test('window bounds: a settings file with garbage in it gives the default size and never throws', () => {
  const DEF = { bounds: { width: 1180, height: 800 }, maximized: false };
  const bounds = [undefined, null, 5, 'x', [], {}, true, { x: '1', y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 0, height: 700 }, { x: 1, y: 2, width: -5, height: 700 }, { x: NaN, y: 2, width: 900, height: 700 },
    { x: 1, y: 2, width: Infinity, height: 700 }, { x: 1, y: 2, width: 900 }, [1, 2, 3, 4], { x: 1e9, y: 0, width: 900, height: 700 }, { x: 1, y: 2, width: '900', height: 700 }];
  for (const b of bounds) assert.deepEqual(W.restoreWindow({ bounds: b, maximized: false }, ONE), DEF, JSON.stringify(b));
  for (const s of [undefined, null, 5, 'x', [], true, () => {}, { bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: 'x' }]) assert.doesNotThrow(() => W.restoreWindow(s, ONE));
  for (const areas of [undefined, null, 5, 'x', {}, [null], [5], [{}], [{ x: 0, y: 0, width: 'a', height: 5 }]]) {
    const r = W.restoreWindow(saved({ x: 10, y: 10, width: 1000, height: 700 }), areas);
    assert.deepEqual(r.bounds, { width: 1000, height: 700 }, `screens ${JSON.stringify(areas)}`);
  }
  // Whatever comes in, what goes out is at least the minimum and whole numbers.
  for (let i = 0; i < 300; i++) {
    const pick = () => [-1e6, -5, 0, 1, 99.5, 600, 960, 1180.7, 2000, 5000, 1e6, NaN, 'x', null][Math.floor(Math.random() * 14)];
    const r = W.restoreWindow({ bounds: { x: pick(), y: pick(), width: pick(), height: pick() }, maximized: pick() }, [{ x: pick(), y: pick(), width: pick(), height: pick() }, ...ONE]);
    assert.ok(r.bounds.width >= 960 && r.bounds.height >= 620 && Number.isInteger(r.bounds.width) && Number.isInteger(r.bounds.height));
  }
});

test('window bounds: what is written down is the restored size, and nothing unusable', () => {
  const win = (normal, max = false) => ({ getNormalBounds: () => normal, isMaximized: () => max });
  assert.deepEqual(W.windowState(win({ x: 5, y: 6, width: 1100, height: 700 })), { bounds: { x: 5, y: 6, width: 1100, height: 700 }, maximized: false });
  assert.deepEqual(W.windowState(win({ x: 5, y: 6, width: 1100, height: 700 }, true)).maximized, true);
  assert.equal(W.windowState(win({ x: 5, y: 6, width: 0, height: 0 })), null);
  assert.equal(W.windowState(win(null)), null);
});

test('window bounds: they are kept in the data folder, cannot be set from a window, and survive a file with garbage in it', () => {
  const dir = tmp();
  const s1 = new Settings(dir, { available: () => false });
  assert.deepEqual(s1.get().appWindow, { bounds: null, maximized: false }, 'nothing remembered at first');
  s1.set({ appWindow: { bounds: { x: 10, y: 20, width: 1300, height: 850 }, maximized: true } });
  assert.ok(s1.file.startsWith(dir), 'a test run with its own data folder writes there');
  const s2 = new Settings(dir, { available: () => false });
  assert.deepEqual(W.restoreWindow(s2.get().appWindow, ONE), { bounds: { x: 10, y: 20, width: 1300, height: 850 }, maximized: true });
  s2.set({ appWindow: { maximized: false } });
  assert.deepEqual(s2.get().appWindow.bounds, { x: 10, y: 20, width: 1300, height: 850 }, 'maximised and the size are written separately');
  // Hand-edited file.
  for (const junk of ['"x"', '5', '[1,2]', 'null', '{"bounds":"x"}', '{"bounds":{"x":"a"},"maximized":7}']) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'settings.json'), `{"appWindow":${junk}}`);
    const s = new Settings(d, { available: () => false });
    assert.doesNotThrow(() => W.restoreWindow(s.get().appWindow, ONE), junk);
    assert.deepEqual(W.restoreWindow(s.get().appWindow, ONE).bounds, { width: 1180, height: 800 }, junk);
    assert.doesNotThrow(() => s.set({ appWindow: { bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: false } }), junk);
    assert.deepEqual(s.get().appWindow.bounds, { x: 1, y: 2, width: 1000, height: 700 }, junk);
  }
  // A window may not set it.
  const ctx = { settable: SETTABLE, autoModes: MODES, sttProviders: Object.keys(STT_PROVIDERS), llmProviders: Object.keys(LLM_PROVIDERS), personalityIds: () => ['default'] };
  assert.deepEqual(V.sanitiseSettingsPatch({ appWindow: { bounds: { x: 0, y: 0, width: 9, height: 9 }, maximized: true } }, ctx).patch, {});
  assert.ok(!('appWindow' in SETTABLE));
  assert.ok(DEFAULTS.appWindow);
});

// createAppWindow and the one-time hint, cut out of main.js and run against a stand-in window.
function windowHarness({ saved: savedState, displays = ONE, meetingActive = true, meta = { id: 'm1' } } = {}) {
  const log = { created: [], sent: [], overlay: [], tray: 0, quit: 0, settings: [], windows: [] };
  class FakeWindow {
    constructor(opts) { this.opts = opts; this.handlers = {}; this.destroyed = false; this.maximizedNow = false; this.normal = { x: 50, y: 60, width: 1111, height: 777 }; log.created.push(opts); log.windows.push(this); }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev) { for (const fn of this.handlers[ev] || []) fn(); }
    maximize() { this.maximizedNow = true; log.maximized = true; }
    isMaximized() { return this.maximizedNow; }
    getNormalBounds() { return this.normal; }
    isDestroyed() { return this.destroyed; }
    loadFile() {}
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const meeting = { active: meetingActive, meta };
  const broadcast = (m) => log.sent.push(m);
  const settings = { get: () => ({ appearance: { theme: 'dark' }, appWindow: savedState }), set: (p) => log.settings.push(p) };
  const make = new Function('BrowserWindow', 'settings', 'screen', 'nativeTheme', 'path', 'ASSETS', 'RENDERER', 'webPrefs', 'lockDown', 'restoreWindow', 'windowState', 'createTrayHint', 'meeting', 'broadcast', 'toggleOverlay', 'refreshTray', 'app', `
    let appWin = null;
    let trayHint = createTrayHint({ meeting, send: broadcast });
    ${between('function createAppWindow() {', 'function createOverlay()')}
    return { createAppWindow, win: () => appWin };`);
  const h = make(FakeWindow, settings, { getAllDisplays: () => displays.map((workArea) => ({ workArea })) }, { shouldUseDarkColors: true }, path, 'assets', 'renderer', () => ({}), () => {},
    W.restoreWindow, W.windowState, W.createTrayHint, meeting, broadcast, (v) => log.overlay.push(v), () => { log.tray++; }, { quit: () => { log.quit++; } });
  return { ...h, log, meeting };
}

test('the main window opens where it was, maximised if it was, and keeps the minimum size', () => {
  const h = windowHarness({ saved: saved({ x: 120, y: 90, width: 1250, height: 820 }, true) });
  h.createAppWindow();
  const o = h.log.created[0];
  assert.deepEqual([o.x, o.y, o.width, o.height, o.minWidth, o.minHeight], [120, 90, 1250, 820, 960, 620]);
  assert.equal(h.log.maximized, true);
  const fresh = windowHarness({ saved: { bounds: null, maximized: false } });
  fresh.createAppWindow();
  assert.deepEqual([fresh.log.created[0].width, fresh.log.created[0].height, fresh.log.created[0].x], [1180, 800, undefined]);
  assert.equal(fresh.log.maximized, undefined);
  const gone = windowHarness({ saved: saved({ x: 5000, y: 90, width: 1250, height: 820 }) });
  gone.createAppWindow();
  assert.deepEqual([gone.log.created[0].x, gone.log.created[0].y, gone.log.created[0].width], [undefined, undefined, 1250], 'the saved screen is not there any more');
});

test('the main window writes its bounds a moment after a move or resize, and straight away as it closes', async () => {
  const h = windowHarness({ meetingActive: false });
  h.createAppWindow();
  const w = h.log.windows[0];
  w.emit('moved'); w.emit('resized'); w.emit('moved');
  assert.equal(h.log.settings.length, 0, 'not on every event');
  await new Promise((x) => setTimeout(x, 800));
  assert.deepEqual(h.log.settings, [{ appWindow: { bounds: { x: 50, y: 60, width: 1111, height: 777 }, maximized: false } }], 'once, after the last one');
  w.maximizedNow = true; w.emit('maximize');
  w.close();
  assert.equal(h.log.settings.length, 2, 'and once more on close');
  assert.equal(h.log.settings[1].appWindow.maximized, true);
  assert.equal(h.log.quit, 1, 'with no meeting, closing the window quits as before');
  await new Promise((x) => setTimeout(x, 800));
  assert.equal(h.log.settings.length, 2, 'the pending write was cancelled by the close');
  const bad = windowHarness({ meetingActive: false });
  bad.createAppWindow();
  bad.log.windows[0].normal = null;
  assert.doesNotThrow(() => bad.log.windows[0].close());
  assert.equal(bad.log.settings.length, 0, 'nothing unusable is written');
});

// ---------------------------------------------------------------- C4: closing the window during a meeting

test('closing the main window during a meeting tells the overlay once per meeting', () => {
  const HINT = 'Still listening. Understudy is in the tray.';
  const h = windowHarness();
  h.createAppWindow();
  h.log.windows[0].close();
  assert.deepEqual(h.log.sent, [{ type: 'hint', message: HINT }], 'the same event the other hints use');
  assert.deepEqual(h.log.overlay, [true], 'and the overlay is brought up first');
  assert.equal(h.log.quit, 0);
  // The person opens the window from the tray and closes it again: the same meeting is not told twice.
  h.createAppWindow();
  h.log.windows[1].close();
  h.log.windows[1].emit('hide');
  assert.equal(h.log.sent.length, 1);
  // The next meeting is told again.
  h.meeting.meta = { id: 'm2' };
  h.createAppWindow();
  h.log.windows[2].emit('hide'); // hidden to the tray
  assert.equal(h.log.sent.length, 2);
  h.log.windows[2].close();
  assert.equal(h.log.sent.length, 2);
});

test('the hint is not sent when no meeting is running, and a failing send never breaks the close', () => {
  const idle = windowHarness({ meetingActive: false });
  idle.createAppWindow();
  idle.log.windows[0].emit('hide');
  idle.log.windows[0].close();
  assert.deepEqual(idle.log.sent, []);
  const sent = [];
  const meeting = { active: true, meta: { id: 'a' } };
  const hint = W.createTrayHint({ meeting, send: (m) => sent.push(m) });
  assert.equal(hint(), true); assert.equal(hint(), false);
  meeting.active = false; meeting.meta = { id: 'b' };
  assert.equal(hint(), false, 'a meeting that has ended is not told');
  meeting.active = true;
  assert.equal(hint(), true);
  assert.equal(sent.length, 2);
  const broken = W.createTrayHint({ meeting, send: () => { throw new Error('overlay gone'); } });
  assert.doesNotThrow(() => broken());
  for (const m of [null, undefined, {}, { active: true }]) assert.doesNotThrow(() => W.createTrayHint({ meeting: m, send: () => {} })());
  assert.match(mainSrc, /trayHint = createTrayHint\(\{ meeting, send: broadcast \}\)/, 'main.js sends it through broadcast, like every other hint');
  assert.match(mainSrc, /broadcast\(\{ type: 'hint', message: `Nobody has spoken/, 'the idle warning goes the same way');
});

// ---------------------------------------------------------------- C5: app:show

test('app:show: nothing, or a page of the app, or a Settings tab; anything else is ignored', () => {
  for (const nothing of [undefined, null, {}, [], 'settings', 5, true, () => {}, { page: 5 }, { page: ['settings'] }, { tab: 'keys' }, { page: 'nope', tab: 'keys' }]) assert.deepEqual(V.cleanAppShow(nothing), {}, JSON.stringify(nothing));
  for (const page of ['home', 'meetings', 'knowledge', 'styles']) assert.deepEqual(V.cleanAppShow({ page }), { page });
  assert.deepEqual(V.cleanAppShow({ page: 'settings' }), { page: 'settings' });
  for (const tab of ['you', 'keys', 'ai', 'speech', 'remote', 'behaviour', 'shortcuts', 'claude']) assert.deepEqual(V.cleanAppShow({ page: 'settings', tab }), { page: 'settings', tab });
  assert.deepEqual(V.cleanAppShow({ page: 'settings', tab: 'nope' }), { page: 'settings' }, 'a bad tab drops the tab only');
  assert.deepEqual(V.cleanAppShow({ page: 'home', tab: 'keys' }), { page: 'home' }, 'a tab belongs to Settings');
  for (const bad of ['constructor', '__proto__', 'toString', 'Settings', 'settings ', '../settings', 'file:///C:/x.html', '']) {
    assert.deepEqual(V.cleanAppShow({ page: bad }), {}, bad);
    assert.deepEqual(V.cleanAppShow({ page: 'settings', tab: bad }), { page: 'settings' }, bad);
  }
  assert.deepEqual(V.cleanAppShow(JSON.parse('{"__proto__":{"page":"settings"},"page":"home","evil":1}')), { page: 'home' }, 'only the two fields, only own ones');
  assert.deepEqual(V.cleanAppShow({ page: 'settings', tab: 'keys', url: 'https://evil.example', extra: 1 }), { page: 'settings', tab: 'keys' });
});

test('app:show: the lists are the ones the main window has', () => {
  const app = read('src/renderer/app.js');
  const nav = [...app.match(/const NAV = \[([\s\S]*?)\];\n/)[1].matchAll(/\['([a-z]+)'/g)].map((m) => m[1]);
  const tabs = [...app.match(/const SETTINGS_TABS = \[([\s\S]*?)\];\n/)[1].matchAll(/\['([a-z]+)', '/g)].map((m) => m[1]);
  assert.deepEqual(V.APP_PAGES, nav);
  assert.deepEqual(V.SETTINGS_TABS, tabs);
  assert.equal(tabs[tabs.indexOf('speech') + 1], 'remote');
  assert.match(app, /\['remote', 'Other PC'\]/);
});

// handle() and the app:show handler, cut out of main.js.
function showHarness({ appWin = 'open', from = 'app.html' } = {}) {
  const log = { show: 0, focus: 0, restore: 0, sent: [], created: 0 };
  const handlers = {};
  const mkWin = (minimised = false) => ({
    isDestroyed: () => false, isMinimized: () => minimised, restore: () => { log.restore++; }, show: () => { log.show++; }, focus: () => { log.focus++; },
    webContents: { send: (ch, msg) => log.sent.push([ch, msg]), once: (ev, fn) => { log.once = [ev, fn]; } },
  });
  const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
  const make = new Function('path', 'fileURLToPath', 'RENDERER', 'ipcMain', 'V', 'initial', 'mkWin', 'onCreate', `
    let appWin = initial;
    const createAppWindow = () => { onCreate(); appWin = mkWin(); };
    ${between('const pageOf = (url) =>', 'function broadcast(msg)')}
    ${between('function handle(channel, fn) {', 'const SETTABLE')}
    ${between('  // From either window. With a page', '  const checkKey = keyChecker();')}`);
  make(path, require('node:url').fileURLToPath, RENDERER, { handle: (ch, fn) => { handlers[ch] = fn; } }, V,
    appWin === 'none' ? null : mkWin(appWin === 'minimised'), mkWin, () => { log.created++; });
  const call = (arg, page = from) => handlers['app:show']({ senderFrame: { url: `file:///${path.join(RENDERER, page).split(path.sep).join('/')}` } }, arg);
  return { call, log };
}

test('app:show: from either window, brings the main window forward and tells it where to go', async () => {
  for (const from of ['app.html', 'overlay.html']) {
    const h = showHarness({ from });
    assert.deepEqual(await h.call(), { ok: true, value: true });
    assert.deepEqual([h.log.show, h.log.focus, h.log.sent.length], [1, 1, 0], `${from}: with no argument it only shows the window, as before`);
    await h.call({ page: 'settings', tab: 'remote' });
    assert.deepEqual(h.log.sent, [['evt', { type: 'navigate', page: 'settings', tab: 'remote' }]]);
    await h.call({ page: 'meetings' });
    assert.deepEqual(h.log.sent[1], ['evt', { type: 'navigate', page: 'meetings' }]);
    await h.call({ page: 'evil', tab: 'x' });
    await h.call('settings');
    assert.equal(h.log.sent.length, 2, 'what is not a page is ignored');
    assert.equal(h.log.show, 5, 'but the window still comes forward');
  }
});

test('app:show: only the app\'s own windows may ask, a minimised window is restored, and a closed one is made again', async () => {
  const stranger = showHarness();
  const r = await stranger.call({ page: 'settings' }, 'capture.html');
  assert.equal(r.ok, false);
  assert.deepEqual([stranger.log.show, stranger.log.sent.length], [0, 0]);
  const min = showHarness({ appWin: 'minimised' });
  await min.call({ page: 'settings', tab: 'keys' });
  assert.deepEqual([min.log.restore, min.log.show, min.log.focus, min.log.sent.length], [1, 1, 1, 1]);
  const none = showHarness({ appWin: 'none' });
  assert.deepEqual(await none.call({ page: 'settings', tab: 'keys' }), { ok: true, value: true });
  assert.equal(none.log.created, 1);
  assert.equal(none.log.sent.length, 0, 'not before the new window has loaded');
  assert.equal(none.log.once[0], 'did-finish-load');
  none.log.once[1]();
  assert.deepEqual(none.log.sent, [['evt', { type: 'navigate', page: 'settings', tab: 'keys' }]]);
});
