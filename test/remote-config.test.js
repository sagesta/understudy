'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, DEFAULTS, merge } = require('../src/main/settings');
const V = require('../src/main/validate');
const { createRemoteConfig } = require('../src/main/remote-config');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const settable = new Function(`return ${mainSrc.match(/const SETTABLE = (\{[\s\S]*?\n\});/)[1]}`)();
const ctx = { settable };
const sanitise = (remote) => V.sanitiseSettingsPatch({ remote, me: { name: 'Ade' } }, ctx);
const defaults = { enabled: false, host: '', port: 47615, listen: 'room', micFrom: 'recorder' };

function fixture(t, stored) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-remote-config-'));
  const configPath = path.join(dir, 'settings.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (stored !== undefined) fs.writeFileSync(configPath, JSON.stringify(stored));
  // A reversible stand-in checks that Settings uses its encrypted-secret path, without Electron.
  const encryption = { available: () => true, encrypt: (v) => Buffer.from(v).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() };
  const settings = new Settings(dir, encryption);
  const writes = [], sizes = [], timers = [];
  const clipboard = { text: '', clears: 0, writeText(v) { this.text = v; writes.push(v); },
    readText() { return this.text; }, clear() { this.text = ''; this.clears++; } };
  const later = (fn, ms) => { const timer = { fn, ms, unrefs: 0, unref() { this.unrefs++; } }; timers.push(timer); return timer; };
  const remote = createRemoteConfig({ settings, clipboard, setTimeout: later, randomBytes: (n) => { sizes.push(n); return Buffer.alloc(n, sizes.length); } });
  return { dir, configPath, encryption, settings, remote, writes, sizes, clipboard, timers };
}

const noToken = (values, token) => {
  for (const value of values) assert.ok(!JSON.stringify(value).includes(token), 'public results never include the token');
};

test('remote settings start disabled with an empty address and the default port', (t) => {
  const { settings, remote, sizes } = fixture(t);
  assert.deepEqual(DEFAULTS.remote, defaults);
  assert.deepEqual(settings.get().remote, defaults);
  assert.deepEqual(remote.info(), { ...defaults, hasToken: false, address: '' });
  assert.deepEqual(sizes, [], 'reading info does not make a token');
});

test('an old settings file gains the remote defaults without losing existing settings', (t) => {
  const { settings } = fixture(t, { me: { name: 'Ade' }, audio: { captureSystem: false } });
  assert.deepEqual(settings.get().remote, defaults);
  assert.equal(settings.get().me.name, 'Ade');
  assert.equal(settings.get().audio.captureSystem, false);
});

test('old remote settings without micFrom load the recorder microphone default', (t) => {
  const stored = { remote: { enabled: true, host: '127.0.0.1', port: 47615 } };
  const { settings, remote, configPath } = fixture(t, stored);
  assert.deepEqual(settings.get().remote, { ...stored.remote, listen: 'room', micFrom: 'recorder' });
  assert.equal(remote.info().micFrom, 'recorder');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), stored, 'Loading does not rewrite the file');
});

test('an explicit main microphone survives loading, repair and an unrelated save', (t) => {
  const stored = { remote: { enabled: true, host: '127.0.0.1', port: 47615, micFrom: 'main' } };
  const { settings, remote, configPath, encryption } = fixture(t, stored);
  assert.deepEqual(settings.get().remote, { ...stored.remote, listen: 'room' });
  assert.equal(remote.info().micFrom, 'main');
  assert.deepEqual(V.repairSettings(settings.get(), DEFAULTS, ctx).patch, {});
  settings.set({ me: { name: 'Ade' } });
  assert.equal(settings.get().remote.micFrom, 'main');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).remote.micFrom, 'main');
  assert.equal(new Settings(path.dirname(configPath), encryption).get().remote.micFrom, 'main');
});

test('both microphone choices persist and invalid choices repair to the recorder default', (t) => {
  const { settings, remote, configPath, encryption } = fixture(t);
  for (const micFrom of ['main', 'recorder']) {
    const result = sanitise({ micFrom }); assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.patch.remote, { micFrom }); settings.set(result.patch);
    assert.equal(remote.info().micFrom, micFrom);
    assert.equal(new Settings(path.dirname(configPath), encryption).get().remote.micFrom, micFrom);
  }
  for (const micFrom of [null, true, 0, {}, [], 'RECORDER', 'other', '']) {
    const result = sanitise({ micFrom, enabled: true });
    assert.deepEqual(result.patch.remote, { enabled: true }); assert.deepEqual(result.rejected, ['remote.micFrom']);
    const repaired = V.repairSettings(merge(DEFAULTS, { remote: { micFrom } }), DEFAULTS, ctx);
    assert.deepEqual(repaired.patch, { remote: { micFrom: 'recorder' } });
  }
});

test('remote hosts accept only empty text or Tailscale and loopback IPv4/IPv6 literals', () => {
  for (const host of ['100.64.1.2', '100.127.255.254', 'fd7a:115c:a1e0::1', '127.0.0.1', '::1', '::ffff:100.64.1.2', '::ffff:127.0.0.1', '']) {
    const r = sanitise({ host });
    assert.deepEqual(r.patch, { remote: { host }, me: { name: 'Ade' } });
    assert.deepEqual(r.rejected, []);
  }
  for (const host of ['example.com', '192.168.1.10', '10.0.0.5', '172.16.0.1', '0.0.0.0', '::', '8.8.8.8', '100.63.255.255', '100.128.0.1', '2001:db8::1', 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255', '100.64.1.2:80', 'x'.repeat(46), 12, null, ' 100.64.1.2', '[fd7a:115c:a1e0::1]']) {
    const r = sanitise({ host, enabled: true, port: 47616 });
    assert.deepEqual(r.patch, { me: { name: 'Ade' }, remote: { enabled: true, port: 47616 } });
    assert.deepEqual(r.rejected, ['remote.host']);
  }
});

test('remote ports are integers from 1024 to 65535 and a refusal keeps good fields', () => {
  for (const port of [1024, 47615, 65535]) {
    const r = sanitise({ port });
    assert.deepEqual(r.patch.remote, { port });
    assert.deepEqual(r.rejected, []);
  }
  for (const port of [80, 70000, 1.5, '47615', null, NaN, Infinity]) {
    const r = sanitise({ port, enabled: true, host: '100.64.1.2' });
    assert.deepEqual(r.patch, { me: { name: 'Ade' }, remote: { enabled: true, host: '100.64.1.2' } });
    assert.deepEqual(r.rejected, ['remote.port']);
  }
});

test('remote enabled is a boolean and a window cannot set a token', () => {
  for (const enabled of [true, false]) assert.deepEqual(sanitise({ enabled }).patch.remote, { enabled });
  for (const enabled of ['true', 0, null]) {
    const r = sanitise({ enabled, host: '100.64.1.2', port: 47615 });
    assert.deepEqual(r.patch.remote, { host: '100.64.1.2', port: 47615 });
    assert.deepEqual(r.rejected, ['remote.enabled']);
  }
  assert.deepEqual(sanitise({ token: 'ignored', remoteToken: 'ignored' }).patch, { me: { name: 'Ade' } });
});

test('repairSettings replaces bad stored remote values and keeps good fields', (t) => {
  const { settings, configPath } = fixture(t, { remote: { enabled: true, host: 'example.com', port: '47615' } });
  const r = V.repairSettings(settings.get(), DEFAULTS, ctx);
  assert.deepEqual(r.patch, { remote: { host: '', port: 47615 } });
  assert.deepEqual(r.fixed, ['remote.host', 'remote.port']);
  settings.set(r.patch);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).remote, { ...defaults, enabled: true });
  assert.deepEqual(new Settings(path.dirname(configPath), settings.crypto).get().remote, { ...defaults, enabled: true });
  for (const remote of [null, [], 7, 'broken']) {
    const bad = V.repairSettings(merge(DEFAULTS, { remote }), DEFAULTS, ctx);
    assert.deepEqual(bad.patch, { remote: defaults });
    assert.deepEqual(bad.fixed, ['remote']);
  }
  const bad = V.repairSettings(merge(DEFAULTS, { remote: { enabled: 'yes', host: 'fd7a:115c:a1e0::1', port: 1.5 } }), DEFAULTS, ctx);
  assert.deepEqual(bad.patch, { remote: { enabled: false, port: 47615 } });
});

test('the token is made once, encrypted, stable after reloading and replaced on request', (t) => {
  const { dir, configPath, encryption, settings, remote, sizes } = fixture(t);
  settings.set({ remote: { host: '100.64.1.2' } });
  const first = remote.token();
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(remote.token() === first);
  assert.deepEqual(sizes, [24]);
  assert.ok(settings.getSecret('remoteToken') === first);
  assert.ok(settings.secrets.remoteToken.enc && !settings.secrets.remoteToken.plain);
  const reloaded = createRemoteConfig({ settings: new Settings(dir, encryption), clipboard: { writeText() {} }, randomBytes: () => { throw new Error('The stored token should be used.'); } });
  assert.ok(reloaded.token() === first);
  const info = remote.info(), result = remote.newToken(), next = remote.token();
  assert.ok(next !== first);
  assert.ok(settings.getSecret('remoteToken') === next);
  assert.ok(remote.token() === next);
  assert.deepEqual(sizes, [24, 24]);
  assert.deepEqual(result, { hasToken: true });
  assert.equal(info.hasToken, true);
  const stored = fs.readFileSync(configPath, 'utf8');
  assert.ok(!stored.includes(first) && !stored.includes(next) && !stored.includes('remoteToken'));
  noToken([info, result, remote.info()], first); noToken([info, result, remote.info()], next);
});

test('newToken also works before a token exists', (t) => {
  const { remote, sizes } = fixture(t);
  assert.deepEqual(remote.newToken(), { hasToken: true });
  assert.equal(remote.info().hasToken, true);
  assert.match(remote.token(), /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(sizes, [24]);
});

test('copySettings exports the token only through the injected clipboard', (t) => {
  const { configPath, settings, remote, writes, sizes } = fixture(t);
  settings.set({ remote: { host: '100.64.1.2', port: 47616 } });
  const copied = remote.copySettings(), token = remote.token();
  assert.equal(copied, true);
  assert.deepEqual(JSON.parse(writes[0]), { url: 'ws://100.64.1.2:47616', token });
  assert.equal(remote.copySettings(), true);
  assert.equal(writes[1], writes[0]);
  assert.deepEqual(sizes, [24]);
  const changed = remote.newToken(), next = remote.token();
  assert.equal(remote.copySettings(), true);
  assert.ok(JSON.parse(writes[2]).token === next && next !== token);
  noToken([remote.info(), changed, copied], token); noToken([remote.info(), changed, copied], next);
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes(next));
});

test('an empty host copies nothing and does not create a token', (t) => {
  const { settings, remote, writes, sizes } = fixture(t);
  assert.equal(remote.copySettings(), false);
  assert.deepEqual(writes, []); assert.deepEqual(sizes, []);
  const token = remote.token();
  assert.equal(remote.copySettings(), false);
  assert.deepEqual(writes, []); assert.deepEqual(sizes, [24]);
  settings.set({ remote: { enabled: true } });
  assert.equal(remote.info().address, '');
  noToken([remote.info(), remote.copySettings()], token);
});

test('the copied settings are cleared after thirty seconds without holding the app open', (t) => {
  const { settings, remote, clipboard, timers } = fixture(t);
  assert.equal(remote.copySettings(), false); assert.deepEqual(timers, []);
  settings.set({ remote: { host: '127.0.0.1' } });
  assert.equal(remote.copySettings(), true);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 30000); assert.equal(timers[0].unrefs, 1);
  assert.equal(clipboard.clears, 0);
  timers[0].fn();
  assert.equal(clipboard.readText(), ''); assert.equal(clipboard.clears, 1);
});

test('clipboard cleanup leaves text copied by the owner alone', (t) => {
  const { settings, remote, clipboard, timers } = fixture(t);
  settings.set({ remote: { host: '127.0.0.1' } }); remote.copySettings();
  clipboard.writeText('My next clipboard item.'); timers[0].fn();
  assert.equal(clipboard.readText(), 'My next clipboard item.'); assert.equal(clipboard.clears, 0);
});

test('an older clipboard timer cannot clear newly copied settings with a replaced token', (t) => {
  const { settings, remote, clipboard, timers } = fixture(t);
  settings.set({ remote: { host: '127.0.0.1' } }); remote.copySettings();
  remote.newToken(); remote.copySettings();
  timers[0].fn(); assert.equal(clipboard.clears, 0);
  timers[1].fn(); assert.equal(clipboard.clears, 1); assert.equal(clipboard.readText(), '');
});

test('IPv6 recorder addresses have brackets and follow saved host and port changes', (t) => {
  const { settings, remote, writes } = fixture(t);
  settings.set({ remote: { host: 'fd7a:115c:a1e0::1', port: 65535 } });
  assert.equal(remote.info().address, 'ws://[fd7a:115c:a1e0::1]:65535');
  assert.equal(remote.copySettings(), true);
  assert.equal(new URL(JSON.parse(writes[0]).url).hostname, '[fd7a:115c:a1e0::1]');
  settings.set({ remote: { host: '100.64.1.2', port: 1024 } });
  assert.equal(remote.info().address, 'ws://100.64.1.2:1024');
});

test('the default random source produces a 24-byte base64url token', (t) => {
  const { settings } = fixture(t);
  const remote = createRemoteConfig({ settings, clipboard: { writeText() {} } });
  assert.match(remote.token(), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Buffer.from(remote.token(), 'base64url').length, 24);
});


test('old remote settings default to room and explicit computer audio survives load, save and validation', (t) => {
  for (const listen of [undefined, 'room', 'computer']) {
    const stored = { remote: { enabled: true, host: '127.0.0.1', ...(listen ? { listen } : {}) } };
    const { settings, remote, configPath, encryption } = fixture(t, stored), expected = listen || 'room';
    assert.equal(settings.get().remote.listen, expected); assert.equal(remote.info().listen, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), stored);
    assert.deepEqual(V.repairSettings(settings.get(), DEFAULTS, ctx).patch, {});
    settings.set({ me: { name: 'Ade' } });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).remote.listen, expected);
    assert.equal(new Settings(path.dirname(configPath), encryption).get().remote.listen, expected);
  }
  for (const listen of ['room', 'computer']) {
    const result = sanitise({ listen });
    assert.deepEqual(result.patch.remote, { listen }); assert.deepEqual(result.rejected, []);
  }
  for (const listen of [null, true, 0, {}, [], 'ROOM', 'microphone', '']) {
    const result = sanitise({ listen, enabled: true });
    assert.deepEqual(result.patch.remote, { enabled: true }); assert.deepEqual(result.rejected, ['remote.listen']);
    assert.deepEqual(V.repairSettings(merge(DEFAULTS, { remote: { listen } }), DEFAULTS, ctx).patch, { remote: { listen: 'room' } });
  }
});
