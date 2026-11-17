'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, screen, dialog, shell, safeStorage, clipboard, nativeTheme, Tray, Menu, nativeImage } = require('electron');
if (process.argv.includes('--recorder')) { require('./recorder-mode').run(); return; }
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const { Settings, DEFAULTS, writeAtomic } = require('./settings');
const { createRemoteConfig } = require('./remote-config');
const { createConnectionTest } = require('./remote-test');
const { tailscaleAddresses } = require('./network-detect');
const { channelPlan } = require('./channel-plan');
const { createBridge } = require('./remote-bridge');
const { createListener } = require('./remote-link');
const { Library, buildSources, countNoteFiles } = require('./knowledge/library');
const { createImageReader } = require('./knowledge/images');
const inbox = require('./notes-inbox');
const issues = require('./issues');
const { MeetingStore, isSuperseded, useGeneratedTitle } = require('./meetings/store');
const { watchMeetings } = require('./meetings/watch');
const { openForRewrite, rewriteSaved } = require('./meetings/carry-over');
const { generateNotes, transcriptMdToPlain } = require('./meetings/notes');
const { MeetingSession } = require('./session');
const { MODES: AUTO_MODES } = require('./triggers');
const { createLlm, PROVIDERS: LLM_PROVIDERS } = require('./llm');
const { runSpeedTest, defaultCandidates } = require('./llm/speedtest');
const { PROVIDERS: STT_PROVIDERS, createStream } = require('./stt');
const { profilePrompt, ACTIONS } = require('./prompts');
const V = require('./validate');
const claude = require('./claude-connect');
const { createSharedFolder } = require('./shared-folder');
const { createLiveCopy, liveFileName } = require('./live-copy');
const { createKeyChecker, openKeyPage, probeKey } = require('./keycheck');
const { cleanBounds, restoreWindow, windowState, createTrayHint } = require('./window-state');

app.setName('Understudy');
// Provider SDKs read their address, extra headers and logging from the
// environment. Stored keys must only ever go where the app sends them, so
// those variables are dropped before anything else runs.
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE_GENAI)_/i.test(k)) delete process.env[k];
// Hooks for automated tests. They do nothing in an installed build.
const DEV = !app.isPackaged;
if (DEV && process.env.UNDERSTUDY_DATA_DIR) app.setPath('userData', process.env.UNDERSTUDY_DATA_DIR);
if (DEV && process.env.UNDERSTUDY_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.UNDERSTUDY_FAKE_AUDIO);
}
// Every crash leaves a file in <userData>/logs. Native crashes (the engine
// itself dying) leave a minidump in Crashpad's folder; nothing is uploaded.
const { CrashLog } = require('./crashlog');
const crashLog = new CrashLog(path.join(app.getPath('userData'), 'logs'), {
  version: app.getVersion(),
  context: () => `meeting ${typeof meeting !== 'undefined' && meeting && meeting.active ? 'active' : 'idle'}`,
});
crashLog.attach(app);
try { require('electron').crashReporter.start({ uploadToServer: false, submitURL: '', compress: true }); } catch { /* optional */ }
// A large library is held in memory as a search index; do not let the default heap limit get in the way.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
// The capture window is hidden, so its audio graph must start without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const BUILTIN_PERSONALITIES = path.join(__dirname, '..', '..', 'personalities');

let settings, remoteConfig, connectionTest, library, store, llm, meeting, imageReader;
let imageError = ''; // the first problem the picture reader reported during the current library pass
let speedRun = null, speedLast = null; // the running model speed test (its AbortController) and the last finished result
let appWin = null, overlayWin = null, captureWin = null;
let captureStatus = { me: 'off', them: 'off' };
let captureChannels = [];
let capturePlan = null;
let bridge = null; // fixed for the meeting, even if Settings changes while it is running
let audioMap = { me: 'me', them: 'them' };
let libraryBusy = null;
let notesJobs = new Map();
let meetingsWatch = null; // tells the Meetings page when a meeting file changes on disk (meetings/watch.js)
let liveCopy = null; // keeps _live-<PC>.md in the Meetings folder up to date while a meeting runs (live-copy.js)
let tray = null;
let quitting = false;
let trayHint = () => false; // says once per meeting that the window was closed and the app is still listening (set up with the meeting)

// ---------------------------------------------------------------- helpers
const userDir = (...p) => path.join(app.getPath('userData'), ...p);
const sttOverride = () => (DEV && process.env.UNDERSTUDY_STT_URL) || undefined;
const meetingsDir = () => settings.get().meetingsDir || (DEV && process.env.UNDERSTUDY_DATA_DIR ? path.join(process.env.UNDERSTUDY_DATA_DIR, 'Meetings') : path.join(app.getPath('documents'), 'Understudy', 'Meetings'));
// The Notes folder: the person's choice, else Documents\Understudy\Notes. A test run (its own data folder)
// never touches the real Documents: its default is a folder inside the test data.
const notesDir = () => settings.get().notesDir || (DEV && process.env.UNDERSTUDY_DATA_DIR ? path.join(process.env.UNDERSTUDY_DATA_DIR, 'Notes') : inbox.defaultNotesDir(app.getPath('documents')));
// In-progress transcripts stay on this machine: not in the roaming profile.
const liveDir = () => (process.platform === 'win32' && process.env.LOCALAPPDATA && !(DEV && process.env.UNDERSTUDY_DATA_DIR) ? path.join(process.env.LOCALAPPDATA, 'Understudy', 'live') : userDir('live'));
// The Issues folder (issues.js): a file for every unexpected problem, next to the Notes and Meetings folders, for Claude to
// read and fix. Not a setting. A test run keeps it inside its own data folder. The crash log above is kept as it is.
const issuesDir = () => issues.issuesDirFor({ notesDir: notesDir(), dev: DEV, dataDir: process.env.UNDERSTUDY_DATA_DIR });
const crumbs = issues.createBreadcrumbs({ max: 60 }); // the last 60 things the app did: channel and event names with their outcome, never arguments or text
const issueReporter = issues.createReporter({
  dir: () => (settings ? issuesDir() : ''), // not known before the settings are loaded
  breadcrumbs: () => crumbs.list(),
  // Only provider names, model names, the mode and switches: never a name, folder, profile, key or text.
  info: () => {
    const s = settings ? settings.get() : null;
    const llm = (s && s.llm) || {};
    return {
      appVersion: app.getVersion(),
      context: {
        meetingActive: Boolean(meeting && meeting.active),
        mode: s && s.copilot ? s.copilot.autoMode : undefined, live: llm.live, notes: llm.notes, speech: s && s.stt ? s.stt.provider : undefined,
        webSearch: s && s.llm ? s.llm.webSearch !== false : undefined, overlayVisible: Boolean(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()),
      },
    };
  },
  onFail: (e) => { crashLog.write('issues-folder', e); }, // a problem with the folder itself goes to the local log only
});
crashLog.reporter = (err, where, kind) => issueReporter.report(err, where, { kind });
const reportCaught = (err, where) => { try { issueReporter.report(err, where, { kind: 'error' }); } catch { /* reporting never stops the app */ } };
try { require('./knowledge/diagrams')._pool.pool.onError = (e) => reportCaught(e, 'worker:diagram'); } catch { /* the diagram reader is optional */ }
// Events that fire many times a second would fill the 60 breadcrumbs with nothing.
const QUIET_EVENTS = new Set(['levels', 'partial', 'card-delta', 'profile-delta', 'cost']);
function noteEvent(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (!QUIET_EVENTS.has(msg.type)) crumbs.add('event', msg.type === 'error' && typeof msg.where === 'string' ? `error ${msg.where}` : msg.type);
  // A message that tells of a mistake in the code ("x is not a function") is recorded; provider and user messages are not (issues.isBug).
  const said = typeof msg.message === 'string' && (msg.type === 'error' || msg.status === 'error' || msg.state === 'error') ? msg.message : '';
  const bug = said && issues.errorFromMessage(said);
  if (bug) reportCaught(bug, `event:${msg.type}`);
  // A meeting that could not be saved when it ended (the autosave is kept and recovered at the next start).
  if (msg.type === 'meeting-ended' && msg.error) {
    const code = /\b(E[A-Z]{3,})\b/.exec(String(msg.error));
    reportCaught({ name: 'MeetingSaveError', message: `The transcript could not be saved when the meeting ended${code ? ` (${code[1]})` : ''}.` }, 'save');
  }
}

// Which of the app's own pages a URL is ('' for anything else). Compared as
// file paths, because URL strings for the same file differ in escaping and,
// on Windows, in drive-letter case.
const pageOf = (url) => {
  try {
    const rel = path.relative(RENDERER, fileURLToPath(String(url).split(/[?#]/)[0]));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[\\/]/.test(rel) ? rel.toLowerCase() : '';
  } catch { return ''; }
};

function broadcast(msg) {
  try { noteEvent(msg); } catch { /* a breadcrumb or a report never stops an event */ }
  for (const w of [appWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('evt', msg);
}

function readProfile() { try { return fs.readFileSync(userDir('profile.md'), 'utf8'); } catch { return ''; } }

function parsePersonality(file, builtin) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head = m ? m[1] : '';
  const get = (k) => { const x = head.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')); return x ? x[1].trim() : ''; };
  const id = path.basename(file, '.md');
  return { id, name: get('name') || id, description: get('description'), text: (m ? m[2] : raw).trim(), builtin };
}

function listPersonalities() {
  const out = new Map();
  for (const [dir, builtin] of [[BUILTIN_PERSONALITIES, true], [userDir('personalities'), false]]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) { try { const p = parsePersonality(path.join(dir, f), builtin); out.set(p.id, { ...p, overridden: !builtin && out.has(p.id) }); } catch {} }
  }
  const list = [...out.values()];
  list.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.name.localeCompare(b.name)));
  return list;
}

function personalityText(id) {
  const p = listPersonalities().find((x) => x.id === id);
  return p ? p.text : '';
}

// The person's folders, the meetings, and always the Notes folder (see buildSources for how overlaps are handled).
function librarySources() {
  const s = settings.get();
  // The folder is made here, not only when the first note is saved: Claude's connector may be the one that saves
  // it, and a folder that exists is one the watcher can see.
  try { fs.mkdirSync(notesDir(), { recursive: true }); } catch { /* a drive that is not there (a synced folder offline): the folder is simply absent for now */ }
  return buildSources({ folders: s.library.folders, includeMeetings: s.library.includeMeetings, meetingsDir: meetingsDir(), notesDir: notesDir() });
}

// A request that arrives while a pass is running is not dropped: the pass is
// repeated once it finishes, so a folder removed a moment ago is really gone.
let libraryDirty = false;
function reindexLibrary() {
  if (libraryBusy) { libraryDirty = true; return libraryBusy; }
  broadcast({ type: 'library', busy: true });
  // Reading pictures (when the switch is on) can take minutes; the screen is told, and told again when it ends.
  const picturesOn = () => Boolean(imageReader) && settings.get().library.readImages === true;
  let reading = false;
  libraryBusy = (async () => {
    try {
      let stats;
      // Text files are in the index before the first picture is read, so the screen can say so at once.
      const onTextDone = () => { if (picturesOn()) broadcast({ type: 'library', busy: true, stats: libraryStats() }); };
      do {
        libraryDirty = false;
        if (!reading && picturesOn()) { reading = true; imageError = ''; broadcast({ type: 'images', state: 'working', stats: imageReader.stats() }); }
        stats = await library.reindex(librarySources(), { onTextDone });
      } while (libraryDirty);
      library.watch(() => reindexLibrary());
      return stats;
    } finally {
      libraryBusy = null;
      broadcast({ type: 'library', busy: false, stats: libraryStats() });
      if (reading) broadcast({ type: 'images', state: imageError ? 'error' : 'done', ...(imageError ? { message: imageError } : {}), stats: imageReader.stats() });
    }
  })();
  return libraryBusy;
}
// For callers that do not wait for the pass (a note was just saved): it must never end as an unhandled rejection.
function reindexSoon() { reindexLibrary().catch(() => {}); }

// The folders marked "always include" that are still in the library (a folder removed or renamed drops out by itself).
function pinnedFolders() {
  const lib = settings.get().library;
  return (Array.isArray(lib.pinned) ? lib.pinned : []).filter((d) => typeof d === 'string' && (lib.folders || []).includes(d));
}

function libraryStats() {
  const sum = library.summary();
  return {
    files: sum.workFiles,
    chunks: sum.workChunks,
    meetingChunks: sum.meetingChunks,
    words: Math.round(sum.workChars / 6),
    skipped: library.stats.skipped.slice(0, 20),
    skippedCount: library.stats.skipped.length,
    redacted: library.stats.redacted || 0,
    indexedAt: library.stats.indexedAt,
    folders: settings.get().library.folders,
    pinned: pinnedFolders(),
    pinnedInfo: (({ items, chars, omitted, newestMs }) => ({ files: items.length, chars, omitted, newestMs }))(library.pinned(pinnedFolders())),
  };
}

function publicSettings() {
  return {
    settings: settings.get(),
    secrets: settings.secretsPresent(),
    secretsEncrypted: settings.secretsEncrypted(),
    llmProviders: Object.fromEntries(Object.entries(LLM_PROVIDERS).map(([k, v]) => [k, { label: v.label, secret: v.secret, suggested: v.suggested, known: v.known }])),
    sttProviders: Object.fromEntries(Object.entries(STT_PROVIDERS).map(([k, v]) => [k, { label: v.label, secret: v.secret, streaming: v.streaming, speakers: v.speakers, defaultModel: v.defaultModel, perMinute: v.perMinute, billing: v.billing }])),
    meetingsDir: meetingsDir(),
    platform: process.platform,
  };
}

// ---------------------------------------------------------------- windows
function webPrefs(extra = {}) {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra };
}

function lockDown(win) {
  // The windows only ever show the app's own pages; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  const stay = (e, url) => { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {}); };
  win.webContents.on('will-navigate', stay);
  win.webContents.on('will-redirect', stay);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

function createAppWindow() {
  const theme = settings.get().appearance.theme;
  const light = theme === 'light' || (theme !== 'dark' && !nativeTheme.shouldUseDarkColors);
  // Where it was last time (size, place, maximised), if that place is still on a connected screen.
  const { bounds, maximized } = restoreWindow(settings.get().appWindow, screen.getAllDisplays().map((d) => d.workArea));
  const win = appWin = new BrowserWindow({ ...bounds, minWidth: 960, minHeight: 620, backgroundColor: light ? '#f4f5f8' : '#0a0b0f', title: 'Understudy', autoHideMenuBar: true, icon: path.join(ASSETS, 'icon.png'), webPreferences: webPrefs() });
  if (maximized) win.maximize();
  lockDown(win);
  win.loadFile(path.join(RENDERER, 'app.html'));
  // Written a moment after a move or resize, and again as the window closes. Not settable from a window (see SETTABLE).
  const saveBounds = () => { try { const st = !win.isDestroyed() && windowState(win); if (st) settings.set({ appWindow: st }); } catch { /* try again on the next move */ } };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(saveBounds, 600); };
  for (const ev of ['resized', 'moved', 'maximize', 'unmaximize']) win.on(ev, later);
  win.on('close', () => { clearTimeout(t); saveBounds(); });
  win.on('hide', () => trayHint());
  win.on('closed', () => {
    if (appWin === win) appWin = null;
    const busy = Boolean(meeting && (meeting.active || meeting.stopping)) || Boolean(typeof notesJobs !== 'undefined' && notesJobs && notesJobs.size);
    if (!busy) { app.quit(); return; }
    // A meeting is still being recorded: never leave that running out of sight.
    if (meeting && meeting.active) {
      toggleOverlay(true);
      trayHint();
    }
    refreshTray();
  });
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const saved = cleanBounds(settings.get().overlay.bounds);
  const area = screen.getPrimaryDisplay().workArea;
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const maxW = Math.max(460, ...areas.map((a) => a.width));
  const maxH = Math.max(420, ...areas.map((a) => a.height));
  const b = saved
    ? { x: saved.x, y: saved.y, width: Math.min(Math.max(380, saved.width), maxW), height: Math.min(Math.max(420, saved.height), maxH) }
    : { width: 460, height: Math.min(680, area.height - 80), x: area.x + area.width - 480, y: area.y + 40 };
  // Keep the window on a screen that still exists.
  const visible = screen.getAllDisplays().some((d) => b.x < d.workArea.x + d.workArea.width - 60 && b.x + b.width > d.workArea.x + 60 && b.y >= d.workArea.y - 10 && b.y < d.workArea.y + d.workArea.height - 60);
  if (!visible) { b.x = area.x + area.width - b.width - 20; b.y = area.y + 40; }
  overlayWin = new BrowserWindow({
    ...b, minWidth: 380, minHeight: 420, frame: false, show: false, resizable: true, skipTaskbar: true,
    backgroundColor: '#0d0f14', title: 'Understudy overlay', alwaysOnTop: true, fullscreenable: false, maximizable: false,
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  lockDown(overlayWin);
  // Above full-screen meeting windows and slide shows.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the overlay (your notes, the transcript, private questions) out of
  // screen shares and recordings. Other people see the window behind it.
  overlayWin.setContentProtection(settings.get().overlay.hideFromCapture !== false);
  overlayWin.setOpacity(Math.min(1, Math.max(0.4, settings.get().overlay.opacity || 0.94)));
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  const saveBounds = () => { try { if (overlayWin && !overlayWin.isDestroyed()) settings.set({ overlay: { bounds: overlayWin.getBounds() } }); } catch { /* try again on the next move */ } };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(saveBounds, 600); };
  overlayWin.on('moved', later); overlayWin.on('resized', later);
  overlayWin.on('closed', () => { overlayWin = null; });
  return overlayWin;
}

function createCaptureWindow() {
  const win = captureWin = new BrowserWindow({ show: false, width: 300, height: 200, webPreferences: webPrefs({ backgroundThrottling: false }) });
  lockDown(win);
  win.loadFile(path.join(RENDERER, 'capture.html'));
  win.webContents.on('render-process-gone', () => {
    if (captureWin !== win) return;
    captureWin = null;
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
    if (quitting) return;
    createCaptureWindow();
    if (meeting && meeting.active && !meeting.paused && !meeting.stopping && captureChannels.length) {
      startCapture(captureChannels).catch(() => {});
    }
  });
  win.on('closed', () => { if (captureWin === win) captureWin = null; });
}

function setupMedia() {
  const ses = session.defaultSession;
  // Only the app's own pages get anything, and each page only what it needs:
  // the capture window records, the main window lists microphones.
  const allowed = (url, permission) => {
    const page = pageOf(url);
    if (permission === 'media') return page === 'capture.html' || page === 'app.html';
    if (permission === 'display-capture') return page === 'capture.html';
    if (permission === 'clipboard-sanitized-write') return Boolean(page);
    return false;
  };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed((details && details.requestingUrl) || (wc && wc.getURL()), permission)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) => allowed((details && details.requestingUrl) || (wc && wc.getURL()) || '', permission));
  // "Share your screen with audio" answered in code: the first screen, plus
  // the computer's audio output (loopback). The picture is discarded by the
  // capture window; only the sound is used.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const deny = () => { try { callback({}); } catch { /* a refused request surfaces as an error in the page */ } };
    if (!request.frame || pageOf(request.frame.url) !== 'capture.html') return deny();
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => { if (!sources.length) return deny(); callback({ video: sources[0], audio: 'loopback' }); })
      .catch(deny);
  });
}

async function startCapture(channels) {
  if (!captureWin) createCaptureWindow();
  if (captureWin.webContents.isLoading()) await new Promise((r) => captureWin.webContents.once('did-finish-load', r));
  const a = settings.get().audio;
  const opts = { mic: channels.includes('me'), system: channels.includes('them'), micDeviceId: a.micDeviceId || 'default' };
  // Run as a user gesture so screen-audio capture is allowed from a hidden window.
  await captureWin.webContents.executeJavaScript(`window.startCapture(${JSON.stringify(opts)})`, true).catch((e) => broadcast({ type: 'error', where: 'capture', message: `Audio capture failed to start: ${e.message}` }));
}

function stopCapture() {
  if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.executeJavaScript('window.stopCapture && window.stopCapture()', true).catch(() => {});
  captureStatus = { me: 'off', them: 'off' };
}

// ---------------------------------------------------------------- tray
// Always shows whether the app is listening, even with every window closed.
function refreshTray() {
  if (!tray) return;
  const on = meeting.active && !meeting.paused;
  try { tray.setImage(nativeImage.createFromPath(path.join(ASSETS, on ? 'tray-live.png' : 'tray.png'))); } catch { /* icon file missing */ }
  tray.setToolTip(meeting.active ? (meeting.paused ? 'Understudy: paused' : `Understudy: listening to "${meeting.meta.title}"`) : 'Understudy');
  const items = [{ label: 'Open Understudy', click: () => { if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus(); } else createAppWindow(); } }];
  if (meeting.active) {
    items.push({ type: 'separator' },
      { label: 'Show overlay', click: () => toggleOverlay(true) },
      { label: meeting.paused ? 'Resume listening' : 'Pause listening', click: () => togglePause().catch(() => {}) },
      { label: 'End meeting and save', click: () => stopMeeting().catch(() => {}) });
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => quitApp() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
    tray.on('click', () => { if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus(); } else createAppWindow(); });
    refreshTray();
  } catch { tray = null; /* no notification area on this system */ }
}

// The live copy hears how a meeting was saved once it has ended: its transcript is then replaced by a line saying where. Never throws.
function liveEnded(r) {
  try { if (liveCopy) liveCopy.ended(r ? { file: r.file, turns: r.turns, error: r.saveError, title: r.meta && r.meta.title, end: r.meta && r.meta.end } : {}); } catch { /* the live copy never stops a meeting from ending */ }
}

// Quitting during a meeting saves it first.
async function quitApp() {
  if (quitting) return;
  quitting = true;
  try { await serial(async () => {
    if (connectionTest) await connectionTest.cancel();
    stopCapture();
    if (bridge) { bridge.setWanted('stopped'); await bridge.close(); bridge = null; }
    if (meeting && meeting.active) liveEnded(await meeting.stop());
  }); } catch { /* the autosave still holds the transcript */ }
  app.quit();
}

// ---------------------------------------------------------------- shortcuts
// Never throws, whatever the stored values are: it is called while a meeting is
// starting, after the audio has begun, and a failure there would leave the
// meeting running with no way to end it from the start button.
function registerShortcuts() {
  try {
    globalShortcut.unregisterAll();
    const sc = (settings && settings.get().shortcuts) || {};
    const failed = [], invalid = [], seen = new Set();
    const reg = (accel, fn) => {
      if (accel === '' || accel == null) return; // not set
      if (typeof accel !== 'string') { invalid.push('(not text)'); return; }
      const key = accel.toLowerCase();
      if (seen.has(key)) { invalid.push(`${accel} (used twice)`); return; }
      seen.add(key);
      try { if (!globalShortcut.register(accel, fn)) failed.push(accel); } catch { invalid.push(`${accel} (not a valid combination)`); }
    };
    reg(sc.toggleOverlay, () => toggleOverlay());
    if (meeting && meeting.active) {
      reg(sc.answer, () => runAction('say'));
      reg(sc.screen, () => runAction('screen'));
      reg(sc.take, () => runAction('take'));
      reg(sc.catchup, () => runAction('catchup'));
      reg(sc.pause, () => togglePause().catch(() => {}));
    }
    if (invalid.length) broadcast({ type: 'error', where: 'shortcuts', message: `These shortcuts could not be used: ${invalid.join(', ')}. Set them again in Settings.` });
    if (failed.length) broadcast({ type: 'error', where: 'shortcuts', message: `These shortcuts are already taken by another program and were not registered: ${failed.join(', ')}. Change them in Settings.` });
  } catch (e) {
    try { broadcast({ type: 'error', where: 'shortcuts', message: `The shortcuts could not be set up (${e.message}). Check them in Settings.` }); } catch { /* nothing more to do */ }
  }
}

function toggleOverlay(force) {
  if (!overlayWin || overlayWin.isDestroyed()) { if (!meeting.active) return; createOverlay(); }
  const show = force != null ? force : !overlayWin.isVisible();
  if (show) overlayWin.showInactive();
  else {
    overlayWin.hide();
    if (meeting.active && (!appWin || appWin.isDestroyed())) { createAppWindow(); appWin.minimize(); }
  }
  refreshTray();
}

// ---------------------------------------------------------------- screenshots
async function captureScreen() {
  // The display the pointer is on, without the overlay covering it.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const wasVisible = overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible();
  if (wasVisible) { overlayWin.setOpacity(0); await new Promise((r) => setTimeout(r, 140)); }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error('The screen could not be captured.');
    let img = src.thumbnail;
    const { width, height } = img.getSize();
    const longest = Math.max(width, height);
    if (longest > 2000) img = img.resize({ width: Math.round(width * 2000 / longest), height: Math.round(height * 2000 / longest), quality: 'best' });
    return { mime: 'image/jpeg', base64: img.toJPEG(88).toString('base64') };
  } finally {
    if (wasVisible && overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(Math.min(1, Math.max(0.4, Number(settings.get().overlay.opacity) || 0.94)));
  }
}

// ---------------------------------------------------------------- meeting flow
async function runAction(action, params = {}) {
  if (!meeting.active || typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) return null;
  if (meeting.stopping) return null;
  try {
    let image = null;
    if (action === 'screen') {
      image = await captureScreen();
      if (!meeting.active || meeting.stopping) return null;
    }
    toggleOverlay(true);
    const card = meeting.runAction(action, params, { image });
    return card.id;
  } catch (e) {
    broadcast({ type: 'error', where: 'action', message: e.message });
    return null;
  }
}

// Start, pause, resume and stop run one at a time, in the order they were
// asked for, so two quick key presses can never leave the audio half torn down.
let transition = Promise.resolve();
const serial = (fn) => { const run = transition.then(fn); transition = run.catch(() => {}); return run; };
const startMeeting = (opts) => serial(() => _startMeeting(opts));
const pauseMeeting = () => serial(_pauseMeeting);
const resumeMeeting = () => serial(_resumeMeeting);
const stopMeeting = () => serial(_stopMeeting);
const togglePause = () => serial(() => (meeting.paused ? _resumeMeeting() : _pauseMeeting()));

async function _startMeeting({ title } = {}) {
  if (meeting.active) return meeting.snapshot();
  await connectionTest.cancel(); // release the test port before the meeting binds it
  if (speedRun) speedRun.abort(); // a speed test would compete with live answers
  const s = settings.get();
  const plan = channelPlan(s);
  if (plan.error) throw new Error(plan.error);
  // Fail early, with a clear message, when a key is missing.
  createStream(s.stt, (n) => settings.getSecret(n), 'me').removeAllListeners();
  audioMap = plan.audioMap;
  captureChannels = plan.localCapture;
  capturePlan = plan;
  // Binding first avoids starting speech streams for a meeting that cannot receive its audio.
  if (plan.remote) {
    try {
      bridge = createBridge({ session: meeting, remoteConfig, settings, createListener, micRemote: plan.micRemote, roomRemote: plan.roomRemote,
        onHint: (message) => broadcast({ type: 'hint', message }),
        onCaptureStatus: (state, hint) => {
          if (!['off', 'starting', 'on', 'lost', 'error'].includes(state)) return;
          captureStatus.them = state;
          if (plan.micRemote && !plan.roomRemote) captureStatus.me = state;
          const msg = (state === 'error' || state === 'lost') && typeof hint === 'string' ? hint : '';
          broadcast({ type: 'capture', status: captureStatus, message: msg });
        },
        onState: (state) => {
          if (!bridge || (state !== 'disconnected' && state !== 'waiting')) return;
          const next = meeting.active && !meeting.paused && !meeting.stopping ? (state === 'disconnected' ? 'lost' : 'starting') : 'off';
          if (captureStatus.them !== next || (plan.micRemote && !plan.roomRemote && captureStatus.me !== next)) {
            captureStatus.them = next;
            if (plan.micRemote && !plan.roomRemote) captureStatus.me = next;
            broadcast({ type: 'capture', status: captureStatus, message: '' });
          }
        }
      });
      await bridge.open();
    } catch (e) { bridge = null; throw e; }
  }
  try {
    meeting.start({ title, channels: plan.room ? ['them'] : plan.channels, room: plan.room });
  } catch (e) {
    if (bridge) { try { await bridge.close(); } catch { /* keep the original start error */ } bridge = null; }
    throw e;
  }
  if (bridge) bridge.setWanted('recording');
  try {
    const win = createOverlay();
    win.once('ready-to-show', () => win.showInactive());
    if (!win.webContents.isLoading()) win.showInactive();
    if (plan.localCapture.length) await startCapture(plan.localCapture);
  } catch (e) {
    if (bridge) { try { await bridge.close(); } catch { /* keep the original start error */ } bridge = null; }
    stopCapture();
    try { await meeting.stop(); } catch { /* nothing was heard yet */ } // the live copy closes its file on its own when the state event says so
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    try { refreshTray(); } catch { /* the tray is cosmetic */ }
    throw e;
  }
  // Shortcuts and the tray are conveniences: if either fails, the meeting carries on.
  registerShortcuts();
  try { refreshTray(); } catch { /* the tray is cosmetic */ }
  return meeting.snapshot();
}

async function _pauseMeeting() { if (!meeting.active || meeting.paused) return; if (bridge) bridge.setWanted('paused'); await meeting.pause(); stopCapture(); refreshTray(); }
async function _resumeMeeting() { if (!meeting.active || !meeting.paused) return; meeting.resume(); if (bridge) bridge.setWanted('recording'); if (captureChannels.length) await startCapture(captureChannels); refreshTray(); }

async function _stopMeeting() {
  if (!meeting.active || meeting.stopping) return null;
  stopCapture();
  if (bridge) { bridge.setWanted('stopped'); await bridge.close(); bridge = null; }
  const result = await meeting.stop();
  if (!result) return null;
  liveEnded(result);
  registerShortcuts();
  refreshTray();
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  // Do not pull Understudy in front of the call that just ended: show it
  // without taking focus, or just flash the taskbar if it was minimised.
  if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.flashFrame(true); else appWin.showInactive(); } else { createAppWindow(); }
  broadcast({ type: 'meeting-ended', id: result.meta.id, file: result.file, turns: result.turns, cost: result.cost, error: result.saveError || '' });
  if (result.file) writeNotes(result.meta, result.transcriptMd, result.transcriptPlain);
  return { id: result.meta.id, file: result.file, turns: result.turns };
}

// Notes are written after the transcript is already safely on disk. `rewrite` is a second go at a saved meeting:
// the ticks and updates the person made in the old notes are carried into the new ones (meetings/carry-over.js).
async function writeNotes(meta, transcriptMd, transcriptPlain, { rewrite = false } = {}) {
  if (notesJobs.has(meta.id)) return;
  const ac = new AbortController();
  notesJobs.set(meta.id, ac);
  broadcast({ type: 'notes', id: meta.id, status: 'working' });
  try {
    // A long meeting is written in stages; each stage says where it is ("Part 2 of 5"). Same 'notes' event, one more field.
    // A rewrite tells the model which items are already ticked, so the follow-up does not promise them again.
    const savedNotes = rewrite ? openForRewrite(store, meta.id).notes : undefined;
    const notes = await generateNotes({ llm, name: settings.get().me.name, meta, transcriptPlain, savedNotes, signal: ac.signal, onProgress: (t) => broadcast({ type: 'notes', id: meta.id, status: 'working', message: t }) });
    if (useGeneratedTitle(meta, notes.title)) meta.title = notes.title; // never a title the person typed (see store.js)
    const file = rewrite ? rewriteSaved(store, meta, notes.notesMd, transcriptMd) : store.save(meta, notes.notesMd, transcriptMd);
    broadcast({ type: 'notes', id: meta.id, status: 'done', file, title: meta.title });
    if (settings.get().library.includeMeetings !== false) reindexLibrary();
  } catch (e) {
    broadcast({ type: 'notes', id: meta.id, status: 'error', message: `The transcript is saved, but notes could not be written: ${e.message}` });
  } finally {
    notesJobs.delete(meta.id);
  }
}

// ---------------------------------------------------------------- notes bridge
// What the windows ask of the Notes folder and of a saved meeting's action items. Each function checks what it was
// given (validate.js), and turns any failure into a sentence that carries no disk path: a message written for the
// person passes through, anything else (a file system error, a bug) becomes the plain fallback.
function notesCall(fallback, fn) {
  try { return fn(); } catch (e) { throw new Error(V.userMessage(e, fallback, { strict: true })); }
}
const NOTE_SAVE_FAILED = 'The note could not be saved. Check that the Notes folder is available and try again.';

function addNote(arg) {
  const r = notesCall(NOTE_SAVE_FAILED, () => { const c = V.cleanNoteAdd(arg); return inbox.saveNote(notesDir(), { title: c.title, text: c.text, source: 'pasted' }); });
  reindexSoon(); // the library reads it now, without waiting for the folder watcher
  return { rel: r.rel, title: r.title };
}

function addNoteImage(arg) {
  const r = notesCall(NOTE_SAVE_FAILED, () => { const c = V.cleanNoteImage(arg); return inbox.saveImage(notesDir(), { bytes: c.bytes, mime: c.mime, title: c.title, note: c.note, source: 'screenshot' }); });
  reindexSoon();
  return { rel: r.rel, title: r.title };
}

function listNotes(arg) {
  return notesCall('The notes could not be listed.', () => inbox.listNotes(notesDir(), V.cleanNotesList(arg)));
}

// The same name notes are stamped with when they are saved (os.hostname() in notes-inbox.js).
function thisPcName() { try { return require('node:os').hostname(); } catch { return ''; } }

async function notesInfo() {
  const s = settings.get();
  let count = 0;
  try { count = await countNoteFiles(notesDir()); } catch { /* an unreadable folder counts as empty */ }
  return {
    dir: notesDir(), isDefault: !s.notesDir, count, readImages: s.library.readImages === true,
    host: thisPcName(), // so the notes list can leave out "this PC" and name only the others
    images: imageReader ? imageReader.stats() : { described: 0, cached: 0, pending: 0, skipped: 0, cost: 0 },
  };
}

// An edit to a saved meeting from the window: refused while its notes are being rewritten (the rewrite would
// replace the edit), and the library is read again afterwards when meetings are part of it. Returns the meeting
// the way meetings:get does.
function editMeeting(clean, write, fallback) {
  let c;
  try {
    c = clean();
    if (notesJobs.has(c.id)) throw new V.ArgError('Notes for this meeting are still being written. Try again when they are done.');
    write(c);
  } catch (e) { throw new Error(V.userMessage(e, fallback)); }
  if (settings.get().library.includeMeetings !== false) reindexSoon();
  const m = store.find(c.id);
  if (!m) throw new Error('That meeting file no longer exists.');
  return m;
}
const setActionItem = (id, index, text, done) => editMeeting(() => V.cleanActionItemCall(id, index, text, done), (c) => store.setActionItem(c.id, { index: c.index, text: c.text, done: c.done }), 'The action item could not be saved. Try again.');
// The title of a saved meeting, changed by the person. Not while that meeting is the one being recorded.
const renameMeeting = (id, title) => editMeeting(() => V.cleanRenameCall(id, title), (c) => {
  if (meeting && meeting.active && meeting.meta && meeting.meta.id === c.id) throw new V.ArgError('This meeting is still being recorded. Try again when it has ended.');
  store.renameMeeting(c.id, c.title);
}, 'The meeting could not be renamed. Try again.');
const addUpdate = (id, text) => editMeeting(() => V.cleanUpdateCall(id, text), (c) => store.addUpdate(c.id, c.text), 'The update could not be saved. Try again.');

// ---------------------------------------------------------------- IPC
// A test run (its own data folder) keeps its Claude config in that folder too:
// it must never rewrite the real connection to point at a test build.
const claudeOpts = () => ({
  execPath: process.execPath, serverPath: path.join(app.getAppPath(), 'src', 'mcp', 'server.js'), meetingsDir: meetingsDir(), notesDir: notesDir(), issuesDir: issuesDir(),
  ...(DEV && process.env.UNDERSTUDY_DATA_DIR ? { configPath: path.join(process.env.UNDERSTUDY_DATA_DIR, 'claude_desktop_config.json') } : {}),
});

// "Sync between PCs" (shared-folder.js): one chosen folder holds both the Meetings and the Notes folder. The folder
// comes from the dialog here and is held in this process; the window only says copy or not. Nothing is written to
// the settings until the person has confirmed, and (like meetings:chooseFolder and notes:chooseFolder) the two
// locations are never accepted through settings:set. The Claude connection follows, and in a test run it stays in
// the test data folder (claudeOpts).
const sharedFolder = createSharedFolder({
  current: () => ({ meetingsDir: meetingsDir(), notesDir: notesDir() }),
  defaults: () => ({
    meetingsDir: DEV && process.env.UNDERSTUDY_DATA_DIR ? path.join(process.env.UNDERSTUDY_DATA_DIR, 'Meetings') : path.join(app.getPath('documents'), 'Understudy', 'Meetings'),
    notesDir: DEV && process.env.UNDERSTUDY_DATA_DIR ? path.join(process.env.UNDERSTUDY_DATA_DIR, 'Notes') : inbox.defaultNotesDir(app.getPath('documents')),
  }),
  guards: () => ({ home: app.getPath('home'), appData: app.getPath('userData') }),
  meetingActive: () => Boolean(meeting && meeting.active),
  commit: (next) => {
    settings.set({ meetingsDir: next.meetingsDir, notesDir: next.notesDir });
    store.dir = meetingsDir();
    try { claude.refresh(claudeOpts()); } catch { /* Claude's config is left alone if it cannot be updated */ }
    reindexSoon();
  },
});

// Speech-to-text: open a stream, send a second of silence, close it. `signal` ends it early (the key check's time limit).
function sttConnectionTest(id, signal) {
  const s = settings.get();
  if (typeof id !== 'string' || !Object.hasOwn(STT_PROVIDERS, id)) throw new Error('Unknown speech-to-text provider.');
  // Tested against the same address meetings use.
  const stream = createStream({ ...s.stt, provider: id, skipSilence: false }, (n) => settings.getSecret(n), 'me', { baseUrlOverride: sttOverride() });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); stream.stop().catch(() => {}); fn(v); };
    const timer = setTimeout(() => (STT_PROVIDERS[id].streaming ? finish(reject, new Error('No answer from the provider within 6 seconds. Check the network.')) : finish(resolve, { text: 'Key saved. This provider is checked on first use.' })), STT_PROVIDERS[id].streaming ? 6000 : 300);
    if (signal) signal.addEventListener('abort', () => finish(reject, Object.assign(new Error('No answer in time.'), { timeout: true })), { once: true });
    stream.on('error', (e) => finish(reject, e));
    // AssemblyAI confirms a session with a first message; Deepgram answers once it has audio.
    stream.on('state', (st) => {
      if (!STT_PROVIDERS[id].streaming) return;
      if (st === 'listening') stream.send(new Int16Array(16000));
      if (st === 'ready' || (st === 'listening' && id !== 'assemblyai')) setTimeout(() => finish(resolve, { text: 'Connected.' }), 900);
      if (st === 'closed') finish(reject, new Error('The provider closed the connection.'));
    });
    stream.start();
  });
}

// keys:test. The saved key for one secret, tried with the cheapest real request (see keycheck.js). An AI key runs the
// connection test on that provider's suggested live model; a streaming speech key runs the speech test; Groq, which
// has no stream, lists its models.
const keyChecker = () => createKeyChecker({
  hasKey: (name) => Boolean(settings.getSecret(name)),
  meetingActive: () => Boolean(meeting && meeting.active),
  liveModel: (name) => { const l = settings.get().llm.live; return l && l.provider === name ? l.model : ''; },
  testLlm: (name, signal, model) => llm.streamChat('live', { override: { provider: name, model: model || LLM_PROVIDERS[name].suggested.live }, system: 'You are a connection test.', userText: 'Reply with the single word: ready', maxTokens: 2000, signal }),
  testStt: (name, signal) => (STT_PROVIDERS[name].streaming
    ? sttConnectionTest(name, signal)
    : probeKey({ baseUrl: sttOverride() || STT_PROVIDERS[name].baseUrl, apiKey: settings.getSecret(name), signal })),
});

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    const from = pageOf(e.senderFrame && e.senderFrame.url);
    if (from !== 'app.html' && from !== 'overlay.html') return { ok: false, error: 'This request did not come from an Understudy window.' };
    try { const value = await fn(...args); noteCall(channel, true); return { ok: true, value }; } catch (err) {
      noteCall(channel, false, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}
// What a call leaves for the Issues folder: a breadcrumb (the channel and how it ended, never its arguments), and the error
// when it failed (only mistakes in the code are kept: issues.isBug). The reporting calls themselves leave nothing. Never throws.
function noteCall(channel, ok, err) {
  try {
    if (channel.startsWith('issues:')) return;
    crumbs.add('ipc', channel, ok);
    if (!ok) reportCaught(err, `ipc:${channel}`);
  } catch { /* a breadcrumb never stops a call */ }
}

// What a window may change through settings:set. Folders, the meetings and
// notes locations and window geometry are only ever set by the main process itself.
// What each value must look like is the table in validate.js; a key listed
// here without a rule there is refused. A value that does not fit is dropped
// and the person is told, so one bad field never costs the good ones sent with it.
const SETTABLE = {
  me: ['name', 'aliases', 'role'],
  llm: ['live', 'notes', 'webSearch'],
  stt: ['provider', 'language', 'skipSilence', 'identifySpeakers', 'suggestNames', 'keyterms', 'models'],
  audio: ['micDeviceId', 'captureMic', 'captureSystem', 'echoFilter'],
  remote: ['enabled', 'host', 'port', 'listen', 'micFrom'],
  copilot: ['autoMode', 'personality', 'proactiveEverySec', 'autoStopMinutes'],
  overlay: ['opacity', 'hideFromCapture'],
  appearance: ['theme'],
  shortcuts: ['answer', 'screen', 'take', 'catchup', 'toggleOverlay', 'pause'],
  library: ['includeMeetings', 'readImages'],
  sync: ['liveCopy'],
};
const vctx = () => ({ settable: SETTABLE, autoModes: AUTO_MODES, sttProviders: Object.keys(STT_PROVIDERS), llmProviders: Object.keys(LLM_PROVIDERS), personalityIds: () => listPersonalities().map((p) => p.id), currentShortcuts: () => (settings && settings.get().shortcuts) || {} });
// A refused shortcut is answered in a sentence of its own (`refused`, by path: "shortcuts.take"), which goes back to the
// window that asked (see settings:set) and is shown where the person pressed the keys. The other refusals are told here.
function settable(raw) {
  const { patch, rejected, refused = {} } = V.sanitiseSettingsPatch(raw, vctx());
  const others = rejected.filter((p) => !refused[p]);
  if (others.length) broadcast({ type: 'error', where: 'settings', message: `These settings were not saved because the values were not valid: ${V.describeRejected(others)}.` });
  return { patch, refused };
}

// Settings written by an older version, or edited by hand, can hold a value of
// the wrong type. Put the default back for each, in memory and on disk, before
// anything reads them.
function repairSettings() {
  const { patch, fixed } = V.repairSettings(settings.get(), DEFAULTS, vctx());
  if (!fixed.length) return;
  try { settings.set(patch); } catch { /* the repaired values are in use for this run even if the file cannot be written */ }
  console.warn(`Settings repaired (wrong type): ${fixed.join(', ')}`);
}

function setupIpc() {
  ipcMain.on('audio', (e, channel, bytes) => {
    if (!captureWin || e.sender !== captureWin.webContents) return;
    if (!meeting.active || (channel !== 'me' && channel !== 'them')) return;
    if (bridge && channel === 'them') return; // the other PC is the only source for this channel
    if (capturePlan?.roomRemote || (capturePlan?.micRemote && channel === 'me')) return;
    const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    if (!u8 || !u8.byteLength || u8.byteLength > 640000) return;
    const even = u8.byteLength - (u8.byteLength % 2);
    if (!even) return;
    // Copy into an aligned buffer before viewing it as 16-bit samples.
    const copy = new Uint8Array(even);
    copy.set(u8.subarray(0, even));
    if (audioMap[channel]) meeting.pushAudio(audioMap[channel], new Int16Array(copy.buffer));
  });
  ipcMain.on('capture:status', (e, status) => {
    if (!captureWin || e.sender !== captureWin.webContents || !status || typeof status !== 'object' || Array.isArray(status) || capturePlan?.roomRemote) return;
    if (status.levels && typeof status.levels === 'object' && !Array.isArray(status.levels)) {
      const lv = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
      broadcast({ type: 'levels', levels: { me: lv(status.levels.me), them: lv(status.levels.them) } });
      return;
    }
    if (typeof status.hint === 'string' && status.hint) { broadcast({ type: 'hint', message: status.hint.slice(0, 500) }); return; }
    if (!status.channels || typeof status.channels !== 'object' || Array.isArray(status.channels)) return;
    const validStates = ['off', 'starting', 'on', 'lost', 'error'];
    const channels = {};
    for (const ch of ['me', 'them']) {
      if (Object.hasOwn(status.channels, ch) && validStates.includes(status.channels[ch])) channels[ch] = status.channels[ch];
    }
    if (bridge) delete channels.them; // local microphone startup reports the unused computer audio as off
    const msg = typeof status.message === 'string' ? status.message.slice(0, 500) : '';
    if (!Object.keys(channels).length && !msg) return;
    captureStatus = { ...captureStatus, ...channels };
    broadcast({ type: 'capture', status: captureStatus, message: msg });
    if (msg) broadcast({ type: 'error', where: 'capture', message: msg });
  });

  // Queue only the start of a test, so its wait never holds up a meeting and cannot race a meeting's bind.
  handle('remote:test', (...args) => { V.cleanRemoteArgs(...args); return serial(() => ({ reply: quitting ? { result: 'cancelled', message: 'Test stopped.' } : connectionTest.run() })).then(({ reply }) => reply); });
  handle('remote:testCancel', (...args) => { V.cleanRemoteArgs(...args); return serial(async () => { await connectionTest.cancel(); return true; }); });
  handle('remote:info', (...args) => { V.cleanRemoteArgs(...args); return remoteConfig.info(); });
  handle('remote:detect', (...args) => { V.cleanRemoteArgs(...args); return { addresses: tailscaleAddresses() }; });
  handle('remote:newToken', (...args) => { V.cleanRemoteArgs(...args); return remoteConfig.newToken(); });
  handle('remote:copySettings', (...args) => { V.cleanRemoteArgs(...args); return remoteConfig.copySettings(); });

  handle('settings:get', () => publicSettings());
  handle('settings:set', (raw) => {
    const { patch, refused } = settable(raw);
    settings.set(patch);
    if (patch.shortcuts) registerShortcuts();
    if (patch.library) reindexLibrary();
    if (patch.sync && liveCopy) liveCopy.settingChanged();
    if (patch.overlay && overlayWin && !overlayWin.isDestroyed()) {
      if (patch.overlay.opacity) overlayWin.setOpacity(Math.min(1, Math.max(0.4, Number(patch.overlay.opacity) || 0.94)));
      if ('hideFromCapture' in patch.overlay) overlayWin.setContentProtection(patch.overlay.hideFromCapture !== false);
    }
    return Object.keys(refused).length ? { ...publicSettings(), refused } : publicSettings();
  });
  handle('secrets:set', (name, value) => {
    if (!['anthropic', 'openai', 'gemini', 'deepgram', 'assemblyai', 'groq'].includes(name)) throw new Error('Unknown key name.');
    settings.setSecret(name, V.cleanSecretValue(value)); // text, trimmed, one line, at most 500 characters; '' removes the key
    return publicSettings();
  });
  handle('models:list', (provider) => {
    if (typeof provider !== 'string' || !Object.hasOwn(LLM_PROVIDERS, provider)) throw new Error('Unknown AI provider.');
    return llm.listModels(provider);
  });
  handle('models:speedTest', async () => {
    if (speedRun) throw new Error('A speed test is already running.');
    if (meeting.active) throw new Error('End the meeting before running a speed test.');
    const candidates = defaultCandidates({ providers: LLM_PROVIDERS, secretsPresent: settings.secretsPresent(), current: settings.get().llm.live });
    if (!candidates.length) throw new Error('Add an AI key first.');
    const ac = new AbortController();
    speedRun = ac;
    try {
      const r = await runSpeedTest({ llm, candidates, signal: ac.signal, onProgress: (p) => broadcast({ type: 'speedtest', ...p }) });
      const out = { ...r, candidates };
      if (!r.cancelled) speedLast = out; // a stopped run is not a finished one
      return out;
    } finally { speedRun = null; }
  });
  handle('models:speedTestCancel', () => { if (speedRun) speedRun.abort(); return true; });
  handle('models:speedTestLast', () => speedLast);
  handle('provider:test', async (kind, id) => {
    const c = V.cleanProviderTest(kind, id, STT_PROVIDERS);
    if (c.kind === 'llm') {
      const t0 = Date.now();
      let first = null;
      const r = await llm.streamChat(c.role, { system: 'You are a connection test.', userText: 'Reply with the single word: ready', maxTokens: 2000, onText: () => { if (first == null) first = Date.now() - t0; } });
      return { text: r.text.trim().slice(0, 80), firstTokenMs: first, totalMs: Date.now() - t0, model: r.model };
    }
    return sttConnectionTest(c.id);
  });

  handle('library:addFolder', async () => {
    const r = await dialog.showOpenDialog(appWin, { title: 'Choose a folder of your notes and documents', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return libraryStats();
    const folders = [...new Set([...(settings.get().library.folders || []), ...r.filePaths])];
    settings.set({ library: { folders } });
    await reindexLibrary();
    return libraryStats();
  });
  handle('library:removeFolder', async (dir) => {
    settings.set({ library: { folders: (settings.get().library.folders || []).filter((f) => f !== dir), pinned: pinnedFolders().filter((f) => f !== dir) } });
    await reindexLibrary();
    return libraryStats();
  });
  handle('library:pinFolder', (arg) => {
    const { dir, on } = V.cleanPinFolder(arg, settings.get().library.folders || []);
    settings.set({ library: { pinned: [...pinnedFolders().filter((f) => f !== dir), ...(on ? [dir] : [])] } });
    return libraryStats();
  });
  handle('library:reindex', async () => { await reindexLibrary(); return libraryStats(); });
  handle('library:stats', () => libraryStats());
  handle('library:search', (q) => library.search(V.cleanLibrarySearch(q), { k: 6 }).map((h) => ({ rel: h.rel, headings: h.headings, text: h.text.slice(0, 500), kind: h.kind, score: h.score })));

  handle('profile:get', () => readProfile());
  handle('profile:save', (text) => { writeAtomic(userDir('profile.md'), V.cleanProfileSave(text)); return true; });
  handle('profile:preview', async () => {
    if (libraryBusy) await libraryBusy;
    const sample = await library.sampleForProfile();
    const c = settings.get().llm.notes;
    return { files: sample.files, filesTotal: sample.filesTotal, chars: sample.chars, partial: sample.files < sample.filesTotal || sample.chunksIncluded < sample.chunksTotal, provider: LLM_PROVIDERS[c.provider] ? LLM_PROVIDERS[c.provider].label : c.provider, model: c.model, redacted: library.stats.redacted || 0 };
  });
  handle('profile:build', async () => {
    if (libraryBusy) await libraryBusy;
    const sample = await library.sampleForProfile();
    if (!sample.files) throw new Error('Add a folder of your notes first: the profile is written from them.');
    const me = settings.get().me;
    const { system, user } = profilePrompt({ name: me.name, role: me.role, sample });
    const r = await llm.streamChat('notes', { system, userText: user, maxTokens: 16000, onText: (delta) => broadcast({ type: 'profile-delta', delta }) });
    const text = r.text.trim();
    if (!text) throw new Error('The model returned an empty profile.');
    writeAtomic(userDir('profile.md'), text);
    return { text, files: sample.files, filesTotal: sample.filesTotal, chunksIncluded: sample.chunksIncluded, chunksTotal: sample.chunksTotal };
  });

  handle('personalities:list', () => listPersonalities());
  handle('personalities:save', (arg) => {
    const { id, name, description, text } = V.cleanPersonalitySave(arg);
    const safe = String(id || name || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'custom';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(safe)) throw new Error('That name is reserved by Windows. Choose another.');
    writeAtomic(userDir('personalities', `${safe}.md`), `---\nname: ${String(name || safe).replace(/\n/g, ' ')}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\n---\n${String(text || '').trim()}\n`);
    return listPersonalities();
  });
  handle('personalities:delete', (id) => {
    const file = userDir('personalities', `${V.cleanPersonalityDelete(id).replace(/[^a-z0-9-]/g, '')}.md`);
    try { fs.unlinkSync(file); } catch {}
    return listPersonalities();
  });

  handle('meeting:start', (opts) => startMeeting({ title: opts && typeof opts.title === 'string' ? opts.title.trim().slice(0, 200) : undefined }));
  handle('meeting:stop', () => stopMeeting());
  handle('meeting:pause', async () => { await pauseMeeting(); return meeting.snapshot(); });
  handle('meeting:resume', async () => { await resumeMeeting(); return meeting.snapshot(); });
  handle('meeting:state', () => ({ ...meeting.snapshot(), capture: captureStatus, personalities: listPersonalities().map(({ id, name, description }) => ({ id, name, description })), shortcuts: settings.get().shortcuts, models: { live: llm.describe('live') } }));
  handle('meeting:action', (action, params) => { const c = V.cleanActionCall(action, params, ACTIONS); return runAction(c.action, c.params); });
  handle('meeting:cancelCard', (id) => { meeting.cancelCard(id, false); return true; });
  handle('meeting:set', (arg) => {
    const { autoMode, personality } = V.cleanMeetingSet(arg, vctx()); // anything that is not a real mode or style is ignored
    if (autoMode) { meeting.setAutoMode(autoMode); settings.set({ copilot: { autoMode } }); }
    if (personality) { meeting.setPersonality(personality); settings.set({ copilot: { personality } }); }
    return meeting.snapshot();
  });

  handle('meeting:renameSpeaker', (key, name) => meeting.renameSpeaker(String(key), name == null ? '' : String(name)));
  handle('meeting:suggestion', (id, accept) => meeting.resolveSuggestion(id, Boolean(accept)));
  // The question the app left alone, answered on request. Returns the card id; the card arrives as a normal 'card' event.
  handle('meeting:answerPassed', (id) => { toggleOverlay(true); return meeting.answerPassed(Number(id)).id; });

  handle('meetings:list', () => store.list({ limit: 300 }).map((m) => ({ ...m, notesWorking: notesJobs.has(m.id) })));
  // The page searches as you type and only the newest search matters. The store reads in small
  // slices so the live meeting is not held up, and abandons an older search; its caller (which
  // would otherwise draw an empty result for a moment) gets the answer to the newest instead.
  let latestSearch = null;
  handle('meetings:search', async (q) => {
    let p = latestSearch = store.searchAsync(String(q || '').slice(0, 200), { limit: 30 });
    for (;;) {
      try { return await p; } catch (e) {
        if (!isSuperseded(e) || latestSearch === p) throw e;
        p = latestSearch;
      }
    }
  });
  handle('meetings:get', (id) => { const m = store.find(V.meetingId(id)); if (!m) throw new Error('That meeting file no longer exists.'); return m; });
  handle('meetings:regenerate', async (id) => {
    // Refused here, before the model is asked for anything, when the saved file cannot be read as it should be.
    const cleanId = typeof V !== 'undefined' ? V.meetingId(id) : (typeof id === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(id) ? id : (() => { throw new Error('That meeting file no longer exists.'); })());
    const m = openForRewrite(store, cleanId);
    const meta = { ...m.meta, autoTitle: false, startMs: 0 };
    await writeNotes(meta, m.transcript, transcriptMdToPlain(m.transcript), { rewrite: true });
    return true;
  });
  handle('meetings:renameSpeaker', (id, from, to, merge) => {
    const c = V.cleanRenameSpeakerCall(id, from, to, merge);
    if (notesJobs.has(c.id)) throw new Error('Notes for this meeting are still being written. Try again when they are done.');
    // The person's own name (and aliases) is never given to another speaker; another speaker's name only with `merge`.
    const me = settings.get().me;
    const r = store.renameSpeaker(c.id, c.from, c.to, { reserved: [me.name, ...(Array.isArray(me.aliases) ? me.aliases : [])], merge: c.merge });
    if (settings.get().library.includeMeetings !== false) reindexLibrary();
    return r;
  });
  handle('meetings:reveal', (id) => { const m = store.find(V.meetingId(id)); if (m) shell.showItemInFolder(m.file); return true; });
  handle('meetings:openFolder', () => { fs.mkdirSync(meetingsDir(), { recursive: true }); return shell.openPath(meetingsDir()); });
  handle('meetings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(appWin, { title: 'Where should meeting files be saved?', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return publicSettings();
    settings.set({ meetingsDir: r.filePaths[0] });
    store.dir = meetingsDir();
    try { claude.refresh(claudeOpts()); } catch { /* Claude's config is left alone if it cannot be updated */ }
    reindexLibrary();
    return publicSettings();
  });

  handle('meetings:setActionItem', (id, index, text, done) => setActionItem(id, index, text, done));
  handle('meetings:addUpdate', (id, text) => addUpdate(id, text));
  handle('meetings:rename', (id, title) => renameMeeting(id, title));

  // The Notes folder. Its location is written here only, never through settings:set. Notes already saved are not moved when it changes.
  handle('notes:add', (arg) => addNote(arg));
  handle('notes:addImage', (arg) => addNoteImage(arg));
  handle('notes:list', (arg) => listNotes(arg));
  handle('notes:info', () => notesInfo());
  handle('notes:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(appWin, { title: 'Where should notes be saved?', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.set({ notesDir: r.filePaths[0] });
    try { claude.refresh(claudeOpts()); } catch { /* Claude's config is left alone if it cannot be updated */ }
    reindexSoon();
    return { dir: notesDir() };
  });
  handle('notes:openFolder', async () => {
    const dir = notesDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* shell.openPath says if it cannot be opened */ }
    if (await shell.openPath(dir)) throw new Error('The Notes folder could not be opened.');
    return true;
  });

  // Sync between PCs. shared:choose opens the dialog (a test run may name the folder instead, see below) and only
  // remembers the choice; shared:apply acts on that choice and nothing else.
  handle('shared:info', () => ({ ...sharedFolder.info(), liveFile: liveFileName(thisPcName()) })); // liveFile: for the live copy switch's help line
  handle('shared:choose', async () => {
    sharedFolder.assertIdle();
    // Test hook: in an unpackaged build with its own data folder, UNDERSTUDY_PICK_FOLDER stands in for the dialog.
    let picked = DEV && process.env.UNDERSTUDY_DATA_DIR ? process.env.UNDERSTUDY_PICK_FOLDER : '';
    if (!picked) {
      const r = await dialog.showOpenDialog(appWin, { title: 'Choose the shared folder for meetings and notes', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      picked = r.filePaths[0];
    }
    return sharedFolder.choose(picked);
  });
  handle('shared:apply', (arg) => sharedFolder.apply(V.cleanSharedApply(arg)));
  handle('shared:open', async () => {
    const i = sharedFolder.info();
    const dir = i.parent || i.meetingsDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* shell.openPath says if it cannot be opened */ }
    if (await shell.openPath(dir)) throw new Error('The folder could not be opened.');
    return true;
  });

  handle('claude:info', () => claude.info(claudeOpts()));
  handle('claude:install', () => claude.install(claudeOpts()));

  handle('overlay:toggle', (force) => { toggleOverlay(force); return true; });
  handle('overlay:opacity', (v) => { const o = Math.min(1, Math.max(0.4, Number(v) || 0.94)); settings.set({ overlay: { opacity: o } }); if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(o); return true; });
  // From either window. With a page (and a Settings tab) the main window is told to open it; anything that is not one of its pages is ignored.
  handle('app:show', (arg) => {
    const to = V.cleanAppShow(arg);
    const send = () => { if (to.page && appWin && !appWin.isDestroyed()) appWin.webContents.send('evt', { type: 'navigate', ...to }); };
    if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus(); send(); } else { createAppWindow(); appWin.webContents.once('did-finish-load', send); }
    return true;
  });
  const checkKey = keyChecker();
  handle('keys:test', (name) => checkKey(name));
  handle('keys:link', (name) => openKeyPage(name, (url) => shell.openExternal(url)));
  handle('app:openExternal', (url) => { shell.openExternal(V.cleanExternalUrl(url)).catch(() => {}); return true; });
  handle('app:copy', (text) => { clipboard.writeText(V.cleanCopyText(text)); return true; });
  handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData'), logsDir: path.join(app.getPath('userData'), 'logs') }));

  // The Issues folder. A report from the person (their note, one line) and the folder's counts; errors the windows hit are
  // reported by the windows themselves, from app.html and overlay.html only (handle() checks the sender).
  handle('issues:report', (arg) => {
    const c = V.cleanIssueReport(arg);
    try { return issueReporter.reportManual(c.note); } catch (e) { throw new Error(V.userMessage(e, issues.SAVE_FAILED, { strict: true })); }
  });
  handle('issues:info', () => issueReporter.info());
  handle('issues:open', async () => {
    const dir = issueReporter.ensureDir();
    if (await shell.openPath(dir)) throw new Error('The Issues folder could not be opened.');
    return true;
  });
  const rendererLimit = { app: issues.createLimiter({ max: 20, windowMs: 60000 }), overlay: issues.createLimiter({ max: 20, windowMs: 60000 }) };
  handle('issues:rendererError', (arg) => {
    try {
      const c = V.cleanRendererError(arg);
      if (/issues:(?:rendererError|report)/.test(`${c.message}\n${c.stack}`)) return true; // an error about this very call is not reported again
      if (!rendererLimit[c.where].allow()) return true; // one window in an error loop cannot fill the folder
      issueReporter.report({ name: c.name || 'Error', message: c.message, stack: c.stack }, `renderer:${c.where}`, { kind: 'error' });
    } catch { /* an error report never fails */ }
    return true;
  });
}

// ---------------------------------------------------------------- boot
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus(); } else if (settings) createAppWindow(); });

  app.whenReady().then(() => {
    settings = new Settings(app.getPath('userData'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    }, { requireEncryption: true });
    repairSettings();
    remoteConfig = createRemoteConfig({ settings, clipboard });
    connectionTest = createConnectionTest({ remoteConfig, settings, createListener, isMeetingRunning: () => Boolean(meeting && meeting.active) });
    library = new Library();
    // The autosave of a running meeting: if it cannot be kept, or works again, the overlay says so (a 'hint').
    store = new MeetingStore(meetingsDir(), liveDir(), { onLiveProblem: (message) => broadcast({ type: 'hint', message }) });
    meetingsWatch = watchMeetings(() => store.dir, () => broadcast({ type: 'meetings-changed' }));
    llm = createLlm(settings, { allowBaseUrls: DEV });
    // Pictures in the library folders are described by the notes model, only while the switch is on; each is
    // read once (the description is kept in the data folder by the hash of the picture).
    imageReader = createImageReader({
      llm, cacheDir: userDir('image-notes'), enabled: () => settings.get().library.readImages === true,
      onProgress: (p) => {
        if (!p || p.state !== 'error') return;
        imageError = imageError || String(p.message || 'Pictures could not be read.').slice(0, 300);
        broadcast({ type: 'images', state: 'error', message: imageError, stats: imageReader.stats() });
      },
    });
    library.imageReader = imageReader;
    meeting = new MeetingSession({ settings, library, store, llm, getProfile: readProfile, getPersonality: personalityText, sttBaseUrl: sttOverride() });
    for (const ev of ['state', 'partial', 'turn', 'card', 'card-delta', 'card-done', 'card-remove', 'mention', 'error', 'cost', 'stt-state', 'speakers', 'speaker-suggestion', 'speaker-suggestion-clear', 'hint', 'passed', 'passed-clear']) {
      meeting.on(ev, (payload) => broadcast({ type: ev, ...payload }));
    }

    // The live copy (live-copy.js): the transcript so far in the Meetings folder, for another PC. It hears of every change here and
    // never throws, and the Meetings folder is asked at each write, because it can be changed while the app runs.
    liveCopy = createLiveCopy({
      getState: () => ({ active: meeting.active, paused: meeting.paused, title: meeting.meta && meeting.meta.title, startedAt: meeting.meta && meeting.meta.startMs, transcript: meeting.transcript }),
      getEnabled: () => { const s = settings.get().sync; return !s || s.liveCopy !== false; },
      getDir: meetingsDir,
      pcName: thisPcName(),
      onProblem: (message) => crashLog.write('live-copy', message), // the local log only, and the copy itself limits it to one a minute
    });
    meeting.on('state', () => liveCopy.stateChanged());
    for (const ev of ['turn', 'speakers']) meeting.on(ev, () => liveCopy.changed());
    liveCopy.startUp(); // a file left saying "listening" by a crash is closed

    trayHint = createTrayHint({ meeting, send: broadcast });
    meeting.on('mention', () => { if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isVisible()) overlayWin.showInactive(); });

    // A meeting nobody is speaking in any more was probably left running.
    meeting.on('idle-warning', ({ inMinutes }) => broadcast({ type: 'hint', message: `Nobody has spoken for a while. The meeting will end and be saved in about ${inMinutes} minutes unless someone does.` }));
    meeting.on('idle', ({ minutes }) => {
      stopMeeting().then(() => broadcast({ type: 'error', where: 'idle', message: `The meeting was ended and saved because nothing was said for ${minutes} minutes.` })).catch(() => {});
    });

    setupMedia();
    setupIpc();
    // Counts of problems that keep happening are written about once a minute, and as the app quits.
    setInterval(() => issueReporter.flush(), 60000).unref();
    createAppWindow();
    // A settings or keys file that could not be read was set aside and the defaults are in use: the person is told
    // once, when the window has loaded (a message sent before that would reach nobody), and the record is cleared.
    appWin.webContents.once('did-finish-load', () => setTimeout(() => {
      const message = V.takeLoadNotice(settings);
      if (message) broadcast({ type: 'error', where: 'settings', message });
    }, 500));
    createCaptureWindow();
    createTray();
    registerShortcuts();

    // If Claude was connected by an earlier install or folder, point it at this one.
    try { claude.refresh(claudeOpts()); } catch { /* not connected, or not writable */ }
    const recovered = store.recoverOrphans(null);
    // An unfinished meeting that could not be turned into a file stays where it is: recorded as a problem (once, however often the app starts).
    try { if (store.liveDir && fs.readdirSync(store.liveDir).some((f) => f.endsWith('.jsonl'))) reportCaught({ name: 'CrashRecoveryError', message: 'An unfinished meeting could not be recovered at startup.' }, 'recovery'); } catch { /* no such folder: nothing to recover */ }
    if (recovered.length) setTimeout(() => broadcast({ type: 'recovered', count: recovered.length }), 1500);
    reindexLibrary();
  });

  app.on('window-all-closed', () => { if ((!meeting || (!meeting.active && !meeting.stopping)) && !notesJobs.size) app.quit(); });
  app.on('before-quit', (e) => { if (!quitting && (bridge || (meeting && (meeting.active || meeting.stopping)) || (connectionTest && connectionTest.active()))) { e.preventDefault(); quitApp(); return; } if (library) library.unwatch(); if (liveCopy) liveCopy.close(); if (meetingsWatch) meetingsWatch.stop(); issueReporter.flush(true); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
