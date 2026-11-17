'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createListener, createSender } = require('../src/main/remote-link');

const TOKEN = 'local-test-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message = 'Condition was not met', ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { assert.ok(Date.now() < end, message); await sleep(5); }
}
async function listener(t, options = {}) {
  const link = createListener({ token: TOKEN, host: '127.0.0.1', port: 0, ...options });
  t.after(() => link.close());
  const { port } = await link.listen();
  return { link, port, url: `ws://127.0.0.1:${port}` };
}
function client(t, url, options = {}) {
  const ws = new WebSocket(url, { perMessageDeflate: false, ...options });
  const peer = { ws, messages: [], pings: 0, closed: false, code: null };
  ws.on('error', () => {});
  ws.on('ping', () => peer.pings++);
  ws.on('message', (data, binary) => { if (!binary) peer.messages.push(JSON.parse(data.toString())); });
  ws.on('close', (code) => { peer.closed = true; peer.code = code; });
  t.after(async () => {
    if (!peer.closed) { ws.terminate(); await until(() => peer.closed, 'Client did not close'); }
  });
  return peer;
}
async function message(peer, type) {
  await until(() => peer.messages.some((msg) => msg.t === type), `No ${type} message`);
  return peer.messages.find((msg) => msg.t === type);
}
function hello(peer, nonce, token = TOKEN, pc = 'Recorder', sid = '01234567') {
  const mac = crypto.createHmac('sha256', token).update(nonce).digest('hex');
  peer.ws.send(JSON.stringify({ t: 'hello', mac, pc, sid }));
  return mac;
}
async function authenticated(t, url, options) {
  const peer = client(t, url, options);
  const challenge = await message(peer, 'challenge');
  assert.match(challenge.nonce, /^[a-f\d]{32}$/);
  hello(peer, challenge.nonce);
  const proof = crypto.createHmac('sha256', TOKEN).update('server:' + challenge.nonce).digest('hex');
  assert.deepEqual(await message(peer, 'ready'), { t: 'ready', proof });
  return peer;
}
function sender(t, url, options = {}) {
  const link = createSender({ url, token: TOKEN, reconnectMs: 25, ...options });
  t.after(() => link.stop());
  return link;
}
function samples(seed = 0) {
  return Int16Array.from({ length: 1600 }, (_, i) => ((i * 101 + seed) & 0xffff) - 32768);
}
function frame(counter, pcm = samples(), ch = 1) {
  // An odd-offset source catches accidental typed-array views of transport buffers.
  const data = Buffer.alloc(3206).subarray(1);
  data[0] = ch; data.writeUInt32BE(counter, 1);
  for (let i = 0; i < 1600; i++) data.writeInt16LE(pcm[i], 5 + i * 2);
  return data;
}

for (const fault of ['wrong token', 'no hello', 'binary before hello', 'oversized message', 'malformed JSON']) {
  test(`authentication closes ${fault} without delivering audio`, async (t) => {
    const audio = [];
    const { link, url } = await listener(t, { helloMs: fault === 'no hello' ? 50 : 1000, onAudio: (...args) => audio.push(args) });
    const peer = client(t, url);
    const { nonce } = await message(peer, 'challenge');
    if (fault === 'wrong token') hello(peer, nonce, 'wrong-token');
    if (fault === 'binary before hello') peer.ws.send(frame(0));
    if (fault === 'oversized message') peer.ws.send('x'.repeat(8193));
    if (fault === 'malformed JSON') peer.ws.send('{');
    await until(() => peer.closed, 'Unauthenticated client was not closed');
    assert.equal(link.stats().badHellos, 1);
    assert.equal(link.stats().connected, false);
    assert.deepEqual(audio, []);
  });
}

test('hello requires a JSON object, a hex MAC, a short PC name and the hello type', async (t) => {
  const { link, url } = await listener(t);
  for (const payload of ['null', '[]', '{"t":"hello","mac":"zz","pc":"PC","sid":"01234567"}',
    JSON.stringify({ t: 'hello', mac: '0'.repeat(64), pc: 'x'.repeat(31), sid: '01234567' })]) {
    const peer = client(t, url);
    await message(peer, 'challenge'); peer.ws.send(payload);
    await until(() => peer.closed);
  }
  const peer = client(t, url);
  await message(peer, 'challenge'); peer.ws.send(JSON.stringify({ t: 'status', state: 'ready' }));
  await until(() => peer.closed);
  assert.equal(link.stats().badHellos, 5);
});

test('hello rejects a missing or malformed sender session ID even with a valid MAC', async (t) => {
  const { link, url } = await listener(t);
  for (const sid of [undefined, 12345678, 'a'.repeat(7), 'a'.repeat(33), 'g'.repeat(8)]) {
    const peer = client(t, url), { nonce } = await message(peer, 'challenge');
    const mac = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex');
    peer.ws.send(JSON.stringify({ t: 'hello', mac, pc: 'Recorder', sid }));
    await until(() => peer.closed);
  }
  assert.equal(link.stats().badHellos, 5); assert.equal(link.stats().connected, false);
});

test('valid hello delivers exact fresh aligned samples and limits status strings', async (t) => {
  const audio = [], statuses = [], states = [];
  const { link, url } = await listener(t, {
    onAudio: (channel, pcm) => audio.push({ channel, pcm }),
    onStatus: (value) => statuses.push(value), onState: (state) => states.push(state)
  });
  const peer = await authenticated(t, url), pcm = samples(73), data = frame(0, pcm);
  assert.equal(data.byteOffset % 2, 1);
  peer.ws.send(data); peer.ws.send(frame(1, pcm)); peer.ws.send(frame(0, pcm, 0));
  peer.ws.send(Buffer.alloc(3204)); peer.ws.send(frame(2, pcm, 2));
  peer.ws.send(JSON.stringify({ t: 'status', state: 'x'.repeat(250), hint: 'y'.repeat(250) }));
  peer.ws.send(JSON.stringify({ t: 'status', state: 'recording' }));
  peer.ws.send(JSON.stringify({ t: 'status', state: {}, hint: 'ignored' }));
  peer.ws.send(JSON.stringify({ t: 'status', state: 'ignored', hint: [] }));
  await until(() => audio.length === 3 && statuses.length === 2 && link.stats().badFrames === 2);
  assert.deepEqual(audio.map((item) => item.channel), ['them', 'them', 'me']);
  for (const { pcm: actual } of audio) {
    assert.ok(actual instanceof Int16Array); assert.equal(actual.byteOffset % 2, 0);
    assert.equal(actual.buffer.byteLength, 3200); assert.deepEqual(actual, pcm);
  }
  assert.notEqual(audio[0].pcm.buffer, audio[1].pcm.buffer);
  audio[0].pcm[0] = 42;
  assert.deepEqual(audio[1].pcm, pcm);
  assert.deepEqual(statuses, [{ state: 'x'.repeat(200), hint: 'y'.repeat(200) }, { state: 'recording' }]);
  assert.deepEqual(states, ['waiting', 'connected']);
  assert.deepEqual(link.stats(), { connected: true, blocks: 3, dropped: 2, duplicates: 0, lost: 0, badFrames: 2, badHellos: 0 });
  peer.ws.close(); await until(() => states.includes('disconnected'));
});

test('a fresh challenge prevents replaying a previous hello', async (t) => {
  const { link, url } = await listener(t);
  const first = await authenticated(t, url);
  const old = first.messages.find((msg) => msg.t === 'challenge').nonce;
  const second = client(t, url), next = await message(second, 'challenge');
  assert.notEqual(next.nonce, old);
  hello(second, old);
  await until(() => second.closed);
  assert.equal(first.closed, false); assert.equal(link.stats().badHellos, 1);
});

test('five failed hellos lock new connections until the lock period ends', async (t) => {
  const audio = [], lockMs = 180;
  const { link, url } = await listener(t, { lockMs, onAudio: (...args) => audio.push(args) });
  for (let i = 0; i < 5; i++) {
    const peer = client(t, url), challenge = await message(peer, 'challenge');
    hello(peer, challenge.nonce, 'wrong-token');
    await until(() => peer.closed);
  }
  const refused = client(t, url);
  await until(() => refused.closed);
  assert.deepEqual(refused.messages, []);
  assert.equal(link.stats().badHellos, 5); assert.deepEqual(audio, []);
  await sleep(lockMs + 10);
  const accepted = await authenticated(t, url);
  accepted.ws.send(frame(0));
  await until(() => audio.length === 1);
});

test('counters reject duplicates, report one gap per hole and wrap per channel', async (t) => {
  const audio = [], gaps = [];
  const { link, url } = await listener(t, { onAudio: (ch) => audio.push(ch), onGap: (...args) => gaps.push(args) });
  const peer = await authenticated(t, url);
  for (const counter of [10, 10, 9, 13]) peer.ws.send(frame(counter));
  for (const counter of [0xffffffff, 0, 0xffffffff, 2]) peer.ws.send(frame(counter, samples(), 0));
  await until(() => link.stats().blocks === 5 && link.stats().duplicates === 3);
  assert.deepEqual(gaps, [['them', 2], ['me', 1]]);
  assert.deepEqual(audio, ['them', 'them', 'me', 'me', 'me']);
  assert.equal(link.stats().lost, 3); assert.equal(link.stats().dropped, 3);
});

test('a new authenticated recorder replaces a peer that has not answered a ping', async (t) => {
  const audio = [];
  const { link, url } = await listener(t, { pingMs: 150, onAudio: (ch, pcm) => audio.push(pcm) });
  const silent = await authenticated(t, url, { autoPong: false });
  await until(() => silent.pings > 0);
  const next = await authenticated(t, url);
  await until(() => silent.closed);
  assert.equal(silent.code, 4000);
  next.ws.send(frame(0, samples(17)));
  await until(() => audio.length === 1);
  assert.deepEqual(audio[0], samples(17)); assert.equal(link.stats().connected, true);
});

test('heartbeat terminates a silent peer and keeps a peer that answers pings', async (t) => {
  const states = [];
  const { link, url } = await listener(t, { pingMs: 30, onState: (state) => states.push(state) });
  const silent = await authenticated(t, url, { autoPong: false });
  await until(() => silent.closed);
  await until(() => !link.stats().connected);
  assert.ok(states.includes('disconnected'));
  const healthy = await authenticated(t, url);
  await until(() => healthy.pings >= 3);
  assert.equal(healthy.closed, false); assert.equal(link.stats().connected, true);
});

test('only boolean mic and room flags on start and resume reach the wire', async (t) => {
  const { link, url } = await listener(t), peer = await authenticated(t, url);
  const commands = [
    ['start', { mic: true, room: false, ignored: 'private' }, { t: 'start', mic: true, room: false }],
    ['resume', { mic: false, room: true }, { t: 'resume', mic: false, room: true }],
    ['start', { mic: 'true', room: 'true' }, { t: 'start' }],
    ['resume', { mic: 1, room: 1 }, { t: 'resume' }],
    ['start', { room: true }, { t: 'start', room: true }],
    ['resume', { room: false }, { t: 'resume', room: false }],
    ['start', { mic: false, room: null }, { t: 'start', mic: false }],
    ['start', null, { t: 'start' }], ['start', true, { t: 'start' }],
    ['resume', 'mic', { t: 'resume' }], ['start', undefined, { t: 'start' }],
    ['pause', { mic: true, room: true, ignored: true }, { t: 'pause' }],
    ['stop', { mic: false, room: false }, { t: 'stop' }]
  ];
  for (const [name, extra] of commands) assert.equal(link.command(name, extra), true);
  await until(() => peer.messages.length === commands.length + 2);
  assert.deepEqual(peer.messages.slice(2), commands.map(([, , expected]) => expected));
});

test('sender commands contain strict mic and room booleans and both channel counters are independent', async (t) => {
  const audio = [], commands = [];
  const { link, url } = await listener(t, { onAudio: (...args) => audio.push(args) });
  const peer = sender(t, url, { onCommand: (...args) => commands.push(args) });
  peer.start(); await until(() => link.stats().connected);
  link.command('start', { mic: true }); link.command('resume', { mic: false }); link.command('start');
  await until(() => commands.length === 3);
  assert.deepEqual(commands, [['start', { mic: true, room: false }], ['resume', { mic: false, room: false }], ['start', { mic: false, room: false }]]);
  const expected = [['me', samples(7)], ['them', samples(11)], ['them', samples(12)], ['me', samples(8)], ['them', samples(13)]];
  for (const [channel, pcm] of expected) peer.push(channel, pcm);
  await until(() => audio.length === expected.length);
  assert.deepEqual(audio, expected); assert.equal(link.stats().lost, 0); assert.equal(link.stats().duplicates, 0);
});

test('sender ignores unrecognised fields and treats malformed wire mic and room values as false', async (t) => {
  const commands = [], nonce = 'a'.repeat(32);
  const messages = [{ t: 'start' }, { t: 'start', mic: 'true', room: 'true', extra: 'private' },
    { t: 'resume', mic: 1, room: 1 }, { t: 'resume', mic: true, room: true, extra: { mic: false } },
    { t: 'start', mic: null, room: null }, { t: 'resume', mic: false, room: false },
    { t: 'start', room: {} }, { t: 'resume', room: [] }];
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise((resolve) => server.close(resolve)); });
  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'challenge', nonce }));
    ws.once('message', () => {
      const proof = crypto.createHmac('sha256', TOKEN).update('server:' + nonce).digest('hex');
      ws.send(JSON.stringify({ t: 'ready', proof }));
      for (const msg of messages) ws.send(JSON.stringify(msg));
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const peer = sender(t, 'ws://127.0.0.1:' + server.address().port, { onCommand: (...args) => commands.push(args) });
  peer.start(); await until(() => commands.length === messages.length);
  assert.deepEqual(commands, [
    ['start', { mic: false, room: false }], ['start', { mic: false, room: false }],
    ['resume', { mic: false, room: false }], ['resume', { mic: true, room: true }],
    ['start', { mic: false, room: false }], ['resume', { mic: false, room: false }],
    ['start', { mic: false, room: false }], ['resume', { mic: false, room: false }]
  ]);
});

test('commands reach the sender and status is available only while authenticated', async (t) => {
  const commands = [], statuses = [], states = [], senderStates = [];
  const { link, url } = await listener(t, { onStatus: (value) => statuses.push(value), onState: (state) => states.push(state) });
  const recorder = sender(t, url, { pc: 'A'.repeat(100), onCommand: (name) => commands.push(name), onState: (state) => senderStates.push(state) });
  assert.equal(link.command('pause'), false); assert.equal(link.command('unknown'), false);
  assert.equal(recorder.sendStatus({ state: 'idle' }), false);
  recorder.start(); recorder.start();
  await until(() => senderStates.includes('connected'));
  assert.equal(link.command('unknown'), false);
  for (const name of ['start', 'pause', 'resume', 'stop']) assert.equal(link.command(name), true);
  assert.equal(recorder.sendStatus({ state: 'r'.repeat(250), hint: 'h'.repeat(250) }), true);
  assert.equal(recorder.sendStatus({ state: 42 }), false);
  await until(() => commands.length === 4 && statuses.length === 1);
  assert.deepEqual(commands, ['start', 'pause', 'resume', 'stop']);
  assert.deepEqual(statuses, [{ state: 'r'.repeat(200), hint: 'h'.repeat(200) }]);
  recorder.stop(); recorder.stop();
  await until(() => !link.stats().connected);
  assert.deepEqual(states, ['waiting', 'connected', 'disconnected']);
  assert.deepEqual(senderStates, ['connecting', 'connected', 'disconnected']);
  assert.equal(link.command('pause'), false);
});

test('sender counters continue when the connection is replaced and reconnects', async (t) => {
  const audio = [], states = [];
  const { link, url } = await listener(t, { onAudio: (ch, pcm) => audio.push(pcm[0]) });
  const recorder = sender(t, url, { reconnectMs: 100, onState: (state) => states.push(state) });
  recorder.start(); await until(() => states.includes('connected'));
  recorder.push('them', samples(1)); await until(() => audio.length === 1);
  const replacement = await authenticated(t, url);
  await until(() => states.includes('disconnected'));
  recorder.push('them', samples(2)); recorder.push('them', samples(3));
  await until(() => audio.length === 3);
  assert.deepEqual(audio, [samples(1)[0], samples(2)[0], samples(3)[0]]);
  assert.equal(link.stats().duplicates, 0); assert.equal(link.stats().lost, 0);
  assert.equal(recorder.stats().reconnects, 1);
  await until(() => replacement.closed); assert.equal(replacement.code, 4000);
});

test('a restarted recorder delivers fresh counters on both channels without gaps or duplicates', async (t) => {
  const audio = [], gaps = [];
  const { link, url } = await listener(t, { onAudio: (ch, pcm) => audio.push([ch, pcm[0]]), onGap: (...args) => gaps.push(args) });
  const first = sender(t, url);
  first.start();
  for (let i = 0; i < 5; i++) first.push(i % 2 ? 'them' : 'me', samples(i));
  await until(() => audio.length === 5);
  first.stop(); await until(() => !link.stats().connected);
  const next = sender(t, url);
  next.start(); next.push('me', samples(10)); next.push('them', samples(11));
  await until(() => audio.length === 7);
  assert.deepEqual(audio.slice(5), [['me', samples(10)[0]], ['them', samples(11)[0]]]);
  assert.deepEqual(gaps, []);
  assert.equal(link.stats().duplicates, 0); assert.equal(link.stats().dropped, 0); assert.equal(link.stats().lost, 0);
});

test('the same sender keeps its session and reports a hole after reconnecting', async (t) => {
  const audio = [], gaps = [];
  const { link, url } = await listener(t, { onAudio: (ch, pcm) => audio.push(pcm[0]), onGap: (...args) => gaps.push(args) });
  const recorder = sender(t, url, { keepBlocks: 2 });
  recorder.start(); recorder.push('them', samples(0));
  await until(() => audio.length === 1);
  recorder.stop(); await until(() => !link.stats().connected);
  for (let i = 1; i <= 5; i++) recorder.push('them', samples(i));
  recorder.start(); await until(() => audio.length === 3);
  assert.deepEqual(audio, [samples(0)[0], samples(4)[0], samples(5)[0]]);
  assert.deepEqual(gaps, [['them', 3]]);
  assert.equal(link.stats().lost, 3); assert.equal(link.stats().duplicates, 0);
});

for (const fault of ['wrong', 'missing', 'short', 'non-hex', 'reflected']) {
  test(`sender rejects ${fault} server proof without sending live or queued audio`, async (t) => {
    const audio = [], states = [];
    let hellos = 0, closed = 0;
    const server = new WebSocket.Server({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    t.after(async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    });
    server.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('close', () => closed++);
      ws.on('message', (data, binary) => {
        if (binary) { audio.push(data); return; }
        const msg = JSON.parse(data.toString());
        if (msg.t !== 'hello') return;
        hellos++;
        const proof = fault === 'missing' ? undefined : fault === 'short' ? 'a'.repeat(63) :
          fault === 'non-hex' ? 'g'.repeat(64) : fault === 'reflected' ? msg.mac : '0'.repeat(64);
        ws.send(JSON.stringify({ t: 'ready', proof }));
      });
      ws.send(JSON.stringify({ t: 'challenge', nonce: crypto.randomBytes(16).toString('hex') }));
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const recorder = sender(t, `ws://127.0.0.1:${server.address().port}`, { onState: (state) => states.push(state) });
    recorder.push('them', samples(1)); recorder.start();
    await until(() => hellos > 0 && (closed > 0 || audio.length > 0));
    assert.equal(recorder.push('me', samples(2)), false);
    await until(() => recorder.stats().reconnects > 0 || audio.length > 0);
    assert.deepEqual(audio, []); assert.equal(states.includes('connected'), false);
    assert.equal(recorder.stats().sent, 0); assert.equal(recorder.stats().queued, 2);
    assert.ok(closed > 0); assert.ok(recorder.stats().reconnects > 0);
  });
}

test('loopback delivers 20 blocks, bounds offline storage and reports discarded blocks after recovery', async (t) => {
  const audio = [], gaps = [], states = [], keepBlocks = 4;
  const { link, url, port } = await listener(t, { onAudio: (ch, pcm) => audio.push(pcm), onGap: (...args) => gaps.push(args) });
  const recorder = sender(t, url, { keepBlocks, onState: (state) => states.push(state) });
  recorder.start(); await until(() => states.includes('connected'));
  for (let i = 0; i < 20; i++) recorder.push('them', samples(i));
  await until(() => audio.length === 20);
  for (let i = 0; i < 20; i++) assert.deepEqual(audio[i], samples(i));
  await link.close(); await until(() => states.includes('disconnected'));
  const mutable = new Int16Array(1600), offline = 10000;
  for (let i = 0; i < offline; i++) {
    mutable.fill(i); recorder.push('them', mutable);
    assert.ok(recorder.stats().queued <= keepBlocks);
  }
  assert.deepEqual(recorder.stats(), { sent: 20, dropped: offline - keepBlocks, reconnects: 0, queued: keepBlocks });
  // A refused TCP connection must be handled and retried without growing the audio ring.
  await until(() => recorder.stats().reconnects >= 1);
  assert.equal(recorder.stats().queued, keepBlocks);
  assert.deepEqual(await link.listen(), { port });
  await until(() => audio.length === 20 + keepBlocks);
  for (let i = 0; i < keepBlocks; i++) assert.deepEqual(audio[20 + i], new Int16Array(1600).fill(offline - keepBlocks + i));
  assert.deepEqual(gaps, [['them', offline - keepBlocks]]);
  assert.equal(link.stats().duplicates, 0); assert.equal(recorder.stats().queued, 0);
});

test('backpressure drops a block while advancing its counter', async (t) => {
  const audio = [], gaps = [], states = [];
  const { url } = await listener(t, { onAudio: (ch, pcm) => audio.push(pcm[0]), onGap: (...args) => gaps.push(args) });
  const recorder = sender(t, url, { maxBufferedBytes: 10, onState: (state) => states.push(state) });
  recorder.start(); await until(() => states.includes('connected'));
  recorder.push('them', samples(1)); await until(() => audio.length === 1);
  // Real loopback usually drains immediately, so force only the public backpressure reading.
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount');
  let congested = true;
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', { configurable: true,
    get() { return congested && !this._isServer ? 11 : descriptor.get.call(this); } });
  t.after(() => Object.defineProperty(WebSocket.prototype, 'bufferedAmount', descriptor));
  assert.equal(recorder.push('them', samples(2)), false);
  congested = false;
  assert.equal(recorder.push('them', samples(3)), true);
  await until(() => audio.length === 2);
  assert.deepEqual(audio, [samples(1)[0], samples(3)[0]]);
  assert.deepEqual(gaps, [['them', 1]]); assert.equal(recorder.stats().dropped, 1);
});

test('empty and single-block rings, input validation and buffer ownership', async (t) => {
  const { url } = await listener(t);
  const empty = sender(t, url, { keepBlocks: 0 });
  empty.push('them', samples());
  assert.deepEqual(empty.stats(), { sent: 0, dropped: 1, reconnects: 0, queued: 0 });
  assert.throws(() => empty.push('other', samples()), TypeError);
  assert.throws(() => empty.push('them', new Uint16Array(1600)), TypeError);
  assert.throws(() => empty.push('them', new Int16Array(1599)), TypeError);
  const one = sender(t, url, { keepBlocks: 1 });
  one.push('them', samples(1)); one.push('them', samples(2));
  assert.deepEqual(one.stats(), { sent: 0, dropped: 1, reconnects: 0, queued: 1 });
  assert.throws(() => createListener({ token: '' }), TypeError);
  assert.throws(() => createListener({ token: TOKEN, helloMs: Infinity }), TypeError);
  assert.throws(() => createSender({ url, token: TOKEN, keepBlocks: -1 }), TypeError);
  assert.throws(() => createSender({ url, token: TOKEN, reconnectMs: 0 }), TypeError);
  assert.throws(() => createSender({ url, token: TOKEN, maxBufferedBytes: NaN }), TypeError);
});

test('malformed and oversized authenticated messages close the recorder', async (t) => {
  const { link, url } = await listener(t);
  for (const payload of ['{', 'x'.repeat(8193)]) {
    const peer = await authenticated(t, url);
    peer.ws.send(payload); await until(() => peer.closed);
  }
  assert.equal(link.stats().blocks, 0); assert.equal(link.stats().badHellos, 0);
});

test('close is idempotent, frees the port and handles a close during bind', async (t) => {
  const { link, port } = await listener(t);
  await authenticated(t, `ws://127.0.0.1:${port}`);
  const first = link.close(); assert.equal(link.close(), first);
  assert.equal(link.command('pause'), false); assert.equal(link.stats().connected, false);
  await first;
  const other = createListener({ token: TOKEN, host: '127.0.0.1', port });
  t.after(() => other.close());
  assert.deepEqual(await other.listen(), { port }); await other.close();
  const pending = createListener({ token: TOKEN, host: '127.0.0.1', port: 0 });
  t.after(() => pending.close());
  const binding = pending.listen(), closing = pending.close();
  const allocated = await binding; await closing;
  const rebound = createListener({ token: TOKEN, host: '127.0.0.1', port: allocated.port });
  t.after(() => rebound.close());
  await rebound.listen();
});

test('stop during connection and reconnect cancels future activity', async (t) => {
  const { link, url } = await listener(t);
  const states = [], recorder = sender(t, url, { onState: (state) => states.push(state), reconnectMs: 20 });
  recorder.start(); recorder.stop();
  await sleep(50);
  assert.deepEqual(states, ['connecting', 'disconnected']); assert.equal(link.stats().connected, false);
  recorder.start(); await until(() => states.includes('connected'));
  await link.close(); await until(() => states.at(-1) === 'disconnected');
  recorder.stop(); const retries = recorder.stats().reconnects;
  await sleep(60); assert.equal(recorder.stats().reconnects, retries);
  assert.equal(recorder.sendStatus({ state: 'stopped' }), false);
});

test('a failed bind rejects cleanly and can be closed twice', async (t) => {
  const { port } = await listener(t);
  const occupied = createListener({ token: TOKEN, host: '127.0.0.1', port });
  t.after(() => occupied.close());
  await assert.rejects(occupied.listen(), { code: 'EADDRINUSE' });
  await occupied.close(); await occupied.close();
});

test('stop and restart inside a state callback opens only one connection', async (t) => {
  const states = [], senderStates = [];
  const { link, url } = await listener(t, { onState: (state) => states.push(state) });
  let restart = true, recorder;
  recorder = sender(t, url, { onState(state) {
    senderStates.push(state);
    if (state === 'connecting' && restart) { restart = false; recorder.stop(); recorder.start(); }
  } });
  recorder.start(); await until(() => senderStates.includes('connected'));
  await sleep(50);
  assert.deepEqual(states, ['waiting', 'connected']);
  assert.equal(link.stats().badHellos, 0); assert.equal(recorder.stats().reconnects, 0);
  recorder.stop(); await until(() => !link.stats().connected);
});
