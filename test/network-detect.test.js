'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { tailscaleAddresses } = require('../src/main/network-detect');
const entry = (address, internal = false) => ({ address, internal });

test('IPv4 detection includes both ends of 100.64.0.0/10 and nothing outside it', () => {
  const addresses = ['100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0', '192.168.1.1', '127.0.0.1', '10.0.0.1'];
  assert.deepEqual(tailscaleAddresses({ ethernet: addresses.map((v) => entry(v)) }), ['100.127.255.255', '100.64.0.0']);
});

test('IPv6 detection compares the /48 numerically, including expanded and mixed-case forms', () => {
  const inside = ['fd7a:115c:a1e0::', 'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff', 'FD7A:115C:A1E0:0000:0000:0000:0000:0001', 'fd7a:115c:a1e0::100.64.1.2'];
  const outside = ['fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff', 'fd7a:115c:a1e1::', 'fd7a:115d:a1e0::1', 'fd7b:115c:a1e0::1', '::fd7a:115c:a1e0', 'fe80::1'];
  assert.deepEqual(tailscaleAddresses({ tailscale: [...inside, ...outside].map((v) => entry(v)) }), inside.sort());
});

test('internal addresses are ignored and IPv6 scope suffixes are removed before deduplication', () => {
  assert.deepEqual(tailscaleAddresses({ tailscale: [entry('100.64.1.2', true), entry('fd7a:115c:a1e0::1', true),
    entry('fd7a:115c:a1e0::2%12'), entry('fd7a:115c:a1e0::2%eth0'), entry('fd7a:115c:a1e0::2')] }), ['fd7a:115c:a1e0::2']);
});

test('duplicates across interfaces are removed and sorted IPv4 addresses come before sorted IPv6', () => {
  const addresses = ['fd7a:115c:a1e0::9', '100.90.1.2', 'fd7a:115c:a1e0::1', '100.64.1.2', '100.100.1.2'];
  assert.deepEqual(tailscaleAddresses({ b: addresses.map((v) => entry(v)), a: addresses.slice().reverse().map((v) => entry(v)) }),
    ['100.100.1.2', '100.64.1.2', '100.90.1.2', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::9']);
});

test('missing, malformed and non-object input never throws and yields no addresses', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({}));
  for (const value of [undefined, null, 7, false, 'text', [], { a: null, b: 1, c: {}, d: 'text' },
    { a: [null, undefined, 7, true, '100.64.1.2', [], {}, { address: 7 }, entry('100.64.1.2%12'), entry('100.64.001.2'),
      entry('100.64.1.256'), entry('fd7a:115c:a1e0oops::1'), entry('fd7a:115c:a1e0::1%12%3'), entry('fd7a:115c:a1e0:::1')] }]) {
    assert.deepEqual(tailscaleAddresses(value), []);
  }
});

test('the default reads OS interfaces without requiring Electron', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ tailscale: [entry('100.64.1.2')] }));
  assert.deepEqual(tailscaleAddresses(), ['100.64.1.2']);
});

test('OS enumeration failures yield no addresses instead of throwing', (t) => {
  t.mock.method(os, 'networkInterfaces', () => { throw new Error('Interfaces unavailable'); });
  assert.deepEqual(tailscaleAddresses(), []);
  assert.deepEqual(tailscaleAddresses(undefined), []);
});

test('throwing entries are ignored and unreadable interface maps never throw', () => {
  const bad = { get address() { throw new Error('Malformed address'); } };
  assert.deepEqual(tailscaleAddresses({ tailscale: [bad, entry('100.64.1.2')] }), ['100.64.1.2']);
  assert.deepEqual(tailscaleAddresses({ get tailscale() { throw new Error('Malformed map'); } }), []);
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.deepEqual(tailscaleAddresses(proxy.proxy), []);
});
