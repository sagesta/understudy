'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createListener, createSender } = require('../src/main/remote-link');
const { createBridge } = require('../src/main/remote-bridge');
const { channelPlan } = require('../src/main/channel-plan');
const { DEFAULTS } = require('../src/main/settings');

const TOKEN = 'bridge-local-test-token';
const CONNECTED = 'The recorder on the other PC is connected.';
const MISSING = 'The recorder on the other PC is not connected. Its audio is missing until it is back.';
const LOST = 'Some audio from the other PC was lost.';
async function until(fn, message = 'Condition was not met') {
  const end = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < end, message); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
const samples = (seed = 0) => Int16Array.from({ length: 1600 }, (_, i) => ((i * 101 + seed) & 0xffff) - 32768);

function fixture(t, { port = 0, now, drainMs = 5, micRemote = false, roomRemote = false } = {}) {
  const audio = [], hints = [], statuses = [], states = [];
  const session = new EventEmitter();
  session.pushAudio = (...args) => audio.push(args);
  const rig = { audio, hints, statuses, states };
  rig.bridge = createBridge({ session, micRemote, roomRemote, remoteConfig: { token: () => TOKEN },
    settings: { get: () => ({ remote: { enabled: true, host: '127.0.0.1', port } }) }, now, ...(drainMs === null ? {} : { drainMs }),
    createListener(options) {
      rig.callbacks = options;
      const listener = rig.listener = createListener(options);
      return { ...listener, async listen() {
        const address = await listener.listen();
        rig.port = address.port; rig.url = `ws://127.0.0.1:${address.port}`;
        return address;
      } };
    },
    onHint: (hint) => hints.push(hint), onCaptureStatus: (state) => statuses.push(state), onState: (state) => states.push(state)
  });
  t.after(() => rig.bridge.close());
  return rig;
}
function recorder(t, url, options = {}) {
  const commands = [], states = [], infos = [];
  const sender = createSender({ url, token: TOKEN, reconnectMs: 50, ...options,
    onCommand: (name, info) => { commands.push(name); infos.push(info); }, onState: (state) => states.push(state) });
  t.after(() => sender.stop());
  return { sender, commands, states, infos };
}
async function connected(rig, peer) {
  peer.sender.start();
  await until(() => rig.bridge.state().connected && peer.states.at(-1) === 'connected');
}
async function fence(rig, peer) {
  const before = rig.statuses.length;
  assert.equal(peer.sender.sendStatus({ state: 'on' }), true);
  await until(() => rig.statuses.length > before);
}

test('the bridge delivers exact recorder samples for them and ignores its me frames', async (t) => {
  const rig = fixture(t); await rig.bridge.open();
  rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer);
  const pcm = samples(73);
  peer.sender.push('me', samples(5)); peer.sender.push('them', pcm);
  await fence(rig, peer);
  assert.equal(rig.audio.length, 1);
  assert.equal(rig.audio[0][0], 'them'); assert.deepEqual(rig.audio[0][1], pcm);
  assert.deepEqual(rig.states, ['waiting', 'connected']);
});

for (const micRemote of [false, true]) test('bridge microphone authorisation and reconnect: ' + micRemote, async (t) => {
  const rig = fixture(t, { micRemote }); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer); await until(() => peer.commands.length === 1);
  peer.sender.push('me', samples(21)); peer.sender.push('them', samples(22)); await fence(rig, peer);
  assert.deepEqual(rig.audio, micRemote ? [['me', samples(21)], ['them', samples(22)]] : [['them', samples(22)]]);
  rig.bridge.setWanted('paused'); await until(() => peer.commands.length === 2);
  rig.bridge.setWanted('recording'); await until(() => peer.commands.length === 3);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  await connected(rig, peer); await until(() => peer.commands.length === 4);
  assert.deepEqual(peer.commands, ['start', 'pause', 'resume', 'start']);
  assert.deepEqual(peer.infos, [{ mic: micRemote, room: false }, { mic: false, room: false }, { mic: micRemote, room: false }, { mic: micRemote, room: false }]);
  await rig.bridge.close(); const before = rig.audio.length;
  rig.callbacks.onAudio('me', samples()); assert.equal(rig.audio.length, before);
});

test('a recorder with a wrong token delivers no audio, status or commands', async (t) => {
  const rig = fixture(t); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url, { token: 'wrong-test-token' });
  peer.sender.push('them', samples()); peer.sender.start();
  await until(() => rig.listener.stats().badHellos === 1);
  peer.sender.stop();
  assert.deepEqual(rig.audio, []); assert.deepEqual(rig.statuses, []); assert.deepEqual(peer.commands, []);
  assert.equal(rig.bridge.state().connected, false);
});

test('a late recorder starts, pauses, resumes and reconnects paused without starting', async (t) => {
  const rig = fixture(t); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer);
  await until(() => peer.commands.length === 1); assert.deepEqual(peer.commands, ['start']);
  rig.bridge.setWanted('paused'); await until(() => peer.commands.length === 2);
  rig.bridge.setWanted('recording'); await until(() => peer.commands.length === 3);
  assert.deepEqual(peer.commands, ['start', 'pause', 'resume']);
  rig.bridge.setWanted('paused'); await until(() => peer.commands.length === 4);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  await connected(rig, peer); await until(() => peer.commands.length === 5);
  assert.deepEqual(peer.commands, ['start', 'pause', 'resume', 'pause', 'pause']);
  assert.deepEqual(rig.bridge.state(), { wanted: 'paused', connected: true });
});

test('recording again after stop sends start, and reconnecting after stop sends no command', async (t) => {
  const rig = fixture(t); await rig.bridge.open();
  const peer = recorder(t, rig.url); await connected(rig, peer); await fence(rig, peer);
  assert.deepEqual(peer.commands, []);
  rig.bridge.setWanted('recording'); await until(() => peer.commands.length === 1);
  rig.bridge.setWanted('stopped'); await until(() => peer.commands.length === 2);
  assert.deepEqual(peer.commands, ['start', 'stop']);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  const before = rig.hints.length;
  await connected(rig, peer); await fence(rig, peer);
  assert.deepEqual(peer.commands, ['start', 'stop']);
  assert.equal(rig.hints.length, before, 'the same connected hint is not repeated');
  assert.ok(!rig.hints.includes(MISSING));
  rig.bridge.setWanted('recording'); await until(() => peer.commands.length === 3);
  assert.deepEqual(peer.commands, ['start', 'stop', 'start']);
});

test('close with the default drain delivers stop before resolving, frees the port and is safe twice', async (t) => {
  const rig = fixture(t, { drainMs: null }); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer);
  await until(() => peer.commands.includes('start'));
  const first = rig.bridge.close(); assert.equal(rig.bridge.close(), first); await first;
  assert.ok(peer.commands.includes('stop'), 'stop reached the recorder before close resolved');
  peer.sender.stop();
  assert.deepEqual(peer.commands, ['start', 'stop']);
  assert.ok(!rig.hints.includes(MISSING), 'closing does not warn about missing audio');
  rig.bridge.setWanted('recording'); await rig.bridge.close();
  assert.deepEqual(rig.bridge.state(), { wanted: 'stopped', connected: false });
  const next = createListener({ token: TOKEN, host: '127.0.0.1', port: rig.port });
  t.after(() => next.close()); await next.listen();
});

test('close drains only a stop accepted by a connected recorder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const state of ['connected', 'waiting']) for (const accepted of [true, false]) {
    const calls = [];
    const bridge = createBridge({ session: new EventEmitter(), remoteConfig: { token: () => TOKEN },
      settings: { get: () => ({ remote: { host: '127.0.0.1', port: 0 } }) }, drainMs: 10,
      createListener(options) {
        return { async listen() { options.onState(state); },
          command(name) { calls.push(name); return accepted; }, async close() { calls.push('close'); } };
      } });
    await bridge.open();
    const closing = bridge.close(); assert.equal(bridge.close(), closing);
    await Promise.resolve();
    if (state === 'connected' && accepted) {
      assert.deepEqual(calls, ['stop']);
      t.mock.timers.tick(9); await Promise.resolve();
      assert.deepEqual(calls, ['stop']);
      t.mock.timers.tick(1);
    }
    await closing;
    assert.deepEqual(calls, state === 'connected' ? ['stop', 'close'] : ['close']);
  }
});

test('an explicit stop followed by close does not send a second stop', async (t) => {
  const rig = fixture(t); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer);
  await until(() => peer.commands.length === 1);
  rig.bridge.setWanted('stopped'); await until(() => peer.commands.length === 2);
  await rig.bridge.close(); peer.sender.stop();
  assert.deepEqual(peer.commands, ['start', 'stop']);
});

test('close while binding waits for the port to be released', async (t) => {
  const rig = fixture(t), opening = rig.bridge.open();
  await rig.bridge.close(); await opening;
  const next = createListener({ token: TOKEN, host: '127.0.0.1', port: rig.port });
  t.after(() => next.close()); await next.listen();
});

test('an occupied port rejects with the plain bind message and leaves no listener', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (occupied.listening) return new Promise((resolve) => occupied.close(resolve)); });
  const port = occupied.address().port, rig = fixture(t, { port });
  await assert.rejects(rig.bridge.open(), (err) => err.message === `Could not listen on 127.0.0.1:${port}. Check the Tailscale address in Settings, or whether another program uses that port.` && !err.cause);
  await rig.bridge.close(); await rig.bridge.close();
  await new Promise((resolve) => occupied.close(resolve));
  const next = createListener({ token: TOKEN, host: '127.0.0.1', port });
  t.after(() => next.close()); await next.listen();
});

test('listener creation errors also become the plain bind message', async () => {
  const config = { enabled: true, host: '127.0.0.1', port: 0 };
  const bridge = createBridge({ session: new EventEmitter(), remoteConfig: { token: () => TOKEN },
    settings: { get: () => ({ remote: config }) }, createListener() { throw new Error('Private transport detail'); } });
  await assert.rejects(bridge.open(), { message: 'Could not listen on 127.0.0.1:0. Check the Tailscale address in Settings, or whether another program uses that port.' });
  await bridge.close();
});

test('connect and disconnect hints are deduplicated and stop suppresses missing audio hints', async (t) => {
  const rig = fixture(t); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer);
  rig.callbacks.onState('connected');
  assert.deepEqual(rig.hints, [CONNECTED]);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  rig.callbacks.onState('disconnected');
  assert.deepEqual(rig.hints, [CONNECTED, MISSING]);
  rig.bridge.setWanted('stopped'); rig.callbacks.onState('disconnected');
  assert.deepEqual(rig.hints, [CONNECTED, MISSING]);
});

test('counter holes report lost audio at most once every twenty seconds', async (t) => {
  let time = 0;
  const rig = fixture(t, { now: () => time }); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url, { keepBlocks: 1 }); await connected(rig, peer);
  peer.sender.push('them', samples()); await until(() => rig.audio.length === 1);
  async function hole() {
    peer.sender.stop(); await until(() => !rig.bridge.state().connected);
    peer.sender.push('them', samples(1)); peer.sender.push('them', samples(2));
    const before = rig.audio.length;
    await connected(rig, peer); await until(() => rig.audio.length === before + 1);
  }
  await hole(); await hole();
  assert.equal(rig.listener.stats().lost, 2);
  assert.equal(rig.hints.filter((hint) => hint === LOST).length, 1);
  time = 20000; await hole();
  assert.equal(rig.hints.filter((hint) => hint === LOST).length, 2);
});

test('status states pass through, hints are deduplicated and credentials never reach hints', async (t) => {
  const rig = fixture(t); await rig.bridge.open();
  const peer = recorder(t, rig.url); await connected(rig, peer);
  for (const state of ['off', 'starting', 'on', 'lost', 'error', 'unknown']) peer.sender.sendStatus({ state, hint: 'Recorder status.' });
  peer.sender.sendStatus({ state: 'on', hint: `Private: ${TOKEN}` });
  await until(() => rig.statuses.length === 7);
  assert.deepEqual(rig.statuses, ['off', 'starting', 'on', 'lost', 'error', 'unknown', 'on']);
  assert.equal(rig.hints.filter((hint) => hint === 'Recorder status.').length, 1);
  assert.ok(rig.hints.every((hint) => !hint.includes(TOKEN)));
  await rig.bridge.close();
  const before = [rig.audio.length, rig.hints.length, rig.statuses.length];
  rig.callbacks.onAudio('them', samples()); rig.callbacks.onGap('them', 1);
  rig.callbacks.onStatus({ state: 'on', hint: 'Too late.' }); rig.callbacks.onState('connected');
  assert.deepEqual([rig.audio.length, rig.hints.length, rig.statuses.length], before);
});

// Execute only the glue, as in notes-wiring.test.js. Requiring main.js would start Electron.
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
function between(a, b) {
  const i = source.indexOf(a), j = source.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, `${a} .. ${b} found in main.js`);
  return source.slice(i, j);
}
const flow = between('async function _startMeeting', '// Notes are written after');
const quit = between('async function quitApp()', '// ---------------------------------------------------------------- shortcuts');
const audioIpc = between("  ipcMain.on('audio'", "  // Queue only the start of a test");

function wiring({ remote = true, mic = true, system = true, micFrom = DEFAULTS.remote.micFrom, listen = 'computer', fail = '', bridgeFactory } = {}) {
  const events = [], broadcasts = [], handlers = {};
  const s = { audio: { captureMic: mic, captureSystem: system }, remote: { enabled: remote, host: '127.0.0.1', port: 0, listen, micFrom }, stt: {} };
  const meeting = new EventEmitter();
  Object.assign(meeting, { active: false, paused: false,
    snapshot: () => ({ active: meeting.active, paused: meeting.paused }),
    start(plan) { events.push(['meeting.start', plan]); if (fail === 'meeting') throw new Error('Meeting refused.'); meeting.active = true; },
    async pause() { events.push(['meeting.pause']); meeting.paused = true; },
    resume() { events.push(['meeting.resume']); meeting.paused = false; },
    async stop() { events.push(['meeting.stop']); meeting.active = false; if (fail === 'stop') throw new Error('Save refused.'); return { meta: { id: 'test' }, turns: 0, cost: {} }; },
    pushAudio: (...args) => events.push(['audio', ...args])
  });
  const win = { once() {}, showInactive() {}, hide() {}, isDestroyed: () => false, isMinimized: () => false, webContents: { isLoading: () => false } };
  const rig = { events, broadcasts, meeting, s, handlers };
  const deps = { connectionTest: { async cancel() {} }, channelPlan, meeting, settings: { get: () => s, getSecret() {} }, remoteConfig: {}, createListener,
    createBridge(options) {
      rig.options = options;
      if (bridgeFactory) return bridgeFactory(options);
      return { async open() { events.push(['bridge.open']); if (fail === 'bind') throw new Error('Bind refused.'); rig.open = true; },
        setWanted: (state) => events.push(['bridge.setWanted', state]), async close() { events.push(['bridge.close']); rig.open = false; } };
    },
    speedRun: { abort: () => events.push(['speed.abort']) },
    createStream() { events.push(['key.check']); if (fail === 'key') throw new Error('Key refused.'); return { removeAllListeners() {} }; },
    createOverlay() { if (fail === 'overlay') throw new Error('Overlay refused.'); return win; },
    async startCapture(channels) { events.push(['capture.start', [...channels]]); if (fail === 'capture') throw new Error('Capture refused.'); },
    stopCapture: () => events.push(['capture.stop']), registerShortcuts() {}, refreshTray() {}, liveEnded() {}, writeNotes() {},
    broadcast: (value) => broadcasts.push(structuredClone(value)),
    overlayWin: win, appWin: win, createAppWindow() {}, captureWin: win,
    app: { quit: () => events.push(['app.quit']) }, ipcMain: { on: (name, fn) => { handlers[name] = fn; } }
  };
  const make = new Function(...Object.keys(deps), `let bridge = null, captureChannels = [], capturePlan = null, audioMap = { me: 'me', them: 'them' }, captureStatus = { me: 'off', them: 'off' }, quitting = false;
    const serial = (fn) => Promise.resolve().then(fn);
    ${flow}\n${quit}\n${audioIpc}
    return { start: _startMeeting, pause: _pauseMeeting, resume: _resumeMeeting, stop: _stopMeeting, quit: quitApp,
      state: () => ({ bridge: Boolean(bridge), captureChannels, audioMap, captureStatus }) };`);
  rig.api = make(...Object.values(deps));
  rig.audio = (channel, pcm) => handlers.audio({ sender: win.webContents }, channel, pcm);
  rig.status = (status) => handlers['capture:status']({ sender: win.webContents }, status);
  return rig;
}

test('main wires channel planning, bridge opening and wanted commands into every transition', () => {
  assert.match(flow, /channelPlan\(/);
  const start = flow.slice(0, flow.indexOf('async function _pauseMeeting'));
  assert.match(start, /await bridge\.open\(/); assert.match(start, /bridge\.setWanted\('recording'\)/);
  assert.match(flow, /async function _pauseMeeting[^\n]*bridge\.setWanted\('paused'\)/);
  assert.match(flow, /async function _resumeMeeting[^\n]*bridge\.setWanted\('recording'\)/);
  assert.match(flow.slice(flow.indexOf('async function _stopMeeting')), /bridge\.setWanted\('stopped'\)/);
  assert.match(audioIpc, /if \(bridge && channel === 'them'\) return/);
  assert.match(quit, /await bridge\.close\(/);
  assert.match(source, /createRemoteConfig\(\{ settings, clipboard \}\)/);
});

test('main binds before starting the meeting and resumes the same local microphone plan', async () => {
  const rig = wiring({ micFrom: 'main' }); await rig.api.start({ title: 'Remote' });
  assert.deepEqual(rig.events.slice(0, 4).map((event) => event[0]), ['speed.abort', 'key.check', 'bridge.open', 'meeting.start']);
  assert.deepEqual(rig.events.find((e) => e[0] === 'meeting.start')[1], { title: 'Remote', channels: ['me', 'them'], room: false });
  assert.deepEqual(rig.events.find((e) => e[0] === 'capture.start')[1], ['me']);
  rig.s.audio.captureSystem = false; rig.s.remote.enabled = false;
  await rig.api.pause(); await rig.api.resume(); await rig.api.stop();
  assert.deepEqual(rig.events.filter((e) => e[0] === 'bridge.setWanted').map((e) => e[1]), ['recording', 'paused', 'recording', 'stopped']);
  assert.deepEqual(rig.events.filter((e) => e[0] === 'capture.start').map((e) => e[1]), [['me'], ['me']]);
  assert.equal(rig.open, false); assert.equal(rig.api.state().bridge, false);
});

test('a remote meeting with no local microphone skips capture on start and resume', async () => {
  const rig = wiring({ mic: false, system: false });
  await rig.api.start(); await rig.api.pause(); await rig.api.resume(); await rig.api.stop();
  assert.deepEqual(rig.events.filter((e) => e[0] === 'capture.start'), []);
  assert.deepEqual(rig.events.find((e) => e[0] === 'meeting.start')[1].channels, ['them']);
});

for (const mic of [false, true]) test('main uses no local devices with the default recorder microphone: ' + mic, async () => {
  const rig = wiring({ mic }); await rig.api.start();
  assert.equal(rig.options.micRemote, mic);
  assert.deepEqual(rig.api.state().captureChannels, []);
  assert.deepEqual(rig.events.find((e) => e[0] === 'meeting.start')[1].channels, mic ? ['me', 'them'] : ['them']);
  // A settings edit during the meeting must not switch the source of the owner's voice.
  rig.s.remote.micFrom = 'main';
  if (mic) { rig.audio('me', new Uint8Array([1, 0])); assert.ok(!rig.events.some((e) => e[0] === 'audio')); }
  await rig.api.pause(); await rig.api.resume(); await rig.api.stop();
  assert.ok(!rig.events.some((e) => e[0] === 'capture.start'));
  rig.s.remote.enabled = false; rig.s.audio.captureMic = true;
  await rig.api.start(); rig.audio('me', new Uint8Array([2, 0]));
  assert.equal(rig.events.at(-1)[0], 'audio'); await rig.api.stop();
});

test('non-remote starts retain all four input combinations, room mapping and the error text', async () => {
  for (const mic of [true, false]) for (const system of [true, false]) {
    const rig = wiring({ remote: false, mic, system });
    if (!mic && !system) {
      await assert.rejects(rig.api.start(), { message: 'Both the microphone and the computer audio are switched off in Settings. Turn at least one on.' });
    } else {
      await rig.api.start();
      const room = mic && !system;
      assert.deepEqual(rig.events.find((e) => e[0] === 'meeting.start')[1], { title: undefined,
        channels: room ? ['them'] : [...(mic ? ['me'] : []), ...(system ? ['them'] : [])], room });
      assert.deepEqual(rig.api.state().captureChannels, [...(mic ? ['me'] : []), ...(system ? ['them'] : [])]);
      rig.audio('me', new Uint8Array([1, 0]));
      assert.equal(rig.events.at(-1)[1], room ? 'them' : 'me');
      await rig.api.stop();
    }
    assert.ok(!rig.events.some((e) => e[0].startsWith('bridge.')));
  }
});

for (const fail of ['bind', 'meeting', 'overlay', 'capture']) {
  test(`main releases the bridge after a ${fail} start failure`, async () => {
    const rig = wiring({ fail, micFrom: 'main' }); await assert.rejects(rig.api.start());
    assert.equal(Boolean(rig.open), false); assert.equal(rig.api.state().bridge, false); assert.equal(rig.meeting.active, false);
    assert.equal(rig.events.filter((e) => e[0] === 'bridge.close').length, fail === 'bind' ? 0 : 1);
    const started = fail === 'overlay' || fail === 'capture';
    assert.equal(rig.events.filter((e) => e[0] === 'meeting.stop').length, started ? 1 : 0);
    assert.equal(rig.events.filter((e) => e[0] === 'capture.stop').length, started ? 1 : 0);
    if (fail === 'bind') assert.ok(!rig.events.some((e) => e[0] === 'meeting.start'));
  });
}

function realWiring(t, options) {
  const rig = wiring({ ...options, bridgeFactory(config) {
    const bridge = rig.bridge = createBridge({ ...config, remoteConfig: { token: () => TOKEN }, drainMs: 0,
      createListener(options) {
        const listener = rig.listener = createListener(options);
        return { ...listener, async listen() {
          const address = await listener.listen(); rig.port = address.port; return address;
        } };
      } });
    t.after(() => bridge.close());
    return bridge;
  } });
  return rig;
}

test('a non-remote meeting refusing to start never stops the previous meeting or capture', async () => {
  const rig = wiring({ remote: false, fail: 'meeting' });
  await assert.rejects(rig.api.start(), { message: 'Meeting refused.' });
  assert.deepEqual(rig.events.map((e) => e[0]), ['speed.abort', 'key.check', 'meeting.start']);
  assert.equal(rig.api.state().bridge, false);
});

test('main preserves the plain bind error without starting or stopping a meeting and leaves no listener', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (occupied.listening) return new Promise((resolve) => occupied.close(resolve)); });
  const port = occupied.address().port, rig = realWiring(t);
  rig.s.remote.port = port;
  await assert.rejects(rig.api.start(), (err) => err.message ===
    'Could not listen on 127.0.0.1:' + port + '. Check the Tailscale address in Settings, or whether another program uses that port.' && !err.cause);
  assert.deepEqual(rig.events.map((e) => e[0]), ['speed.abort', 'key.check']);
  assert.equal(rig.api.state().bridge, false);
  await new Promise((resolve) => occupied.close(resolve));
  const next = createListener({ token: TOKEN, host: '127.0.0.1', port });
  t.after(() => next.close()); await next.listen();
});

test('main closes a real bridge when meeting.start throws without stopping the previous meeting or capture', async (t) => {
  const rig = realWiring(t, { fail: 'meeting' });
  await assert.rejects(rig.api.start(), { message: 'Meeting refused.' });
  assert.deepEqual(rig.events.map((e) => e[0]), ['speed.abort', 'key.check', 'meeting.start']);
  assert.equal(rig.api.state().bridge, false);
  assert.deepEqual(rig.bridge.state(), { wanted: 'stopped', connected: false });
  assert.ok(rig.port > 0);
  const next = createListener({ token: TOKEN, host: '127.0.0.1', port: rig.port });
  t.after(() => next.close()); await next.listen();
});

test('a missing speech key fails before any listener or meeting starts', async () => {
  const rig = wiring({ fail: 'key' }); await assert.rejects(rig.api.start(), { message: 'Key refused.' });
  assert.deepEqual(rig.events.map((e) => e[0]), ['speed.abort', 'key.check']);
});

test('main accepts only known recorder capture states and protects them from local reports', async () => {
  const rig = wiring({ micFrom: 'main' }); await rig.api.start();
  rig.options.onHint('Recorder hint.');
  assert.deepEqual(rig.broadcasts.at(-1), { type: 'hint', message: 'Recorder hint.' });
  for (const state of ['off', 'starting', 'on', 'lost', 'error']) {
    rig.options.onCaptureStatus(state);
    assert.deepEqual(rig.broadcasts.at(-1), { type: 'capture', status: { me: 'off', them: state }, message: '' });
  }
  const before = rig.broadcasts.length;
  for (const state of ['connected', 'recording', 'paused', '', null, {}, 'toString']) rig.options.onCaptureStatus(state);
  assert.equal(rig.broadcasts.length, before);
  rig.options.onCaptureStatus('on'); rig.status({ channels: { me: 'starting', them: 'off' } });
  assert.deepEqual(rig.api.state().captureStatus, { me: 'starting', them: 'on' });
  rig.audio('them', new Uint8Array([1, 0])); rig.audio('me', new Uint8Array([2, 0]));
  const audio = rig.events.filter((e) => e[0] === 'audio');
  assert.equal(audio.length, 1); assert.equal(audio[0][1], 'me'); assert.deepEqual(audio[0][2], Int16Array.of(2));
  await rig.api.stop();
});

test('quit stops and closes the recorder before saving, even if saving fails', async () => {
  for (const fail of ['', 'stop']) {
    const rig = wiring({ fail }); await rig.api.start();
    const before = rig.events.length; await rig.api.quit();
    assert.deepEqual(rig.events.slice(before).map((e) => e[0]), ['capture.stop', 'bridge.setWanted', 'bridge.close', 'meeting.stop', 'app.quit']);
    assert.equal(rig.open, false); assert.equal(rig.api.state().bridge, false);
  }
});


for (const micRemote of [false, true]) test('room bridge authorises only room audio through start, resume and both reconnect states: ' + micRemote, async (t) => {
  const rig = fixture(t, { roomRemote: true, micRemote }); await rig.bridge.open(); rig.bridge.setWanted('recording');
  const peer = recorder(t, rig.url); await connected(rig, peer); await until(() => peer.commands.length === 1);
  peer.sender.push('me', samples(1)); peer.sender.push('them', samples(2)); await fence(rig, peer);
  assert.deepEqual(rig.audio, [['them', samples(2)]]);
  rig.bridge.setWanted('paused'); await until(() => peer.commands.length === 2);
  rig.bridge.setWanted('recording'); await until(() => peer.commands.length === 3);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  await connected(rig, peer); await until(() => peer.commands.length === 4);
  rig.bridge.setWanted('paused'); await until(() => peer.commands.length === 5);
  peer.sender.stop(); await until(() => !rig.bridge.state().connected);
  await connected(rig, peer); await until(() => peer.commands.length === 6);
  assert.deepEqual(peer.commands, ['start', 'pause', 'resume', 'start', 'pause', 'pause']);
  assert.deepEqual(peer.infos, [true, false, true, true, false, false].map((room) => ({ mic: false, room })));
});

test('main starts a remote room, ignores all local audio and status, and keeps the plan for resume', async () => {
  for (const mic of [false, true]) for (const system of [false, true]) for (const micFrom of ['main', 'recorder']) {
    const rig = wiring({ listen: 'room', mic, system, micFrom }); await rig.api.start({ title: 'Room' });
    assert.equal(rig.options.roomRemote, true); assert.equal(rig.options.micRemote, false);
    assert.deepEqual(rig.events.find((e) => e[0] === 'meeting.start')[1], { title: 'Room', room: true, channels: ['them'] });
    rig.s.remote.listen = 'computer'; rig.s.audio.captureMic = true;
    rig.audio('me', new Uint8Array([1, 0])); rig.audio('them', new Uint8Array([2, 0]));
    const count = rig.broadcasts.length;
    rig.status({ channels: { me: 'on', them: 'on' }, hint: 'Old local device.' });
    assert.equal(rig.broadcasts.length, count);
    assert.ok(!rig.events.some((e) => e[0] === 'audio'));
    await rig.api.pause(); await rig.api.resume(); await rig.api.stop();
    assert.ok(!rig.events.some((e) => e[0] === 'capture.start'));
  }
});
