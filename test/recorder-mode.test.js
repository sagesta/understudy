'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createRecorder, createConfig } = require('../src/main/recorder-mode');
const { createListener, createSender } = require('../src/main/remote-link');
const { createBridge } = require('../src/main/remote-bridge');
const { channelPlan } = require('../src/main/channel-plan');
const { DEFAULTS, merge } = require('../src/main/settings');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'Distinctive_Recorder_Test_Token_7s94';
const VALUE = { url: 'ws://127.0.0.1:43127', token: TOKEN };
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < end, 'Condition was not met'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-recorder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
  decryptString: (bytes) => Buffer.from(bytes).map((byte) => byte ^ 0xa5).toString()
};
function fixture(t, { value = VALUE, encryption = safeStorage, factory, start } = {}) {
  const dir = temp(t), disk = createConfig({ dir, safeStorage });
  if (value) disk.save(value);
  const store = createConfig({ dir, safeStorage: encryption });
  const trays = [], logs = [], senders = [], capture = { running: false, starts: [], stops: 0,
    start(options) { this.running = true; this.starts.push(options); return start ? start() : true; },
    stop() { this.running = false; this.stops++; },
    emit(channel, bytes) { recorder.audio(channel, bytes); }
  };
  const recorder = createRecorder({ capture, config: { ...store, log(line) { logs.push(line); store.log(line); } },
    tray: { update: (value) => trays.push(value) }, now: () => 1234567890000,
    createSender(options) {
      if (factory) { const sender = factory(options); senders.push(sender); return sender; }
      const sender = { options, blocks: [], statuses: [], starts: 0, stops: 0,
        start() { this.starts++; }, stop() { this.stops++; options.onState('disconnected'); },
        push(channel, pcm) { this.blocks.push([channel, pcm]); return true; },
        sendStatus(status) { this.statuses.push(status); return true; }
      };
      senders.push(sender); return sender;
    }
  });
  t.after(() => recorder.stop());
  recorder.start();
  return { recorder, capture, dir, store, trays, logs, senders, get link() { return senders.at(-1); },
    connected() { senders.at(-1).options.onState('connected'); },
    command(name, info) { senders.at(-1).options.onCommand(name, info); }
  };
}
function pcmBytes(count, seed = 0) {
  const bytes = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(((i * 101 + seed) & 0xffff) - 32768, i * 2);
  return bytes;
}
function assertBlocks(blocks, expected, expectedChannel = 'them') {
  const actual = Buffer.alloc(blocks.length * 3200);
  for (let i = 0; i < blocks.length; i++) {
    const [channel, pcm] = blocks[i];
    assert.equal(channel, expectedChannel); assert.ok(pcm instanceof Int16Array); assert.equal(pcm.length, 1600);
    for (let j = 0; j < pcm.length; j++) actual.writeInt16LE(pcm[j], i * 3200 + j * 2);
  }
  assert.equal(Buffer.compare(actual, expected.subarray(0, actual.length)), 0, 'Every sample arrives in order');
  assert.equal(blocks.length, Math.floor(expected.length / 3200));
}

test('commands gate computer capture, including disconnect and reconnect without a fresh command', (t) => {
  const rig = fixture(t);
  assert.equal(rig.capture.running, false); assert.equal(rig.recorder.state().state, 'disconnected');
  rig.command('start'); assert.equal(rig.capture.starts.length, 0);
  rig.connected(); assert.equal(rig.recorder.state().state, 'waiting'); assert.equal(rig.capture.running, false);
  rig.command('start'); rig.command('start');
  assert.deepEqual(rig.capture.starts, [{ mic: false, system: true }]); assert.equal(rig.capture.running, true);
  rig.capture.emit('them', pcmBytes(1600)); assert.equal(rig.recorder.state().state, 'sending');
  rig.command('pause'); assert.equal(rig.capture.running, false); assert.equal(rig.recorder.state().state, 'paused');
  rig.capture.emit('them', pcmBytes(1600)); assert.equal(rig.link.blocks.length, 1);
  rig.command('resume'); assert.equal(rig.capture.starts.length, 2); assert.equal(rig.capture.running, true);
  rig.command('stop'); assert.equal(rig.capture.running, false); assert.equal(rig.recorder.state().state, 'waiting');
  rig.command('start'); rig.link.options.onState('disconnected');
  assert.equal(rig.capture.running, false); assert.equal(rig.recorder.state().state, 'disconnected');
  rig.capture.emit('them', pcmBytes(1600)); rig.command('resume'); assert.equal(rig.link.blocks.length, 1);
  rig.connected(); assert.equal(rig.capture.running, false);
  rig.command('start'); assert.equal(rig.capture.running, true); assert.equal(rig.capture.starts.length, 4);
  assert.equal(rig.link.options.keepBlocks, 0);
  rig.recorder.stop(); rig.command('start'); rig.connected(); assert.equal(rig.capture.running, false);
  assert.equal(rig.capture.stops, 4);
});

test('re-blocking carries odd bytes and large chunks without losing, repeating or aliasing samples', (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start');
  const expected = pcmBytes(500400), sizes = [700, 3, 1000000, 1, 2, 94];
  let pos = 0;
  for (const size of sizes) { rig.capture.emit('them', expected.subarray(pos, pos + size)); pos += size; }
  assert.equal(pos, expected.length);
  assertBlocks(rig.link.blocks, expected);
  assert.notEqual(rig.link.blocks[0][1].buffer, rig.link.blocks[1][1].buffer);
  expected.fill(0); assert.notEqual(rig.link.blocks[0][1][0], 0);
});

for (const end of ['stop', 'pause', 'disconnected']) test(`partial samples are dropped on ${end} and cannot enter the next recording`, (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start');
  rig.capture.emit('me', pcmBytes(1600)); rig.capture.emit('other', pcmBytes(1600));
  rig.capture.emit('them', pcmBytes(1600).subarray(0, 3199));
  if (end === 'disconnected') { rig.link.options.onState(end); rig.connected(); } else rig.command(end);
  rig.command('start');
  const expected = pcmBytes(3200, 72);
  const unaligned = Buffer.concat([Buffer.from([99]), expected]).subarray(1);
  rig.capture.emit('them', new Uint8Array(unaligned.buffer, unaligned.byteOffset, 7));
  rig.capture.emit('them', new DataView(unaligned.buffer, unaligned.byteOffset + 7, 3));
  rig.capture.emit('them', Uint8Array.from(expected.subarray(10)).buffer);
  rig.capture.emit('them', null); rig.capture.emit('them', [1, 2]);
  assertBlocks(rig.link.blocks, expected);
});

test('a stale start failure or sender callback cannot stop or restart a newer recording', async (t) => {
  const pending = [];
  const rig = fixture(t, { start: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  rig.connected(); rig.command('start'); rig.command('pause'); rig.command('resume');
  pending[0].reject(new Error(TOKEN)); await tick();
  assert.equal(rig.capture.running, true);
  pending[1].resolve(true); await tick();
  const old = rig.link;
  assert.equal(rig.recorder.paste(JSON.stringify({ ...VALUE, url: 'ws://[::1]:43128' })), true);
  assert.equal(rig.capture.running, false);
  rig.connected(); rig.command('start');
  old.options.onState('disconnected'); old.options.onCommand('pause');
  assert.equal(rig.capture.running, true);
  pending[2].resolve(false); await tick(); assert.equal(rig.capture.running, false);
  assert.ok(rig.trays.at(-1).text.includes('Computer audio could not be captured.'));
  assert.equal(JSON.stringify([rig.trays, rig.logs]).includes(TOKEN), false);
});

test('synchronous and asynchronous capture failures close the gate and expose only a plain message', async (t) => {
  for (const start of [() => { throw new Error(TOKEN); }, () => Promise.reject(new Error(TOKEN))]) {
    let broken = true;
    const rig = fixture(t, { start: () => broken ? start() : true }); rig.connected(); rig.command('start'); await tick();
    assert.equal(rig.capture.running, false); assert.equal(rig.recorder.state().recording, false);
    assert.deepEqual(rig.link.statuses.at(-1), { state: 'off' });
    assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
    broken = false; rig.command('start'); rig.capture.emit('them', pcmBytes(1600));
    assert.equal(rig.trays.at(-1).text, 'Sending audio');
  }
});

test('only an explicit true mic flag opens the default microphone', (t) => {
  const rig = fixture(t); rig.connected();
  for (const info of [undefined, {}, { mic: false }, { mic: 'true' }, { mic: 1 }, null, { mic: true }]) {
    rig.command('start', info); rig.capture.emit('me', pcmBytes(1600));
    assert.deepEqual(rig.capture.starts.at(-1), { mic: info?.mic === true, system: true });
    assert.equal(rig.link.blocks.length, info?.mic === true ? 1 : 0);
    rig.command('stop');
  }
});

test('two independent byte accumulators preserve odd chunks on both channels', (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start', { mic: true });
  const expected = { me: pcmBytes(8000, 73), them: pcmBytes(8000, 91) };
  const pos = { me: 0, them: 0 }, sizes = [1, 700, 3, 3201, 17, 12078];
  for (const size of sizes) for (const channel of ['them', 'me']) {
    rig.capture.emit(channel, expected[channel].subarray(pos[channel], pos[channel] + size)); pos[channel] += size;
  }
  for (const channel of ['me', 'them']) assertBlocks(rig.link.blocks.filter(([ch]) => ch === channel), expected[channel], channel);
  assert.equal(rig.trays.at(-1).text, 'Sending audio and microphone');
  assert.equal(rig.recorder.state().state, 'sendingMic');
  const log = fs.readFileSync(path.join(rig.dir, 'recorder.log'), 'utf8');
  assert.ok(log.includes('Sending audio and microphone'));
  rig.store.log('2009-02-13T23:31:30.000Z Sending audio and microphone ' + TOKEN);
  assert.equal(fs.readFileSync(path.join(rig.dir, 'recorder.log'), 'utf8'), log);
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

for (const end of ['pause', 'stop', 'disconnected', 'mic change', 'me error', 'them error'])
  test('both devices and partial blocks are released on ' + end, (t) => {
    const rig = fixture(t); rig.connected(); rig.command('start', { mic: true });
    for (const channel of ['me', 'them']) rig.capture.emit(channel, pcmBytes(1600).subarray(0, 3199));
    if (end === 'disconnected') rig.link.options.onState('disconnected');
    else if (end === 'mic change') rig.command('start', { mic: false });
    else if (end.endsWith('error')) rig.recorder.status({ channels: { [end.split(' ')[0]]: 'error' }, message: TOKEN });
    else rig.command(end);
    assert.equal(rig.capture.stops, 1);
    assert.equal(rig.capture.running, end === 'mic change');
    if (end === 'mic change') {
      rig.capture.emit('me', pcmBytes(1600)); assert.equal(rig.link.blocks.length, 0);
      assert.deepEqual(rig.capture.starts.at(-1), { mic: false, system: true });
      rig.command('resume', { mic: true }); assert.equal(rig.capture.stops, 2);
    } else {
      for (const channel of ['me', 'them']) rig.capture.emit(channel, pcmBytes(1600));
      assert.equal(rig.link.blocks.length, 0);
      if (end === 'disconnected') { rig.connected(); assert.equal(rig.capture.running, false); }
      rig.command('resume', { mic: true });
    }
    for (const channel of ['me', 'them']) {
      const expected = pcmBytes(3200, channel === 'me' ? 31 : 19);
      rig.capture.emit(channel, expected.subarray(0, 1)); rig.capture.emit(channel, expected.subarray(1));
      assertBlocks(rig.link.blocks.filter(([ch]) => ch === channel), expected, channel);
    }
    assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
  });

test('a rejected mic start cannot stop a newer start with the mic disabled', async (t) => {
  const pending = [];
  const rig = fixture(t, { start: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  rig.connected(); rig.command('start', { mic: true });
  rig.command('start', { mic: false }); assert.equal(rig.capture.stops, 1);
  pending[0].reject(new Error(TOKEN)); await tick(); assert.equal(rig.capture.running, true);
  rig.capture.emit('me', pcmBytes(1600)); assert.equal(rig.link.blocks.length, 0);
  pending[1].resolve(false); await tick(); assert.equal(rig.capture.running, false);
  rig.command('resume'); assert.deepEqual(rig.capture.starts.at(-1), { mic: false, system: true });
  pending[2].resolve(true); await tick();
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

test('a command changing mic permission during a send discards the rest of that old chunk', (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start', { mic: true });
  const push = rig.link.push.bind(rig.link);
  rig.link.push = (channel, pcm) => { const sent = push(channel, pcm); rig.command('start', { mic: false }); return sent; };
  rig.capture.emit('me', pcmBytes(4800));
  assert.equal(rig.link.blocks.length, 1); assert.equal(rig.capture.stops, 1);
  assert.equal(rig.recorder.state().state, 'waiting');
});

test('a valid paste encrypts the token, starts the sender and can be loaded again', (t) => {
  const rig = fixture(t, { value: null });
  assert.equal(rig.recorder.state().state, 'unset'); assert.equal(rig.senders.length, 0);
  assert.equal(rig.recorder.paste(JSON.stringify(VALUE)), true);
  assert.equal(rig.link.starts, 1); assert.equal(rig.capture.starts.length, 0);
  const data = JSON.parse(fs.readFileSync(path.join(rig.dir, 'recorder.json'), 'utf8'));
  assert.deepEqual(Object.keys(data.token), ['enc']); assert.ok(data.token.enc);
  assert.deepEqual(rig.store.load(), VALUE);
  for (const file of fs.readdirSync(rig.dir)) assert.equal(fs.readFileSync(path.join(rig.dir, file), 'utf8').includes(TOKEN), false);
  rig.recorder.start(); assert.equal(rig.senders.length, 1);
});

const invalid = [
  ['wrong scheme', { ...VALUE, url: 'wss://127.0.0.1:43127' }],
  ['host name', { ...VALUE, url: 'ws://meeting.example:43127' }],
  ['user info', { ...VALUE, url: 'ws://user@127.0.0.1:43127' }],
  ['password', { ...VALUE, url: `ws://user:${TOKEN}@127.0.0.1:43127` }],
  ['path', { ...VALUE, url: 'ws://127.0.0.1:43127/' }],
  ['query', { ...VALUE, url: `ws://127.0.0.1:43127?token=${TOKEN}` }],
  ['fragment', { ...VALUE, url: 'ws://127.0.0.1:43127#part' }],
  ['port 80', { ...VALUE, url: 'ws://127.0.0.1:80' }],
  ['large port', { ...VALUE, url: 'ws://127.0.0.1:65536' }],
  ['invalid IPv4', { ...VALUE, url: 'ws://127.0.0.999:43127' }],
  ['LAN IPv4', { ...VALUE, url: 'ws://192.168.1.10:43127' }],
  ['wildcard IPv4', { ...VALUE, url: 'ws://0.0.0.0:43127' }],
  ['wildcard IPv6', { ...VALUE, url: 'ws://[::]:43127' }],
  ['public IPv6', { ...VALUE, url: 'ws://[2001:db8::1]:43127' }],
  ['unbracketed IPv6', { ...VALUE, url: 'ws://::1:43127' }],
  ['short token', { ...VALUE, token: 'short' }],
  ['long token', { ...VALUE, token: 'a'.repeat(201) }],
  ['non-base64url token', { ...VALUE, token: 'a'.repeat(16) + '=' }],
  ['null token', { ...VALUE, token: null }], ['null', null], ['array', []], ['malformed JSON', '{']
];
for (const [name, value] of invalid) test(`paste refuses ${name} with a plain message and leaves the active config unchanged`, (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start');
  const before = fs.readFileSync(path.join(rig.dir, 'recorder.json'));
  assert.equal(rig.recorder.paste(name === 'malformed JSON' ? value : JSON.stringify(value)), false);
  assert.deepEqual(fs.readFileSync(path.join(rig.dir, 'recorder.json')), before);
  assert.equal(rig.senders.length, 1); assert.equal(rig.capture.running, true);
  assert.ok(rig.trays.at(-1).text.length > 'Connected, waiting'.length);
  assert.doesNotMatch(rig.trays.at(-1).text, /TypeError|SyntaxError|\u2014|\n/);
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

test('Tailscale and loopback IPv4 and bracketed IPv6 literals and both port and token limits are accepted', (t) => {
  const rig = fixture(t, { value: null });
  for (const url of ['ws://100.64.0.2:1024', 'ws://[fd7a:115c:a1e0::1]:65535', 'ws://[::1]:43127', 'ws://[::ffff:100.64.1.2]:49152', 'ws://[::ffff:127.0.0.1]:49152']) {
    for (const token of ['a'.repeat(16), 'Z_-9'.repeat(50)]) {
      assert.equal(rig.recorder.paste(JSON.stringify({ url, token })), true);
      assert.deepEqual(rig.store.load(), { url, token });
    }
  }
});

test('unavailable encryption refuses to save or overwrite and explains why in the tray', (t) => {
  for (const encryption of [undefined, { isEncryptionAvailable: () => false }]) {
    const rig = fixture(t, { encryption: encryption || null });
    const before = fs.readFileSync(path.join(rig.dir, 'recorder.json'));
    assert.equal(rig.senders.length, 0);
    assert.equal(rig.recorder.paste(JSON.stringify(VALUE)), false);
    assert.deepEqual(fs.readFileSync(path.join(rig.dir, 'recorder.json')), before);
    assert.match(rig.trays.at(-1).text, /Windows encryption is not available/);
  }
  const rig = fixture(t, { value: null, encryption: null });
  assert.equal(rig.recorder.paste(JSON.stringify(VALUE)), false);
  assert.equal(fs.existsSync(path.join(rig.dir, 'recorder.json')), false);
});

test('corrupt or plaintext saved config is not used and a failed save leaves the old file intact', (t) => {
  const dir = temp(t), file = path.join(dir, 'recorder.json');
  const store = createConfig({ dir, safeStorage });
  for (const text of ['null', '{', JSON.stringify(VALUE), JSON.stringify({ ...VALUE, token: { enc: 'wrong!' } })]) {
    fs.writeFileSync(file, text);
    assert.throws(() => store.load(), /Saved recorder settings could not be opened/);
  }
  store.save(VALUE); const before = fs.readFileSync(file);
  const broken = createConfig({ dir, safeStorage: { ...safeStorage, encryptString() { throw new Error(TOKEN); } } });
  assert.throws(() => broken.save(VALUE), /Recorder settings could not be saved/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('only allowed computer states and hints are forwarded, and output never includes the token', (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start'); rig.link.statuses.length = 0;
  for (const state of ['off', 'starting', 'on', 'lost']) rig.recorder.status({ channels: { me: 'error', them: state } });
  assert.deepEqual(rig.link.statuses, ['off', 'starting', 'on', 'lost'].map((state) => ({ state })));
  rig.recorder.status({ channels: { them: 'invented' }, hint: TOKEN });
  rig.recorder.status({ channels: { me: 'on' }, message: TOKEN });
  rig.recorder.status({ levels: { them: 0.1 } }); assert.equal(rig.link.statuses.length, 4);
  rig.recorder.status({ channels: { them: 'on' }, message: 'Computer audio is ready.' });
  rig.recorder.status({ hint: 'No sound has come from the computer yet.' });
  assert.deepEqual(rig.link.statuses.at(-1), { state: 'on', hint: 'No sound has come from the computer yet.' });
  rig.recorder.status({ hint: `Private ${TOKEN} ${TOKEN}` });
  assert.deepEqual(rig.link.statuses.at(-1), { state: 'on', hint: 'Private [removed] [removed]' });
  rig.recorder.status({ hint: 'x'.repeat(195) + TOKEN });
  assert.ok(rig.link.statuses.at(-1).hint.length <= 200);
  rig.capture.emit('them', pcmBytes(1600));
  rig.recorder.status({ channels: { them: 'lost' }, message: `Device ${TOKEN} stopped.` });
  assert.equal(rig.recorder.state().state, 'waiting');
  rig.command('pause'); rig.recorder.status({ channels: { them: 'on' }, hint: TOKEN });
  assert.deepEqual(rig.link.statuses.at(-1), { state: 'off' });
  assert.equal(JSON.stringify([rig.link.statuses, rig.trays, rig.logs]).includes(TOKEN), false);
  assert.ok(rig.trays.some((value) => value.state === 'sending' && value.text === 'Sending audio'));
  assert.ok(rig.trays.every((value) => !value.target || value.target === VALUE.url));
});

test('recorder log retains only the last 100 state changes and no clipboard, address or hint text', (t) => {
  const rig = fixture(t), file = path.join(rig.dir, 'recorder.log');
  fs.writeFileSync(file, TOKEN + '\n');
  rig.connected();
  for (let i = 0; i < 80; i++) { rig.command('start'); rig.capture.emit('them', pcmBytes(1600)); rig.command('pause'); }
  const text = fs.readFileSync(file, 'utf8'), lines = text.trim().split('\n');
  assert.equal(lines.length, 100); assert.equal(text.includes(TOKEN), false); assert.equal(text.includes(VALUE.url), false);
  for (const line of lines) assert.match(line, /^2009-02-13T23:31:30\.000Z (Connected, waiting|Sending audio|Paused)$/);
  const before = text; rig.recorder.paste('{');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'A paste error is not a state change');
});

test('recorder source dependency closure cannot reach the connector, keys or owner data modules', () => {
  const files = new Set(), externals = new Set();
  function visit(file) {
    if (files.has(file)) return;
    files.add(file); const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /getSecret|secrets\.json|claude_desktop_config/);
    for (const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = match[1];
      assert.doesNotMatch(name, /^\.\/(settings|knowledge|llm|stt|claude-connect|live-copy|notes-inbox|issues|crashlog|meetings)(?:\/|$)/);
      if (name.startsWith('.')) visit(require.resolve(path.resolve(path.dirname(file), name))); else externals.add(name);
    }
  }
  visit(path.join(ROOT, 'src/main/recorder-mode.js'));
  // Also cover the scripts loaded by the hidden page, which are not CommonJS dependencies.
  for (const name of ['src/preload.js', 'src/renderer/capture.js', 'src/renderer/pcm-worklet.js']) visit(path.join(ROOT, name));
  assert.deepEqual([...externals].sort(), ['electron', 'node:crypto', 'node:fs', 'node:net', 'node:path', 'node:url', 'ws'].sort());
  assert.ok(files.has(path.join(ROOT, 'src/main/remote-link.js')));
});

test('the recorder entry returns after Electron and before any other main app dependency', () => {
  const source = read('src/main/main.js'), calls = [];
  const fakeRequire = (name) => {
    calls.push(name);
    if (name === 'electron') return {};
    if (name === './recorder-mode') return { run: () => calls.push('run') };
    throw new Error('Main app dependency loaded');
  };
  const entry = vm.runInNewContext(`(function(require, process) { ${source}\n})`);
  entry(fakeRequire, { argv: ['Understudy.exe', '--recorder'] });
  assert.deepEqual(calls, ['electron', './recorder-mode', 'run']);
  assert.match(source, /require\('electron'\);\r\nif \(process\.argv\.includes\('--recorder'\)\) \{ require\('\.\/recorder-mode'\)\.run\(\); return; \}/);
});

test('package file rules include recorder, capture, preload and the existing ws dependency inside asar', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('src/**/*')); assert.ok(pkg.dependencies.ws);
  assert.notEqual(pkg.build.asar, false); assert.equal(pkg.build.asarUnpack, undefined);
  assert.ok(fs.existsSync(require.resolve('ws')));
});

function electronFixture(t, { packaged = false, locked = true, noTray = false, value = null, autoStart = false, argv = [] } = {}) {
  const dir = temp(t), envDir = path.join(dir, 'override'), events = [], paths = {}, windows = [], icons = [], senders = [], ipcMain = new EventEmitter();
  const handlers = new Map(), replies = [], messages = [], loginCalls = [], loginReads = [];
  ipcMain.handle = (channel, fn) => { assert.equal(handlers.has(channel), false); handlers.set(channel, fn); };
  const app = new EventEmitter();
  app.getLoginItemSettings = (...args) => { loginReads.push(args); return { openAtLogin: autoStart }; };
  app.setLoginItemSettings = (options) => { loginCalls.push(options); autoStart = options.openAtLogin; };
  app.isPackaged = packaged;
  if (value) createConfig({ dir: packaged ? path.join(dir, 'Understudy Recorder') : envDir, safeStorage }).save(value);
  app.setName = (name) => events.push(['name', name]);
  app.setPath = (name, value) => { paths[name] = value; events.push(['path', name]); };
  app.getPath = (name) => {
    events.push(['getPath', name]);
    if (name === 'appData') return dir;
    assert.ok(paths[name], 'Data must be set before it is read'); return paths[name];
  };
  app.requestSingleInstanceLock = () => { events.push(['lock']); assert.ok(paths.userData); return locked; };
  app.commandLine = { appendSwitch: (name) => events.push(['switch', name]) };
  app.whenReady = () => Promise.resolve();
  app.quit = () => { events.push(['quit']); app.emit('before-quit'); };
  const permissions = {};
  const ses = { setPermissionRequestHandler: (fn) => { permissions.request = fn; },
    setPermissionCheckHandler: (fn) => { permissions.check = fn; }, setDisplayMediaRequestHandler: (fn) => { permissions.display = fn; } };
  const clipboard = { text: '', readText() { return this.text; }, clear() { this.text = ''; } };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
      const wc = this.webContents;
      wc.setWindowOpenHandler = (fn) => { this.openHandler = fn; };
      wc.mainFrame = {};
      wc.send = (channel, value) => messages.push([channel, value]);
      wc.getURL = () => wc.mainFrame.url;
      wc.executeJavaScript = async (script, gesture) => { this.script = script; this.gesture = gesture; return true; };
      windows.push(this);
    }
    loadFile(file) {
      this.file = file; this.webContents.mainFrame.url = pathToFileURL(file).href;
      return new Promise((resolve, reject) => { this.loaded = resolve; this.failed = reject; });
    }
    isDestroyed() { return this.dead; }
    setMenu(menu) { this.menu = menu; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  class Tray {
    constructor(image) { if (noTray) throw new Error('No tray'); this.image = image; icons.push(this); }
    setImage(image) { this.image = image; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.dead = true; }
  }
  const electron = { app, BrowserWindow, ipcMain, session: { defaultSession: ses }, safeStorage, clipboard, Tray,
    Menu: { buildFromTemplate: (menu) => menu }, nativeImage: { createFromBitmap: (bytes, size) => ({ bytes, size }) },
    desktopCapturer: { getSources: async () => [{ id: 'screen:0' }] } };
  const module = { exports: {} };
  const load = (name) => {
    events.push(['require', name]);
    if (name === 'electron') return electron;
    if (name === './remote-link') return { createSender(options) {
      const sender = { options, statuses: [], blocks: [], start() { options.onState('connecting'); }, stop() { options.onState('disconnected'); },
        sendStatus(value) { this.statuses.push(value); return true; }, push(...args) { this.blocks.push(args); return true; } };
      senders.push(sender); return sender;
    } };
    assert.ok(['node:fs', 'node:path', 'node:net', 'node:url'].includes(name)); return require(name);
  };
  // This runs only our JavaScript with an Electron stand-in. No Electron process is launched.
  const wrapper = vm.runInNewContext(`(function(require, module, __dirname, process, Buffer) { ${read('src/main/recorder-mode.js')}\n})`);
  wrapper(load, module, path.join(ROOT, 'src/main'), { argv, env: { UNDERSTUDY_DATA_DIR: envDir } }, Buffer);
  t.after(() => app.quit());
  return { ...module.exports, app, dir, envDir, paths, events, windows, icons, senders, ipcMain, clipboard, permissions,
    handlers, replies, messages, loginCalls, loginReads,
    get setupWindows() { return windows.filter((win) => win.file === path.join(ROOT, 'src/renderer/recorder-setup.html')); },
    get captureWindows() { return windows.filter((win) => win.file === path.join(ROOT, 'src/renderer/capture.html')); },
    invoke(channel, args = [], event) {
      const wc = this.setupWindows.at(-1)?.webContents;
      try { const reply = handlers.get(channel)(event || { sender: wc, senderFrame: wc?.mainFrame }, ...args); replies.push(reply); return reply; }
      catch (err) { replies.push({ error: err.message }); throw err; }
    }
  };
}

test('Electron wiring sets separate data and lock before loading or capture, and packaged builds ignore the override', async (t) => {
  for (const packaged of [false, true]) {
    const rig = electronFixture(t, { packaged }); await rig.run();
    assert.equal(rig.paths.userData, packaged ? path.join(rig.dir, 'Understudy Recorder') : rig.envDir);
    assert.ok(rig.events.findIndex(([event]) => event === 'path') < rig.events.findIndex(([event]) => event === 'lock'));
    assert.ok(rig.events.findIndex(([event]) => event === 'lock') < rig.events.findIndex(([event, name]) => event === 'require' && name === './remote-link'));
    assert.equal(rig.setupWindows.length, 1); assert.equal(rig.captureWindows.length, 0); assert.equal(rig.icons.length, 1);
    const icon = rig.icons[0]; assert.equal(icon.tooltip, 'Not set up');
    assert.deepEqual(Array.from(icon.menu, (item) => item.label), ['Not set up', 'Open', 'Paste settings from clipboard', 'Start with Windows', 'Quit']);
    assert.equal(icon.menu[0].enabled, false);
    rig.clipboard.text = JSON.stringify(VALUE); icon.menu.find((item) => item.label === 'Paste settings from clipboard').click();
    assert.equal(rig.clipboard.text, ''); assert.equal(rig.senders.length, 1); assert.equal(rig.captureWindows.length, 0);
    const link = rig.senders[0]; link.options.onState('connected');
    assert.equal(icon.tooltip, 'Connected, waiting\n' + VALUE.url);
    link.options.onCommand('start'); assert.equal(rig.captureWindows.length, 1);
    const win = rig.captureWindows[0]; assert.equal(win.options.show, false);
    assert.equal(win.options.webPreferences.nodeIntegration, false); assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.preload, path.join(ROOT, 'src/preload.js'));
    assert.equal(win.file, path.join(ROOT, 'src/renderer/capture.html'));
    win.loaded(); await tick(); assert.equal(win.script, 'window.startCapture({ mic: false, system: true })'); assert.equal(win.gesture, true);
    rig.ipcMain.emit('audio', { sender: {} }, 'them', pcmBytes(1600));
    rig.ipcMain.emit('audio', { sender: win.webContents }, 'me', pcmBytes(1600)); assert.equal(link.blocks.length, 0);
    rig.ipcMain.emit('audio', { sender: win.webContents }, 'them', pcmBytes(1600)); assert.equal(link.blocks.length, 1);
    assert.equal(icon.tooltip, 'Sending audio\n' + VALUE.url);
    rig.ipcMain.emit('capture:status', { sender: win.webContents }, { hint: `Device ${TOKEN}` });
    assert.equal(JSON.stringify(link.statuses).includes(TOKEN), false);
    link.options.onCommand('pause'); assert.equal(win.dead, true); assert.equal(icon.tooltip, 'Paused\n' + VALUE.url);
    rig.ipcMain.emit('audio', { sender: win.webContents }, 'them', pcmBytes(1600)); assert.equal(link.blocks.length, 1);
    link.options.onCommand('resume');
    const next = rig.captureWindows[1]; link.options.onState('disconnected'); assert.equal(next.dead, true);
    next.loaded(); await tick(); assert.equal(next.script, undefined, 'A pending load cannot start after disconnect');
    assert.equal(icon.tooltip, 'Not connected\n' + VALUE.url);
    assert.equal(icon.image.bytes.length, 16 * 16 * 4);
    icon.menu.find((item) => item.label === 'Quit').click(); assert.equal(icon.dead, true);
  }
});

test('Electron capture forwards mic permission and the setup and tray show the mic label', async (t) => {
  const rig = electronFixture(t); await rig.run(); rig.invoke('recorder:connect', [JSON.stringify(VALUE)]);
  const link = rig.senders[0]; link.options.onState('connected'); link.options.onCommand('start', { mic: true });
  const win = rig.captureWindows[0]; win.loaded(); await tick();
  assert.equal(win.script, 'window.startCapture({ mic: true, system: true })');
  rig.ipcMain.emit('audio', { sender: win.webContents }, 'me', pcmBytes(1600));
  assert.equal(link.blocks[0][0], 'me'); assert.ok(rig.icons[0].tooltip.startsWith('Sending audio and microphone'));
  assert.equal(rig.invoke('recorder:state').label, 'Sending audio and microphone');
  link.options.onCommand('start', { mic: false }); assert.equal(win.dead, true);
  rig.ipcMain.emit('audio', { sender: win.webContents }, 'me', pcmBytes(1600)); assert.equal(link.blocks.length, 1);
  const next = rig.captureWindows[1]; next.loaded(); await tick();
  assert.equal(next.script, 'window.startCapture({ mic: false, system: true })');
  rig.ipcMain.emit('audio', { sender: next.webContents }, 'me', pcmBytes(1600)); assert.equal(link.blocks.length, 1);
  link.options.onCommand('pause'); assert.equal(next.dead, true);
  assert.equal(JSON.stringify([rig.replies, rig.messages]).includes(TOKEN), false);
});

test('clipboard is cleared only after a valid save and only while it still holds that paste', async (t) => {
  const rig = electronFixture(t); await rig.run(); const icon = rig.icons[0];
  rig.clipboard.text = '{'; icon.menu.find((item) => item.label === 'Paste settings from clipboard').click(); assert.equal(rig.clipboard.text, '{'); assert.equal(rig.senders.length, 0);
  let reads = 0;
  rig.clipboard.readText = () => ++reads === 1 ? JSON.stringify(VALUE) : 'new clipboard text';
  let cleared = false; rig.clipboard.clear = () => { cleared = true; };
  icon.menu.find((item) => item.label === 'Paste settings from clipboard').click(); assert.equal(cleared, false); assert.equal(rig.senders.length, 1);
});

test('capture permissions are restricted to the hidden page, including delayed loopback requests', async (t) => {
  const rig = electronFixture(t); await rig.run();
  rig.clipboard.text = JSON.stringify(VALUE); rig.icons[0].menu.find((item) => item.label === 'Paste settings from clipboard').click();
  const link = rig.senders[0]; link.options.onState('connected'); link.options.onCommand('start');
  const win = rig.captureWindows[0], wc = win.webContents, p = rig.permissions;
  let allowed;
  p.request(wc, 'media', (value) => { allowed = value; }, {}); assert.equal(allowed, true);
  p.request({}, 'media', (value) => { allowed = value; }, { requestingUrl: wc.getURL() }); assert.equal(allowed, false);
  assert.equal(p.check(wc, 'display-capture', '', {}), true); assert.equal(p.check(wc, 'notifications', '', {}), false);
  assert.equal(p.check(wc, 'media', '', { requestingUrl: 'file:///untrusted/capture.html' }), false);
  let reply;
  p.display({ frame: { url: wc.getURL() } }, (value) => { reply = value; }); assert.deepEqual(Object.keys(reply), []);
  p.display({ frame: wc.mainFrame }, (value) => { reply = value; }); await tick();
  assert.equal(reply.audio, 'loopback'); assert.equal(reply.video.id, 'screen:0');
  p.display({ frame: wc.mainFrame }, (value) => { reply = value; }); link.options.onState('disconnected'); await tick();
  assert.deepEqual(Object.keys(reply), []); assert.equal(win.dead, true);
});

test('failure to acquire the recorder lock or create its tray never opens capture or starts a sender', async (t) => {
  for (const options of [{ locked: false }, { noTray: true }]) {
    const rig = electronFixture(t, options); await rig.run();
    assert.equal(rig.windows.length, 0); assert.equal(rig.senders.length, 0); assert.equal(rig.icons.length, 0);
    assert.ok(rig.events.some(([event]) => event === 'quit'));
  }
});

test('setup opens on first run, hides on close and stays closed at startup with saved settings', async (t) => {
  for (const value of [null, VALUE]) {
    const rig = electronFixture(t, { value, autoStart: !!value }); await rig.run();
    assert.equal(rig.setupWindows.length, value ? 0 : 1); assert.equal(rig.captureWindows.length, 0);
    assert.equal(rig.loginCalls.length, 0, 'Startup reads the setting without changing it');
    rig.icons[0].menu.find((item) => item.label === 'Open').click();
    const win = rig.setupWindows[0]; win.loaded(); await tick();
    assert.equal(win.visible, true); assert.equal(win.options.title, 'Understudy Recorder');
    assert.equal(win.options.width, 420); assert.equal(win.options.height, 380); assert.equal(win.options.resizable, false);
    assert.equal(win.options.webPreferences.preload, path.join(ROOT, 'src/recorder-preload.js'));
    assert.equal(win.options.webPreferences.contextIsolation, true); assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.menu, null);
    assert.equal(rig.invoke('recorder:state').autoStart, !!value);
    win.close(); assert.equal(win.visible, false); assert.equal(win.dead, false); assert.equal(rig.icons[0].dead, undefined);
    assert.equal(rig.events.some(([event]) => event === 'quit'), false);
    rig.app.emit('window-all-closed'); assert.equal(rig.events.some(([event]) => event === 'quit'), false);
    rig.icons[0].menu.find((item) => item.label === 'Open').click(); assert.equal(win.visible, true); assert.equal(rig.setupWindows.length, 1);
    assert.deepEqual(Object.keys(win.openHandler()), ['action']); assert.equal(win.openHandler().action, 'deny');
    let prevented = false; win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    rig.app.quit(); assert.equal(win.dead, true); assert.equal(rig.icons[0].dead, true);
  }
});

test('setup paste saves, connects and conditionally clears the clipboard without exposing settings', async (t) => {
  const rig = electronFixture(t); await rig.run();
  const state = rig.invoke('recorder:state'); assert.equal(state.state, 'unset'); assert.equal(state.autoStart, false);
  rig.clipboard.text = JSON.stringify(VALUE);
  assert.equal(rig.invoke('recorder:paste').state, 'disconnected'); assert.equal(rig.clipboard.text, '');
  assert.equal(rig.senders.length, 1); assert.equal(rig.captureWindows.length, 0);
  assert.deepEqual(createConfig({ dir: rig.paths.userData, safeStorage }).load(), VALUE);
  const file = path.join(rig.paths.userData, 'recorder.json'), before = fs.readFileSync(file);
  for (const text of ['{', JSON.stringify({ ...VALUE, url: 'https://' + TOKEN }), 'x'.repeat(2001)]) {
    rig.clipboard.text = text;
    const reply = rig.invoke('recorder:paste');
    assert.equal(reply.state, 'disconnected'); assert.ok(reply.message); assert.equal(rig.clipboard.text, text);
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(rig.senders.length, 1);
  }
  let reads = 0, clears = 0;
  rig.clipboard.readText = () => ++reads === 1 ? JSON.stringify(VALUE) : 'Changed clipboard';
  rig.clipboard.clear = () => { clears++; };
  rig.invoke('recorder:paste'); assert.equal(clears, 0); assert.equal(rig.senders.length, 2);
  rig.clipboard.readText = () => { throw new Error(TOKEN); };
  assert.match(rig.invoke('recorder:paste').message, /Clipboard text could not be read/);
  for (const contents of fs.readdirSync(rig.paths.userData)) assert.equal(fs.readFileSync(path.join(rig.paths.userData, contents), 'utf8').includes(TOKEN), false);
  assert.equal(JSON.stringify([rig.replies, rig.messages]).includes(TOKEN), false);
});

test('all setup IPC handlers validate type, count and sending frame before any side effect', async (t) => {
  const rig = electronFixture(t); await rig.run();
  const win = rig.setupWindows[0], wc = win.webContents;
  assert.deepEqual([...rig.handlers.keys()].sort(), ['recorder:paste', 'recorder:connect', 'recorder:state', 'recorder:autoStart'].sort());
  for (const channel of ['recorder:paste', 'recorder:state']) for (const value of [null, {}, true, TOKEN]) assert.throws(() => rig.invoke(channel, [value]), /not valid/);
  for (const args of [[], [null], [undefined], [1], [false], [{}], [[]], ['x'.repeat(2001)], [JSON.stringify(VALUE), true]]) assert.throws(() => rig.invoke('recorder:connect', args), /not valid/);
  for (const args of [[], [null], [undefined], [0], [1], [{}], [[]], ['true'], [true, false]]) assert.throws(() => rig.invoke('recorder:autoStart', args), /not valid/);
  for (const event of [{ sender: {}, senderFrame: wc.mainFrame }, { sender: wc, senderFrame: { url: wc.getURL() } }, { sender: wc }]) {
    for (const [channel, args] of [['recorder:paste', []], ['recorder:state', []], ['recorder:connect', [JSON.stringify(VALUE)]], ['recorder:autoStart', [true]]]) assert.throws(() => rig.invoke(channel, args, event), /not valid/);
  }
  const url = wc.mainFrame.url; wc.mainFrame.url = 'file:///other.html';
  assert.throws(() => rig.invoke('recorder:state'), /not valid/); wc.mainFrame.url = url;
  assert.equal(rig.senders.length, 0); assert.equal(rig.loginCalls.length, 0); assert.equal(rig.captureWindows.length, 0);
  // The exact boundary is accepted. JSON whitespace does not alter the saved settings.
  const text = JSON.stringify(VALUE).padEnd(2000);
  assert.equal(rig.invoke('recorder:connect', [text]).state, 'disconnected'); assert.equal(rig.senders.length, 1);
  assert.equal(JSON.stringify([rig.replies, rig.messages]).includes(TOKEN), false);
});

test('setup state messages stay token-free through every capture state, validation and encryption error', async (t) => {
  const rig = electronFixture(t); await rig.run();
  rig.invoke('recorder:state'); rig.invoke('recorder:connect', [JSON.stringify(VALUE)]);
  const link = rig.senders[0]; link.options.onState('connected'); rig.invoke('recorder:state');
  link.options.onCommand('start'); const win = rig.captureWindows[0]; win.loaded(); await tick();
  rig.ipcMain.emit('audio', { sender: win.webContents }, 'them', pcmBytes(1600)); rig.invoke('recorder:state');
  rig.ipcMain.emit('capture:status', { sender: win.webContents }, { hint: TOKEN });
  link.options.onCommand('pause'); rig.invoke('recorder:state');
  link.options.onState('disconnected'); rig.invoke('recorder:state');
  for (const [, value] of invalid) rig.invoke('recorder:connect', [typeof value === 'string' ? value : JSON.stringify(value)]);
  assert.deepEqual(new Set(rig.messages.map(([, value]) => value.state)), new Set(['disconnected', 'waiting', 'sending', 'paused']));
  for (const [, value] of rig.messages) assert.deepEqual(Object.keys(value).sort(), ['autoStart', 'label', 'message', 'state']);
  assert.equal(JSON.stringify([rig.replies, rig.messages, link.statuses]).includes(TOKEN), false);
  const broken = electronFixture(t); await broken.run();
  // Use a separate adapter object so no global fake or owner's data is touched.
  const file = path.join(broken.paths.userData, 'recorder.json');
  fs.mkdirSync(file, { recursive: true });
  assert.match(broken.invoke('recorder:connect', [JSON.stringify(VALUE)]).message, /could not be saved/);
  assert.equal(JSON.stringify([broken.replies, broken.messages]).includes(TOKEN), false);
});

for (const recorderFlag of [false, true]) test(`start with Windows preserves ${recorderFlag ? 'flag' : 'installed'} mode and stays in sync with the tray`, async (t) => {
  const args = recorderFlag ? ['--recorder'] : [];
  const rig = electronFixture(t, { packaged: true, argv: ['Understudy.exe', ...args], autoStart: true }); await rig.run();
  assert.equal(rig.invoke('recorder:state').autoStart, true);
  assert.equal(JSON.stringify(rig.loginReads), JSON.stringify([recorderFlag ? [{ args }] : []]));
  const check = (openAtLogin) => assert.equal(JSON.stringify(rig.loginCalls.at(-1)), JSON.stringify(recorderFlag ? { openAtLogin, args } : { openAtLogin }));
  for (const flag of [true, false]) {
    const reply = rig.invoke('recorder:autoStart', [flag]); assert.equal(reply.autoStart, flag); check(flag);
    const item = rig.icons[0].menu.find((item) => item.label === 'Start with Windows');
    assert.equal(item.type, 'checkbox'); assert.equal(item.checked, flag);
    item.click({ checked: !flag }); assert.equal(rig.invoke('recorder:state').autoStart, !flag); check(!flag);
  }
  rig.app.setLoginItemSettings = () => { throw new Error(TOKEN); };
  assert.match(rig.invoke('recorder:autoStart', [true]).message, /could not be changed/);
  assert.equal(JSON.stringify([rig.replies, rig.messages]).includes(TOKEN), false);
});

for (const micFrom of [undefined, 'main']) test('real bridge and sender deliver exact samples and release capture on pause, stop and close, microphone=' + (micFrom || 'default'), async (t) => {
  const s = merge(DEFAULTS, { remote: { enabled: true, host: '127.0.0.1', port: 0, listen: 'computer', ...(micFrom ? { micFrom } : {}) } });
  const { micRemote } = channelPlan(s);
  assert.equal(micRemote, micFrom !== 'main');
  const audio = [], states = [], statuses = [];
  let url;
  const bridge = createBridge({ session: { pushAudio: (...args) => audio.push(args) }, remoteConfig: { token: () => TOKEN },
    settings: { get: () => s }, micRemote, drainMs: 5,
    onCaptureStatus: (state) => statuses.push(state),
    createListener(options) {
      const listener = createListener(options);
      return { ...listener, async listen() { const address = await listener.listen(); url = `ws://127.0.0.1:${address.port}`; return address; } };
    }
  });
  t.after(() => bridge.close()); await bridge.open();
  const rig = fixture(t, { value: { url, token: TOKEN }, factory: (options) => createSender({ ...options, reconnectMs: 25,
    onState(state) { states.push(state); options.onState(state); } }) });
  await until(() => rig.recorder.state().connected); assert.equal(rig.capture.running, false);
  bridge.setWanted('recording'); await until(() => rig.capture.running);
  assert.deepEqual(rig.capture.starts.at(-1), { mic: micRemote, system: true });
  const expected = pcmBytes(4800, 15), mine = pcmBytes(4800, 37);
  rig.capture.emit('me', mine.subarray(0, 17));
  rig.capture.emit('me', mine.subarray(17));
  for (const chunk of [expected.subarray(0, 701), expected.subarray(701, 3203), expected.subarray(3203)]) rig.capture.emit('them', chunk);
  const count = micRemote ? 6 : 3;
  await until(() => audio.length === count); assertBlocks(audio.filter(([ch]) => ch === 'them'), expected);
  if (micRemote) assertBlocks(audio.filter(([ch]) => ch === 'me'), mine, 'me');
  rig.recorder.status({ channels: { them: 'on' }, hint: 'Computer audio is ready.' }); await until(() => statuses.includes('on'));
  bridge.setWanted('paused'); await until(() => !rig.capture.running);
  rig.capture.emit('them', expected); rig.capture.emit('me', mine);
  // Status travels on the same connection after any queued audio, so it is a fence.
  const off = statuses.filter((state) => state === 'off').length;
  rig.recorder.status({ channels: { them: 'on' } });
  await until(() => statuses.filter((state) => state === 'off').length > off); assert.equal(audio.length, count);
  bridge.setWanted('recording'); await until(() => rig.capture.running);
  rig.capture.emit('them', expected.subarray(0, 3200)); await until(() => audio.length === count + 1);
  bridge.setWanted('stopped'); await until(() => !rig.capture.running);
  bridge.setWanted('recording'); await until(() => rig.capture.running);
  await bridge.close(); await until(() => !rig.capture.running && states.includes('disconnected'));
  rig.capture.emit('them', expected); rig.capture.emit('me', mine); assert.equal(audio.length, count + 1); assert.equal(rig.link.stats().queued, 0);
});

test('a recorder started before a meeting connects late and records only after the bridge sends start', async (t) => {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const audio = [], senderStates = [];
  const rig = fixture(t, { value: { url: `ws://127.0.0.1:${port}`, token: TOKEN }, factory: (options) => createSender({ ...options, reconnectMs: 25,
    onState(state) { senderStates.push(state); options.onState(state); } }) });
  await until(() => senderStates.includes('disconnected')); assert.equal(rig.capture.starts.length, 0);
  const bridge = createBridge({ session: { pushAudio: (...args) => audio.push(args) }, remoteConfig: { token: () => TOKEN }, createListener,
    settings: { get: () => ({ remote: { host: '127.0.0.1', port } }) }, drainMs: 0 });
  t.after(() => bridge.close()); bridge.setWanted('recording'); await bridge.open();
  await until(() => rig.capture.running);
  rig.capture.emit('them', pcmBytes(1600, 82)); await until(() => audio.length === 1);
  assertBlocks(audio, pcmBytes(1600, 82));
  await bridge.close(); await until(() => !rig.capture.running);
  const starts = rig.capture.starts.length;
  const next = createBridge({ session: { pushAudio: (...args) => audio.push(args) }, remoteConfig: { token: () => TOKEN }, createListener,
    settings: { get: () => ({ remote: { host: '127.0.0.1', port } }) }, drainMs: 0 });
  t.after(() => next.close()); await next.open(); await until(() => rig.recorder.state().connected);
  assert.equal(rig.capture.starts.length, starts, 'Reconnecting to an idle meeting cannot resume capture');
  next.setWanted('recording'); await until(() => rig.capture.starts.length > starts);
});


test('room commands open only the microphone and re-block every sample onto them', (t) => {
  const rig = fixture(t); rig.command('start', { room: true }); assert.equal(rig.capture.starts.length, 0);
  rig.connected(); rig.command('start', { room: true, mic: false }); rig.command('resume', { room: true });
  assert.deepEqual(rig.capture.starts, [{ mic: true, system: false }]);
  const expected = pcmBytes(8000, 73), sizes = [1, 700, 3, 3201, 17, 12078];
  let pos = 0;
  for (const size of sizes) {
    rig.capture.emit('them', pcmBytes(1600));
    rig.capture.emit('me', expected.subarray(pos, pos + size)); pos += size;
  }
  assert.equal(pos, expected.length); assertBlocks(rig.link.blocks, expected);
  assert.equal(rig.recorder.state().state, 'sendingRoom');
  assert.equal(rig.trays.at(-1).text, 'Sending audio from the microphone');
  const file = path.join(rig.dir, 'recorder.log'), log = fs.readFileSync(file, 'utf8');
  assert.ok(log.includes('Sending audio from the microphone'));
  for (const label of ['Sending audio from the microphone ' + TOKEN, 'Sending room', TOKEN]) rig.store.log('2009-02-13T23:31:30.000Z ' + label);
  assert.equal(fs.readFileSync(file, 'utf8'), log);
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

for (const end of ['pause', 'stop', 'disconnected', 'mode change', 'error']) test('room capture releases devices and partial bytes on ' + end, (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start', { room: true });
  rig.capture.emit('me', pcmBytes(1600).subarray(0, 3199));
  if (end === 'disconnected') rig.link.options.onState(end);
  else if (end === 'mode change') rig.command('start', { mic: true });
  else if (end === 'error') rig.recorder.status({ channels: { me: 'error' }, hint: TOKEN });
  else rig.command(end);
  assert.equal(rig.capture.stops, 1); assert.equal(rig.capture.running, end === 'mode change');
  if (end === 'mode change') {
    for (const channel of ['me', 'them']) rig.capture.emit(channel, pcmBytes(1600).subarray(0, 3199));
  } else {
    rig.capture.emit('me', pcmBytes(3200)); assert.equal(rig.link.blocks.length, 0);
    if (end === 'disconnected') rig.connected();
  }
  rig.command('resume', { room: true, mic: true });
  assert.deepEqual(rig.capture.starts.at(-1), { mic: true, system: false });
  const expected = pcmBytes(3200, 31);
  rig.capture.emit('me', expected.subarray(0, 1)); rig.capture.emit('me', expected.subarray(1));
  assertBlocks(rig.link.blocks, expected);
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

test('room status follows only the microphone with hints and a closed state vocabulary', (t) => {
  const rig = fixture(t); rig.connected(); rig.command('start', { room: true });
  for (const state of ['off', 'starting', 'on', 'lost']) {
    rig.recorder.status({ channels: { me: state, them: 'error' }, hint: 'Microphone ' + state });
    assert.deepEqual(rig.link.statuses.at(-1), { state, hint: 'Microphone ' + state }); assert.equal(rig.capture.running, true);
  }
  const count = rig.link.statuses.length;
  for (const state of ['unknown', '', null, {}, 'toString']) rig.recorder.status({ channels: { me: state } });
  rig.recorder.status({ channels: { them: 'on' } }); assert.equal(rig.link.statuses.length, count);
  rig.recorder.status({ channels: { me: 'error' }, message: 'Device ' + TOKEN });
  assert.equal(rig.capture.running, false); assert.deepEqual(rig.link.statuses.at(-1), { state: 'error', hint: 'Device [removed]' });
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

test('only an exact room or mic permission can open the microphone', (t) => {
  const rig = fixture(t); rig.connected();
  for (const room of [undefined, false, 'true', 1, null, {}, [], true]) {
    rig.command('start', { room });
    assert.deepEqual(rig.capture.starts.at(-1), { mic: room === true, system: room !== true }); rig.command('stop');
  }
});

test('room mode changes during a send discard the rest of the old chunk and stale opens cannot halt the new mode', async (t) => {
  const pending = [], rig = fixture(t, { start: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  rig.connected(); rig.command('start', { room: true });
  const push = rig.link.push.bind(rig.link);
  rig.link.push = (channel, pcm) => { const sent = push(channel, pcm); rig.command('start'); return sent; };
  rig.capture.emit('me', pcmBytes(4800)); assert.equal(rig.link.blocks.length, 1); assert.equal(rig.capture.stops, 1);
  pending[0].reject(new Error(TOKEN)); await tick(); assert.equal(rig.capture.running, true);
  assert.deepEqual(rig.capture.starts.at(-1), { mic: false, system: true });
  pending[1].resolve(false); await tick(); assert.equal(rig.capture.running, false);
  assert.equal(JSON.stringify([rig.trays, rig.logs, rig.link.statuses]).includes(TOKEN), false);
});

test('Electron room capture disables system audio and exposes the room tray and setup label', async (t) => {
  const rig = electronFixture(t); await rig.run(); rig.invoke('recorder:connect', [JSON.stringify(VALUE)]);
  const link = rig.senders[0]; link.options.onState('connected'); link.options.onCommand('start', { room: true });
  const win = rig.captureWindows[0]; win.loaded(); await tick();
  assert.equal(win.script, 'window.startCapture({ mic: true, system: false })');
  rig.ipcMain.emit('audio', { sender: win.webContents }, 'them', pcmBytes(1600)); assert.equal(link.blocks.length, 0);
  rig.ipcMain.emit('audio', { sender: win.webContents }, 'me', pcmBytes(1600)); assert.equal(link.blocks[0][0], 'them');
  assert.ok(rig.icons[0].tooltip.startsWith('Sending audio from the microphone'));
  assert.equal(rig.invoke('recorder:state').label, 'Sending audio from the microphone');
  win.webContents.emit('render-process-gone'); assert.equal(win.dead, true);
  assert.equal(link.statuses.at(-1).state, 'error');
  assert.equal(JSON.stringify([rig.replies, rig.messages, link.statuses]).includes(TOKEN), false);
  assert.match(read('src/renderer/recorder-setup.css'), /\[data-state="sendingRoom"\] \.dot/);
});

for (const late of [false, true]) test('real room listener, bridge and sender deliver microphone samples and pause capture, late=' + late, async (t) => {
  const s = merge(DEFAULTS, { remote: { enabled: true, host: '127.0.0.1', port: 0 }, audio: { captureMic: false, captureSystem: false } });
  const { roomRemote, micRemote } = channelPlan(s), audio = [], statuses = [];
  assert.equal(roomRemote, true); assert.equal(micRemote, false);
  let url;
  const bridge = createBridge({ session: { pushAudio: (...args) => audio.push(args) }, remoteConfig: { token: () => TOKEN },
    settings: { get: () => s }, roomRemote, micRemote, drainMs: 5, onCaptureStatus: (state) => statuses.push(state),
    createListener(options) { const listener = createListener(options); return { ...listener, async listen() {
      const address = await listener.listen(); url = 'ws://127.0.0.1:' + address.port; return address;
    } }; }
  });
  t.after(() => bridge.close()); await bridge.open(); if (late) bridge.setWanted('recording');
  const rig = fixture(t, { value: { url, token: TOKEN }, factory: (options) => createSender({ ...options, reconnectMs: 25 }) });
  await until(() => rig.recorder.state().connected);
  if (!late) { assert.equal(rig.capture.running, false); bridge.setWanted('recording'); }
  await until(() => rig.capture.running); assert.deepEqual(rig.capture.starts.at(-1), { mic: true, system: false });
  const expected = pcmBytes(4800, 15);
  rig.capture.emit('them', expected); rig.capture.emit('me', expected.subarray(0, 701)); rig.capture.emit('me', expected.subarray(701));
  await until(() => audio.length === 3); assertBlocks(audio, expected);
  bridge.setWanted('paused'); await until(() => !rig.capture.running);
  rig.capture.emit('me', expected); rig.capture.emit('them', expected);
  const off = statuses.filter((state) => state === 'off').length;
  rig.recorder.status({ channels: { me: 'on' } }); await until(() => statuses.filter((state) => state === 'off').length > off);
  assert.equal(audio.length, 3);
  bridge.setWanted('recording'); await until(() => rig.capture.running);
  assert.deepEqual(rig.capture.starts.at(-1), { mic: true, system: false });
  await bridge.close(); await until(() => !rig.capture.running); assert.equal(rig.link.stats().queued, 0);
});
