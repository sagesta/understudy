'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, merge } = require('../src/main/settings');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const panel = app.slice(app.indexOf('async function remotePanel()'), app.indexOf('\nconst SETTINGS_TABS'));

test('Other PC owns the remote controls and a four-step setup guide', () => {
  const speechStart = app.indexOf("  if (settingsTab === 'speech')"), remoteStart = app.indexOf("  if (settingsTab === 'remote')"), behaviourStart = app.indexOf("  if (settingsTab === 'behaviour')");
  assert.ok(speechStart >= 0 && remoteStart > speechStart && behaviourStart > remoteStart);
  const speech = app.slice(speechStart, remoteStart), remote = app.slice(remoteStart, behaviourStart);
  assert.match(app, /\['speech', 'Speech'\], \['remote', 'Other PC'\]/);
  assert.doesNotMatch(speech, /remotePanel|remote-controls|stackcol/);
  assert.match(speech, /panel\('Audio sources'/);
  assert.match(remote, /await remotePanel\(\), panel\('On the other PC'/);
  assert.equal([...remote.matchAll(/h\('li',/g)].length, 4);
  for (const text of ["Use this when the meeting runs on another PC.", 'a separate installer', 'can hear or play the meeting', 'sign in to the same account', 'Paste and connect', 'Start the meeting on this PC.', 'Not connected', 'Settings > Other PC']) assert.ok(remote.includes(text));
  for (const channel of ['remote:detect', 'remote:info', 'remote:copySettings', 'remote:newToken']) assert.ok(panel.includes("call('" + channel + "'"));
  assert.match(panel, /controls\.hidden = !S\(\)\.remote\.enabled/);
  assert.doesNotMatch(panel, /classList\.add|remote-panel|\bscr\b/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/app.css'), 'utf8');
  assert.doesNotMatch(css, /t-speech[^}]*remote|remote-panel|remote-detected[^}]*max-height/);
});

test('address discovery uses the same validated save and read-back path as typing', () => {
  assert.match(panel, /await call\('remote:detect'\)/);
  assert.match(panel, /textInput\(info\.host, \(v\) => update\(\{ host: v\.trim\(\) \}\)/);
  assert.match(panel, /const choose = async \(value\) => \{ await update\(\{ host: value \}\); toast\(`Found \$\{host\.value\}\.`\); \}/);
  assert.match(panel, /await save\(\{ remote: patch \}\);\s*const r = await call\('remote:info'\);\s*host\.value = r\.host; port\.value = r\.port;/);
  assert.match(panel, /addresses\.length === 1\) await choose\(addresses\[0\]\)/);
  assert.match(panel, /addresses\.map\(\(value\) => btn\(value, null, \(\) => choose\(value\)\.catch\(fail\), 'small mono'\)\)/);
  assert.match(panel, /Tailscale was not found on this PC\. Install it, sign in, then try again\./);
  assert.match(panel, /field\("This PC's Tailscale address", \[host, find\], detected\)/);
});

test('the firewall button copies only the rule with the saved port and explains where to run it', async () => {
  const start = panel.indexOf("  const firewall = btn('Copy firewall command'"), end = panel.indexOf('\n  let running', start);
  assert.ok(start >= 0 && end > start);
  const source = panel.slice(start, end), copied = [], notices = [], calls = [];
  assert.doesNotMatch(source, /token|copySettings|port\.value|info\.port/i);
  assert.match(source, /const \{ port \} = await call\('remote:info'\)/);
  const build = new Function('btn', 'call', 'toast', 'fail', `${source}; return firewall;`);
  let savedPort = 47616;
  const click = build((label, ic, action) => action, async (channel, text) => {
    calls.push(channel);
    if (channel === 'remote:info') return { port: savedPort };
    assert.equal(channel, 'app:copy'); copied.push(text);
  }, (text) => notices.push(text), (err) => { throw err; });
  for (const port of [47616, 65535]) {
    savedPort = port; await click();
    assert.equal(copied.at(-1), `New-NetFirewallRule -DisplayName "Understudy recorder" -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress 100.64.0.0/10 -Action Allow`);
    assert.equal(notices.at(-1), 'Copied. Run it in an administrator PowerShell on this PC.');
  }
  assert.deepEqual(calls, ['remote:info', 'app:copy', 'remote:info', 'app:copy']);
});

for (const initial of ['recorder', 'main']) test('voice source shows the saved value and saves changes: ' + initial, async () => {
  const start = panel.indexOf("segmented([['main',"), end = panel.indexOf(", 'Choose the other PC", start);
  assert.ok(start >= 0 && end > start);
  const expression = panel.slice(start, end), calls = [];
  let config = { settings: merge(DEFAULTS, initial === 'main' ? { remote: { micFrom: 'main' } } : {}) };
  assert.equal(config.settings.remote.micFrom, initial);
  const save = app.slice(app.indexOf('async function save(patch)'), app.indexOf('\n', app.indexOf('async function save(patch)')));
  const make = new Function('call', 'segmented', 'info', 'fail', 'let cfg; const S = () => ({ remote: info }); ' + save + '; return ' + expression + ';');
  const control = make(async (channel, patch) => {
    calls.push([channel, patch]); config.settings.remote = { ...config.settings.remote, ...patch.remote }; return config;
  }, (options, value, onchange) => ({ options, value, onchange }), config.settings.remote, (err) => { throw err; });
  assert.deepEqual(control.options, [['main', "This PC's microphone"], ['recorder', "The other PC's microphone"]]);
  assert.equal(control.value, initial);
  for (const micFrom of ['recorder', 'main']) {
    await control.onchange(micFrom);
    assert.deepEqual(calls.at(-1), ['settings:set', { remote: { micFrom } }]);
    assert.equal(config.settings.remote.micFrom, micFrom);
  }
  assert.ok(panel.includes('Choose the other PC if you speak into its microphone.'));
});

test('connection test calls, countdown and navigation cleanup are wired without data HTML', () => {
  assert.match(panel, /btn\('Test connection'/);
  assert.match(panel, /await call\('remote:test'\)/);
  assert.match(panel, /await call\('remote:testCancel'\)/);
  assert.match(panel, /testButton\.textContent = 'Stop'/);
  assert.match(panel, /testButton\.disabled = !info\.enabled/);
  assert.match(panel, /Waiting for the recorder\.\.\./);
  assert.match(panel, /countdown = setInterval\(tick, 1000\)/);
  assert.match(panel, /clearInterval\(countdown\)/);
  assert.match(panel, /finally \{\s*clearCountdown\(\)/);
  assert.match(panel, /remoteTestCleanup = \(\) => \{\s*disposed = true; clearCountdown\(\);\s*if \(running\) call\('remote:testCancel'\)/);
  const navigation = app.slice(app.indexOf('function go('), app.indexOf('function renderNav('));
  assert.match(navigation, /remoteTestCleanup\(\); remoteTestCleanup = null/);
  assert.match(panel, /status\.textContent = result\.message/);
  assert.doesNotMatch(panel, /innerHTML/);
});

test('the main renderer builds discovered content with DOM helpers and never innerHTML', () => {
  assert.doesNotMatch(app, /innerHTML/);
  assert.match(panel, /detected\.textContent = 'Tailscale/);
  assert.match(panel, /class: 'help remote-detected'/);
});


for (const initial of ['room', 'computer']) test('listen choice saves through settings:set and removes the voice row in room mode: ' + initial, async () => {
  const start = panel.indexOf("segmented([['room',"), end = panel.indexOf(", 'Choose the room", start);
  assert.ok(start >= 0 && end > start);
  const expression = panel.slice(start, end), calls = [], shown = [];
  let config = { settings: merge(DEFAULTS, { remote: { listen: initial } }) };
  const save = app.slice(app.indexOf('async function save(patch)'), app.indexOf('\n', app.indexOf('async function save(patch)')));
  const build = new Function('call', 'segmented', 'info', 'showVoice', 'fail', 'let cfg; ' + save + '; return ' + expression + ';');
  const control = build(async (channel, patch) => {
    calls.push([channel, patch]); config.settings.remote = { ...config.settings.remote, ...patch.remote }; return config;
  }, (options, value, onchange) => ({ options, value, onchange }), config.settings.remote,
  () => shown.push(config.settings.remote.listen), (err) => { throw err; });
  assert.deepEqual(control.options, [['room', 'The room, through its microphone'], ['computer', "The computer's audio"]]);
  assert.equal(control.value, initial);
  for (const listen of ['computer', 'room']) {
    await control.onchange(listen);
    assert.deepEqual(calls.at(-1), ['settings:set', { remote: { listen } }]); assert.equal(shown.at(-1), listen);
  }
  assert.match(panel, /voice\.replaceChildren\(\.\.\.\(S\(\)\.remote\.listen === 'computer' \? \[\s*field\('Your voice comes from'/);
  assert.ok(panel.includes('] : []))'));
});

test('next meeting notes reuse the renderer state on both audio tabs', () => {
  assert.ok(app.includes("hidden: !live?.active, text: 'Changes apply to the next meeting.'"));
  assert.ok(panel.includes('meetingChangeNote()'));
  assert.match(app, /panel\('Audio sources'[\s\S]*?meetingChangeNote\(\)/);
  assert.ok(app.includes("querySelectorAll('.next-meeting')) note.hidden = !live.active"));
});
