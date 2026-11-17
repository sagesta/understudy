'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createConnectionTest } = require('../src/main/remote-test');
const { createListener, createSender } = require('../src/main/remote-link');

const TOKEN = 'connection-test-only';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 4000;
  while (!fn()) { assert.ok(Date.now() < end, 'Connection test did not finish'); await sleep(5); }
}
async function bind(t, port = 0) {
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
async function freePort(t) {
  const server = await bind(t), port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function fixture(t, options = {}) {
  const state = { host: '127.0.0.1', port: 0, meeting: false, opened: 0, closed: 0, listeners: [] };
  const connection = createConnectionTest({ timeoutMs: 150, afterMs: 80,
    remoteConfig: { token: () => TOKEN }, settings: { get: () => ({ remote: state }) },
    isMeetingRunning: () => state.meeting,
    createListener(args) {
      // Only the authentication state callback is allowed into a connection test.
      assert.deepEqual(Object.keys(args).sort(), ['host', 'onState', 'port', 'token']);
      assert.equal(args.token === TOKEN, true);
      const listener = createListener(args); state.listeners.push(listener);
      return { async listen() { const address = await listener.listen(); state.port = address.port; state.opened++; return address; },
        async close() { await listener.close(); state.closed++; } };
    }, ...options });
  t.after(() => connection.cancel());
  return { connection, state };
}
function sender(t, state, options = {}) {
  const link = createSender({ url: `ws://127.0.0.1:${state.port}`, token: TOKEN, reconnectMs: 1000, ...options });
  t.after(() => link.stop()); link.start(); return link;
}
function clean(value) {
  assert.equal(value.message.includes(TOKEN), false, 'A result must never contain the credential');
  return value;
}
async function reusable(t, state) { const probe = await bind(t, state.port); await new Promise((resolve) => probe.close(resolve)); }

test('reached: a real recorder authenticates, sees the grace period, gets no command, and the port is released', async (t) => {
  const { connection, state } = fixture(t, { timeoutMs: 2000, afterMs: 120 });
  for (let i = 0; i < 2; i++) {
    const pending = connection.run(); await until(() => state.opened === i + 1);
    const commands = [], states = [];
    const link = sender(t, state, { pc: TOKEN, onCommand: (name) => commands.push(name), onState: (s) => states.push(s) });
    assert.deepEqual(clean(await pending), { result: 'reached', message: 'The recorder reached this PC.' });
    assert.equal(connection.active(), true, 'Result arrives while the recorder can still show Connected, waiting');
    await until(() => states.includes('connected'));
    link.sendStatus({ state: TOKEN, hint: TOKEN });
    link.push('them', new Int16Array(1600));
    await sleep(30); assert.equal(state.closed, i);
    await until(() => !connection.active()); link.stop();
    assert.deepEqual(commands, []); assert.equal(state.closed, i + 1);
    await reusable(t, state);
  }
});

test('wrong token never reaches; timeout uses the injected duration and can run again', async (t) => {
  const { connection, state } = fixture(t);
  for (let i = 0; i < 2; i++) {
    const pending = connection.run(); await until(() => state.opened === i + 1);
    const link = sender(t, state, { token: 'wrong-connection-test-only' });
    assert.deepEqual(clean(await pending), { result: 'nothing', message: 'Nothing arrived in 0.15 seconds. Check that Tailscale is on for both PCs, the address above, and Windows Firewall.' });
    link.stop(); assert.equal(connection.active(), false); await reusable(t, state);
  }
});

test('setup and meeting busy do not open a port, and the next run works', async (t) => {
  const { connection, state } = fixture(t);
  state.host = '';
  assert.deepEqual(clean(await connection.run()), { result: 'setup', message: "Enter this PC's Tailscale address first." });
  state.host = '127.0.0.1'; state.meeting = true;
  assert.deepEqual(clean(await connection.run()), { result: 'busy', message: 'A meeting is running. Start the recorder there instead.' });
  assert.equal(state.opened, 0); assert.equal(connection.active(), false);
  state.meeting = false;
  const pending = connection.run(); await connection.cancel();
  assert.equal(clean(await pending).result, 'cancelled'); await reusable(t, state);
});

test('another run is busy during both waiting and the reached grace period', async (t) => {
  const { connection, state } = fixture(t, { timeoutMs: 2000, afterMs: 2000 });
  const pending = connection.run();
  const expected = { result: 'busy', message: 'A test is already running.' };
  assert.deepEqual(clean(await connection.run()), expected);
  await until(() => state.opened === 1); const link = sender(t, state);
  assert.equal(clean(await pending).result, 'reached');
  assert.deepEqual(clean(await connection.run()), expected);
  await connection.cancel(); link.stop(); await reusable(t, state);
});

test('bind error closes the failed listener, uses a plain message, and allows a retry', async (t) => {
  const occupied = await bind(t), { connection, state } = fixture(t);
  state.port = occupied.address().port;
  assert.deepEqual(clean(await connection.run()), { result: 'error', message: `Could not listen on 127.0.0.1:${state.port}. Check the Tailscale address in Settings, or whether another program uses that port.` });
  assert.equal(state.closed, 1); assert.equal(connection.active(), false);
  await new Promise((resolve) => occupied.close(resolve));
  const pending = connection.run(); await until(() => state.opened === 1); await connection.cancel();
  assert.equal(clean(await pending).result, 'cancelled'); await reusable(t, state);
});

for (const when of ['during bind', 'while waiting']) test('cancelling ' + when + ' frees the port and allows another run', async (t) => {
  const { connection, state } = fixture(t, { timeoutMs: 2000 });
  state.port = await freePort(t);
  for (let i = 0; i < 2; i++) {
    const pending = connection.run();
    if (when === 'while waiting') await until(() => state.opened === i + 1);
    await Promise.all([connection.cancel(), connection.cancel()]);
    assert.deepEqual(clean(await pending), { result: 'cancelled', message: 'Test stopped.' });
    assert.equal(connection.active(), false); assert.equal(state.closed, i + 1); await reusable(t, state);
  }
  await connection.cancel();
});

test('cancelling a reached test skips its long grace period', async (t) => {
  const { connection, state } = fixture(t, { timeoutMs: 2000, afterMs: 30000 });
  const pending = connection.run(); await until(() => state.opened === 1);
  const link = sender(t, state); assert.equal(clean(await pending).result, 'reached');
  await connection.cancel(); link.stop(); assert.equal(connection.active(), false); await reusable(t, state);
});

test('synchronous factory and listen failures never expose an error or prevent another test', async (t) => {
  for (const stage of ['factory', 'listen']) {
    let broken = true, closed = 0;
    const connection = createConnectionTest({ remoteConfig: { token: () => TOKEN }, settings: { get: () => ({ remote: { host: '127.0.0.1', port: 12345 } }) }, isMeetingRunning: () => false,
      createListener() {
        if (broken && stage === 'factory') throw new Error(TOKEN);
        return { listen() { if (broken) throw new Error(TOKEN); }, async close() { closed++; } };
      } });
    t.after(() => connection.cancel());
    assert.equal(clean(await connection.run()).result, 'error'); assert.equal(connection.active(), false);
    broken = false; const pending = connection.run(); await connection.cancel();
    assert.equal(clean(await pending).result, 'cancelled'); assert.ok(closed >= 1);
  }
});

test('timers are unrefed and cleared on completion and cancellation', async (t) => {
  const timers = [], cleared = new Set();
  t.mock.method(global, 'setTimeout', (fn, ms) => { const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; timers.push(timer); return timer; });
  t.mock.method(global, 'clearTimeout', (timer) => { if (timer) cleared.add(timer); });
  let state;
  const connection = createConnectionTest({ remoteConfig: { token: () => TOKEN }, settings: { get: () => ({ remote: { host: '127.0.0.1', port: 12345 } }) }, isMeetingRunning: () => false,
    createListener: ({ onState }) => { state = onState; return { listen() {}, close() {} }; } });
  let pending = connection.run(); state('connected'); state('connected');
  assert.equal(clean(await pending).result, 'reached'); assert.deepEqual(timers.map((v) => v.ms), [30000, 1500]);
  await connection.cancel(); assert.ok(timers.every((v) => v.unrefed && cleared.has(v)));
  pending = connection.run(); timers.at(-1).fn();
  assert.equal(clean(await pending).result, 'nothing'); assert.ok(timers.every((v) => cleared.has(v)));
});
