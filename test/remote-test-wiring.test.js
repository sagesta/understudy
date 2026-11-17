'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../src/main/validate');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');

test('main cancels the test before opening a meeting bridge and when quitting with only a test active', () => {
  const start = main.slice(main.indexOf('async function _startMeeting('), main.indexOf('async function _pauseMeeting('));
  const cancelled = start.indexOf('await connectionTest.cancel()');
  assert.ok(cancelled > 0 && cancelled < start.indexOf('createBridge(') && cancelled < start.indexOf('await bridge.open()'));
  assert.match(main, /connectionTest = createConnectionTest\(\{ remoteConfig, settings, createListener, isMeetingRunning: \(\) => Boolean\(meeting && meeting.active\) \}\)/);
  const quit = main.slice(main.indexOf('async function quitApp()'), main.indexOf('// ---------------------------------------------------------------- shortcuts'));
  assert.match(quit, /await connectionTest.cancel\(\)/);
  assert.match(main, /app.on\('before-quit', \(e\) => \{ if \(!quitting && [^\n]*connectionTest && connectionTest.active\(\)/);
});

test('Stop also cancels a test queued behind a meeting transition', async () => {
  const serial = main.slice(main.indexOf('let transition = Promise.resolve();'), main.indexOf('const startMeeting ='));
  const handlers = {}, lines = main.split('\n').filter((line) => /handle\('remote:test(?:Cancel)?'/.test(line)).join('\n');
  let release, resolveResult, runs = 0, cancellations = 0;
  const make = new Function('V', 'connectionTest', 'handle', 'let quitting = false; ' + serial + '\n' + lines + '\nreturn serial;');
  const queue = make(V, { run() { runs++; return new Promise((resolve) => { resolveResult = resolve; }); }, async cancel() { cancellations++; resolveResult({ result: 'cancelled' }); } }, (name, fn) => { handlers[name] = fn; });
  const transition = queue(() => new Promise((resolve) => { release = resolve; }));
  const result = handlers['remote:test'](), stopped = handlers['remote:testCancel']();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 0); assert.equal(cancellations, 0);
  release(); await transition;
  assert.deepEqual(await result, { result: 'cancelled' }); assert.equal(await stopped, true);
  assert.equal(runs, 1); assert.equal(cancellations, 1);
});

test('a queued test cannot open a listener once quitting has begun', async () => {
  const serial = main.slice(main.indexOf('let transition = Promise.resolve();'), main.indexOf('const startMeeting ='));
  const line = main.split('\n').find((line) => line.includes("handle('remote:test'"));
  let handler, runs = 0;
  new Function('V', 'connectionTest', 'handle', 'let quitting = true; ' + serial + '\n' + line)(V, { run() { runs++; } }, (_name, fn) => { handler = fn; });
  assert.deepEqual(await handler(), { result: 'cancelled', message: 'Test stopped.' }); assert.equal(runs, 0);
});

test('the IPC serial queue never waits for the test result and keeps a new test behind meeting startup', async () => {
  const serial = main.slice(main.indexOf('let transition = Promise.resolve();'), main.indexOf('const startMeeting ='));
  const line = main.split('\n').find((line) => line.includes("handle('remote:test'"));
  let resolveResult, finishStart, handler, runs = 0, meetingStarted = false;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const make = new Function('V', 'connectionTest', 'handle', `let quitting = false; ${serial}\n${line}\nreturn serial;`);
  const queue = make(V, { run() { runs++; return meetingStarted ? Promise.resolve({ result: 'busy' }) : result; } }, (_ch, fn) => { handler = fn; });
  const first = handler();
  await queue(() => { finishStart = true; });
  assert.equal(finishStart, true); assert.equal(runs, 1, 'A pending result must not block a meeting');
  resolveResult({ result: 'cancelled' }); assert.deepEqual(await first, { result: 'cancelled' });
  let release;
  const starting = queue(async () => { await new Promise((resolve) => { release = resolve; }); meetingStarted = true; });
  const second = handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1, 'No test may bind during meeting startup');
  release(); await starting;
  assert.deepEqual(await second, { result: 'busy' }); assert.equal(runs, 2);
});
