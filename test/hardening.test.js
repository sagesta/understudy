'use strict';
// Regression tests for the second review: what the windows may send the main
// process (settings, actions), settings already on disk, and saved meeting files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../src/main/validate');
const { Settings, DEFAULTS } = require('../src/main/settings');
const { MeetingStore, newMeta, parse, render } = require('../src/main/meetings/store');
const { ACTIONS } = require('../src/main/prompts');
const { MODES } = require('../src/main/triggers');
const { PROVIDERS: STT_PROVIDERS } = require('../src/main/stt');
const { PROVIDERS: LLM_PROVIDERS } = require('../src/main/llm');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-hard-'));
const plain = { available: () => false };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('src/main/main.js');
const between = (a, b) => { const i = mainSrc.indexOf(a), j = mainSrc.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} .. ${b} found in main.js`); return mainSrc.slice(i, j); };

// The same lists main.js hands to the validator, built from the real modules.
const SETTABLE = new Function(`return ${mainSrc.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();
const ctx = { settable: SETTABLE, autoModes: MODES, sttProviders: Object.keys(STT_PROVIDERS), llmProviders: Object.keys(LLM_PROVIDERS), personalityIds: () => ['default', 'blunt'] };
const sanitise = (raw) => V.sanitiseSettingsPatch(raw, ctx);
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const nest = (p, v) => { const o = {}; p.split('.').reduce((x, k, i, a) => (x[k] = i === a.length - 1 ? v : {}), o); return o; };
const str = (n) => 'x'.repeat(n);

// ---------------------------------------------------------------- 1. settings

const BAD = [
  ['me.aliases', 5], ['me.aliases', { a: 1 }], ['me.aliases', 'Ade'], ['me.aliases', null], ['me.aliases', ['a', 5]], ['me.aliases', [{}]], ['me.aliases', ['']],
  ['me.aliases', Array.from({ length: 21 }, (_, i) => `a${i}`)], ['me.aliases', [str(61)]],
  ['me.name', 5], ['me.name', null], ['me.name', {}], ['me.name', str(81)], ['me.role', ['x']], ['me.role', str(121)],
  ['llm.webSearch', 'true'], ['llm.webSearch', 1], ['llm.live', 5], ['llm.live', { provider: 'nope' }], ['llm.live', { model: 5 }], ['llm.notes', { provider: 'constructor' }], ['llm.live', { model: '' }], ['llm.live', { model: str(121) }],
  ['stt.provider', 'nope'], ['stt.provider', 'constructor'], ['stt.provider', 5], ['stt.language', str(21)], ['stt.language', 5],
  ['stt.skipSilence', 'yes'], ['stt.identifySpeakers', 0], ['stt.suggestNames', null],
  ['stt.keyterms', 'Trivy'], ['stt.keyterms', Array.from({ length: 101 }, (_, i) => `t${i}`)], ['stt.keyterms', [str(61)]], ['stt.keyterms', [1]],
  ['stt.models', 5], ['stt.models', { deepgram: 5 }], ['stt.models', { deepgram: '' }], ['stt.models', { deepgram: str(121) }], ['stt.models', ['nova-3']], ['stt.models', { evil: 'x' }],
  ['audio.micDeviceId', 5], ['audio.micDeviceId', str(201)], ['audio.captureMic', 'on'], ['audio.captureSystem', 1], ['audio.echoFilter', {}],
  ['copilot.autoMode', 'nope'], ['copilot.autoMode', 5], ['copilot.autoMode', 'constructor'],
  ['copilot.personality', 5], ['copilot.personality', {}], ['copilot.personality', 'not-a-real-style'], ['copilot.personality', ''], ['copilot.personality', ['default']],
  ['copilot.proactiveEverySec', 'abc'], ['copilot.proactiveEverySec', '45'], ['copilot.proactiveEverySec', NaN], ['copilot.proactiveEverySec', Infinity], ['copilot.proactiveEverySec', 19], ['copilot.proactiveEverySec', 301], ['copilot.proactiveEverySec', null],
  ['copilot.autoStopMinutes', -1], ['copilot.autoStopMinutes', 241], ['copilot.autoStopMinutes', '20'], ['copilot.autoStopMinutes', {}],
  ['overlay.opacity', 0.39], ['overlay.opacity', 1.01], ['overlay.opacity', '0.9'], ['overlay.opacity', NaN], ['overlay.hideFromCapture', 'false'],
  ['appearance.theme', 'blue'], ['appearance.theme', 5], ['appearance.theme', {}],
  ['shortcuts.answer', 5], ['shortcuts.screen', {}], ['shortcuts.take', null], ['shortcuts.catchup', ['Alt+A']], ['shortcuts.toggleOverlay', str(41)], ['shortcuts.pause', true],
  ['library.includeMeetings', 'yes'],
  // Not settable from a window at all.
  ['library.folders', ['C:\\secret']], ['meetingsDir', 'C:\\elsewhere'], ['overlay.bounds', { x: 1 }], ['llm.baseUrls', { openai: 'http://evil' }],
];

test('settings:set refuses a value of the wrong type, and keeps the good value sent beside it', () => {
  for (const [p, bad] of BAD) {
    const group = p.split('.')[0];
    // A good value in the same group (when there is one to use) and one in another group.
    const sibling = { me: 'me.role', llm: 'llm.webSearch', stt: 'stt.language', audio: 'audio.captureMic', copilot: 'copilot.autoStopMinutes', overlay: 'overlay.hideFromCapture', appearance: null, shortcuts: 'shortcuts.take', library: null }[group];
    const goodVals = { 'me.role': 'Engineer', 'llm.webSearch': false, 'stt.language': 'en-GB', 'audio.captureMic': false, 'copilot.autoStopMinutes': 30, 'overlay.hideFromCapture': false, 'shortcuts.take': 'Alt+Shift+K' };
    const other = group === 'appearance' ? ['me.role', 'Eng'] : ['appearance.theme', 'dark'];
    const raw = {};
    const merge = (p2, v) => { const n = nest(p2, v); for (const [g, o] of Object.entries(n)) raw[g] = typeof o === 'object' && o !== null && !Array.isArray(o) ? { ...(raw[g] || {}), ...o } : o; };
    if (sibling && sibling !== p) merge(sibling, goodVals[sibling]);
    merge(other[0], other[1]);
    merge(p, bad);
    const { patch, rejected } = sanitise(raw);
    assert.equal(get(patch, p), undefined, `${p} = ${JSON.stringify(bad)} must not be saved`);
    assert.deepEqual(get(patch, other[0]), other[1], `a good value beside ${p} is kept`);
    if (sibling && sibling !== p) assert.deepEqual(get(patch, sibling), goodVals[sibling], `a good sibling of ${p} is kept`);
    if (!p.startsWith('library.folders') && p !== 'meetingsDir' && p !== 'overlay.bounds' && p !== 'llm.baseUrls' && JSON.stringify(bad) !== '{"evil":"x"}') assert.ok(rejected.some((r) => p.startsWith(r) || r.startsWith(p) || r === p), `${p} is reported as refused`);
  }
});

test('settings:set: whole patches that are not objects change nothing; a hostile key cannot reach a prototype', () => {
  for (const raw of [null, undefined, 5, 'x', [], [{ me: { name: 'A' } }]]) assert.deepEqual(sanitise(raw).patch, {});
  const patch = sanitise(JSON.parse('{"__proto__":{"polluted":1},"me":{"__proto__":{"polluted":2},"name":"Ade"},"constructor":{"prototype":{"polluted":3}}}')).patch;
  assert.deepEqual(patch, { me: { name: 'Ade' } });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(sanitise({ stt: { models: { __proto__: { x: 'y' }, constructor: 'z', deepgram: 'nova-2' } } }).patch, { stt: { models: { deepgram: 'nova-2' } } });
});

test('settings:set: every key the renderer really sends still round-trips, including partial patches', () => {
  const sends = [
    { me: { name: 'Ade' } }, { me: { name: '' } }, { me: { aliases: ['A.', 'Adeline'] } }, { me: { aliases: [] } }, { me: { role: 'DevSecOps engineer' } },
    { appearance: { theme: 'system' } }, { appearance: { theme: 'dark' } }, { appearance: { theme: 'light' } },
    { llm: { live: { provider: 'openai', model: 'gpt-6-luna' } } }, { llm: { notes: { model: 'claude-opus-5-5' } } }, { llm: { webSearch: false } },
    { stt: { suggestNames: true } }, { stt: { identifySpeakers: false } }, { stt: { skipSilence: false } }, { stt: { language: 'en-GB' } }, { stt: { keyterms: ['Trivy', 'Argo CD'] } }, { stt: { keyterms: [] } },
    { stt: { provider: 'assemblyai' } }, { stt: { models: { deepgram: 'nova-3' } } }, { stt: { models: { groq: 'whisper-large-v3-turbo' } } },
    { audio: { micDeviceId: 'default' } }, { audio: { micDeviceId: 'a1b2c3' } }, { audio: { captureMic: false } }, { audio: { captureSystem: true } }, { audio: { echoFilter: false } },
    { copilot: { personality: 'default' } }, { copilot: { personality: 'blunt' } }, { copilot: { proactiveEverySec: 20 } }, { copilot: { proactiveEverySec: 300 } }, { copilot: { autoStopMinutes: 0 } }, { copilot: { autoStopMinutes: 240 } },
    ...MODES.map((autoMode) => ({ copilot: { autoMode } })),
    { overlay: { hideFromCapture: false } }, { overlay: { opacity: 0.4 } }, { overlay: { opacity: 1 } },
    ...['answer', 'screen', 'take', 'catchup', 'toggleOverlay', 'pause'].flatMap((k) => [{ shortcuts: { [k]: 'Alt+Shift+Q' } }, { shortcuts: { [k]: '' } }, { shortcuts: { [k]: 'Control+Alt+F5' } }]),
    { library: { includeMeetings: false } },
  ];
  for (const s of sends) {
    const { patch, rejected } = sanitise(s);
    assert.deepEqual(patch, s);
    assert.deepEqual(rejected, []);
  }
  // Several groups at once, as chipSave can send.
  const many = { me: { name: 'Ade', aliases: ['A.'], role: 'Eng' }, copilot: { autoMode: 'mine', proactiveEverySec: 60 } };
  assert.deepEqual(sanitise(many).patch, many);
});

test('every setting the app starts with passes its own rules, and every settable key has one', () => {
  const { patch, rejected } = sanitise(DEFAULTS);
  assert.deepEqual(rejected, []);
  for (const [g, keys] of Object.entries(SETTABLE)) for (const k of keys) assert.ok(k in (patch[g] || {}), `${g}.${k} has a rule that accepts its default`);
  // And nothing without a rule is settable.
  const spec = V.specFor(ctx);
  for (const [g, keys] of Object.entries(spec)) assert.deepEqual(Object.keys(keys).sort(), [...SETTABLE[g]].sort(), g);
});

test('the renderer only calls settings:set with keys the main process accepts', () => {
  const app = read('src/renderer/app.js');
  const seen = new Set();
  for (const m of app.matchAll(/save\(\{ (\w+): \{ (\w+):/g)) seen.add(`${m[1]}.${m[2]}`);
  assert.ok(seen.size > 15, 'the scan finds the calls');
  for (const k of seen) { const [g, key] = k.split('.'); assert.ok((SETTABLE[g] || []).includes(key), `${k} is settable`); }
});

test('settings with bad values on disk are repaired when the app starts', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    me: { name: 'Ade', aliases: 5, role: ['x'] },
    llm: { live: { provider: 'nope', model: 7 }, webSearch: 'yes', baseUrls: { openai: 'http://kept' } },
    stt: { provider: 'constructor', keyterms: { a: 1 }, models: { deepgram: 5, openai: 'gpt-x' }, skipSilence: false },
    audio: 'broken',
    copilot: { autoMode: 'x', proactiveEverySec: '45', autoStopMinutes: 9999, personality: 5 },
    overlay: { opacity: 'high', bounds: { x: 1, y: 2, width: 3, height: 4 } },
    shortcuts: { answer: 5, screen: null, take: { a: 1 }, pause: 'Alt+Shift+Z' },
    appearance: { theme: 'neon' },
    library: { folders: ['C:\\docs'], includeMeetings: 1 },
    future: { key: 'from a newer version' },
  }));
  const settings = new Settings(dir, plain);
  const { patch, fixed } = V.repairSettings(settings.get(), DEFAULTS, ctx);
  assert.ok(fixed.length >= 15, `repairs ${fixed.length} values`);
  settings.set(patch);
  const s = settings.get();
  assert.deepEqual(s.me, { name: 'Ade', aliases: [], role: '' });
  assert.deepEqual(s.llm.live, DEFAULTS.llm.live);
  assert.equal(s.llm.webSearch, true);
  assert.deepEqual(s.llm.baseUrls, { openai: 'http://kept' }, 'settings the windows cannot set are not touched');
  assert.deepEqual([s.stt.provider, s.stt.keyterms, s.stt.skipSilence], ['deepgram', [], false]);
  assert.deepEqual(s.stt.models, { ...DEFAULTS.stt.models, openai: 'gpt-x' });
  assert.deepEqual(s.audio, DEFAULTS.audio);
  assert.deepEqual(s.copilot, DEFAULTS.copilot);
  assert.equal(s.overlay.opacity, DEFAULTS.overlay.opacity);
  assert.deepEqual(s.overlay.bounds, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(s.shortcuts, { ...DEFAULTS.shortcuts, pause: 'Alt+Shift+Z' });
  assert.equal(s.appearance.theme, 'system');
  assert.equal(s.library.includeMeetings, true);
  assert.deepEqual(s.library.folders, ['C:\\docs']);
  assert.deepEqual(s.future, { key: 'from a newer version' });
  // What is in use now fits every rule, a second pass finds nothing, and the file on disk is clean.
  assert.deepEqual(sanitise(s).rejected, []);
  assert.deepEqual(V.repairSettings(s, DEFAULTS, ctx).fixed, []);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(V.repairSettings(onDisk, DEFAULTS, ctx).fixed, []);
  assert.deepEqual(new Settings(dir, plain).get().me.aliases, []);
});

test('a list on disk with some bad entries keeps the good ones; a whole bad group goes back to its defaults', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ me: { aliases: ['A.', 5, '', null, 'Adeline'] }, stt: 'oops', shortcuts: 7 }));
  const settings = new Settings(dir, plain);
  const { patch, fixed } = V.repairSettings(settings.get(), DEFAULTS, ctx);
  settings.set(patch);
  assert.deepEqual(settings.get().me.aliases, ['A.', 'Adeline']);
  assert.deepEqual(settings.get().stt, DEFAULTS.stt);
  assert.deepEqual(settings.get().shortcuts, DEFAULTS.shortcuts);
  assert.ok(fixed.includes('me.aliases') && fixed.includes('stt') && fixed.includes('shortcuts'));
});

test('main.js repairs settings right after reading them, and sanitises through the validator', () => {
  assert.match(mainSrc, /new Settings\([\s\S]*?\}\);\s*repairSettings\(\);/);
  assert.ok(mainSrc.includes('V.sanitiseSettingsPatch(raw, vctx())'));
});

// main.js cannot be required outside Electron, so the functions under test are cut out of its text and run against stubs.
function shortcutsHarness(sc, { registerThrows = false, active = true, noSettings = false } = {}) {
  const log = { registered: [], errors: [], unregistered: 0 };
  const globalShortcut = {
    unregisterAll() { log.unregistered++; },
    register(a) { if (registerThrows) throw new Error('Invalid accelerator'); log.registered.push(a); return true; },
  };
  const make = new Function('globalShortcut', 'settings', 'meeting', 'broadcast', 'toggleOverlay', 'runAction', 'togglePause', `${between('function registerShortcuts() {', 'function toggleOverlay(force)')}; return registerShortcuts;`);
  const fn = make(globalShortcut, noSettings ? null : { get: () => ({ shortcuts: sc }) }, { active }, (m) => log.errors.push(m), () => {}, () => {}, () => Promise.resolve());
  return { fn, log };
}

test('registerShortcuts never throws, whatever the stored values are', () => {
  const values = [5, {}, [], null, undefined, true, '', 'Alt+Shift+A', 'Alt+Shift+A', 'bad', str(500), Symbol.iterator.toString()];
  for (const v of values) {
    const { fn, log } = shortcutsHarness({ answer: v, screen: v, take: v, catchup: v, toggleOverlay: v, pause: v });
    assert.doesNotThrow(() => fn(), `value ${String(v)}`);
    assert.ok(log.registered.every((a) => typeof a === 'string'));
  }
  for (const sc of [null, undefined, 5, 'x', []]) assert.doesNotThrow(() => shortcutsHarness(sc).fn());
  assert.doesNotThrow(() => shortcutsHarness({}, { noSettings: true }).fn());
  const dup = shortcutsHarness({ answer: 'Alt+Shift+A', screen: 'alt+shift+a', toggleOverlay: 5 });
  dup.fn();
  assert.deepEqual(dup.log.registered, ['Alt+Shift+A']);
  assert.ok(dup.log.errors.some((e) => /used twice/.test(e.message)) && dup.log.errors.some((e) => /not text/.test(e.message)));
  const bad = shortcutsHarness({ answer: 'Nonsense+' }, { registerThrows: true });
  assert.doesNotThrow(() => bad.fn());
  assert.ok(bad.log.errors.some((e) => /not a valid combination/.test(e.message)));
});

function startHarness({ captureThrows = false, trayThrows = false, shortcutsThrow = false } = {}) {
  const log = [];
  const meeting = { active: false, start() { this.active = true; log.push('start'); }, async stop() { this.active = false; log.push('stop'); }, snapshot() { return { active: this.active }; } };
  const win = { once() {}, showInactive() { log.push('show'); }, hide() { log.push('hide'); }, isDestroyed: () => false, webContents: { isLoading: () => false } };
  const make = new Function('meeting', 'settings', 'createStream', 'createOverlay', 'startCapture', 'stopCapture', 'registerShortcuts', 'refreshTray', 'getOverlayWin', 'channelPlan', `
    const connectionTest = { async cancel() {} };
    let audioMap, captureChannels, bridge = null, speedRun = null;
    ${between('async function _startMeeting(', 'async function _pauseMeeting')
      .replace(/overlayWin/g, 'getOverlayWin()')}
    return _startMeeting;`);
  const fn = make(
    meeting, { get: () => ({ audio: {}, stt: {} }), getSecret: () => 'k' }, () => ({ removeAllListeners() {} }), () => win,
    async () => { log.push('capture'); if (captureThrows) throw new Error('capture window failed'); }, () => log.push('stopCapture'),
    () => { log.push('shortcuts'); if (shortcutsThrow) throw new Error('shortcuts failed'); }, () => { log.push('tray'); if (trayThrows) throw new Error('tray failed'); }, () => win, require('../src/main/channel-plan').channelPlan);
  return { fn, log, meeting };
}

test('starting a meeting: a failure after audio has started either does no harm or leaves nothing running', async () => {
  const ok = startHarness();
  assert.deepEqual(await ok.fn({ title: 'T' }), { active: true });
  const tray = startHarness({ trayThrows: true });
  assert.deepEqual(await tray.fn({}), { active: true }, 'a failing tray does not fail the start');
  const failed = startHarness({ captureThrows: true });
  await assert.rejects(() => failed.fn({}), /capture window failed/);
  assert.equal(failed.meeting.active, false, 'the meeting was ended again');
  assert.ok(failed.log.includes('stopCapture') && failed.log.includes('stop'));
  assert.ok(!failed.log.includes('shortcuts'));
  // Shortcuts are registered after the capture has started and are registerShortcuts' own business: it does not throw (above).
  assert.ok(ok.log.indexOf('capture') < ok.log.indexOf('shortcuts'));
});

// ---------------------------------------------------------------- 2. meeting:action and meeting:set

test('meeting:action: only the app\'s own actions pass, and only the fields they use', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '', 'nope', 'ANSWER', 5, null, undefined, {}, ['say']]) {
    assert.throws(() => V.cleanActionCall(bad, {}, ACTIONS), /not an action/, String(bad));
  }
  for (const a of Object.keys(ACTIONS)) assert.equal(V.cleanActionCall(a, {}, ACTIONS).action, a);
  assert.deepEqual(V.cleanActionCall('ask', { typed: 'Why?' }, ACTIONS), { action: 'ask', params: { typed: 'Why?' } });
  for (const p of [null, undefined, 'typed', 5, ['typed'], true]) assert.deepEqual(V.cleanActionCall('say', p, ACTIONS).params, {});
  const got = V.cleanActionCall('answer', { typed: str(5000), ask: str(1500), speaker: str(100), addressee: str(100), target: 'other', minutes: 3.4, reason: 'you were mentioned', evil: 'x', image: 'data', __proto__: { x: 1 }, constructor: 'c' }, ACTIONS).params;
  assert.deepEqual(Object.keys(got).sort(), ['addressee', 'ask', 'minutes', 'speaker', 'target', 'typed']);
  assert.deepEqual([got.typed.length, got.ask.length, got.speaker.length, got.addressee.length, got.target, got.minutes], [2000, 1000, 80, 80, 'other', 3]);
  for (const t of ['x', 5, null, {}, 'You', '']) assert.equal(V.cleanActionCall('answer', { target: t }, ACTIONS).params.target, undefined, `target ${JSON.stringify(t)}`);
  for (const t of ['you', 'room', 'other']) assert.equal(V.cleanActionCall('answer', { target: t }, ACTIONS).params.target, t);
  for (const m of [0, 0.4, 61, -3, NaN, Infinity, '3', null, {}]) assert.equal(V.cleanActionCall('catchup', { minutes: m }, ACTIONS).params.minutes, undefined, `minutes ${String(m)}`);
  for (const m of [1, 5, 60]) assert.equal(V.cleanActionCall('catchup', { minutes: m }, ACTIONS).params.minutes, m);
  for (const f of ['typed', 'ask', 'speaker', 'addressee']) for (const v of [5, {}, ['x'], true, null]) assert.equal(V.cleanActionCall('answer', { [f]: v }, ACTIONS).params[f], undefined, `${f} ${JSON.stringify(v)}`);
  assert.ok(mainSrc.includes('V.cleanActionCall(action, params, ACTIONS)'));
  assert.match(mainSrc, /async function runAction\(action, params = \{\}\) \{\s*if \(!meeting\.active \|\| typeof action !== 'string' \|\| !Object\.hasOwn\(ACTIONS, action\)\) return null;/);
});

test('meeting:set: an unknown mode or style is ignored, never saved', () => {
  assert.deepEqual(V.cleanMeetingSet({ autoMode: 'proactive', personality: 'blunt' }, ctx), { autoMode: 'proactive', personality: 'blunt' });
  for (const arg of [null, undefined, 5, 'x', [], { autoMode: 'nope' }, { autoMode: 5 }, { autoMode: 'constructor' }]) assert.deepEqual(V.cleanMeetingSet(arg, ctx), {});
  for (const p of [5, {}, [], null, true, '', 'nope', 'constructor', '__proto__', str(81)]) assert.deepEqual(V.cleanMeetingSet({ personality: p }, ctx), {}, String(p));
  assert.ok(mainSrc.includes('V.cleanMeetingSet(arg, vctx())'));
});

// ---------------------------------------------------------------- 3 and 4. saved meetings

function savedMeeting(store, { title = 'Roadmap', notes = '## Summary\nSpeaker 1 spoke.', speakers = ['Ade', 'Speaker 1'] } = {}) {
  const meta = newMeta(title, new Date(2026, 10, 14, 14, 30, 5));
  meta.end = '15:00'; meta.durationMin = 30; meta.speakers = speakers;
  const transcript = '**[14:30:09] Speaker 1:** Hello there.\n\n**[14:30:15] Ade:** Hi.';
  const file = store.save(meta, notes, transcript);
  return { meta, file, transcript };
}
const stores = () => { const dir = tmp(); return { dir, store: new MeetingStore(dir, path.join(dir, '.live')) }; };
// What a person adds by hand: after the keys Understudy wrote, before the closing line.
const addFront = (file, lines) => { const t = fs.readFileSync(file, 'utf8'); const i = t.indexOf('\n---\n', 4); fs.writeFileSync(file, `${t.slice(0, i)}\n${lines}${t.slice(i)}`); };
const frontOf = (file) => fs.readFileSync(file, 'utf8').split('\n---\n')[0];

test('renaming a speaker keeps front matter the person added, in order and as written', () => {
  const { store } = stores();
  const { meta, file } = savedMeeting(store);
  const mine = 'tags: [customer, q4]\nproject: "Atlas"\n# kept comment\nreview-by: 2026-12-01\nattendees:\n  - Priya\n  - Sam';
  addFront(file, mine);
  const r = store.renameSpeaker(meta.id, 'Speaker 1', 'Priya');
  const front = frontOf(r.file);
  assert.ok(front.endsWith(mine), 'written back unchanged, after the built-in keys');
  assert.ok(front.indexOf('speakers:') < front.indexOf('tags:'));
  assert.equal(front.match(/^source:/gm).length, 1);
  const got = store.find(meta.id);
  assert.deepEqual(got.meta.speakers, ['Ade', 'Priya']);
  assert.equal(parse(fs.readFileSync(r.file, 'utf8'), r.file).frontMatter, 'ok');
  // Regenerating the notes (same parse and render) keeps it too, and so does the live meeting object saving over the file.
  store.save({ ...got.meta, autoTitle: false }, '## Summary\nNew.', got.transcript);
  assert.ok(frontOf(store._idx.get(meta.id)).endsWith(mine), 'notes regeneration');
  const live = { ...meta }; delete live.frontExtra;
  store.save(live, '## Summary\nLater.', got.transcript);
  assert.ok(frontOf(store._idx.get(meta.id)).endsWith(mine), 'a meeting object that never saw the file');
  // They are not offered in lists, and a source the person set is theirs to keep.
  assert.equal(store.list()[0].frontExtra, undefined);
  fs.writeFileSync(store._idx.get(meta.id), fs.readFileSync(store._idx.get(meta.id), 'utf8').replace('source: understudy', 'source: obsidian'));
  store.renameSpeaker(meta.id, 'Priya', 'Priya N');
  assert.ok(frontOf(store._idx.get(meta.id)).includes('source: obsidian') && !frontOf(store._idx.get(meta.id)).includes('source: understudy'));
});

test('a title already in a file is never shortened by a rewrite; a new title is capped once', () => {
  const { store } = stores();
  const long = `Quarterly ${str(240)}`;
  const meta = newMeta(long, new Date(2026, 10, 14, 9, 0, 0));
  assert.equal(meta.title.length, 200, 'capped when first created');
  meta.title = long; meta.speakers = ['Speaker 1'];
  const file = store.save(meta, 'x', '**[09:00:01] Speaker 1:** Hi.');
  assert.equal(store.find(meta.id).meta.title.length, 250, 'read back in full');
  store.renameSpeaker(meta.id, 'Speaker 1', 'Priya');
  assert.equal(store.find(meta.id).meta.title, long);
  assert.ok(fs.readFileSync(store._idx.get(meta.id), 'utf8').includes(`title: "${long}"`));
  assert.equal(newMeta(null).title.slice(0, 8), 'Meeting ');
  assert.equal(newMeta(str(500)).title.length, 200);
  assert.ok(file);
});

test('renaming "Speaker N" in the notes leaves code, fenced blocks and link addresses alone', () => {
  const { store } = stores();
  const notes = [
    '## Summary',
    'Speaker 1 agreed. Run `Speaker 1` as written, or ``a `Speaker 1` b``.',
    '',
    'See [what Speaker 1 said](http://a/Speaker 1) and <http://a/Speaker 1> and http://a/b?who=Speaker%201 plus https://c.example/Speaker 1.',
    '',
    '[ref]: http://a/Speaker 1 "Speaker 1"',
    '',
    '```',
    'Speaker 1 in a fence',
    '```',
    '',
    '~~~yaml',
    'owner: Speaker 1',
    '~~~',
    '',
    'Speaker 1 again, after the fences. Speaker 12 stays.',
  ].join('\n');
  const { meta } = savedMeeting(store, { notes });
  const r = store.renameSpeaker(meta.id, 'Speaker 1', 'Priya');
  const out = store.find(meta.id).notes;
  assert.ok(out.includes('Priya agreed. Run `Speaker 1` as written, or ``a `Speaker 1` b``.'));
  assert.ok(out.includes('[what Priya said](http://a/Speaker 1) and <http://a/Speaker 1> and http://a/b?who=Speaker%201'));
  assert.ok(out.includes('https://c.example/Speaker 1.'), 'a bare address runs to the next space, and is not rewritten');
  assert.ok(out.includes('[ref]: http://a/Speaker 1 "Speaker 1"'));
  assert.ok(out.includes('```\nSpeaker 1 in a fence\n```') && out.includes('~~~yaml\nowner: Speaker 1\n~~~'));
  assert.ok(out.includes('Priya again, after the fences. Speaker 12 stays.'));
  assert.equal(r.notesMentionOld, false, 'what is left is in code, addresses and Speaker 12');
});

test('notesMentionOld counts prose only', () => {
  const { store } = stores();
  const { meta } = savedMeeting(store, { notes: 'Nothing about `Speaker 1` here, only [a link](http://a/Speaker 1).\n\n```\nSpeaker 1\n```' });
  assert.equal(store.renameSpeaker(meta.id, 'Speaker 1', 'Priya').notesMentionOld, false);
});

test('a meeting file whose front matter cannot be read is left untouched by a rename', () => {
  const { dir, store } = stores();
  const day = path.join(dir, '2026-11-14');
  fs.mkdirSync(day, { recursive: true });
  const body = '\n# Hand edited\n\nSpeaker 1 notes.\n\n## Transcript\n\n**[10:00:01] Speaker 1:** Hello.\n';
  const cases = {
    'garbled': `---\nid: edit-1\ntitle: "Hand edited"\n{{ not yaml at all\n---\n${body}`,
    'unclosed': `---\nid: edit-2\ntitle: "Hand edited"\n${body}`,
    'no-id': `---\ntitle: "Hand edited"\n---\n${body}`,
    'multi-line-speakers': `---\nid: edit-4\ntitle: "Hand edited"\nspeakers:\n  - Speaker 1\n---\n${body}`,
    'none': body.replace(/^\n/, ''),
  };
  let n = 0;
  for (const [name, text] of Object.entries(cases)) {
    const file = path.join(day, `10${String(n++).padStart(2, '0')}-${name}.md`);
    fs.writeFileSync(file, text);
    const id = parse(text, file).meta.id;
    assert.equal(store.find(id).file, file, `${name} is found`);
    assert.throws(() => store.renameSpeaker(id, 'Speaker 1', 'Priya'), /edited in a way Understudy cannot read, so it was left as it is/, name);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${name} is byte for byte as it was`);
  }
  assert.deepEqual(fs.readdirSync(day).filter((f) => f.endsWith('.tmp')), []);
});

test('a rename does not replace a file that changed on disk while it was working', () => {
  const { store } = stores();
  const { meta, file } = savedMeeting(store);
  const orig = fs.readFileSync;
  let reads = 0, newer = null;
  // Reading the file to find it, and again to work on it: after the second read another program writes to it.
  fs.readFileSync = function (f, ...rest) {
    const out = orig.call(this, f, ...rest);
    if (path.resolve(String(f)) === path.resolve(file) && ++reads === 2) { newer = `${out}\nAdded by a sync client.\n`; fs.writeFileSync(file, newer); }
    return out;
  };
  try { assert.throws(() => store.renameSpeaker(meta.id, 'Speaker 1', 'Priya'), /This meeting file changed while it was being renamed\. Try again\./); } finally { fs.readFileSync = orig; }
  assert.equal(reads >= 2, true);
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'the newer content is still there');
  // Nothing else is in the way: the same rename works once the file is quiet.
  assert.ok(store.renameSpeaker(meta.id, 'Speaker 1', 'Priya').file);
});

test('every write of a meeting file, including a rename and the daily digest, goes through a temporary file', () => {
  const { dir, store } = stores();
  const { meta } = savedMeeting(store);
  const origWrite = fs.writeFileSync, written = [];
  fs.writeFileSync = function (f, ...rest) { written.push(String(f)); return origWrite.call(this, f, ...rest); };
  try { store.renameSpeaker(meta.id, 'Speaker 1', 'Priya'); store.writeDaily('2026-11-14'); } finally { fs.writeFileSync = origWrite; }
  assert.ok(written.length >= 2);
  for (const f of written) assert.ok(f.endsWith('.tmp'), `${f} is a temporary file`);
  assert.ok(fs.existsSync(path.join(dir, '2026-11-14', '_daily.md')));
  assert.deepEqual(fs.readdirSync(path.join(dir, '2026-11-14')).filter((f) => f.endsWith('.tmp')), []);
});

test('parse and render round-trip a file with no extra front matter byte for byte', () => {
  const meta = newMeta('Round trip', new Date(2026, 10, 14, 8, 0, 0)); meta.speakers = ['A "q"', 'B'];
  const text = render(meta, '## Summary\nx', '**[08:00:01] A:** hi');
  const p = parse(text, '/m/2026-11-14/0800-round-trip.md');
  assert.equal(p.frontMatter, 'ok');
  assert.deepEqual(p.meta.frontExtra, []);
  assert.equal(render(p.meta, p.notes, p.transcript), text);
});
