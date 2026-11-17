'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const raw = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const read = (rel) => raw(rel).replace(/\r\n/g, '\n');

// Minimal DOM stand-in so ui.js functions (h, segmented, speakerSlot, renderMarkdown) run in plain Node.
function makeDom() {
  class NodeStub {
    constructor(tag) {
      this.tagName = tag ? tag.toUpperCase() : '#fragment';
      this.nodeType = 1;
      this.children = [];
      this.childNodes = [];
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.className = '';
      this.tabIndex = 0;
      this.textContent = '';
      const self = this;
      this.classList = {
        toggle(cls, force) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          const add = force === undefined ? !set.has(cls) : Boolean(force);
          if (add) set.add(cls); else set.delete(cls);
          self.className = [...set].join(' ');
        },
        contains(cls) { return self.className.split(/\s+/).filter(Boolean).includes(cls); },
      };
    }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    addEventListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    removeEventListener(ev, fn) {
      const list = this.listeners.get(ev);
      if (list) this.listeners.set(ev, list.filter((x) => x !== fn));
    }
    append(...items) {
      for (const item of items) {
        if (item && item.tagName === '#fragment') {
          this.append(...item.childNodes);
        } else if (item && item.nodeType) {
          this.childNodes.push(item);
          if (item.nodeType === 1) this.children.push(item);
        } else {
          this.childNodes.push({ nodeType: 3, textContent: String(item) });
        }
      }
    }
    querySelectorAll(pred) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (pred(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }
  const document = {
    activeElement: null,
    body: new NodeStub('body'),
    documentElement: { dataset: {}, clientWidth: 1024, clientHeight: 768 },
    createElement: (tag) => new NodeStub(tag),
    createDocumentFragment: () => new NodeStub(''),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = {
    document,
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(read('src/renderer/ui.js'), ctx);
  return ctx;
}

test('hygiene and docs: .gitignore, recorder metadata, fixing-issues mode and updated docs', () => {
  const gi = read('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(gi.includes('dist/'), 'dist/ ignored');
  assert.ok(gi.includes('dist-recorder/'), 'dist-recorder/ ignored');

  const recPkg = JSON.parse(read('electron-builder.recorder.json'));
  assert.equal(recPkg.extraMetadata.description, 'Sends meeting audio from this PC to Understudy on your main PC.');

  const fixing = read('docs/fixing-issues.md');
  assert.match(fixing, /mode: questions/);
  assert.doesNotMatch(fixing, /mode: auto\b/);

  const claudeMd = read('CLAUDE.md');
  for (const mod of ['channel-plan.js', 'network-detect.js', 'recorder-entry.js', 'recorder-mode.js', 'remote-bridge.js', 'remote-config.js', 'remote-link.js', 'remote-test.js', 'src/recorder-preload.js', 'recorder-setup.*', 'electron-builder.recorder.json', 'dist:recorder', 'Understudy Recorder\\recorder.json']) {
    assert.ok(claudeMd.includes(mod), `CLAUDE.md mentions ${mod}`);
  }

  const readme = read('README.md');
  assert.doesNotMatch(readme, /point it at the meetings folder/);
  assert.match(readme, /point it at the Meetings folder/);
  for (const model of ['gpt-6.1-terra', 'gpt-6-astra', 'gemini-3.6-flash', 'gemini-3.8-flash']) {
    assert.ok(readme.includes(model), `README.md mentions ${model}`);
  }
  for (const entry of ['channel-plan.js', 'remote-link.js', 'recorder-mode.js', 'src/recorder-preload.js', 'electron-builder.recorder.json']) {
    assert.ok(readme.includes(entry), `README.md layout mentions ${entry}`);
  }
});

test('ui.js: speakerSlot is always 0..4 (including Speaker 0), segmented falls back to tabIndex 0, and renderMarkdown handles CommonMark fences', () => {
  const ui = makeDom();

  assert.equal(ui.speakerSlot('Speaker 0'), 4);
  assert.equal(ui.speakerSlot('Speaker 1'), 0);
  assert.equal(ui.speakerSlot('Speaker 2'), 1);
  assert.equal(ui.speakerSlot('Speaker 5'), 4);
  assert.equal(ui.speakerSlot('Speaker 6'), 0);
  for (const label of ['Speaker 0', 'Speaker 00', 'Guest 0', 'Priya', 'Them', '']) {
    const slot = ui.speakerSlot(label);
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < 5, `${label} -> ${slot}`);
  }

  const unmatched = ui.segmented([['a', 'Alpha'], ['b', 'Beta']], 'missing', () => {});
  assert.deepEqual(unmatched.children.map((b) => b.tabIndex), [0, -1]);
  assert.deepEqual(unmatched.children.map((b) => b.getAttribute('aria-checked')), ['false', 'false']);

  const matched = ui.segmented([['a', 'Alpha'], ['b', 'Beta']], 'b', () => {});
  assert.deepEqual(matched.children.map((b) => b.tabIndex), [-1, 0]);
  matched.setValue('unknown');
  assert.deepEqual(matched.children.map((b) => b.tabIndex), [0, -1]);

  // Inline triple backticks on one line must not swallow checkboxes below them into a code block.
  const seen = [];
  const frag1 = ui.renderMarkdown('```cmd```\n- [ ] Restart the service\n- [x] Verify logs (done: 2026-11-15)', {
    onTask: (idx, done, text) => seen.push([idx, done, text]),
  });
  const boxes1 = frag1.querySelectorAll((el) => el.getAttribute('role') === 'checkbox');
  assert.equal(boxes1.length, 2, 'both tasks below inline triple-backticks remain checkboxes');
  assert.equal(boxes1[0].dataset.task, '0');
  assert.equal(boxes1[1].dataset.task, '1');

  // Tilde fences and 4-backtick fences enclose task-like lines without miscounting real tasks after them.
  const frag2 = ui.renderMarkdown('~~~\n- [ ] Not a task inside tilde fence\n~~~\n````md\n```\n- [ ] Still inside 4-backtick fence\n````\n- [ ] Real task after fences', {
    onTask: () => {},
  });
  const boxes2 = frag2.querySelectorAll((el) => el.getAttribute('role') === 'checkbox');
  assert.equal(boxes2.length, 1);
  assert.equal(boxes2[0].dataset.task, '0');
});

test('app.js: Settings > Claude copy, IPv6 firewall rule, test cancellation, shortcut recorder, pinned 0-char note and stale render guards', async () => {
  const app = read('src/renderer/app.js');

  assert.doesNotMatch(app, /read-only connector/i);
  assert.ok(app.includes('Lets Claude read your meetings, notes and problem reports, tick off action items, add updates and save notes.'));
  assert.ok(app.includes("'aria-label': 'Open the Meetings folder'"));
  assert.ok(app.includes('Point it at the Meetings folder. The files are plain Markdown.'));

  // Firewall command uses fd7a:115c:a1e0::/48 for IPv6 and 100.64.0.0/10 for IPv4.
  const panel = app.slice(app.indexOf('async function remotePanel()'), app.indexOf('\nconst SETTINGS_TABS'));
  const fwStart = panel.indexOf("  const firewall = btn('Copy firewall command'"), fwEnd = panel.indexOf('\n  let running', fwStart);
  const buildFw = new Function('btn', 'call', 'toast', 'fail', `${panel.slice(fwStart, fwEnd)}; return firewall;`);
  let remoteInfo = { port: 47616, host: '100.64.1.2' };
  const copied = [];
  const clickFw = buildFw((_l, _i, fn) => fn, async (ch, arg) => {
    if (ch === 'remote:info') return remoteInfo;
    if (ch === 'app:copy') copied.push(arg);
  }, () => {}, (e) => { throw e; });

  await clickFw();
  assert.match(copied.at(-1), /-LocalPort 47616 -RemoteAddress 100\.64\.0\.0\/10 -Action Allow$/);
  remoteInfo = { port: 50000, host: 'fd7a:115c:a1e0::1' };
  await clickFw();
  assert.match(copied.at(-1), /-LocalPort 50000 -RemoteAddress fd7a:115c:a1e0::\/48 -Action Allow$/);

  // Changing host/port or making a new token cancels an active connection test.
  assert.match(panel, /host\.value = r\.host; port\.value = r\.port;[\s\S]*?if \(running\) await call\('remote:testCancel'\);/);
  assert.match(panel, /await call\('remote:newToken'\);\s*if \(running\) await call\('remote:testCancel'\);/);

  // Pinned folder with 0 files / 0 chars never claims "about 1 thousand characters".
  const pinSrc = app.slice(app.indexOf('  const pinned = lib.pinned || [];'), app.indexOf('  const skipped =', app.indexOf('  const pinned = lib.pinned || [];')));
  const evalPin = new Function('lib', 'Date', 'plural', 'agoText', `${pinSrc}; return pinNote;`);
  const zeroText = evalPin({ pinned: ['facts'], pinnedInfo: { files: 0, chars: 0, omitted: 0, newestMs: 0 } }, { now: () => 0 }, (n, one, many) => `${n} ${n === 1 ? one : many}`, () => '');
  assert.doesNotMatch(zeroText, /thousand characters/);
  assert.match(zeroText, /0 files go with every answer\./);

  // Shortcut recorder: bare Backspace clears, Ctrl+Alt+Backspace records, navigation keys work, disconnected button bails out.
  const srStart = app.indexOf('function shortcutRecorder(key)'), srEnd = app.indexOf('\n// ---- Find the fastest', srStart);
  let savedPatch = null;
  const winListeners = new Map();
  const makeRec = (connected = true) => {
    let cleanup = null;
    const fn = new Function('h', 'S', 'accelLabel', 'save', 'cfg', 'fail', 'window', 'setCleanup', `
      let shortcutCleanup = null;
      ${app.slice(srStart, srEnd)}
      const res = shortcutRecorder('take');
      setCleanup(() => shortcutCleanup);
      return res;
    `);
    const [btn] = fn(
      (tag) => {
        const listeners = {};
        return {
          tag, isConnected: connected, textContent: '',
          classList: { contains: (c) => Boolean(listeners[`cls:${c}`]), add: (c) => { listeners[`cls:${c}`] = true; }, remove: (c) => { listeners[`cls:${c}`] = false; } },
          addEventListener: (ev, cb) => { listeners[ev] = cb; },
          removeEventListener: (ev, cb) => { if (listeners[ev] === cb) delete listeners[ev]; },
          click: () => listeners.click && listeners.click(),
        };
      },
      () => ({ shortcuts: { take: 'Alt+Shift+T' } }),
      (a) => a,
      async (p) => { savedPatch = p; },
      {},
      (e) => { throw e; },
      {
        addEventListener: (ev, cb) => winListeners.set(ev, cb),
        removeEventListener: (ev, cb) => { if (winListeners.get(ev) === cb) winListeners.delete(ev); },
      },
      (g) => { cleanup = g; },
    );
    return { btn, getCleanup: () => cleanup() };
  };

  const r1 = makeRec(true);
  r1.btn.click();
  assert.equal(typeof r1.getCleanup(), 'function');
  await winListeners.get('keydown')({ key: 'Backspace', code: 'Backspace', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(savedPatch, { shortcuts: { take: 'Control+Alt+Backspace' } });

  r1.btn.click();
  await winListeners.get('keydown')({ key: 'Backspace', code: 'Backspace', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(savedPatch, { shortcuts: { take: '' } });

  for (const [code, expected] of [['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'], ['Insert', 'Insert']]) {
    r1.btn.click();
    await winListeners.get('keydown')({ key: code, code, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(savedPatch, { shortcuts: { take: `Control+Alt+${expected}` } });
  }

  savedPatch = null;
  const rDead = makeRec(false);
  rDead.btn.click();
  await winListeners.get('keydown')({ key: 'KeyM', code: 'KeyM', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(savedPatch, null, 'disconnected button does not save or stay listening');
  assert.equal(winListeners.has('keydown'), false);

  // micOptions reuses listMics instead of calling getUserMedia directly, and pages guard renderSeq after awaits.
  const micBlock = app.slice(app.indexOf('async function micOptions('), app.indexOf('function shortcutRecorder('));
  assert.match(micBlock, /await listMics\(\)/);
  assert.doesNotMatch(micBlock, /getUserMedia/);
  assert.ok((app.match(/if \(my !== renderSeq\) return;/g) || []).length >= 10, 'stale async render guards across pages');
  assert.match(app, /if \(meetingsCtx\) \{ meetingsCtx\.refresh\(m\.id\); meetingsCtx\.sync\(\); \}/);
});

test('overlay, CSS and HTML CSPs: stop catch, room meters, mentioned narrow header, dbody min-height and frame/object CSP', () => {
  const overlayJs = read('src/renderer/overlay.js');
  assert.ok(overlayJs.includes("call('meeting:stop').catch((err) => transient(err.message, true)).finally("));
  assert.match(overlayJs, /function syncMeters\(\)/);
  assert.ok(overlayJs.includes("me.title = room ? 'Room microphone' : 'Microphone'"));

  const overlayCss = read('src/renderer/overlay.css');
  assert.match(overlayCss, /\.meter\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(overlayCss, /body\.mentioned #clock,\s*body\.mentioned #meters/);

  const appCss = read('src/renderer/app.css');
  assert.match(appCss, /\.dbody\s*\{[^}]*min-height:\s*120px;/);

  const recCss = read('src/renderer/recorder-setup.css');
  assert.match(recCss, /main\s*\{[^}]*overflow-y:\s*auto;/);

  for (const htmlFile of ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/renderer/capture.html']) {
    const html = read(htmlFile);
    assert.ok(html.includes("object-src 'none'"), `${htmlFile} blocks object-src`);
    assert.ok(html.includes("frame-src 'none'"), `${htmlFile} blocks frame-src`);
  }
});

test('E2E scripts: current UI labels, pathToFileURL, Edge fallback and temp screenshot dir', () => {
  const e2eRun = read('test/e2e/run.js');
  assert.ok(e2eRun.includes("['Speech', '3b-settings-speech']"));
  assert.ok(e2eRun.includes("main.click('text=Start meeting')"));
  assert.doesNotMatch(e2eRun, /Speech and audio|text=Start listening|\.tiles\b|\.stylegrid\b/);

  const overlayUi = read('test/e2e/overlay-ui.js');
  assert.ok(overlayUi.includes('url.pathToFileURL('));
  assert.ok(overlayUi.includes("channel: 'msedge'"));
  assert.ok(overlayUi.includes("os.tmpdir(), 'understudy-overlay-'"));
  assert.doesNotMatch(overlayUi, /process\.argv\[2\] \|\| '\.'/);
});
