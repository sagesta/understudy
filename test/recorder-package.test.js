'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FileMatcher, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const config = JSON.parse(read('electron-builder.recorder.json'));
const filter = new FileMatcher(ROOT, ROOT, (s) => s, config.files).createFilter();
const matches = (file) => filter(path.join(ROOT, file), { isDirectory: () => false });
const pages = ['src/renderer/capture.html', 'src/renderer/recorder-setup.html'];
const scripts = ['src/preload.js', 'src/recorder-preload.js', 'src/renderer/capture.js', 'src/renderer/pcm-worklet.js', 'src/renderer/recorder-setup.js'];
const excluded = ['settings', 'llm', 'stt', 'knowledge', 'meetings', 'mcp', 'personalities', 'claude-connect', 'live-copy', 'notes-inbox', 'issues', 'crashlog'];

test('recorder build has a separate identity, entry, output and one-click user installer', () => {
  assert.equal(config.appId, 'app.understudy.recorder'); assert.notEqual(config.appId, pkg.build.appId);
  assert.equal(config.productName, 'Understudy Recorder'); assert.notEqual(config.productName, pkg.build.productName);
  assert.equal(config.directories.output, 'dist-recorder');
  assert.equal(config.extraMetadata.name, 'understudy-recorder'); assert.ok(config.extraMetadata.description);
  assert.equal(config.extraMetadata.main, 'src/main/recorder-entry.js'); assert.ok(fs.existsSync(path.join(ROOT, config.extraMetadata.main)));
  assert.equal(config.nsis.oneClick, true); assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.createStartMenuShortcut, true); assert.equal(config.nsis.shortcutName, 'Understudy Recorder');
  assert.equal(config.win.icon, pkg.build.win.icon); assert.deepEqual(config.win.target, ['nsis']);
  assert.equal(pkg.scripts.dist, 'electron-builder --win');
  assert.equal(pkg.scripts['dist:recorder'], 'electron-builder --win --config electron-builder.recorder.json');
  const calls = [];
  vm.runInNewContext(read(config.extraMetadata.main), { require(name) { calls.push(name); return { run: () => calls.push('run') }; } });
  assert.deepEqual(calls, ['./recorder-mode', 'run']);
});

test('recorder file rules include the complete local dependency closure and exclude the main app', () => {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file); assert.ok(matches(file), 'Missing package file: ' + file);
    const source = read(file);
    assert.doesNotMatch(source, /getSecret|secrets\.json|claude_desktop_config/);
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = match[1];
      assert.ok(!excluded.some((part) => name === './' + part || name.startsWith('./' + part + '/')), 'Main app dependency: ' + name);
      if (name.startsWith('./') || name.startsWith('../')) {
        const next = require.resolve(path.resolve(ROOT, path.dirname(file), name));
        visit(path.relative(ROOT, next).replaceAll('\\', '/'));
      }
    }
  }
  visit(config.extraMetadata.main);
  for (const file of scripts) visit(file);
  assert.ok(visited.has('src/main/remote-link.js'));
  for (const page of pages) {
    assert.ok(matches(page));
    for (const match of read(page).matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      assert.doesNotMatch(match[1], /^(?:https?:|data:|\/\/)/);
      assert.ok(matches(path.posix.join(path.posix.dirname(page), match[1])), 'Page resource: ' + match[1]);
    }
  }
  for (const match of read('src/renderer/capture.js').matchAll(/addModule\(['"]([^'"]+)['"]\)/g)) assert.ok(matches('src/renderer/' + match[1]));
  for (const name of ['src/main/main.js', 'src/renderer/app.js', 'src/renderer/ui.js', 'src/renderer/base.css', 'src/mcp/server.js', 'personalities/default.md']) assert.equal(matches(name), false, name);
  for (const part of excluded) for (const tail of ['.js', '/index.js', '/nested/private.js']) assert.equal(matches('src/main/' + part + tail), false);
  const allowed = new Set([config.extraMetadata.main, 'src/main/recorder-mode.js', 'src/main/remote-link.js', ...pages, ...scripts, 'src/renderer/recorder-setup.css', 'assets/icon.png', 'package.json']);
  assert.deepEqual(new Set(config.files.filter((file) => !file.startsWith('!'))), allowed);
});

test('builder production-module filter accepts ws only, including scoped and nested packages', () => {
  // v26 collects production modules separately and applies only the negative files patterns.
  const onlyModules = getNodeModuleFileMatcher(ROOT, ROOT, (s) => s, {}, { config, debugLogger: { isEnabled: false } }).createFilter();
  for (const [file, expected] of [
    ['node_modules/ws/index.js', true], ['node_modules/ws/lib/sender.js', true],
    ['node_modules/zod/index.js', false], ['node_modules/@anthropic-ai/sdk/index.js', false],
    ['node_modules/@modelcontextprotocol/sdk/dist/index.js', false], ['node_modules/future-dependency/index.js', false],
    ['node_modules/other/node_modules/ws/index.js', false]
  ]) assert.equal(onlyModules(path.join(ROOT, file), { isDirectory: () => false, moduleFullFilePath: file }), expected, file);
});

test('setup is local with strict CSP, no inline code, safe DOM and a masked manual fallback', () => {
  const html = read('src/renderer/recorder-setup.html'), js = read('src/renderer/recorder-setup.js'), css = read('src/renderer/recorder-setup.css');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(html.includes(directive));
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|\son\w+\s*=/i);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { assert.match(match[1], /\bsrc=/); assert.equal(match[2].trim(), ''); }
  assert.doesNotMatch(html + js, /innerHTML|navigator\.clipboard|localStorage|sessionStorage|https?:\/\//);
  assert.match(css, /prefers-color-scheme:\s*dark/); assert.match(css, /overflow:\s*hidden/); assert.match(css, /-webkit-text-security:\s*disc/);
  assert.match(html, /Settings &gt; Other PC and press Copy recorder settings/);
  assert.doesNotMatch(html, /Settings &gt; Speech/);
  assert.match(read('README.md'), /Settings > Other PC/);
  assert.match(html, /maxlength="2000"/); assert.match(js, /\$\('settings'\)\.value = ''/);
});

test('setup preload exposes only five fixed operations and refuses invalid inputs', async () => {
  const calls = [], listeners = new Map(); let api;
  const electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'recorder'); api = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({}); },
      on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); } } };
  vm.runInNewContext(read('src/recorder-preload.js'), { require(name) { assert.equal(name, 'electron'); return electron; } });
  assert.deepEqual(Object.keys(api).sort(), ['connect', 'getState', 'onState', 'pasteFromClipboard', 'setAutoStart'].sort());
  await api.pasteFromClipboard(); await api.connect('x'.repeat(2000)); await api.getState(); await api.setAutoStart(true);
  assert.deepEqual(calls.map(([channel]) => channel), ['recorder:paste', 'recorder:connect', 'recorder:state', 'recorder:autoStart']);
  const count = calls.length;
  for (const value of [null, undefined, 1, {}, [], false, 'x'.repeat(2001)]) await assert.rejects(api.connect(value));
  for (const value of [null, undefined, 0, 1, {}, [], 'true']) await assert.rejects(api.setAutoStart(value));
  assert.equal(calls.length, count); assert.throws(() => api.onState('bad'), /callback/);
  let state;
  const off = api.onState((value) => { state = value; });
  assert.deepEqual([...listeners.keys()], ['recorder:state']);
  listeners.get('recorder:state')({}, { state: 'waiting' }); assert.deepEqual(state, { state: 'waiting' });
  off(); assert.equal(listeners.size, 0);
});

test('main entry stays CRLF and all recorder additions use LF', () => {
  const main = read('src/main/main.js');
  assert.doesNotMatch(main, /(?<!\r)\n|\r(?!\n)/);
  assert.match(main, /require\('electron'\);\r\nif \(process\.argv\.includes\('--recorder'\)\)/);
  for (const file of [...config.files.filter((file) => !file.startsWith('!') && !file.endsWith('.png')), 'test/recorder-package.test.js', 'test/recorder-mode.test.js', 'README.md', 'src/renderer/app.js']) assert.doesNotMatch(read(file), /\r/);
});
