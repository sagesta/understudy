'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { fileURLToPath } = require('node:url');

const STATES = new Set(['off', 'starting', 'on', 'lost', 'error']);
const LABELS = { unset: 'Not set up', disconnected: 'Not connected', waiting: 'Connected, waiting', sending: 'Sending audio', sendingMic: 'Sending audio and microphone', sendingRoom: 'Sending audio from the microphone', paused: 'Paused' };
class ConfigError extends Error {}
function isTailscaleOrLoopback(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 45 || raw.includes('%')) return false;
  const v4Ok = (a, b) => a === 127 || (a === 100 && b >= 64 && b <= 127);
  const fam = isIP(raw);
  if (fam === 4) {
    const p = raw.split('.').map(Number);
    return p.length === 4 && v4Ok(p[0], p[1]);
  }
  if (fam !== 6) return false;
  let head = raw.toLowerCase(), v4Tail = null;
  if (head.includes('.')) {
    const idx = head.lastIndexOf(':');
    const v4 = head.slice(idx + 1);
    if (isIP(v4) !== 4) return false;
    const b = v4.split('.').map(Number);
    v4Tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    head = head.slice(0, idx);
    if (head.endsWith(':')) head += ':';
  }
  const halves = head.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':').map((x) => parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map((x) => parseInt(x, 16)) : [];
  if (v4Tail) right.push(...v4Tail);
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return false;
  const h = [...left, ...new Array(fill).fill(0), ...right];
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return true;
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) return v4Ok(h[6] >> 8, h[6] & 0xff);
  return h[0] === 0xfd7a && h[1] === 0x115c && h[2] === 0xa1e0;
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('Recorder settings must contain an address and a token.');
  const match = typeof value.url === 'string' && /^ws:\/\/(\[[\da-f:.]+\]|[\d.]+):(\d{1,5})$/i.exec(value.url);
  const host = match ? (match[1][0] === '[' ? match[1].slice(1, -1) : match[1]) : '';
  if (!match || (match[1][0] === '[' ? isIP(host) !== 6 : isIP(host) !== 4))
    throw new ConfigError('Use ws:// with an IPv4 or bracketed IPv6 address and a port. Do not include a path or user name.');
  if (!isTailscaleOrLoopback(host))
    throw new ConfigError('Use a Tailscale address (100.64.x.x or fd7a:115c:a1e0::) for the other PC.');
  if (+match[2] < 1024 || +match[2] > 65535) throw new ConfigError('Use a port from 1024 to 65535.');
  if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(value.token))
    throw new ConfigError('The token must contain 16 to 200 letters, numbers, underscores or hyphens.');
  return { url: value.url, token: value.token };
}

function createConfig({ dir, safeStorage }) {
  const file = path.join(dir, 'recorder.json'), logFile = path.join(dir, 'recorder.log');
  const available = () => safeStorage && safeStorage.isEncryptionAvailable();
  return {
    load() {
      try {
        if (fs.statSync(file).size > 8192) throw new Error();
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!available()) throw new ConfigError('Windows encryption is not available. Recorder settings cannot be opened or saved.');
        if (!value || !value.token || typeof value.token.enc !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.token.enc) || !value.token.enc)
          throw new Error();
        return validate({ url: value.url, token: safeStorage.decryptString(Buffer.from(value.token.enc, 'base64')) });
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        if (err instanceof ConfigError) throw err;
        throw new ConfigError('Saved recorder settings could not be opened. Paste them again.');
      }
    },
    save(raw) {
      const value = validate(raw);
      if (!available()) throw new ConfigError('Windows encryption is not available. Recorder settings cannot be saved.');
      const temp = file + '.tmp';
      try {
        // Only ciphertext reaches either file, even if the final rename fails.
        const data = { url: value.url, token: { enc: safeStorage.encryptString(value.token).toString('base64') } };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(temp, JSON.stringify(data) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch {
        try { fs.unlinkSync(temp); } catch { /* no temporary file */ }
        throw new ConfigError('Recorder settings could not be saved. Try pasting them again.');
      }
    },
    log(line) {
      // A closed vocabulary also prevents an old or edited log from retaining private text.
      const valid = (s) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (Not set up|Not connected|Connected, waiting|Sending audio|Sending audio and microphone|Sending audio from the microphone|Paused)$/.test(s);
      if (!valid(line)) return;
      try {
        let lines = [];
        try { if (fs.statSync(logFile).size < 32768) lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(valid); } catch { /* first state */ }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(logFile, [...lines.slice(-99), line].join('\n') + '\n', { mode: 0o600 });
      } catch { /* logging cannot keep a device open */ }
    }
  };
}

function createRecorder({ createSender, capture, config, tray, now = Date.now }) {
  let current = null, sender = null, connected = false, recording = false, paused = false, sending = false;
  let started = false, closed = false, linkGen = 0, captureGen = 0, mic = false, room = false, captureState = 'off', notice = '', lastState;
  const buffers = { me: Buffer.alloc(3200), them: Buffer.alloc(3200) }, used = { me: 0, them: 0 }, tokens = new Set();
  const clean = (s) => { for (const token of tokens) s = s.replaceAll(token, '[removed]'); return s.replace(/[\r\n\t]/g, ' ').slice(0, 200); };
  const state = () => !current ? 'unset' : !connected ? 'disconnected' : paused ? 'paused' : sending ? (room ? 'sendingRoom' : mic ? 'sendingMic' : 'sending') : 'waiting';
  function refresh() {
    const key = state(), label = LABELS[key];
    tray.update({ state: key, text: label + (notice ? '. ' + notice : ''), target: current ? current.url : '' });
    if (lastState !== key) {
      lastState = key;
      if (config.log) config.log(`${new Date(now()).toISOString()} ${label}`);
    }
  }
  function sendStatus(value) { if (sender) sender.sendStatus(value); }
  function halt() {
    const wasRecording = recording;
    recording = sending = mic = room = false; used.me = used.them = 0; captureState = 'off'; captureGen++;
    if (wasRecording) {
      // stop must cancel pending opens too. The Electron adapter destroys their window.
      try { Promise.resolve(capture.stop()).catch(() => {}); } catch { /* the gate is already closed */ }
    }
    sendStatus({ state: 'off' });
  }
  function failed(gen) {
    if (gen !== captureGen || !recording) return;
    const message = room ? 'Microphone could not be captured.' : 'Computer audio could not be captured.';
    halt(); notice = message; refresh();
  }
  function command(name, info = {}) {
    if (!connected || closed) return;
    if (name === 'pause' || name === 'stop') { halt(); paused = name === 'pause'; refresh(); }
    else if (name === 'start' || name === 'resume') {
      const nextRoom = info?.room === true, nextMic = nextRoom || info?.mic === true;
      if (recording && mic === nextMic && room === nextRoom) return;
      if (recording) halt();
      mic = nextMic; room = nextRoom; recording = true; paused = false; captureState = 'starting'; notice = '';
      const gen = ++captureGen;
      sendStatus({ state: 'starting' }); refresh();
      try { Promise.resolve(capture.start({ mic, system: !room })).then((ok) => { if (ok === false) failed(gen); }, () => failed(gen)); }
      catch { failed(gen); }
    }
  }
  function connect(value) {
    linkGen++;
    halt();
    if (sender) sender.stop();
    current = value; tokens.add(value.token); connected = paused = false;
    const gen = linkGen;
    // No offline ring: audio authorised by an earlier meeting must never cross a reconnect.
    sender = createSender({ ...value, pc: 'Recorder', keepBlocks: 0,
      onCommand(name, info) { if (gen === linkGen) command(name, info); },
      onState(value) {
        if (gen !== linkGen || closed) return;
        if (value === 'connected') { connected = true; sendStatus({ state: 'off' }); }
        else { connected = paused = false; halt(); }
        refresh();
      }
    });
    refresh(); sender.start();
  }
  return {
    start() {
      if (started || closed) return;
      started = true;
      try { const value = config.load(); if (value) { connect(validate(value)); return; } }
      catch (err) { notice = err instanceof ConfigError ? err.message : 'Saved recorder settings could not be opened. Paste them again.'; }
      refresh();
    },
    paste(text) {
      if (closed) return false;
      if (typeof text !== 'string' || !text.trim()) {
        notice = 'Copy the recorder settings from Understudy first, then paste them here.';
        refresh();
        return false;
      }
      let value;
      try { value = JSON.parse(text); }
      catch { notice = 'That text is not recorder settings from Understudy. Copy them from Settings and paste again.'; refresh(); return false; }
      try { value = validate(value); config.save(value); }
      catch (err) { notice = err instanceof ConfigError ? err.message : 'Recorder settings could not be saved. Try pasting them again.'; refresh(); return false; }
      notice = ''; connect(value); return true;
    },
    audio(channel, raw) {
      if (!connected || !recording || closed) return;
      if (room ? channel !== 'me' : (channel !== 'them' && (channel !== 'me' || !mic))) return;
      // Room audio uses one accumulator and the diarised stream, never the owner's stream.
      if (room) channel = 'them';
      const bytes = buffers[channel], gen = captureGen;
      const chunk = raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null;
      if (!chunk) return;
      // Carry bytes, not typed-array views: an IPC split can land halfway through a sample.
      for (let pos = 0; pos < chunk.length && connected && recording && gen === captureGen; ) {
        const count = Math.min(bytes.length - used[channel], chunk.length - pos);
        chunk.copy(bytes, used[channel], pos, pos + count); used[channel] += count; pos += count;
        if (used[channel] !== bytes.length) continue;
        const block = new Int16Array(1600);
        for (let i = 0; i < block.length; i++) block[i] = bytes.readInt16LE(i * 2);
        used[channel] = 0;
        if (sender.push(channel, block) && connected && recording && gen === captureGen && !sending) { sending = true; refresh(); }
      }
    },
    status(value) {
      if (!value || closed) return;
      if (!recording || !connected) { sendStatus({ state: 'off' }); return; }
      const channels = value.channels, source = room ? 'me' : 'them';
      if (channels && (channels[source] === 'error' || (!room && mic && channels.me === 'error'))) {
        const hint = typeof value.hint === 'string' ? value.hint : typeof value.message === 'string' ? value.message : undefined;
        const micOnly = !room && mic && channels.me === 'error' && channels[source] !== 'error';
        halt();
        notice = room || micOnly ? 'Microphone could not be captured.' : 'Computer audio could not be captured.';
        refresh();
        sendStatus({ state: 'error', ...(hint === undefined ? {} : { hint: clean(hint) }) });
        return;
      }
      if (channels && !Object.hasOwn(channels, source)) return;
      const next = channels ? channels[source] : captureState;
      if (!STATES.has(next)) return;
      const hint = typeof value.hint === 'string' ? value.hint : typeof value.message === 'string' ? value.message : undefined;
      if (!channels && hint === undefined) return;
      captureState = next;
      if (next !== 'on') { sending = false; refresh(); }
      sendStatus({ state: next, ...(hint === undefined ? {} : { hint: clean(hint) }) });
    },
    stop() {
      if (closed) return;
      closed = true; linkGen++; halt(); connected = paused = false;
      if (sender) sender.stop();
    },
    state: () => ({ state: state(), connected, recording })
  };
}

function run() {
  const { app, BrowserWindow, ipcMain, desktopCapturer, session, safeStorage, clipboard, Tray, Menu, nativeImage } = require('electron');
  app.setName('Understudy Recorder');
  app.setPath('userData', !app.isPackaged && process.env.UNDERSTUDY_DATA_DIR ? path.resolve(process.env.UNDERSTUDY_DATA_DIR) : path.join(app.getPath('appData'), 'Understudy Recorder'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const { createSender } = require('./remote-link');
  const captureFile = path.join(__dirname, '..', 'renderer', 'capture.html');
  const setupFile = path.join(__dirname, '..', 'renderer', 'recorder-setup.html');
  let win = null, setup = null, icon = null, recorder = null, quitting = false, ready = false, autoStart = false;
  let display = { state: 'unset', text: LABELS.unset, target: '' }, setupNotice = '';
  const getState = () => ({ state: display.state, label: LABELS[display.state],
    message: setupNotice || display.text.slice(LABELS[display.state].length + 2), autoStart });
  function openSetup() {
    if (quitting) return;
    if (setup && !setup.isDestroyed()) {
      if (typeof setup.isMinimized === 'function' && setup.isMinimized() && typeof setup.restore === 'function') setup.restore();
      setup.show(); setup.focus(); return;
    }
    const mine = setup = new BrowserWindow({ show: false, width: 420, height: 380, useContentSize: true,
      title: 'Understudy Recorder', resizable: false, autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, '..', 'recorder-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    mine.setMenu(null);
    mine.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mine.webContents.on('will-navigate', (e) => e.preventDefault());
    mine.on('close', (e) => { if (!quitting) { e.preventDefault(); mine.hide(); } });
    mine.on('closed', () => { if (setup === mine) setup = null; });
    mine.loadFile(setupFile).then(() => {
      if (setup === mine && !quitting && !mine.isDestroyed()) { mine.show(); mine.focus(); }
    }).catch(() => { if (!mine.isDestroyed()) mine.destroy(); });
  }
  function updateView() {
    const { state, text, target } = display;
    icon.setImage(images[state]); icon.setToolTip(`${text}${target ? '\n' + target : ''}`);
    icon.setContextMenu(Menu.buildFromTemplate([
      { label: text, enabled: false },
      { label: 'Open', click: openSetup },
      { label: 'Paste settings from clipboard', click: pasteFromClipboard },
      { label: 'Start with Windows', type: 'checkbox', checked: autoStart, click: (item) => setAutoStart(item.checked) },
      { label: 'Quit', click: () => app.quit() }
    ]));
    // Only this closed status shape crosses to setup. Never send the config or clipboard text.
    if (setup && !setup.isDestroyed()) setup.webContents.send('recorder:state', getState());
  }
  function applyText(text) {
    if (typeof text !== 'string' || text.length > 2000) {
      setupNotice = 'Use settings text of at most 2,000 characters.'; updateView(); return false;
    }
    setupNotice = '';
    return recorder.paste(text);
  }
  function pasteFromClipboard() {
    try {
      const text = clipboard.readText();
      if (applyText(text) && clipboard.readText() === text) clipboard.clear();
    } catch { setupNotice = 'Clipboard text could not be read or cleared. Try again.'; updateView(); }
    return getState();
  }
  function setAutoStart(openAtLogin) {
    if (typeof openAtLogin !== 'boolean') throw new TypeError('Choose whether to start with Windows.');
    // The main executable needs its recorder flag again when Windows starts it.
    try { app.setLoginItemSettings(process.argv.includes('--recorder') ? { openAtLogin, args: ['--recorder'] } : { openAtLogin }); autoStart = openAtLogin; setupNotice = ''; }
    catch { setupNotice = 'Start with Windows could not be changed. Try again.'; }
    updateView(); return getState();
  }
  let images;
  const capture = {
    async start({ mic, system }) {
      const mine = win = new BrowserWindow({ show: false, width: 300, height: 200,
        webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      mine.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      mine.webContents.on('will-navigate', (e) => e.preventDefault());
      mine.webContents.on('render-process-gone', () => {
        if (win !== mine) return;
        capture.stop(); recorder.status({ channels: { [system ? 'them' : 'me']: 'error' }, message: system ? 'Computer audio capture stopped.' : 'Microphone capture stopped.' });
      });
      mine.on('closed', () => { if (win === mine) win = null; });
      await mine.loadFile(captureFile);
      if (win !== mine || mine.isDestroyed()) return false;
      return mine.webContents.executeJavaScript(`window.startCapture({ mic: ${mic === true}, system: ${system === true} })`, true);
    },
    stop() {
      // Destroying also cancels a still-loading page and releases tracks before any next start.
      const mine = win; win = null;
      if (mine && !mine.isDestroyed()) mine.destroy();
    }
  };
  const ownPage = (wc, url) => {
    try { return !!win && wc === win.webContents && fileURLToPath(url) === captureFile; } catch { return false; }
  };
  app.on('second-instance', () => { if (ready) openSetup(); });
  app.on('window-all-closed', () => {}); // stopping capture must leave the tray and reconnect loop alive
  app.on('before-quit', () => { quitting = true; if (recorder) recorder.stop(); capture.stop(); if (setup && !setup.isDestroyed()) setup.destroy(); if (icon) icon.destroy(); });
  return app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(['media', 'display-capture'].includes(permission) && ownPage(wc, details?.requestingUrl || wc?.getURL())));
    ses.setPermissionCheckHandler((wc, permission, origin, details) => ['media', 'display-capture'].includes(permission) && ownPage(wc, details?.requestingUrl || wc?.getURL()));
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const allowed = () => win && request.frame === win.webContents.mainFrame && ownPage(win.webContents, request.frame.url);
      const deny = () => { try { callback({}); } catch { /* the page may have been stopped */ } };
      if (!allowed()) return deny();
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        if (!allowed() || !sources.length) return deny();
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(deny);
    });
    const colours = { unset: [140, 140, 140], disconnected: [220, 65, 65], waiting: [65, 140, 220], sending: [35, 185, 90], sendingMic: [35, 185, 90], sendingRoom: [35, 185, 90], paused: [235, 165, 35] };
    images = Object.fromEntries(Object.entries(colours).map(([key, rgb]) => {
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 < 49) {
        const pos = (y * 16 + x) * 4;
        pixels[pos] = rgb[2]; pixels[pos + 1] = rgb[1]; pixels[pos + 2] = rgb[0]; pixels[pos + 3] = 255;
      }
      return [key, nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 })];
    }));
    // No capture is possible if creating the visible privacy indicator fails.
    icon = new Tray(images.unset);
    if (typeof icon.on === 'function') icon.on('click', openSetup);
    autoStart = !!(process.argv.includes('--recorder') ? app.getLoginItemSettings({ args: ['--recorder'] }) : app.getLoginItemSettings()).openAtLogin;
    recorder = createRecorder({ createSender, capture, config: createConfig({ dir: app.getPath('userData'), safeStorage }),
      tray: { update(value) { if (display.state !== value.state) setupNotice = ''; display = value; updateView(); } }
    });
    ready = true;
    const ownSetup = (e) => {
      try { return !!setup && e.sender === setup.webContents && e.senderFrame === setup.webContents.mainFrame && fileURLToPath(e.senderFrame.url) === setupFile; }
      catch { return false; }
    };
    const noArgs = (args) => args.length === 0;
    const handle = (channel, check, fn) => ipcMain.handle(channel, (e, ...args) => {
      if (!ownSetup(e) || !check(args)) throw new TypeError('Recorder request is not valid.');
      return fn(...args);
    });
    handle('recorder:paste', noArgs, pasteFromClipboard);
    handle('recorder:connect', (args) => args.length === 1 && typeof args[0] === 'string' && args[0].length <= 2000,
      (text) => { applyText(text); return getState(); });
    handle('recorder:state', noArgs, getState);
    handle('recorder:autoStart', (args) => args.length === 1 && typeof args[0] === 'boolean', setAutoStart);
    ipcMain.on('audio', (e, channel, bytes) => { if (win && e.sender === win.webContents) recorder.audio(channel, bytes); });
    ipcMain.on('capture:status', (e, value) => { if (win && e.sender === win.webContents) recorder.status(value); });
    recorder.start();
    if (recorder.state().state === 'unset') openSetup();
  }).catch(() => { app.quit(); });
}

module.exports = { run, createRecorder, createConfig };
