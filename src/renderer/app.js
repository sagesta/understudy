'use strict';
/* global h, call, renderMarkdown, setTaskBox, toast, accelLabel, icon, toggle, segmented, speakerSlot, applyTheme, popMenu, closeMenu, armClick */

// Unexpected errors in this window go to the main process, which saves them in the Issues folder for Claude to fix.
// It must never change what the user sees, never loop, and never send more than a few a minute.
(() => {
  const sent = [];
  let busy = false;
  const cut = (v, n) => { try { return String(v == null ? '' : v).slice(0, n); } catch { return ''; } };
  function report(name, message, stack) {
    if (busy) return;
    busy = true;
    try {
      message = cut(message, 600);
      if (/ResizeObserver loop|issues:rendererError/.test(message)) return; // a harmless browser notice; never report our own reporting
      const now = Date.now();
      while (sent.length && now - sent[0] > 60000) sent.shift();
      if (sent.length >= 5) return;
      sent.push(now);
      Promise.resolve(window.api.invoke('issues:rendererError', { where: 'app', name: cut(name, 100), message, stack: cut(stack, 6000) })).catch(() => {});
    } catch { /* reporting is best effort */ } finally { busy = false; }
  }
  window.addEventListener('error', (e) => {
    try { const err = e.error; report((err && err.name) || 'Error', e.message || (err && err.message), (err && err.stack) || `${e.filename}:${e.lineno}:${e.colno}`); } catch { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason;
      if (r instanceof Error) report(r.name, r.message, r.stack);
      else { let m = ''; try { m = typeof r === 'string' ? r : JSON.stringify(r); } catch { m = String(r); } report('UnhandledRejection', m, ''); }
    } catch { /* ignore */ }
  });
})();

const page = document.getElementById('page');
const NAV = [['home', 'Home', 'home'], ['meetings', 'Meetings', 'calendar'], ['knowledge', 'Knowledge', 'book'], ['styles', 'Styles', 'persona'], ['settings', 'Settings', 'sliders']];
let cfg = null;        // { settings, secrets, llmProviders, sttProviders, meetingsDir, ... }
let live = null;       // meeting snapshot
let lib = null;        // library stats
let current = 'home';
let settingsTab = 'you';
let selectedMeeting = null;
let meetingTab = 'notes';
let selectedStyle = null;
let profileStream = null;
let onLevels = null;
let homeCtx = null;    // Home's start panel while it is showing: { styles, row, keys, steps }
const notesState = new Map(); // meeting id -> 'working'
const KEPT = 'Your ticks and updates are kept.'; // what the Rewrite notes button tells (the old ticks and updates are carried into the new notes)
const notesMsg = new Map();   // meeting id -> how far the notes have got ("Part 2 of 5")
const updateDrafts = new Map(); // meeting id -> an update typed but not added yet
let meetingsCtx = null; // the Meetings page while it shows: { progress(id, message), refresh(id) }
let knowledgeTab = 'folders';
let remoteTestCleanup = null;
let shortcutCleanup = null;
const staleNotes = new Set();  // meeting ids whose notes still use a speaker name that was just changed

const S = () => cfg.settings;
async function save(patch) { cfg = await call('settings:set', patch); return cfg; }
function debounce(fn, ms = 400) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fail(e) { toast(e.message || String(e), 'error', 9000); }
function wrap(title, lead, ...kids) { return h('div', { class: `wrap pg-${current}` }, h('header', { class: 'pagehead' }, h('h1', { text: title }), lead && h('p', { text: lead })), ...kids); }
function panel(title, sub, ...kids) { return h('section', { class: 'panel' }, title && h('h2', {}, title), sub && h('p', { class: 'sub', text: sub }), ...kids); }
function field(label, control, help, cls = '') { return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: `ctl ${cls}` }, control), help && (help.nodeType ? help : h('div', { class: 'help', text: help }))); }
function meetingChangeNote() { return h('p', { class: 'help foot next-meeting', hidden: !live?.active, text: 'Changes apply to the next meeting.' }); }
function btn(label, ic, onclick, cls = '', title = '') { return h('button', { class: cls, onclick, ...(title ? { title } : {}) }, ic && icon(ic, 15), label); }
// A button that needs a second click ("Click again to delete") before it does something that cannot be undone.
function armBtn(label, ic, armed, action, cls = '') { return armClick(h('button', { class: cls, type: 'button' }, ic && icon(ic, 15), label), armed, action); }
function textInput(value, onsave, props = {}) { const i = h('input', { type: 'text', value: value || '', ...props }); i.addEventListener('change', () => Promise.resolve(onsave(i.value)).catch(fail)); return i; }
function elapsed(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); const hh = Math.floor(s / 3600); return `${hh ? `${hh}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function niceDate(ymd, opts = { weekday: 'short', day: 'numeric', month: 'short' }) { return new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, opts); }

function agoText(ms, now = Date.now()) {
  if (!ms || !Number.isFinite(ms)) return '';
  const days = Math.max(0, Math.floor((now - ms) / 86400000));
  if (!days) return 'Newest file changed today.';
  if (days === 1) return 'Newest file changed yesterday.';
  // Whole weeks and 30-day months keep the note short without implying an exact calendar date.
  const n = days < 14 ? days : days < 60 ? Math.floor(days / 7) : Math.floor(days / 30);
  const unit = days < 14 ? 'day' : days < 60 ? 'week' : 'month';
  return `Newest file changed ${n} ${unit}${n === 1 ? '' : 's'} ago.`;
}

let dirtyCheck = null;     // set by pages with editable drafts
let focusTab = false;
let renderSeq = 0;
// A page that finishes loading after a newer navigation started must not paint over it.
function show(my, ...nodes) { if (my === renderSeq) page.replaceChildren(...nodes); }

function go(name, arg) {
  if (dirtyCheck && dirtyCheck() && !window.confirm('You have unsaved changes on this page. Leave without saving them?')) return Promise.resolve();
  dirtyCheck = null;
  if (remoteTestCleanup) { remoteTestCleanup(); remoteTestCleanup = null; }
  if (shortcutCleanup) { shortcutCleanup(); shortcutCleanup = null; }
  closeMenu();
  homeCtx = null;
  meetingsCtx = null;
  notesView = null;
  current = name;
  renderSeq += 1;
  onLevels = null;
  for (const b of document.querySelectorAll('#navitems button')) { b.classList.toggle('on', b.dataset.page === name); if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  page.scrollTop = 0;
  return pages[name](arg).catch(fail);
}

function renderNav() {
  const host = document.getElementById('navlive');
  if (live && live.active) {
    host.replaceChildren(h('div', { class: `livecard${live.paused ? ' paused' : ''}` },
      h('div', { class: 't' }, h('span', { class: `dot${live.paused ? '' : ' pulse'}` }), h('span', { id: 'navclock', text: live.paused ? 'Paused' : elapsed(live.meta.startMs) })),
      h('div', { class: 'n', text: live.meta.title }),
      btn('Show overlay', null, () => call('overlay:toggle', true))));
  } else host.replaceChildren();
}
setInterval(() => {
  if (!live || !live.active || live.paused) return;
  for (const id of ['navclock', 'heroclock']) { const el = document.getElementById(id); if (el) el.textContent = elapsed(live.meta.startMs); }
}, 1000);

const pages = {};

// ====================================================================== Home chips
// The four ways to decide when it answers, shared by the Home menu and Settings > Behaviour.
const MODES = [
  ['manual', 'On request', 'Only answers when you ask.'],
  ['mine', 'Mine', 'Answers questions meant for you: by name, one-to-one, or after you spoke.'],
  ['questions', 'Questions', 'Answers every question, except ones put to someone else by name.'],
  ['proactive', 'Suggest', 'Also speaks up when something is worth raising.'],
];
const modeName = (id) => (MODES.find((m) => m[0] === id) || MODES[2])[1];
const LAST_SOURCE = 'At least one source must stay on';
const sttShort = (p) => p.label.split(' (')[0];
const hasKey = (def) => Boolean(cfg.secrets[def.secret]);
const toSettings = (tab) => () => { settingsTab = tab; go('settings'); };
let micCache = null; // the last microphone list, shown at once while a fresh one is fetched

function chipSpecs(styles) {
  const s = S(), a = s.audio;
  const style = styles.find((p) => p.id === s.copilot.personality);
  const stt = cfg.sttProviders[s.stt.provider], llm = cfg.llmProviders[s.llm.live.provider];
  return [
    { id: 'mic', ic: 'mic', label: 'Microphone', value: a.captureMic !== false ? 'on' : 'off', off: a.captureMic === false },
    { id: 'system', ic: 'speaker', label: 'Computer audio', value: a.captureSystem !== false ? 'on' : 'off', off: a.captureSystem === false },
    { id: 'stt', ic: 'wave', label: 'Speech', value: hasKey(stt) ? sttShort(stt) : 'No key', warn: !hasKey(stt) },
    { id: 'llm', ic: 'bolt', label: 'Answers', value: hasKey(llm) ? s.llm.live.model : 'No key', warn: !hasKey(llm) },
    { id: 'style', ic: 'persona', label: 'Style', value: style ? style.name : 'As I am' },
    { id: 'mode', ic: 'spark', label: 'Mode', value: modeName(s.copilot.autoMode) },
  ];
}

function drawChips(ctx) {
  ctx.row.replaceChildren(...chipSpecs(ctx.styles).map((c) => {
    const chev = icon('chevron', 13); chev.classList.add('chev');
    return h('button', { type: 'button', class: `chip${c.off ? ' off' : ''}${c.warn ? ' warn' : ''}`, dataset: { chip: c.id }, title: `${c.label}: ${c.value}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => openChip(c.id, c.label, e.currentTarget) },
      icon(c.ic, 14), c.label, h('b', { text: c.value }), chev);
  }));
}

const keyState = () => `${hasKey(cfg.llmProviders[S().llm.live.provider])}|${hasKey(cfg.sttProviders[S().stt.provider])}`;

// Bring Home up to date after a choice, without fetching the page again. A change that flips a
// key on or off also changes the start button and the checklist, so that one redraws the page.
async function refreshHome(chipId) {
  const ctx = homeCtx;
  if (!ctx) return;
  const active = document.activeElement;
  const hadFocus = !active || active === document.body || ctx.row.contains(active);
  if (keyState() !== ctx.keys) await go('home');
  else {
    drawChips(ctx);
    if (ctx.steps.llm) ctx.steps.llm.textContent = `Set to ${cfg.llmProviders[S().llm.live.provider].label}.`;
    if (ctx.steps.stt) ctx.steps.stt.textContent = `Set to ${cfg.sttProviders[S().stt.provider].label}.`;
  }
  const chip = hadFocus && current === 'home' && page.querySelector(`.chip[data-chip="${chipId}"]`);
  if (chip) chip.focus();
}

async function chipSave(patch, chipId) {
  const ctx = homeCtx;
  try { await save(patch); } catch (e) { fail(e); return; }
  if (homeCtx === ctx) await refreshHome(chipId);
}

async function listMics() {
  const inputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  try {
    let devices = await inputs();
    // Names stay hidden until the page has been allowed to use a microphone, so ask once if they are missing.
    if (!devices.length || devices.some((d) => !d.label)) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of probe.getTracks()) t.stop();
      devices = await inputs();
    }
    if (!devices.length) return { error: 'No microphone found' };
    return { devices: devices.map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' })) };
  } catch (e) {
    return { error: { NotFoundError: 'No microphone found', NotAllowedError: 'Microphone access is blocked: Windows Settings > Privacy & security > Microphone', NotReadableError: 'The microphone is in use by another program' }[e.name] || `Microphone unavailable (${e.name})` };
  }
}

function micItems(found) {
  const a = S().audio, mic = a.captureMic !== false, sys = a.captureSystem !== false;
  const chosen = a.micDeviceId || 'default';
  const pick = (id) => () => id !== chosen && chipSave({ audio: { micDeviceId: id } }, 'mic');
  let devices;
  if (!found) devices = [{ type: 'note', label: 'Looking for microphones…' }];
  else if (found.error) devices = [{ type: 'note', label: found.error }];
  else {
    devices = found.devices.map((d) => ({ type: 'radio', id: `dev:${d.id}`, label: d.label, checked: d.id === chosen, onSelect: pick(d.id) }));
    if (!found.devices.some((d) => d.id === chosen)) devices.unshift({ type: 'radio', id: 'dev:default', label: 'System default', checked: true, onSelect: pick('default') });
  }
  return [
    { type: 'check', id: 'on', label: 'Listen to microphone', checked: mic, disabled: mic && !sys, reason: LAST_SOURCE, onSelect: () => chipSave({ audio: { captureMic: !mic } }, 'mic') },
    { type: 'separator' }, { type: 'header', label: 'Device' }, ...devices,
    { type: 'action', pinned: true, icon: 'sliders', label: 'More audio settings…', onSelect: toSettings('speech') }];
}

function systemItems() {
  const a = S().audio, mic = a.captureMic !== false, sys = a.captureSystem !== false;
  return [
    { type: 'check', id: 'on', label: 'Listen to computer audio', desc: 'The other people in the call. Turn off for an in-person meeting: the microphone then hears the whole room.', checked: sys, disabled: sys && !mic, reason: LAST_SOURCE, onSelect: () => chipSave({ audio: { captureSystem: !sys } }, 'system') },
    { type: 'action', pinned: true, icon: 'sliders', label: 'More audio settings…', onSelect: toSettings('speech') }];
}

function sttItems() {
  const cur = S().stt.provider;
  return [...Object.entries(cfg.sttProviders).map(([id, p]) => ({
    type: 'radio', id, label: sttShort(p), checked: id === cur, badge: hasKey(p) ? null : 'No key',
    desc: [p.streaming ? 'Live' : 'After each sentence', p.speakers && 'tells speakers apart'].filter(Boolean).join(' · '),
    onSelect: hasKey(p) ? () => id !== cur && chipSave({ stt: { provider: id } }, 'stt') : toSettings('keys') })),
  { type: 'action', pinned: true, icon: 'sliders', label: 'More speech settings…', onSelect: toSettings('speech') }];
}

function llmItems() {
  const cur = S().llm.live, items = [], entries = Object.entries(cfg.llmProviders);
  for (const [id, p] of entries) {
    const here = id === cur.provider;
    if (!hasKey(p) && !here) continue;
    items.push({ type: 'header', label: p.label });
    if (!hasKey(p)) { items.push({ type: 'radio', id: `${id}:${cur.model}`, label: cur.model, checked: true, badge: 'No key', onSelect: toSettings('keys') }); continue; }
    const known = p.known || [], custom = here && !known.includes(cur.model);
    for (const m of custom ? [cur.model, ...known] : known) {
      items.push({ type: 'radio', id: `${id}:${m}`, label: m, checked: here && m === cur.model, desc: custom && m === cur.model ? 'Your own model name' : m === (p.suggested || {}).live ? 'Suggested for live answers' : null,
        onSelect: () => !(here && m === cur.model) && chipSave({ llm: { live: { provider: id, model: m } } }, 'llm') });
    }
  }
  const keyless = entries.filter(([id, p]) => !hasKey(p) && id !== cur.provider);
  if (keyless.length) items.push({ type: 'separator' }, ...keyless.map(([id, p]) => ({ type: 'action', id: `key:${id}`, icon: 'key', label: `${p.label}: add a key…`, onSelect: toSettings('keys') })));
  items.push({ type: 'action', pinned: true, icon: 'bolt', label: 'Find the fastest…', onSelect: () => openSpeedTest() });
  items.push({ type: 'action', pinned: true, icon: 'sliders', label: 'More answer settings…', onSelect: toSettings('ai') });
  return items;
}

function styleItems(styles) {
  const cur = S().copilot.personality;
  return [...styles.map((p) => ({ type: 'radio', id: p.id, label: p.name, desc: p.description || null, checked: p.id === cur, onSelect: () => p.id !== cur && chipSave({ copilot: { personality: p.id } }, 'style') })),
    { type: 'action', pinned: true, icon: 'persona', label: 'Edit styles…', onSelect: () => go('styles') }];
}

function modeItems() {
  const cur = S().copilot.autoMode;
  return [...MODES.map(([id, label, desc]) => ({ type: 'radio', id, label, desc, checked: id === cur, onSelect: () => id !== cur && chipSave({ copilot: { autoMode: id } }, 'mode') })),
    { type: 'action', pinned: true, icon: 'sliders', label: 'More behaviour settings…', onSelect: toSettings('behaviour') }];
}

function openChip(id, label, anchor) {
  if (!homeCtx) return;
  const items = { mic: () => micItems(micCache), system: systemItems, stt: sttItems, llm: llmItems, style: () => styleItems(homeCtx.styles), mode: modeItems }[id]();
  const menu = popMenu(anchor, items, { label });
  if (id === 'mic' && menu) listMics().then((found) => { micCache = found; menu.update(micItems(found)); });
}

// ====================================================================== Home

pages.home = async () => {
  const my = renderSeq;
  let profile, meetings, styles;
  [cfg, live, lib, profile, meetings, styles] = await Promise.all([
    call('settings:get'), call('meeting:state'), call('library:stats'), call('profile:get'),
    call('meetings:list'), call('personalities:list')]);
  if (my !== renderSeq) return;
  renderNav();
  const s = S();
  const llmDef = cfg.llmProviders[s.llm.live.provider];
  const sttDef = cfg.sttProviders[s.stt.provider];
  const liveKey = Boolean(cfg.secrets[llmDef.secret]);
  const sttKey = Boolean(cfg.secrets[sttDef.secret]);
  const ready = liveKey && sttKey;
  const stepEls = {};
  let homeNext = null;

  let hero;
  if (live.active) {
    const me = h('div', { class: 'fill' }), them = h('div', { class: 'fill' });
    onLevels = (l) => { me.style.width = `${Math.min(100, Math.sqrt(l.me) * 110)}%`; them.style.width = `${Math.min(100, Math.sqrt(l.them) * 110)}%`; };
    hero = h('section', { class: 'panel hero' },
      h('div', { class: `livehero${live.paused ? ' paused' : ''}` },
        h('div', { class: 'grow' },
          h('div', { class: 'state' }, h('span', { class: `dot${live.paused ? '' : ' pulse'}` }), live.paused ? 'Paused: nothing is being recorded' : 'Listening'),
          h('h2', { text: live.meta.title }),
          h('div', { class: 'muted', text: `Started at ${live.meta.start}${live.room ? ' · in-person (microphone only)' : ''}` })),
        h('div', { class: 'big', id: 'heroclock', text: elapsed(live.meta.startMs) }),
        h('div', { class: 'row' },
          btn('Show overlay', 'external', () => call('overlay:toggle', true)),
          btn(live.paused ? 'Resume' : 'Pause', live.paused ? 'play' : 'pause', () => call(live.paused ? 'meeting:resume' : 'meeting:pause').then(() => go('home')).catch(fail)),
          armBtn('End meeting', 'stop', 'Click again to end', (e) => { e.currentTarget.disabled = true; call('meeting:stop').catch(fail); }, 'danger'))),
      h('div', { class: 'bars' },
        h('div', { class: 'bar' }, live.room ? 'Room microphone' : 'Microphone', h('div', { class: 'track' }, me)),
        !live.room && h('div', { class: 'bar them' }, 'Computer audio', h('div', { class: 'track' }, them))));
  } else {
    const title = h('input', { type: 'text', placeholder: 'Title (optional: named from the conversation afterwards)', 'aria-label': 'Meeting title' });
    const startBtn = h('button', { class: 'primary' }, icon(ready ? 'mic' : 'key', 17), ready ? 'Start meeting' : 'Add keys to start');
    const start = () => {
      if (!ready) { settingsTab = 'keys'; go('settings'); return; }
      startBtn.disabled = true; call('meeting:start', { title: title.value }).then(() => go('home')).catch((e) => { startBtn.disabled = false; fail(e); }); };
    startBtn.addEventListener('click', start);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
    const row = h('div', { class: 'chips' });
    homeNext = { styles, row, keys: keyState(), steps: stepEls };
    drawChips(homeNext);
    hero = h('section', { class: 'panel hero' },
      h('h2', { text: 'Start a meeting' }),
      h('p', { class: 'sub muted', text: ready ? 'Works with Zoom, Teams, Meet or any call playing on this computer. Nothing joins the meeting.' : 'Needs an AI key and a speech key.' }),
      h('div', { class: 'startrow' }, title, startBtn),
      row);
  }

  const steps = [
    { done: Boolean(s.me.name), what: 'Tell it who you are', why: 'So it can spot questions aimed at you.', to: () => { settingsTab = 'you'; go('settings'); } },
    { done: liveKey, id: 'llm', what: 'Add an AI key', why: `Set to ${llmDef.label}.`, to: () => { settingsTab = 'keys'; go('settings'); } },
    { done: sttKey, id: 'stt', what: 'Add a speech key', why: `Set to ${sttDef.label}.`, to: () => { settingsTab = 'keys'; go('settings'); } },
    { done: lib.files > 0, what: 'Add a folder of your notes', why: lib.files ? `${lib.files.toLocaleString()} file${lib.files === 1 ? "" : "s"} indexed.` : 'Markdown, text and diagram files.', to: () => go('knowledge') },
    { done: Boolean(profile.trim()), what: 'Write your profile', why: 'How you work, written from your files.', to: () => go('knowledge') },
  ];
  // Only the five steps the app needs: once they are done the checklist is gone and recent meetings take its place.
  const doneCount = steps.filter((x) => x.done).length;
  const allDone = doneCount === steps.length;
  let setup = null;
  if (!allDone) {
    const bar = h('i'); bar.style.width = `${Math.round(doneCount / steps.length * 100)}%`;
    setup = panel(h('span', {}, 'Set up ', h('span', { class: 'pill', text: `${doneCount} of ${steps.length}` })), null,
      h('div', { class: 'progress' }, bar),
      h('ul', { class: 'steps' }, steps.map((x) => h('li', { class: x.done ? 'done' : '' },
        h('span', { class: 'mark' }, x.done ? icon('check', 13) : null),
        h('span', { class: 'what' }, x.what, (x.id ? (stepEls[x.id] = h('small', { text: x.why })) : h('small', { text: x.why }))),
        !x.done && h('button', { text: 'Open', 'aria-label': `Open: ${x.what}`, onclick: x.to })))));
  }

  const sc = s.shortcuts;
  const keys = panel('While a meeting runs', 'From any window, without touching the overlay.',
    h('div', { class: 'keys' }, [['answer', 'What to say'], ['screen', 'Read screen'], ['take', 'My take'], ['catchup', 'Catch up'], ['pause', 'Pause or resume listening'], ['toggleOverlay', 'Show or hide overlay']]
      .flatMap(([k, label]) => [sc[k] ? h('kbd', { text: accelLabel(sc[k]) }) : h('span', { class: 'faint', text: 'not set' }), h('span', { text: label })])));

  const recent = meetings.length ? panel('Recent meetings', null,
    h('div', { class: 'recent scr' }, meetings.slice(0, allDone ? 5 : 3).map((m) => h('button', { onclick: () => go('meetings', m.id) },
      h('span', { class: 't', text: m.title }), h('span', { class: 'w', text: `${niceDate(m.date)} · ${m.start} · ${m.durationMin} min` }),
      m.summary && h('span', { class: 's', text: m.summary }))))) : null;
  if (recent) recent.classList.add('recentpanel');

  const firstName = s.me.name ? s.me.name.split(' ')[0] : '';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (my === renderSeq) homeCtx = homeNext;
  show(my, wrap(firstName ? `${greet}, ${firstName}` : 'Understudy', 'Knows your work, listens to your meetings and hands you what to say.',
    hero, ...(allDone
      ? [h('div', { class: 'homegrid' }, ...[recent, keys].filter(Boolean).map((x) => h('div', { class: 'col' }, x)))]
      : [h('div', { class: 'homegrid' }, h('div', { class: 'col' }, setup), h('div', { class: 'col' }, keys, recent))])));
};

// ====================================================================== Meetings
// Everyone but you can be given a real name. "Them" is included: in a
// one-to-one call without speaker separation it is exactly one person.
function canRename(label) {
  return String(label).toLowerCase() !== (S().me.name || 'Me').toLowerCase();
}

// Swap a label for a small text box in place. Enter or leaving the box saves,
// Escape cancels. save(name) does the work and may return a promise.
// A refusal (onError, when given) is shown where the caller says; otherwise it is a toast.
function editSpeaker(el, from, save, onError) {
  const input = h('input', { type: 'text', class: 'speaker-edit', value: from, maxLength: 40, 'aria-label': 'Speaker name', autocomplete: 'off' });
  input.spellcheck = false;
  let done = false;
  const finish = async (doSave) => {
    if (done) return;
    done = true;
    const to = input.value.replace(/\s+/g, ' ').trim();
    if (!doSave || !to || to === from) { if (input.isConnected) input.replaceWith(el); return; }
    input.disabled = true;
    try { await save(to); } catch (e) { (onError || fail)(e); }
    if (input.isConnected) input.replaceWith(el); // the page was not redrawn
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  el.replaceWith(input);
  input.focus();
  input.select();
}

function transcriptView(md, onRename) {
  const box = h('div', { class: 'transcript' });
  const mine = (S().me.name || 'Me').toLowerCase();
  for (const para of String(md || '').split(/\n\s*\n/)) {
    const m = para.match(/^\*\*\[([^\]]+)\] ([^*]+?):\*\*\s*([\s\S]*)$/);
    if (m) {
      const label = m[2];
      const who = onRename && canRename(label)
        ? h('button', { type: 'button', class: 'who', title: 'Click to rename this speaker', 'aria-label': `Rename ${label}`, text: label, onclick: (e) => onRename(label, e.currentTarget) })
        : h('span', { class: 'who', text: label });
      box.append(h('div', { class: `blk ${label.toLowerCase() === mine ? 'me' : `s${speakerSlot(label)}`}` }, h('span', { class: 'ts', text: m[1] }), h('div', {}, who, h('div', { class: 'txt', text: m[3] }))));
    } else if (para.trim()) box.append(h('p', { class: 'muted', text: para.replace(/^_|_$/g, '') }));
  }
  return box;
}

// A search hit is a paragraph of the meeting file: show it as plain words, labelled "Notes" or "Transcript 11:41".
function hitText(raw) {
  const s = String(raw || '').trim();
  const t = s.match(/^\*\*\[(\d{1,2}:\d{2})(?::\d{2})?\]\s*([^*]*?):\*\*\s*([\s\S]*)$/);
  if (t) return { label: `Transcript ${t[1]}`, text: `${t[2]}: ${t[3].replace(/\s+/g, ' ').trim()}` };
  let out = '';
  for (const line of s.split('\n')) {
    let x = line.trim();
    if (!x) continue;
    const head = x.match(/^#{1,6}\s+(.*)$/);
    x = x.replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+(\[[ xX]\]\s*)?/, '').replace(/^\d+[.)]\s+/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').replace(/\s*\(due:\s*not stated\)/i, '').trim();
    if (x) out += `${out ? ' ' : ''}${x}${head && !/[.:!?]$/.test(x) ? ':' : ''}`;
  }
  return { label: 'Notes', text: out };
}

// The part of the notes under the "Follow-up message" heading, as written, for the copy button beside it.
function followUpOf(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^#{1,6}\s+Follow-up message\s*$/i.test(l));
  if (at < 0) return '';
  const level = lines[at].match(/^#+/)[0].length;
  const out = [];
  for (const l of lines.slice(at + 1)) { const m = l.match(/^(#+)\s/); if (m && m[1].length <= level) break; out.push(l); }
  return out.join('\n').trim();
}

// The notes as a page, with a small copy button beside the "Follow-up message" heading.
function notesDoc(notes, onTask) {
  const doc = h('div', { class: 'doc' }, renderMarkdown(notes, { onTask }));
  const head = [...doc.querySelectorAll('h3')].find((x) => /^Follow-up message$/i.test(x.textContent.trim()));
  const text = followUpOf(notes);
  if (head && text) {
    head.classList.add('withcopy');
    head.append(h('button', { type: 'button', class: 'ghost ib small', title: 'Copy the follow-up message', 'aria-label': 'Copy the follow-up message', onclick: () => call('app:copy', text).then(() => toast('Follow-up message copied.')).catch(fail) }, icon('copy', 14)));
  }
  return doc;
}

pages.meetings = async (openId) => {
  const my = renderSeq;
  cfg = cfg || await call('settings:get');
  if (my !== renderSeq) return;
  let list = await call('meetings:list');
  if (my !== renderSeq) return;
  if (openId) selectedMeeting = openId;
  if (!selectedMeeting || !list.some((m) => m.id === selectedMeeting)) selectedMeeting = list[0] ? list[0].id : null;

  const listBox = h('div');
  const detail = h('div', { class: 'detail' });
  const search = h('input', { type: 'search', placeholder: 'Search meetings', 'aria-label': 'Search meetings' });

  const item = (m, hit) => h('button', { class: `item${m.id === selectedMeeting ? ' on' : ''}`, dataset: { id: m.id }, onclick: () => { selectedMeeting = m.id; drawList(); drawDetail(); } },
    h('span', { class: 't', text: m.title }),
    hit ? [h('span', { class: 'm' }, h('span', { class: 'pill', text: hit.label }), niceDate(hit.date)), h('span', { class: 'snip', text: hit.text })] : h('span', { class: 'm' }, `${m.start} · ${m.durationMin} min`, !m.hasNotes && (notesState.get(m.id) || m.notesWorking ? h('span', { class: 'pill warn', dataset: { notesPill: m.id }, text: notesMsg.get(m.id) || 'writing notes' }) : h('span', { class: 'pill warn', text: 'no notes' }))));

  let hits = null;
  let shown = null;      // the meeting the detail shows now, as meetings:get gave it (to see whether the file has changed since)
  let detailSeq = 0;     // each drawing of the detail takes the next number: an older one that is still waiting for the file gives way
  let titleSaving = false;
  // Redraws the list where it is: the list's scroll position and the focused entry stay.
  function drawList() {
    const box = listBox.parentElement;
    const top = box ? box.scrollTop : 0;
    const act = document.activeElement;
    const keepId = act && listBox.contains(act) && act.dataset ? act.dataset.id : undefined;
    const kids = [];
    if (hits) {
      kids.push(h('h3', { text: hits.length ? `${hits.length} matching passage${hits.length === 1 ? '' : 's'}` : 'No matches' }));
      for (const x of hits) kids.push(item({ id: x.id, title: x.title, start: x.start, durationMin: 0, hasNotes: true }, { ...hitText(x.snippet), date: x.date }));
    } else {
      let day = '';
      for (const m of list) {
        if (m.date !== day) { day = m.date; kids.push(h('h3', { text: niceDate(m.date, { weekday: 'long', day: 'numeric', month: 'long' }) })); }
        kids.push(item(m));
      }
    }
    listBox.replaceChildren(...kids);
    if (box) box.scrollTop = top;
    if (keepId !== undefined) { const again = [...listBox.querySelectorAll('button.item')].find((b) => b.dataset.id === keepId); if (again) again.focus({ preventScroll: true }); }
  }
  let searchSeq = 0;
  async function runSearch() {
    const q = search.value.trim(), n = ++searchSeq;
    const found = q.length >= 2 ? await call('meetings:search', q).catch(() => []) : null;
    if (n !== searchSeq || my !== renderSeq) return; // a newer search (or another page) has taken over
    hits = found;
    drawList();
  }
  search.addEventListener('input', debounce(runSearch, 250));

  // Click the title to change it. Enter or leaving the box saves, Escape cancels, as for a speaker name. A title that
  // is empty is not saved: the old one stays and a line under it says why. Only the title and the list are redrawn,
  // so the notes' scroll, the tab and an update typed but not added stay as they are.
  function editTitle(btn, id, from, line) {
    const input = h('input', { type: 'text', class: 'title-edit', value: from, maxLength: 200, 'aria-label': 'Meeting title', autocomplete: 'off' });
    input.spellcheck = false;
    let done = false;
    const say = (text) => { line.textContent = text; };
    const back = (focus) => { if (input.isConnected) input.replaceWith(btn); if (focus && btn.isConnected) btn.focus({ preventScroll: true }); };
    const finish = async (doSave, byKey) => {
      if (done) return;
      done = true;
      const to = input.value.replace(/\s+/g, ' ').trim();
      if (!doSave || to === from) { back(byKey); sync(); return; }
      if (!to) { back(byKey); say('Type a title for this meeting.'); sync(); return; }
      input.disabled = true; titleSaving = true;
      try {
        const next = await call('meetings:rename', id, to);
        btn.textContent = next.meta.title;
        btn.onclick = () => editTitle(btn, id, next.meta.title, line);
        if (my === renderSeq && selectedMeeting === id) shown = next;
        try { list = await call('meetings:list'); } catch { /* the list is read again at the next change */ }
        if (my === renderSeq) drawList();
      } catch (e) { say(e.message || 'The meeting could not be renamed.'); }
      titleSaving = false;
      back(byKey);
      sync(); // a change that arrived while the box was open is shown now
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
    });
    input.addEventListener('blur', () => finish(true, false));
    say('');
    btn.replaceWith(input);
    input.focus();
    input.select();
  }

  // The list and the open meeting again, after a file changed on disk (a meeting from another PC, an edit by Claude)
  // or the window came back to the front. Nothing the person is doing is disturbed: the list keeps its scroll, its
  // focus and the search box; the open meeting is redrawn only when its file differs from what is shown and nothing
  // there is being edited (it is looked at again at the next change otherwise).
  const editing = () => {
    const up = detail.querySelector('.updin');
    return Boolean(detail.querySelector('.speaker-edit, .title-edit') || titleSaving || ticksPending || (up && (up.value || up.readOnly)) || (selectedMeeting && notesState.get(selectedMeeting) === 'working'));
  };
  const sameMeeting = (a, b) => a && b && a.notes === b.notes && a.transcript === b.transcript && JSON.stringify(a.meta) === JSON.stringify(b.meta);
  async function syncOnce() {
    const fresh = await call('meetings:list');
    if (my !== renderSeq) return;
    const listChanged = JSON.stringify(fresh) !== JSON.stringify(list);
    list = fresh;
    const had = selectedMeeting;
    const gone = Boolean(had) && !fresh.some((m) => m.id === had);
    if (gone || !selectedMeeting) selectedMeeting = fresh[0] ? fresh[0].id : null;
    if (listChanged || gone) { if (search.value.trim().length >= 2) await runSearch(); else drawList(); }
    if (my !== renderSeq) return;
    if (gone || !had || (!shown && selectedMeeting)) { if (!editing()) await drawDetail(); return; }
    if (!selectedMeeting || editing()) return;
    const seq = detailSeq;
    let m;
    try { m = await call('meetings:get', selectedMeeting); } catch { return; } // gone since the list was read: the next pass sees it
    if (my !== renderSeq || seq !== detailSeq || editing() || sameMeeting(shown, m)) return;
    await drawDetail(true, m);
  }
  let syncing = false, syncAgain = false;
  async function sync() {
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    try { do { syncAgain = false; await syncOnce(); } while (syncAgain && my === renderSeq); } catch { /* the next change tries again */ } finally { syncing = false; }
  }


  // The same step the toolbar button takes, so progress shows up the usual way ('notes' events).
  function rewriteNotes(id) {
    staleNotes.delete(id);
    notesState.set(id, 'working'); meetingTab = 'notes'; drawDetail();
    // Refused before anything was written (the file cannot be read as it should be): put the page back and say why.
    call('meetings:regenerate', id).catch((e) => { notesState.delete(id); if (selectedMeeting === id) drawDetail(true); fail(e); });
  }

  // A name that is refused (the person's own) is said in the line under the title, where the pills are, and stays
  // until the next try. The name of another speaker asks for a second step in the same place: a button that needs
  // a second click ("Merge into Priya N? Click again"), and only that second click joins the two.
  function renameSpeaker(id, from, el) {
    const line = () => detail.querySelector('.titleline');
    if (line()) line().textContent = '';
    const send = (to, merge) => call('meetings:renameSpeaker', id, from, to, merge).then((r) => {
      toast(r && r.merged ? `Merged ${from} into ${r.merged}.` : `Renamed ${from} to ${to}${/[.!?]$/.test(to) ? '' : '.'}`); // "Priya N." must not end in ".."
      if (r && r.notesMentionOld) staleNotes.add(id); else staleNotes.delete(id);
      return drawDetail(true);
    });
    const say = (e, to) => {
      const at = line();
      if (!at) return fail(e);
      const msg = e.message || 'The name could not be changed.';
      const other = /^There is already a speaker called (.+) in this meeting\./.exec(msg);
      at.textContent = msg;
      if (other && to) at.append(' ', armBtn(`Merge ${from} into ${other[1]}`, null, `Merge into ${other[1]}? Click again`, () => send(to, true).catch((err) => say(err, '')), 'ghost'));
    };
    editSpeaker(el, from, (to) => send(to, false).catch((e) => { say(e, to); }), null);
  }

  // Ticks go one at a time, and the view is redrawn from the meeting the last one returns.
  let tickChain = Promise.resolve(), ticksPending = 0;
  function noteLine(text, bad = false) {
    const el = detail.querySelector('.noteline');
    if (!el) return;
    el.textContent = text; el.className = `noteline${bad ? ' bad' : ''}`;
  }
  function tickTask(id, index, done, text, box) {
    ticksPending += 1;
    tickChain = tickChain.then(async () => {
      let next = null;
      try { next = await call('meetings:setActionItem', id, index, text, done); noteLine(''); } catch (e) {
        if (box.isConnected) setTaskBox(box, !done); // put the box back
        noteLine(e.message || 'The action item could not be saved.', true);
      }
      ticksPending -= 1;
      if (next && !ticksPending && selectedMeeting === id && my === renderSeq) await drawDetail(true, next);
    });
  }

  async function drawDetail(keepScroll = false, given = null, status = null) {
    if (!selectedMeeting) {
      detail.replaceChildren(h('div', { class: 'empty' }, icon('calendar', 34), h('b', { text: 'No meetings yet' }), 'When a meeting ends it is saved here with its notes and full transcript, as a Markdown file in ', h('span', { class: 'mono', text: cfg.meetingsDir })));
      return;
    }
    const seq = ++detailSeq;
    const oldBody = detail.querySelector('.dbody');
    const top = oldBody ? oldBody.scrollTop : 0; // a rename redraws the page in place, so keep the reader's spot
    const act = document.activeElement;
    const keepTask = act && detail.contains(act) && act.dataset ? act.dataset.task : undefined;
    const keepInput = Boolean(act && act.classList && act.classList.contains('updin'));
    let m = given;
    if (!m) { try { m = await call('meetings:get', selectedMeeting); } catch (e) { detail.replaceChildren(h('div', { class: 'empty', text: e.message })); return; } }
    if (my !== renderSeq || seq !== detailSeq) return;
    shown = m;
    const working = notesState.get(m.meta.id) === 'working' || Boolean((list.find((x) => x.id === m.meta.id) || {}).notesWorking);
    const hasNotes = !/^_.*not been generated/m.test(m.notes);
    const tabs = segmented([['notes', 'Notes'], ['transcript', 'Transcript']], meetingTab, (v) => { meetingTab = v; drawDetail(); });
    const id = m.meta.id;
    const body = meetingTab === 'transcript' ? transcriptView(m.transcript, (from, el) => renameSpeaker(id, from, el))
      : working ? h('div', {}, h('p', { class: 'muted', text: 'Writing the notes. The transcript is already saved.' }), h('p', { class: 'muted notesmsg', role: 'status', 'aria-live': 'polite', dataset: { notesMsg: id }, text: notesMsg.get(id) || '' }), h('div', { class: 'skeleton' }, h('i'), h('i'), h('i')))
        : hasNotes ? notesDoc(m.notes, (index, done, text, box) => tickTask(id, index, done, text, box))
          : h('div', { class: 'empty' }, icon('file', 30), h('b', { text: 'No notes for this meeting' }), 'The transcript is saved. Notes can be written from it at any time.');
    const turnsCount = (m.transcript.match(/^\*\*\[/gm) || []).length;
    const bodyBox = h('div', { class: 'dbody scr' }, body);
    // Under the notes, outside what scrolls: add a line to the meeting without leaving the page.
    let footer = null, upIn = null;
    if (meetingTab === 'notes' && hasNotes && !working) {
      upIn = h('input', { type: 'text', class: 'updin', maxLength: 2000, value: updateDrafts.get(id) || '', autocomplete: 'off', placeholder: 'Add an update, for example: runbook sent on Friday', 'aria-label': 'Add an update to these notes' });
      const upBtn = h('button', { type: 'button' }, icon('plus', 15), 'Add update');
      const line = h('p', { class: `noteline${status && status.bad ? ' bad' : ''}`, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', text: status ? status.text : '' });
      const add = async () => {
        const text = upIn.value.replace(/\s+/g, ' ').trim();
        if (!text) { upIn.focus(); return; }
        upBtn.disabled = true; upIn.readOnly = true;
        try {
          const next = await call('meetings:addUpdate', id, text);
          updateDrafts.delete(id);
          if (selectedMeeting === id && my === renderSeq) await drawDetail(false, next, { text: 'Update added.', end: true });
        } catch (e) { upBtn.disabled = false; upIn.readOnly = false; line.textContent = e.message || 'The update could not be saved.'; line.className = 'noteline bad'; upIn.focus(); }
      };
      upBtn.addEventListener('click', add);
      upIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      upIn.addEventListener('input', () => { if (upIn.value) updateDrafts.set(id, upIn.value); else updateDrafts.delete(id); if (line.textContent) { line.textContent = ''; line.className = 'noteline'; } });
      footer = h('div', { class: 'updatebar' }, h('div', { class: 'row nowrap' }, upIn, upBtn), line);
    }
    const titleLine = h('p', { class: 'noteline bad titleline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const titleBtn = h('button', { type: 'button', class: 'titlebtn', title: 'Rename', text: m.meta.title });
    titleBtn.onclick = () => editTitle(titleBtn, id, m.meta.title, titleLine);
    detail.replaceChildren(h('div', { class: 'inner' }, h('div', { class: 'dhead' },
      h('h1', {}, titleBtn), titleLine,
      h('div', { class: 'metaline' },
        h('span', { class: 'pill' }, icon('calendar', 12), niceDate(m.meta.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })),
        h('span', { class: 'pill' }, icon('clock', 12), `${m.meta.start}${m.meta.end ? `–${m.meta.end}` : ''} · ${m.meta.durationMin} min`),
        m.meta.speakers.map((name) => canRename(name)
          ? h('button', { type: 'button', class: 'pill speaker-pill', title: `Rename ${name}`, 'aria-label': `Rename ${name}`, onclick: (e) => renameSpeaker(id, name, e.currentTarget) }, icon('user', 12), name)
          : h('span', { class: 'pill' }, icon('user', 12), name)),
        h('span', { class: 'pill' }, icon('message', 12), `${turnsCount} turn${turnsCount === 1 ? '' : 's'}`)),
      staleNotes.has(id) && !working && hasNotes
        ? h('div', { class: 'inline-notice', role: 'status' }, h('span', { text: 'The notes still use the old name.' }), btn('Rewrite notes', 'refresh', () => rewriteNotes(id), '', KEPT))
        : null,
      h('div', { class: 'toolbar' }, tabs, h('span', { class: 'grow' }),
        meetingTab === 'notes'
          ? btn('Copy', 'copy', () => call('app:copy', m.notes).then(() => toast('Notes copied.')))
          : btn('Copy', 'copy', () => call('app:copy', m.transcript.replace(/\*\*/g, '')).then(() => toast('Transcript copied.'))),
        btn(working ? 'Writing…' : hasNotes ? 'Rewrite notes' : 'Write notes', 'refresh', () => rewriteNotes(id), '', hasNotes ? KEPT : ''),
        h('button', { class: 'ib', title: 'Show the file in Explorer', 'aria-label': 'Show file', onclick: () => call('meetings:reveal', m.meta.id) }, icon('folder', 16)))),
      bodyBox, footer));
    bodyBox.scrollTop = status && status.end ? bodyBox.scrollHeight : keepScroll ? top : 0;
    if (keepInput && upIn) upIn.focus({ preventScroll: true });
    else if (keepTask !== undefined) { const again = detail.querySelector(`[data-task="${keepTask}"]`); if (again) again.focus({ preventScroll: true }); }
    if (status && status.end && upIn) upIn.focus({ preventScroll: true });
  }

  meetingsCtx = {
    // A progress message arrived: change the words where they already are, without redrawing anything.
    progress(id, message) {
      for (const el of page.querySelectorAll('[data-notes-pill]')) if (el.dataset.notesPill === id) el.textContent = message || 'writing notes';
      for (const el of page.querySelectorAll('[data-notes-msg]')) if (el.dataset.notesMsg === id) el.textContent = message || '';
    },
    // The notes for this meeting started or stopped being written somewhere else: show it.
    refresh(id) { drawList(); if (selectedMeeting === id) drawDetail(true); },
    // A meeting file changed on disk, or the window came back to the front.
    sync,
  };
  drawList();
  await drawDetail();
  if (my !== renderSeq) return;
  show(my, h('div', { class: 'split' },
    h('div', { class: 'list scr' }, h('div', { class: 'searchbox' }, icon('search', 15), search), listBox),
    detail));
};

// ====================================================================== Knowledge
// ====================================================================== Notes (Knowledge page)
// What was being written when the page was left, kept here so an error, a redraw or a trip to another page
// never costs the reader their words.
const noteDraft = { title: '', text: '', image: null }; // image: { dataUrl, bytes, w, h, bitmap }
let imgNow = { state: '', message: '', stats: { described: 0, cached: 0, pending: 0, skipped: 0, cost: 0 } };
let notesView = null;  // { drawImages() } while the Notes tab is on screen

const NOTE_IMAGE_TOO_BIG = 'That image is too large (over 15 MB).';
const NOTE_TEXT_TOO_LONG = 'That note is too long to save (over 1 MB).';
const SOURCE_NAMES = { claude: 'Claude', pasted: 'pasted', screenshot: 'screenshot', file: '' }; // a plain file needs no label
const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB` : `${(n / 1048576).toFixed(1)} MB`);

// The window cannot ask for this PC's name, so notes:info may send it as `host`; failing that, the name on the
// last note this window saved is used. Without either, every note shows where it came from.
function pcName(info) {
  if (info && info.host) return info.host;
  try { return localStorage.getItem('understudy.pc') || ''; } catch { return ''; }
}
function rememberPc(name) { try { if (name) localStorage.setItem('understudy.pc', name); } catch { /* the name is only a convenience */ } }

function noteWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Today ${t}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

// A path that loses its middle, not its end, when the row is narrow: the folder name at the end is what tells folders apart.
function midPath(full) {
  const p = String(full || '');
  // The tail starts at the earliest folder separator that leaves it 22 characters or fewer (the last two folder names when they fit).
  let at = Math.max(0, p.length - 18);
  for (let i = 1; i < p.length - 1; i += 1) if ((p[i] === '\\' || p[i] === '/') && p.length - i <= 22) { at = i; break; }
  return h('span', { class: 'midpath mono', title: p },
    h('span', { class: 'a', text: p.slice(0, at) }), h('span', { class: 'b', text: p.slice(at) }));
}

// ---- Settings > Behaviour > Sync between PCs: one folder (in Google Drive, OneDrive or Dropbox) for Meetings and Notes.
// A path with its middle left out, as text for a sentence; the full path goes in a title.
function midText(full, max = 44) {
  const p = String(full || '');
  if (p.length <= max) return p;
  let at = Math.max(0, p.length - 24);
  for (let i = 1; i < p.length - 1; i += 1) if ((p[i] === '\\' || p[i] === '/') && p.length - i <= 26) { at = i; break; }
  return p.slice(0, Math.max(3, max - (p.length - at) - 1)) + '…' + p.slice(at);
}
const countOf = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const andList = (parts) => parts.filter(Boolean).join(' and ');
let syncDone = null; // what the last switch did, shown once when Settings is drawn again

function syncPanel(info) {
  const body = h('div', { class: 'syncbody' });
  const say = h('p', { class: 'noteline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tell = (text, kind = '', title = '') => { say.textContent = text; say.className = 'noteline' + (kind ? ' ' + kind : ''); if (title) say.title = title; else say.removeAttribute('title'); };
  const pathRows = (m, n) => h('dl', { class: 'syncpaths' }, h('dt', { text: 'Meetings' }), h('dd', {}, midPath(m)), h('dt', { text: 'Notes' }), h('dd', {}, midPath(n)));

  const idle = (focusChoose) => {
    const choose = h('button', { type: 'button' }, icon('folder', 15), 'Choose shared folder');
    const open = !info.isDefault && h('button', { type: 'button', class: 'ib', title: 'Open the shared folder', 'aria-label': 'Open the shared folder', onclick: () => call('shared:open').catch((e) => tell(e.message, 'bad')) }, icon('folder', 16));
    const state = info.isDefault
      ? h('p', { class: 'syncstate', text: 'Not shared: meetings and notes are kept on this PC.' })
      : info.shared
        ? h('div', { class: 'syncstate' }, h('span', { class: 'lab', text: 'Shared in' }), h('div', { class: 'pathbox' }, midPath(info.parent)))
        : pathRows(info.meetingsDir, info.notesDir);
    choose.addEventListener('click', async () => {
      choose.disabled = true; tell('');
      try {
        const r = await call('shared:choose');
        if (!r) { choose.disabled = false; choose.focus(); return; }
        ask(r);
      } catch (e) { tell(e.message, 'bad'); choose.disabled = false; choose.focus(); }
    });
    body.onkeydown = null;
    body.replaceChildren(state, h('div', { class: 'syncbtns' }, choose, open),
      h('p', { class: 'synchint', text: 'Choose a folder inside Google Drive (Mirror files), OneDrive or Dropbox. On your other PCs choose the same folder.' }));
    if (focusChoose) choose.focus();
  };

  const ask = (r) => {
    const parts = [h('p', { class: 'syncstate', text: 'Keep meetings and notes in these folders?' }), pathRows(r.meetingsDir, r.notesDir)];
    const m = r.existing.meetings, n = r.existing.notes;
    const cancel = h('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => { tell(''); idle(true); });
    let btns, first;
    const run = async (copy) => {
      for (const b of btns) b.disabled = true;
      tell(copy ? 'Copying…' : 'Switching…');
      try {
        const res = await call('shared:apply', { copy });
        cfg = await call('settings:get');
        syncDone = { parent: r.parent, copy, overlap: r.overlap, copied: res.copied };
        go('settings');
      } catch (e) {
        if (/choose the folder again/i.test(e.message)) { idle(true); tell(e.message, 'bad'); return; }
        tell(e.message, 'bad');
        for (const b of btns) b.disabled = false;
        first.focus();
      }
    };
    if (r.same) {
      parts.push(h('p', { class: 'syncstate', text: 'These are already your Meetings and Notes folders.' }));
      first = h('button', { type: 'button', class: 'primary' }, 'OK');
      first.addEventListener('click', () => { tell(''); idle(true); });
      btns = [first];
    } else if (r.overlap) {
      parts.push(h('p', { class: 'syncstate', text: 'These folders overlap, so nothing will be copied.' }));
      first = h('button', { type: 'button', class: 'primary' }, 'Switch');
      first.addEventListener('click', () => run(false));
      btns = [first, cancel];
    } else if (m + n > 0) {
      const what = andList([m && countOf(m, 'meeting', 'meetings'), n && countOf(n, 'note', 'notes')]);
      parts.push(h('p', { class: 'syncstate', text: 'Copy ' + what + ' into it? Originals stay where they are.' }));
      first = h('button', { type: 'button', class: 'primary' }, 'Copy and switch');
      first.addEventListener('click', () => run(true));
      const without = h('button', { type: 'button' }, 'Switch without copying');
      without.addEventListener('click', () => run(false));
      btns = [first, without, cancel];
    } else {
      first = h('button', { type: 'button', class: 'primary' }, 'Switch');
      first.addEventListener('click', () => run(false));
      btns = [first, cancel];
    }
    body.replaceChildren(...parts, h('div', { class: 'syncbtns' }, ...btns));
    body.onkeydown = (e) => { if (e.key === 'Escape' && !btns[0].disabled) { e.stopPropagation(); tell(''); idle(true); } };
    first.focus();
  };

  idle(false);
  if (syncDone) {
    const d = syncDone; syncDone = null;
    const c = d.copied;
    const lines = ['Meetings and notes now live in ' + midText(d.parent) + '.'];
    const got = andList([c.meetings && 'Copied ' + countOf(c.meetings, 'meeting', 'meetings'), c.notes && (c.meetings ? '' : 'Copied ') + countOf(c.notes, 'note', 'notes')]);
    if (got) lines.push(got + '.');
    else if (d.copy && !d.overlap && c.skipped) lines.push('Everything was already in the new folders.');
    if (d.overlap) lines.push('These folders overlap, so nothing was copied.');
    if (c.failed) lines.push(countOf(c.failed, 'file', 'files') + ' could not be copied and ' + (c.failed === 1 ? 'is' : 'are') + ' still in the old folders.');
    tell(lines.join(' '), c.failed ? 'bad' : 'ok', d.parent);
  }
  const liveCopy = toggle('Live copy while a meeting runs', (S().sync || {}).liveCopy !== false, (v) => save({ sync: { liveCopy: v } }).catch(fail),
    `Keeps a file called ${info.liveFile || '_live-<this PC>.md'} up to date in the Meetings folder, so you can follow along from another PC.`);
  return panel('Sync between PCs', null, h('div', { class: 'syncbox' }, body, say), liveCopy);
}

function imageStatusLine() {
  const { state, message, stats } = imgNow;
  if (state === 'error' && message) return { text: message, bad: true };
  const read = (stats.described || 0) + (stats.cached || 0), wait = stats.pending || 0, skip = stats.skipped || 0;
  if (state === 'working') return { text: wait ? `Reading ${read + 1} of ${read + wait}…` : 'Reading images…' };
  if (!read && !wait && !skip) return { text: 'No images found in your folders yet.' };
  return { text: [`${read} read`, wait && `${wait} waiting`, skip && `${skip} could not be read`].filter(Boolean).join(', ') };
}

const readDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('That image could not be read.')); r.readAsDataURL(file); });

function notesSection(info, recent, loadError) {
  const root = h('div', { class: 'srcbody notesbody scr' });
  if (!info) {
    root.append(h('p', { class: 'noteline bad', role: 'alert', text: loadError || 'Notes are not available right now.' }), h('div', { class: 'row' }, btn('Try again', 'refresh', () => go('knowledge'))));
    return { el: root, drawImages() {} };
  }
  let pc = pcName(info);

  // ---- add a note
  const ta = h('textarea', { class: 'notebox', rows: 3, value: noteDraft.text, spellcheck: true, 'aria-label': 'Note text', placeholder: 'Paste text or a screenshot (Ctrl+V), or drop a file here.' });
  const title = h('input', { type: 'text', value: noteDraft.title, maxLength: 120, placeholder: 'Title (optional)', 'aria-label': 'Note title', autocomplete: 'off' });
  const say = h('p', { class: 'noteline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const prev = h('div', { class: 'imgprev', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'primary' }, icon('check', 15), 'Save');
  const tell = (text, kind = '') => { say.textContent = text; say.className = `noteline${kind ? ` ${kind}` : ''}`; };

  let saving = false, reading = 0;
  const syncSaveBtn = () => { saveBtn.disabled = saving || reading > 0; };
  const clearDraftImage = () => {
    try { noteDraft.image?.bitmap?.close(); } catch { /* already closed */ }
    noteDraft.image = null;
  };

  // The window's content policy does not allow blob: or data: pictures, so the preview is painted onto a canvas.
  const drawPrev = () => {
    const im = noteDraft.image;
    prev.hidden = !im;
    if (!im) { prev.replaceChildren(); return; }
    const thumb = h('canvas', { class: 'thumb', 'aria-hidden': 'true' });
    const w = 64, hh = im.w && im.h ? Math.max(24, Math.min(64, Math.round(64 * im.h / im.w))) : 40;
    thumb.width = w; thumb.height = hh;
    if (im.bitmap) { try { thumb.getContext('2d').drawImage(im.bitmap, 0, 0, w, hh); } catch { /* a blank preview is fine */ } }
    prev.replaceChildren(thumb, h('span', { class: 'meta' }, h('b', { text: 'Image ready to save' }), h('span', { text: `${im.w && im.h ? `${im.w} × ${im.h} · ` : ''}${kb(im.bytes)}` })),
      h('button', { type: 'button', class: 'ghost ib', title: 'Remove the image', 'aria-label': 'Remove the image', onclick: () => { clearDraftImage(); drawPrev(); tell(''); ta.focus(); } }, icon('x', 15)));
  };

  const takeImage = async (file) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { tell('Only PNG, JPEG, WebP and GIF images can be saved.', 'bad'); return; }
    if (file.size > 15 * 1024 * 1024) { tell(NOTE_IMAGE_TOO_BIG, 'bad'); return; }
    reading += 1; syncSaveBtn();
    try {
      const dataUrl = await readDataUrl(file);
      let bitmap = null;
      try { bitmap = await createImageBitmap(file); } catch { /* the preview then has no picture, the image still saves */ }
      clearDraftImage();
      noteDraft.image = { dataUrl, bytes: file.size, w: bitmap ? bitmap.width : 0, h: bitmap ? bitmap.height : 0, bitmap };
      drawPrev(); tell('');
    } catch (e) { tell(e.message, 'bad'); }
    finally { reading -= 1; syncSaveBtn(); }
  };

  const takeText = async (file) => {
    if (file.size > 1000000) { tell(NOTE_TEXT_TOO_LONG, 'bad'); return; }
    reading += 1; syncSaveBtn();
    try {
      const body = await file.text();
      if (body.length > 1000000) { tell(NOTE_TEXT_TOO_LONG, 'bad'); return; }
      ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${body}` : body;
      noteDraft.text = ta.value;
      if (!title.value.trim()) { title.value = file.name.replace(/\.[^.]+$/, '').slice(0, 120); noteDraft.title = title.value; }
      tell('');
    } catch { tell('That file could not be read.', 'bad'); }
    finally { reading -= 1; syncSaveBtn(); }
  };

  const takeFiles = async (files) => {
    const f = [...files];
    const pic = f.find((x) => x.type.startsWith('image/'));
    if (pic) { await takeImage(pic); return; }
    const txt = f.find((x) => x.type.startsWith('text/') || /\.(md|markdown|txt|text|log|csv|json|ya?ml)$/i.test(x.name));
    if (txt) { await takeText(txt); return; }
    tell('Only images and text files can be dropped here.', 'bad');
  };

  ta.addEventListener('input', () => { noteDraft.text = ta.value; if (say.textContent) tell(''); });
  title.addEventListener('input', () => { noteDraft.title = title.value; });
  ta.addEventListener('paste', (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const pic = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!pic) return; // plain text pastes as usual
    const file = pic.getAsFile();
    if (!file) return;
    if (!items.some((i) => i.kind === 'string' && i.type === 'text/plain')) e.preventDefault();
    takeImage(file);
  });
  const drop = h('div', { class: 'notedrop' }, ta);
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  drop.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.remove('over'); takeFiles(e.dataTransfer.files); });

  // ---- recent notes
  const count = h('span', { class: 'pill', text: String(info.count || 0) });
  const listBox = h('div', { class: 'notelist scr', tabindex: 0, role: 'region', 'aria-label': 'Recent notes' });
  const drawList = (items) => {
    // With no PC name to compare against, a list that came from one PC only needs no label; a mixed one shows every name.
    const origins = new Set(items.map((n) => n.origin).filter(Boolean));
    const here = pc || (origins.size === 1 ? [...origins][0] : '');
    listBox.replaceChildren(...(items.length ? items.map((n) => h('div', { class: 'note', title: n.rel },
      h('span', { class: 't', text: n.title || n.rel }),
      h('span', { class: 'w', text: [noteWhen(n.date), n.source in SOURCE_NAMES ? SOURCE_NAMES[n.source] : n.source, n.origin && n.origin !== here ? n.origin : ''].filter(Boolean).join(' · ') })))
      : [h('p', { class: 'muted', text: 'No notes yet. Paste one above, or let Claude save one.' })]));
  };
  drawList(recent || []);

  const refresh = async (savedRel) => {
    try {
      const [items, again] = await Promise.all([call('notes:list', { limit: 8 }), call('notes:info')]);
      const mine = savedRel && items.find((n) => n.rel === savedRel);
      if (mine && mine.origin) { rememberPc(mine.origin); pc = mine.origin; }
      drawList(items); count.textContent = String(again.count || 0);
    } catch (e) { listBox.replaceChildren(h('p', { class: 'noteline bad', text: e.message })); }
  };

  const save1 = async () => {
    if (saving || reading > 0) return;
    const text = ta.value, name = title.value.trim(), im = noteDraft.image;
    if (!im && !text.trim()) { tell('Write something to save first.', 'bad'); ta.focus(); return; }
    saving = true; syncSaveBtn(); tell('Saving…');
    try {
      const r = im ? await call('notes:addImage', { dataUrl: im.dataUrl, title: name, note: text }) : await call('notes:add', { title: name, text });
      noteDraft.text = ''; noteDraft.title = ''; clearDraftImage();
      ta.value = ''; title.value = ''; drawPrev();
      tell('Saved to your notes.', 'ok');
      await refresh(r && r.rel);
    } catch (e) { tell(e.message || 'The note could not be saved.', 'bad'); } // what was typed stays where it is
    saving = false; syncSaveBtn();
  };
  saveBtn.addEventListener('click', save1);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save1(); } });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save1(); } });

  // ---- the folder
  const pathBox = h('div', { class: 'pathbox' }, midPath(info.dir));
  const folderSay = h('p', { class: 'noteline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tellFolder = (text, kind = '') => { folderSay.textContent = text; folderSay.className = `noteline${kind ? ` ${kind}` : ''}`; };
  const change = h('button', { type: 'button', class: 'small', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await call('notes:chooseFolder');
      if (r && r.dir) {
        pathBox.replaceChildren(midPath(r.dir)); info.dir = r.dir; info.isDefault = false;
        tellFolder('Notes folder changed. Notes already saved stay in the old folder.');
        await refresh();
      }
    } catch (err) { tellFolder(err.message, 'bad'); }
    b.disabled = false;
  } }, 'Change');
  const open = h('button', { type: 'button', class: 'small', onclick: () => call('notes:openFolder').catch((err) => tellFolder(err.message, 'bad')) }, 'Open');

  // ---- reading images
  const imgSay = h('p', { class: 'noteline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let readOn = Boolean(info.readImages);
  const drawImages = () => {
    const st = readOn ? imageStatusLine() : { text: '' };
    imgSay.textContent = st.text; imgSay.className = `noteline${st.bad ? ' bad' : ''}`;
  };
  const sw = toggle('Read screenshots and images', readOn, async (v) => {
    const input = sw.querySelector('input');
    try {
      await save({ library: { readImages: v } });
      readOn = v;
      if (!v) imgNow = { ...imgNow, state: '', message: '' };
      const again = await call('notes:info').catch(() => null);
      if (again) imgNow = { ...imgNow, stats: again.images };
    } catch (e) { input.checked = !v; imgSay.textContent = e.message; imgSay.className = 'noteline bad'; return; }
    drawImages();
  }, 'Each new image is sent once to your notes model, which writes down the text in it and what it shows. Costs a little per image.');
  imgNow = { ...imgNow, stats: info.images || imgNow.stats };
  drawImages();

  root.append(
    h('div', { class: 'noteadd' }, h('h3', { text: 'Add a note' }), drop, prev, h('div', { class: 'row savebar' }, title, saveBtn), say),
    h('div', { class: 'noterecent' }, h('h3', {}, 'Recent notes ', count), listBox),
    h('div', { class: 'notefolder' },
      h('div', { class: 'row nowrap' }, icon('folder', 16), h('span', { class: 'sronly', text: 'Notes folder' }), pathBox, change, open),
      h('p', { class: 'help', text: 'Keep this folder in Google Drive, OneDrive or Dropbox to have the same notes on every PC.' }), folderSay),
    h('div', { class: 'noteimages' }, sw, imgSay));
  drawPrev();
  return { el: root, drawImages };
}

pages.knowledge = async () => {
  const my = renderSeq;
  let profileText, noteInfo = null, noteRecent = [], noteError = '';
  [cfg, lib, profileText] = await Promise.all([call('settings:get'), call('library:stats'), call('profile:get')]);
  if (my !== renderSeq) return;
  try { [noteInfo, noteRecent] = await Promise.all([call('notes:info'), call('notes:list', { limit: 8 })]); } catch (e) { noteError = e.message; }
  if (my !== renderSeq) return;

  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const stats = `${plural(lib.files, 'file', 'files')}, ${plural(lib.chunks, 'passage', 'passages')}, ${lib.meetingChunks.toLocaleString()} from meetings`;

  const pinBtn = (f) => { const on = (lib.pinned || []).includes(f); return h('button', { class: `ghost pin${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', title: on ? 'Every file in this folder goes with every answer. Click to stop.' : 'Send every file in this folder with every answer, so none is missed. Best for a small folder of key facts.', onclick: () => call('library:pinFolder', { dir: f, on: !on }).then(() => go('knowledge')).catch(fail) }, 'Always include'); };
  const folders = lib.folders.length
    ? lib.folders.map((f) => h('div', { class: 'folder' }, icon('folder', 16), h('span', { class: 'path', text: f, title: f }), pinBtn(f), h('button', { class: 'ghost ib', title: 'Stop using this folder', 'aria-label': `Remove ${f}`, onclick: () => call('library:removeFolder', f).then(() => go('knowledge')).catch(fail) }, icon('x', 15))))
    : [h('p', { class: 'muted', text: 'No folders yet. Add the folder where you keep runbooks, design notes and write-ups.' })];
  const pinned = lib.pinned || [];
  const newestMs = lib.pinnedInfo && lib.pinnedInfo.newestMs, now = Date.now();
  const age = pinned.length ? agoText(newestMs, now) : '';
  const ageNote = age ? ` ${age}${now - newestMs > 14 * 86400000 ? ' Check that these are still right.' : ''}` : '';
  const pinNote = pinned.length && lib.pinnedInfo
    ? `Stays on this computer. Only matching passages go to your AI provider, except in a folder marked Always include: ${plural(lib.pinnedInfo.files, 'file', 'files')}${lib.pinnedInfo.chars ? ` (about ${Math.max(1, Math.round(lib.pinnedInfo.chars / 1000))} thousand characters)` : ''} ${lib.pinnedInfo.files === 1 ? 'goes' : 'go'} with every answer.${lib.pinnedInfo.omitted ? ` ${plural(lib.pinnedInfo.omitted, 'file is', 'files are')} left out: over the 80 thousand character limit.` : ''}`
    : 'Stays on this computer. Only matching passages go to your AI provider.';
  const skipped = lib.skippedCount ? h('p', { class: 'result scr skipped', text: `${lib.skippedCount} item${lib.skippedCount === 1 ? '' : 's'} could not be read: ${lib.skipped.slice(0, 3).map((x) => `${x.file.split(/[\\/]/).pop()} (${x.reason})`).join(', ')}${lib.skippedCount > 3 ? '…' : ''}` }) : null;
  const foldersBody = h('div', { class: 'srcbody foldersbody' },
    h('p', { class: 'sub', text: 'Markdown, text and diagram files. Changes are picked up automatically.' }),
    h('p', { class: 'privacy', text: pinNote + ageNote }),
    h('div', { class: 'folders scr' }, ...folders), skipped,
    h('div', { class: 'row filesbar' },
      btn('Add folder', 'plus', () => call('library:addFolder').then(() => go('knowledge')).catch(fail), 'primary'),
      btn('Re-read now', 'refresh', (e) => { e.currentTarget.disabled = true; call('library:reindex').then(() => go('knowledge')).catch(fail); }),
      h('span', { class: 'grow' }),
      toggle('Learn from past meetings', S().library.includeMeetings !== false, (v) => save({ library: { includeMeetings: v } }).then(() => setTimeout(() => current === 'knowledge' && go('knowledge'), 900)).catch(fail))));

  const hits = h('div', { class: 'hits scr' });
  const q = h('input', { type: 'search', placeholder: 'Try: how do we rotate secrets', 'aria-label': 'Test question' });
  let qSeq = 0;
  q.addEventListener('input', debounce(async () => {
    const n = ++qSeq;
    if (!q.value.trim()) { hits.replaceChildren(); return; }
    try {
      const res = await call('library:search', q.value);
      if (n !== qSeq || my !== renderSeq) return;
      hits.replaceChildren(...(res.length ? res.map((r) => h('div', { class: 'hit' }, h('div', { class: 'src' }, icon(r.kind === 'meeting' ? 'calendar' : 'file', 13), `${r.rel}${r.headings.length ? ` › ${r.headings.join(' › ')}` : ''}`), h('div', { class: 'txt', text: r.text }))) : [h('p', { class: 'muted', style: 'margin-top:6px', text: lib.files ? 'Nothing in your files matches that.' : 'No files yet. Add a folder above first.' })]));
    } catch (e) { if (n === qSeq && my === renderSeq) fail(e); }
  }, 220));
  const notes = notesSection(noteInfo, noteRecent, noteError);
  notesView = notes;
  const grid = h('div', { class: `kgrid${knowledgeTab === 'notes' ? ' on-notes' : ''}` });
  const tabs = segmented([['folders', 'Folders'], ['notes', 'Quick notes']], knowledgeTab, (v) => {
    knowledgeTab = v; foldersBody.hidden = v !== 'folders'; notes.el.hidden = v !== 'notes'; grid.classList.toggle('on-notes', v === 'notes');
  });
  tabs.setAttribute('aria-label', 'What the files panel shows');
  foldersBody.hidden = knowledgeTab !== 'folders'; notes.el.hidden = knowledgeTab !== 'notes';
  const files = h('section', { class: 'panel srcpanel' }, h('div', { class: 'srchead' }, h('h2', { text: 'Your files' }), tabs), foldersBody, notes.el);

  const tryIt = panel('Check what it finds', 'Type a question the way someone would ask it in a meeting to see which passages would back the answer.',
    h('div', { class: 'searchbox', style: 'margin:0' }, icon('search', 15), q), hits);
  tryIt.classList.add('tryit');

  const ta = h('textarea', { id: 'profile', value: profileText, spellcheck: false, placeholder: 'What you own, your stack, how you decide, positions you hold, how you talk. Write it yourself or have it written from your files.' });
  const preview = h('div', { class: 'preview doc scr' });
  let savedProfile = profileText;
  dirtyCheck = () => !profileStream && ta.value !== savedProfile;
  const status = h('span', { class: 'result grow' });
  const view = segmented([['edit', 'Edit'], ['preview', 'Preview']], 'edit', (v) => { const p = v === 'preview'; if (p) preview.replaceChildren(renderMarkdown(ta.value)); ta.hidden = p; preview.hidden = !p; });
  preview.hidden = true;
  const buildBtn = h('button', { class: profileText.trim() ? '' : 'primary' }, icon('spark', 15), profileText.trim() ? 'Rewrite from my files' : 'Write it from my files');
  buildBtn.addEventListener('click', async () => {
    let pre;
    try { pre = await call('profile:preview'); } catch (e) { return fail(e); }
    if (!pre.files) return fail(new Error('Add a folder of your notes first: the profile is written from them.'));
    const what = pre.partial ? `a sample of your library: the newest files and an even spread of older ones (${pre.files.toLocaleString()} of ${pre.filesTotal.toLocaleString()} files, about ${Math.max(1, Math.round(pre.chars / 1000)).toLocaleString()} thousand characters)` : `all ${pre.files.toLocaleString()} file${pre.files === 1 ? '' : 's'} (about ${Math.max(1, Math.round(pre.chars / 1000)).toLocaleString()} thousand characters)`;
    if (!window.confirm(`This sends ${what} to ${pre.provider} (${pre.model}) to write your profile.${ta.value.trim() ? ' The current profile will be replaced.' : ''}\n\nContinue?`)) return;
    const before = ta.value;
    view.setValue('edit'); ta.hidden = false; preview.hidden = true;
    buildBtn.disabled = true; ta.value = ''; status.className = 'result grow'; status.textContent = 'Reading your files…';
    profileStream = (d) => { ta.value += d; ta.scrollTop = ta.scrollHeight; };
    try {
      const r = await call('profile:build');
      ta.value = r.text; savedProfile = r.text;
      status.className = 'result ok grow';
      status.textContent = r.files < r.filesTotal ? `Written from a sample: the newest files and an even spread of older ones (${r.files.toLocaleString()} of ${r.filesTotal.toLocaleString()} files). Answers still search all of your files.` : (r.chunksIncluded < r.chunksTotal ? `Written from the opening sections of all ${r.files.toLocaleString()} files.` : `Written from all ${r.files.toLocaleString()} files.`);
    } catch (e) { status.className = 'result bad grow'; status.textContent = e.message; ta.value = before; }
    profileStream = null; buildBtn.disabled = false;
  });
  const prof = panel('Your profile', 'Sent with every answer, so it is worth correcting by hand. This is what makes answers sound like you instead of a textbook.',
    h('div', { class: 'row toprow' }, view, h('span', { class: 'grow' }), buildBtn, btn('Save', 'check', () => call('profile:save', ta.value).then(() => { savedProfile = ta.value; toast('Profile saved.'); }).catch(fail))),
    ta, preview, h('div', { class: 'row statusrow' }, status));
  prof.classList.add('profilepanel');

  show(my, wrap('Knowledge', stats, (grid.append(h('div', { class: 'col' }, files, tryIt), h('div', { class: 'col' }, prof)), grid)));
};

// ====================================================================== Styles
pages.styles = async () => {
  const my = renderSeq;
  cfg = await call('settings:get');
  if (my !== renderSeq) return;
  const list = await call('personalities:list');
  if (my !== renderSeq) return;
  if (!selectedStyle || (selectedStyle !== '__new' && !list.some((p) => p.id === selectedStyle))) selectedStyle = S().copilot.personality || 'default';
  const sel = selectedStyle === '__new' ? { id: '', name: '', description: '', text: '', builtin: false, isNew: true } : list.find((p) => p.id === selectedStyle) || list[0];
  const def = S().copilot.personality;

  const grid = h('div', { class: 'stylelist scr' },
    list.map((p) => h('button', { class: `stylecard${p.id === sel.id ? ' on' : ''}`, onclick: () => { selectedStyle = p.id; go('styles'); } },
      h('span', { class: 'n' }, p.name, p.id === def && h('span', { class: 'pill accent', text: 'default' }), !p.builtin && h('span', { class: 'pill', text: 'yours' })),
      h('span', { class: 'd', text: p.description }))));
  const newBtn = h('button', { class: `stylecard new${sel.isNew ? ' on' : ''}`, onclick: () => { selectedStyle = '__new'; go('styles'); } }, icon('plus', 16), 'New style');

  const name = h('input', { type: 'text', value: sel.name, placeholder: 'e.g. Customer call', disabled: sel.builtin });
  const desc = h('input', { type: 'text', value: sel.description, placeholder: 'One line on when to use it', disabled: sel.builtin });
  const text = h('textarea', { value: sel.text, rows: 6, disabled: sel.builtin, placeholder: 'Describe the room and how you want to come across. For example: "This is a customer call. Be warm, avoid internal system names, and never commit to dates."' });
  dirtyCheck = () => !sel.builtin && (name.value !== sel.name || desc.value !== sel.description || text.value !== sel.text);
  const tall = (f) => { f.classList.add('tall'); return f; };
  const editor = panel(sel.isNew ? 'New style' : sel.name, sel.builtin ? 'Built in. Copy it to make your own version.' : 'Added on top of your profile in the meetings where you choose it.',
    field('Name', name), field('When to use it', desc), tall(field('How to answer', text, null, 'stack')),
    h('div', { class: 'row actions' },
      !sel.builtin && btn('Save', 'check', () => { if (!name.value.trim() || !text.value.trim()) return fail(new Error('A style needs a name and a description of how to answer.')); return call('personalities:save', { id: sel.isNew ? '' : sel.id, name: name.value, description: desc.value, text: text.value }).then((l) => { const made = l.find((p) => p.name === name.value.trim()); selectedStyle = made ? made.id : null; dirtyCheck = null; toast('Style saved.'); go('styles'); }).catch(fail); }, 'primary'),
      sel.builtin && btn('Copy as new', 'copy', () => call('personalities:save', { id: `${sel.id}-mine`, name: `${sel.name} (mine)`, description: sel.description, text: sel.text }).then(() => { selectedStyle = `${sel.id}-mine`; go('styles'); }).catch(fail)),
      !sel.isNew && h('button', { disabled: sel.id === def, onclick: () => save({ copilot: { personality: sel.id } }).then(() => go('styles')) }, sel.id === def ? 'This is the default' : 'Use by default'),
      h('span', { class: 'grow' }),
      !sel.builtin && !sel.isNew && armBtn('Delete', 'trash', 'Click again to delete', () => call('personalities:delete', sel.id).then(async () => { dirtyCheck = null; selectedStyle = null; if (def === sel.id) await save({ copilot: { personality: 'default' } }); go('styles'); }).catch(fail), 'ghost danger')));

  editor.classList.add('editor');
  show(my, wrap('Styles', 'The same you, tuned to the room. Switch style from the overlay at any point in a meeting.', h('div', { class: 'sgrid' }, h('div', { class: 'stylecol' }, newBtn, grid), editor)));
};

// ====================================================================== Settings
// What the line under the model box says about a failure: the AI code's plain sentence, never more than this, so it can
// not make the panel grow past the page.
const brief = (m) => { const t = String(m || 'It did not work.').replace(/\s+/g, ' ').trim(); return t.length > 160 ? `${t.slice(0, 159).trimEnd()}…` : t; };
function modelPicker(role) {
  const c = S().llm[role];
  const listId = `models-${role}`;
  const datalist = h('datalist', { id: listId }, cfg.llmProviders[c.provider].known.map((m) => h('option', { value: m })));
  const model = h('input', { type: 'text', value: c.model, spellcheck: false, 'aria-label': 'Model' });
  model.setAttribute('list', listId);
  const provider = h('select', { 'aria-label': 'Provider' }, Object.entries(cfg.llmProviders).map(([id, p]) => h('option', { value: id, text: `${p.label}${cfg.secrets[p.secret] ? '' : ', no key'}`, selected: id === c.provider })));
  const result = h('div', { class: 'help' });
  provider.addEventListener('change', async () => { await save({ llm: { [role]: { provider: provider.value, model: cfg.llmProviders[provider.value].suggested[role] } } }); go('settings'); });
  model.addEventListener('change', () => save({ llm: { [role]: { model: model.value.trim() } } }).then(() => { if (role === 'live') speedDraw(); }).catch(fail));
  const load = btn('Models', 'refresh', async () => {
    load.disabled = true;
    try { const ids = await call('models:list', provider.value); datalist.replaceChildren(...ids.map((m) => h('option', { value: m }))); result.className = 'help ok'; result.textContent = `${ids.length} models available with your key. Click the model box to choose.`; }
    catch (e) { result.className = 'help bad'; result.textContent = brief(e.message); }
    load.disabled = false;
  });
  load.title = 'Fetch the models your key can use';
  const test = btn('Test model', 'bolt', async () => {
    test.disabled = true; result.className = 'help'; result.textContent = 'Testing…';
    try { await save({ llm: { [role]: { model: model.value.trim() } } }); const r = await call('provider:test', 'llm', role); result.className = 'help ok'; result.textContent = `Working. First word after ${(r.firstTokenMs / 1000).toFixed(2)} s (${r.model}).`; }
    catch (e) { result.className = 'help bad'; result.textContent = brief(e.message); }
    test.disabled = false;
  });
  return [field('Provider', provider), h('div', { class: 'field' }, h('label', { text: 'Model' }), h('div', { class: 'ctl' }, model, datalist, load, test), result)];
}

// What each key row says under itself after a save ("Saved. Works."), kept while the page is redrawn.
const keyStatus = new Map(); // secret -> { text, bad }
let keyFocus = null;         // the key box to focus once the page has been redrawn
const lowerFirst = (t) => t.replace(/^(Could|Rate|The|It|Not|No|Request|Timed|Unable|Check)\b/, (w) => w.toLowerCase());

function keyRow(secret, label, hint) {
  const present = Boolean(cfg.secrets[secret]);
  const input = h('input', { type: 'password', placeholder: present ? 'Saved. Paste a new key to replace it.' : 'Paste key', autocomplete: 'off', spellcheck: false, 'aria-label': `${label} API key`, dataset: { secret } });
  const say = h('div', { class: 'help keysay', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', dataset: { keysay: secret } });
  const draw = () => { const st = keyStatus.get(secret); say.textContent = st ? st.text : (hint || ''); say.className = `help keysay${st ? (st.bad ? ' bad' : st.ok ? ' ok' : '') : ''}`; };
  const saveKey = async () => {
    if (!input.value.trim()) { keyStatus.set(secret, { text: 'Paste a key first.', bad: true }); draw(); input.focus(); return; }
    cfg = await call('secrets:set', secret, input.value);
    keyStatus.set(secret, { text: 'Saved. Checking…' });
    keyFocus = secret;
    await go('settings'); // the pill, the remove button and the provider lists all change with the key
    let st;
    try { const r = await call('keys:test', secret); st = r && r.ok ? { text: 'Saved. Works.', ok: true } : { text: `Saved, but ${lowerFirst(String((r && r.message) || 'it could not be checked.'))}`, bad: true }; } catch { st = { text: 'Saved.', ok: true }; }
    keyStatus.set(secret, st);
    const el = document.querySelector(`[data-keysay="${secret}"]`);
    if (el) { el.textContent = st.text; el.className = `help keysay${st.bad ? ' bad' : ' ok'}`; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey().catch(fail); });
  draw();
  const remove = present
    ? armClick(h('button', { type: 'button', class: 'ghost ib danger', title: 'Remove this key', 'aria-label': `Remove ${label} key` }, icon('trash', 15)), 'Click again to remove',
      () => call('secrets:set', secret, '').then((c) => { cfg = c; keyStatus.delete(secret); return go('settings'); }).catch(fail))
    : h('span', { class: 'ibspace', 'aria-hidden': 'true' }); // the trash icon's room, so the row does not change width when a key is saved
  const link = h('button', { type: 'button', class: 'linkbtn', text: 'Get a key', title: `Open the ${label} page where keys are made`, 'aria-label': `Get a ${label} key`, onclick: () => call('keys:link', secret).catch(fail) });
  return h('div', { class: 'field' },
    h('label', {}, label, h('span', { class: `pill ${present ? 'ok' : 'warn'}`, text: present ? 'Saved' : 'No key' })),
    h('div', { class: 'ctl' }, input, btn('Save', null, () => saveKey().catch(fail)), link, remove), say);
}

async function micOptions(select) {
  const found = await listMics();
  micCache = found;
  if (!select.isConnected) return;
  if (found.error) { select.replaceChildren(h('option', { value: 'default', text: found.error })); return; }
  const chosen = S().audio.micDeviceId || 'default';
  select.replaceChildren(...found.devices.map((d) => h('option', { value: d.id, text: d.label, selected: d.id === chosen })));
  if (!found.devices.some((d) => d.id === chosen)) select.prepend(h('option', { value: 'default', text: 'System default', selected: true }));
}

// Click, then press the combination. Escape cancels, Backspace clears. A combination that is refused (not a shortcut,
// or already used by another action) is said in a line under the button, and the old one stays.
function shortcutRecorder(key) {
  const b = h('button', { class: 'keycap', type: 'button' });
  const say = h('p', { class: 'noteline bad keyline', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const show = () => { b.classList.remove('rec'); b.textContent = S().shortcuts[key] ? accelLabel(S().shortcuts[key]) : 'Not set'; };
  const onKey = async (e) => {
    if (!b.isConnected) { stop(); return; }
    e.preventDefault(); e.stopPropagation();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape') return stop();
    let accel = '';
    if (!((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey)) {
      const c = e.code;
      const main = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c
        : ({ Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Backspace: 'Backspace', Delete: 'Delete', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' })[c];
      if (!main) return;
      const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d/.test(main)) { b.textContent = 'Include Ctrl or Alt…'; return; }
      accel = [...mods, main].join('+');
    }
    stop();
    say.textContent = '';
    try { await save({ shortcuts: { [key]: accel } }); say.textContent = (cfg.refused && cfg.refused[`shortcuts.${key}`]) || ''; } catch (err) { fail(err); }
    show();
  };
  function stop() { window.removeEventListener('keydown', onKey, true); b.removeEventListener('blur', stop); if (shortcutCleanup === stop) shortcutCleanup = null; show(); }
  b.addEventListener('click', () => { if (b.classList.contains('rec')) return stop(); if (shortcutCleanup) shortcutCleanup(); say.textContent = ''; b.classList.add('rec'); b.textContent = 'Press the keys…'; shortcutCleanup = stop; window.addEventListener('keydown', onKey, true); b.addEventListener('blur', stop); });
  show();
  return [b, say];
}

// ---- Find the fastest (Settings > Answers; started from the Home "Answers" menu too)
// The run lives in the main process and in this module, not in the page, so leaving the tab and coming back
// finds it as it was: the same rows, the same Cancel button, and no second run.
const speed = {
  running: false, adopted: false, stopping: false, // adopted: a run that was already going when this window learnt of it
  rows: new Map(),      // progress while running, in the order they will be tested
  result: null,         // the last { results, ranAt, cancelled, candidates }, finished or stopped
  error: '', flash: '', autostart: false,
  view: null,           // the pieces of the section that is on screen
};
const speedKey = (x) => `${x.provider}\u0001${x.model}`;
const providerShort = (id) => (cfg.llmProviders[id] ? cfg.llmProviders[id].label.split(' (')[0] : id);
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const rowEnded = (r) => r.state === 'done' || r.state === 'failed';
const FASTEST_NOTE = 'Fastest is not always best: smaller models answer sooner but know less.';

// The same list the main process will test: every known model of each provider that has a key, plus the one in use.
function speedCandidates() {
  const cur = S().llm.live, out = [];
  for (const [provider, p] of Object.entries(cfg.llmProviders)) if (hasKey(p)) for (const model of p.known || []) out.push({ provider, model });
  if (cur.model && cfg.llmProviders[cur.provider] && hasKey(cfg.llmProviders[cur.provider]) && !out.some((c) => c.provider === cur.provider && c.model === cur.model)) {
    let at = -1;
    out.forEach((c, i) => { if (c.provider === cur.provider) at = i; });
    out.splice(at + 1, 0, { provider: cur.provider, model: cur.model });
  }
  return out;
}

function openSpeedTest() { settingsTab = 'ai'; speed.autostart = true; go('settings'); }

function speedRows() {
  if (speed.running) return [...speed.rows.values()];
  return speed.result ? speed.result.results.map((r) => ({ ...r, state: r.ok ? 'done' : 'failed' })) : [];
}

function speedStatus() {
  if (speed.error) return { text: speed.error, bad: true };
  if (speed.running) {
    const rows = [...speed.rows.values()];
    return { text: speed.stopping ? 'Stopping…' : `Testing: ${rows.filter(rowEnded).length} of ${rows.length} models finished.` };
  }
  const r = speed.result;
  if (!r) return { text: '' };
  if (r.cancelled) return { text: r.results.length ? 'Stopped. Results so far:' : 'Stopped. Nothing had finished yet.' };
  const best = r.results.find((x) => x.fastest);
  return { text: best ? `Fastest on your connection: ${best.model} at ${seconds(best.firstMs)}.` : 'No model answered. The reasons are in the list.' };
}

function speedNote(r) {
  const d = new Date(r.ranAt), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = d.toDateString() === new Date().toDateString() ? `Ran at ${t}.` : `Ran on ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${t}.`;
  const costs = r.results.map((x) => x.cost).filter((c) => typeof c === 'number');
  const sum = costs.reduce((a, b) => a + b, 0);
  const cost = costs.length ? (sum < 0.005 ? 'Cost under $0.01.' : `Cost about $${sum.toFixed(2)}.`) : '';
  return [when, cost, FASTEST_NOTE].filter(Boolean).join(' ');
}

function speedRow(r, finished) {
  const cur = S().llm.live;
  const mine = r.provider === cur.provider && r.model === cur.model;
  const stopped = r.state === 'failed' && r.error === 'Cancelled.';
  const head = h('th', { scope: 'row', class: 'm' }, h('span', { class: 'mn', text: r.model }), r.fastest && ' ', r.fastest && h('span', { class: 'pill ok', text: finished && speed.result && speed.result.cancelled ? 'Fastest so far' : 'Fastest' }), h('small', { text: providerShort(r.provider) }));
  let cells;
  if (r.state === 'failed') {
    cells = [h('td', { class: 'why', colSpan: 2, text: stopped ? 'Stopped.' : `Failed: ${String(r.error || 'no reason was given.').replace(/\s+/g, ' ').trim()}`, title: stopped ? null : r.error })];
  } else if (r.state === 'waiting') {
    cells = [h('td', { class: 'st', text: 'Waiting' }), h('td')];
  } else if (r.state === 'running') {
    cells = [h('td', { class: 'st', text: `Round ${Math.min((r.round || 0) + 1, r.rounds || 3)} of ${r.rounds || 3}` }), h('td')];
  } else {
    cells = [h('td', { class: 't' }, h('b', { text: seconds(r.firstMs) })),
      h('td', { class: 'act' }, finished ? (mine ? h('span', { class: 'inuse', tabindex: '-1' }, icon('check', 13), 'In use')
        : h('button', { type: 'button', class: 'use', text: 'Use', 'aria-label': `Use ${r.model} for live answers`, onclick: () => useSpeedModel(r) })) : null)];
  }
  return h('tr', { class: r.fastest ? 'fast' : '', dataset: { key: speedKey(r) } }, head, ...cells);
}

// Redraw the section if it is on screen; `force` also draws one that is not attached yet.
function speedDraw(force = false) {
  const v = speed.view;
  if (!v || !(force || v.root.isConnected)) return;
  const act = document.activeElement;
  const tr = act && act.closest ? act.closest('tr[data-key]') : null;
  const keep = tr ? tr.dataset.key : null;
  const rows = speedRows(), finished = !speed.running;
  v.find.disabled = speed.running;
  v.cancel.hidden = !speed.running; v.cancel.disabled = speed.stopping;
  v.body.replaceChildren(...rows.map((r) => speedRow(r, finished)));
  v.res.hidden = !rows.length;
  const st = speedStatus();
  v.status.textContent = st.text; v.status.classList.toggle('bad', Boolean(st.bad));
  v.flash.textContent = speed.flash;
  v.note.textContent = finished && speed.result ? speedNote(speed.result) : '';
  v.note.hidden = !v.note.textContent;
  if (keep) {
    const again = [...v.body.rows].find((x) => x.dataset.key === keep);
    const target = again && (again.querySelector('button') || again.querySelector('.inuse'));
    if (target) target.focus({ preventScroll: true });
  }
}

// Keep focus on a control that still works: the Cancel button while running, Find when it ends.
function speedFocus() {
  const v = speed.view;
  if (!v || !v.root.isConnected) return;
  const a = document.activeElement;
  if (!a || a === document.body || a === v.find || a === v.cancel) (speed.running ? v.cancel : v.find).focus();
}

function speedLeave(result) {
  speed.running = false; speed.stopping = false; speed.adopted = false; speed.rows = new Map();
  if (result) speed.result = result;
  speedDraw();
  const v = speed.view;
  if (v && v.root.isConnected) v.list.scrollTop = 0;
  speedFocus();
}

async function startSpeed() {
  if (speed.running) return;
  speed.error = ''; speed.flash = ''; speed.stopping = false; speed.adopted = false;
  speed.rows = new Map(speedCandidates().map((c) => [speedKey(c), { ...c, state: 'waiting', round: 0, rounds: 3 }]));
  speed.running = true;
  speedDraw(); speedFocus();
  let r;
  try { r = await call('models:speedTest'); } catch (e) {
    if (e.message === 'A speed test is already running.') { speed.adopted = true; speedDraw(); return; } // it keeps reporting; follow it
    speed.error = e.message || String(e);
    speedLeave(null);
    return;
  }
  speedLeave(r);
}

async function cancelSpeed() {
  if (!speed.running || speed.stopping) return;
  speed.stopping = true; speedDraw();
  try { await call('models:speedTestCancel'); } catch (e) { speed.stopping = false; speedDraw(); fail(e); return; }
  if (!speed.adopted) return; // the run's own call returns with what finished
  setTimeout(() => {
    if (!speed.running) return;
    const rows = [...speed.rows.values()];
    const ok = rows.filter((r) => r.state === 'done').sort((a, b) => a.firstMs - b.firstMs).map((r, i) => ({ provider: r.provider, model: r.model, ok: true, firstMs: r.firstMs, bestMs: null, totalMs: null, charsPerSec: null, rounds: r.rounds, error: '', cost: null, fastest: i === 0 }));
    const bad = rows.filter((r) => r.state === 'failed' && r.error !== 'Cancelled.').map((r) => ({ provider: r.provider, model: r.model, ok: false, firstMs: null, bestMs: null, totalMs: null, charsPerSec: null, rounds: 0, error: r.error, cost: null, fastest: false }));
    speedLeave({ results: [...ok, ...bad], ranAt: Date.now(), cancelled: true, candidates: [] });
  }, 700);
}

async function useSpeedModel(r) {
  try { await save({ llm: { live: { provider: r.provider, model: r.model } } }); } catch (e) { fail(e); return; }
  speed.flash = `Live answers now use ${r.model} (${providerShort(r.provider)}).`;
  const v = speed.view;
  if (!v || !v.root.isConnected) return;
  v.refreshPicker(); // the model box above must agree
  speedDraw();
}

function speedEvent(m) {
  const k = speedKey(m);
  if (!speed.running) {
    // A run this window did not start (the window was reloaded while it ran): follow it from its progress.
    if (m.state !== 'running') return;
    speed.error = ''; speed.flash = ''; speed.stopping = false; speed.running = true; speed.adopted = true;
    speed.rows = new Map(speedCandidates().map((c) => [speedKey(c), { ...c, state: 'waiting', round: 0, rounds: m.rounds || 3 }]));
  }
  const row = speed.rows.get(k) || { provider: m.provider, model: m.model, state: 'waiting', round: 0, rounds: m.rounds || 3 };
  speed.rows.set(k, row);
  row.state = m.state; row.round = m.round || 0; row.rounds = m.rounds || row.rounds;
  if (m.firstMs != null) row.firstMs = m.firstMs;
  if (m.error) row.error = m.error;
  speedDraw();
  if (speed.adopted && [...speed.rows.values()].every(rowEnded)) {
    call('models:speedTestLast').then((last) => speedLeave(last), () => speedLeave(null));
  }
}

function speedSection(refreshPicker) {
  const find = h('button', { type: 'button', class: 'primary', onclick: () => startSpeed() }, icon('bolt', 15), 'Find the fastest');
  const cancel = h('button', { type: 'button', hidden: true, onclick: () => cancelSpeed() }, icon('stop', 15), 'Cancel');
  const status = h('p', { class: 'speedstatus', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const body = h('tbody');
  const list = h('div', { class: 'speedlist scr' }, h('table', { class: 'speedtbl' },
    h('caption', { class: 'sronly', text: 'Models tried, with how long each took to start answering' }),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', text: 'First word' }), h('th', { scope: 'col' }, h('span', { class: 'sronly', text: 'Action' })))),
    body));
  const flash = h('p', { class: 'speedflash', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const note = h('p', { class: 'speednote' });
  const res = h('div', { class: 'speedres', hidden: true }, list, flash, note);
  const root = h('div', { class: 'speedcol', role: 'group', 'aria-label': 'Find the fastest model' },
    h('div', { class: 'speedbar' }, find, cancel),
    h('p', { class: 'help', text: 'Asks each model you have a key for the same short question three times and times its first word. Nothing from your files is sent. Costs a few cents at most.' }),
    status, res);
  const v = { root, find, cancel, status, res, list, body, flash, note, refreshPicker };
  speed.view = v;
  speed.flash = '';
  speedDraw(true);
  const auto = speed.autostart; speed.autostart = false;
  (async () => {
    if (!speed.running && !speed.result) {
      try { const last = await call('models:speedTestLast'); if (last && !speed.running && !speed.result) speed.result = last; } catch { /* nothing to show */ }
    }
    speedDraw();
    if (auto && speed.view === v && root.isConnected && !speed.running && !speed.result) startSpeed();
  })();
  return root;
}

async function remotePanel() {
  const my = renderSeq;
  const info = await call('remote:info');
  if (my !== renderSeq) return null;
  const address = h('code', { class: 'mono', text: info.address || 'Enter the address first.' });
  // Read back accepted values so an invalid address or port never looks saved.
  const update = async (patch) => {
    await save({ remote: patch });
    const r = await call('remote:info');
    host.value = r.host; port.value = r.port; address.textContent = r.address || 'Enter the address first.';
    if (running) await call('remote:testCancel');
  };
  const host = textInput(info.host, (v) => update({ host: v.trim() }), { maxlength: 45, spellcheck: false, placeholder: '100.64.1.2', 'aria-label': "This PC's Tailscale address" });
  const port = h('input', { type: 'number', min: 1024, max: 65535, step: 1, value: info.port, 'aria-label': 'Port' });
  port.addEventListener('change', () => update({ port: Number(port.value) }).catch(fail));
  const detected = h('div', { class: 'help remote-detected', role: 'status', 'aria-live': 'polite' });
  const choose = async (value) => { await update({ host: value }); toast(`Found ${host.value}.`); };
  const find = btn('Find my Tailscale address', null, async () => {
    find.disabled = true; detected.replaceChildren();
    try {
      const { addresses } = await call('remote:detect');
      if (addresses.length === 1) await choose(addresses[0]);
      else if (addresses.length) detected.replaceChildren(...addresses.map((value) => btn(value, null, () => choose(value).catch(fail), 'small mono')));
      else detected.textContent = 'Tailscale was not found on this PC. Install it, sign in, then try again.';
    } catch (e) { fail(e); } finally { find.disabled = false; }
  }, 'small');
  const firewall = btn('Copy firewall command', 'copy', async () => {
    try {
      // The saved port and address family are authoritative, even if an unaccepted edit is still in the field.
      let savedHost = '';
      const { port } = await call('remote:info').then((r) => ({ host: savedHost = '' } = r));
      const range = String(savedHost).includes(':') ? 'fd7a:115c:a1e0::/48' : '100.64.0.0/10';
      await call('app:copy', `New-NetFirewallRule -DisplayName "Understudy recorder" -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress ${range} -Action Allow`);
      toast('Copied. Run it in an administrator PowerShell on this PC.');
    } catch (e) { fail(e); }
  }, 'small');
  let running = false, disposed = false, countdown;
  const status = h('p', { class: 'help foot', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const clearCountdown = () => { clearInterval(countdown); countdown = null; };
  const testButton = btn('Test connection', null, async () => {
    if (running) {
      testButton.disabled = true;
      try { await call('remote:testCancel'); } catch { if (!disposed) testButton.disabled = false; }
      return;
    }
    running = true; testButton.textContent = 'Stop';
    const until = Date.now() + 30000;
    const tick = () => { status.textContent = `Waiting for the recorder... ${Math.max(0, Math.ceil((until - Date.now()) / 1000))} s`; };
    tick(); countdown = setInterval(tick, 1000);
    try {
      const result = await call('remote:test');
      if (!disposed) status.textContent = result.message;
    } catch { if (!disposed) status.textContent = 'The connection test could not finish. Try again.'; }
    finally {
      clearCountdown(); running = false;
      if (!disposed) { testButton.textContent = 'Test connection'; testButton.disabled = !S().remote.enabled; }
    }
  }, 'small');
  testButton.disabled = !info.enabled;
  if (my === renderSeq) remoteTestCleanup = () => {
    disposed = true; clearCountdown();
    if (running) call('remote:testCancel').catch(() => {});
  };
  const voice = h('div');
  const showVoice = () => voice.replaceChildren(...(S().remote.listen === 'computer' ? [
    field('Your voice comes from', segmented([['main', "This PC's microphone"], ['recorder', "The other PC's microphone"]], S().remote.micFrom, (micFrom) => save({ remote: { micFrom } }).catch(fail)), 'Choose the other PC if you speak into its microphone.')
  ] : []));
  showVoice();
  const controls = h('div', { class: 'remote-controls', hidden: !info.enabled },
    field('The recorder listens to', segmented([['room', 'The room, through its microphone'], ['computer', "The computer's audio"]], info.listen, (listen) => save({ remote: { listen } }).then(showVoice).catch(fail)), 'Choose the room when the meeting plays out loud on another PC.'),
    voice,
    field("This PC's Tailscale address", [host, find], detected), field('Port', [port, firewall]), field('Recorder address', address),
    h('div', { class: 'row' },
      btn('Copy recorder settings', 'copy', () => call('remote:copySettings').then((copied) => toast(copied ? 'Copied.' : 'Enter the address first.', 'info', 2000)).catch(fail)),
      armBtn('Make a new token', null, 'Click again to replace the token', () => (async () => { await call('remote:newToken'); if (running) await call('remote:testCancel'); toast('New token made. Copy the recorder settings again.'); })().catch(fail), 'ghost danger')),
    h('p', { class: 'help foot', text: 'The old recorder will stop working when you make a new token.' }));
  return panel('Remote recorder', null, meetingChangeNote(),
    toggle('Take the meeting audio from another PC', info.enabled, (v) => save({ remote: { enabled: v } }).then(() => { controls.hidden = !S().remote.enabled; testButton.disabled = !S().remote.enabled; if (!v && running) return call('remote:testCancel'); }).catch(fail)),
    controls, h('div', { class: 'remote-test' }, testButton, status),
    h('p', { class: 'help foot', text: 'Audio goes to your speech provider, as it does on this PC.' }));
}

const SETTINGS_TABS = [['you', 'You'], ['keys', 'API keys'], ['ai', 'Answers'], ['speech', 'Speech'], ['remote', 'Other PC'], ['behaviour', 'Behaviour'], ['shortcuts', 'Shortcuts'], ['claude', 'Claude']];

pages.settings = async () => {
  const my = renderSeq;
  cfg = await call('settings:get');
  if (my !== renderSeq) return;
  const s = S();
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Settings sections' }, SETTINGS_TABS.map(([id, label]) => h('button', { class: id === settingsTab ? 'on' : '', role: 'tab', tabindex: id === settingsTab ? '0' : '-1', 'aria-selected': id === settingsTab ? 'true' : 'false', text: label, onclick: () => { settingsTab = id; go('settings'); } })));
  tabs.addEventListener('keydown', (e) => {
    const i = SETTINGS_TABS.findIndex(([id]) => id === settingsTab);
    const j = e.key === 'ArrowRight' ? (i + 1) % SETTINGS_TABS.length : e.key === 'ArrowLeft' ? (i + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? SETTINGS_TABS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); settingsTab = SETTINGS_TABS[j][0]; focusTab = true; go('settings');
  });
  let body = [];
  if (settingsTab !== 'keys') keyStatus.clear();

  if (settingsTab === 'you') {
    body = [panel('About you', 'Used to spot questions meant for you.',
      field('Your name', textInput(s.me.name, (v) => save({ me: { name: v.trim() } }), { placeholder: 'As people say it in meetings' })),
      field('Also called', textInput((s.me.aliases || []).join(', '), (v) => save({ me: { aliases: v.split(',').map((x) => x.trim()).filter(Boolean) } }), { placeholder: 'Nicknames, surname, common mis-spellings' }), 'A question containing any of these is treated as aimed at you. Include how transcription tends to spell your name.'),
      field('Role', textInput(s.me.role, (v) => save({ me: { role: v.trim() } }), { placeholder: 'e.g. DevSecOps engineer, platform team' }))),
    panel('Appearance', null,
      field('Theme', segmented([['system', 'Match Windows'], ['dark', 'Dark'], ['light', 'Light']], s.appearance.theme, (v) => { applyTheme(v); save({ appearance: { theme: v } }); }), 'The overlay stays dark so it reads clearly over any window.'))];
  }

  if (settingsTab === 'keys') {
    body = [panel('API keys', cfg.secretsEncrypted ? 'Encrypted with your Windows account. Each key is sent only to its own provider, over HTTPS.' : 'Stored on this computer. Encryption is not available on this system, so the keys file is not encrypted.',
      h('h3', { class: 'grp', text: 'AI' }),
      keyRow('anthropic', 'Anthropic'), keyRow('openai', 'OpenAI', 'Also works as a speech key.'), keyRow('gemini', 'Google Gemini'),
      h('h3', { class: 'grp', text: 'Speech' }),
      keyRow('deepgram', 'Deepgram'), keyRow('assemblyai', 'AssemblyAI'), keyRow('groq', 'Groq'),
      h('p', { class: 'help foot', text: 'You need one AI key and one speech key. Choose which are used under Answers and Speech.' }))];
  }

  if (settingsTab === 'ai') {
    const pick = h('div', { class: 'pick' }, ...modelPicker('live'));
    const livePanel = panel('Live answers', 'Speed matters most here: pick the fastest model that is good enough. Every answer shows how long its first word took.',
      pick,
      field('Web search', toggle('Look things up when your files and the model do not have the answer', s.llm.webSearch !== false, (v) => save({ llm: { webSearch: v } }), 'Adds a second or two to the answers that need it. The AI provider charges per search.')));
    const speedPanel = panel('Speed test', null, speedSection(() => pick.replaceChildren(...modelPicker('live'))));
    speedPanel.classList.add('speedpanel');
    body = [h('div', { class: 'stackcol' }, livePanel, panel('Meeting notes and profile', 'Runs after the meeting, so a stronger, slower model is worth it.', ...modelPicker('notes'))), speedPanel];
  }

  if (settingsTab === 'speech') {
    const sp = cfg.sttProviders[s.stt.provider];
    // Names can only be suggested when speakers are told apart, so the second switch follows the first.
    const suggest = toggle('Suggest names for speakers', s.stt.suggestNames !== false, (v) => save({ stt: { suggestNames: v } }), 'Spots names from introductions and asks you to confirm. Uses the live answers model.');
    suggest.style.display = s.stt.identifySpeakers !== false ? '' : 'none';
    const identify = toggle('Tell the other speakers apart', s.stt.identifySpeakers !== false, (v) => { suggest.style.display = v ? '' : 'none'; return save({ stt: { identifySpeakers: v } }); }, 'Labels them Speaker 1, Speaker 2 and so on.');
    const sttProvider = h('select', { 'aria-label': 'Speech provider', title: 'Speech provider' }, Object.entries(cfg.sttProviders).map(([id, p]) => h('option', { value: id, text: `${sttShort(p)}${p.streaming ? ' (live)' : ''}${cfg.secrets[p.secret] ? '' : ', no key'}`, selected: id === s.stt.provider })));
    sttProvider.addEventListener('change', () => save({ stt: { provider: sttProvider.value } }).then(() => go('settings')));
    const sttResult = h('div', { class: 'help' });
    const sttTest = btn('Test', 'bolt', async () => { sttTest.disabled = true; sttResult.className = 'help'; sttResult.textContent = 'Testing…'; try { const r = await call('provider:test', 'stt', s.stt.provider); sttResult.className = 'help ok'; sttResult.textContent = r.text; } catch (e) { sttResult.className = 'help bad'; sttResult.textContent = e.message; } sttTest.disabled = false; });
    const price = sp.perMinute != null ? `About $${(sp.perMinute * 60).toFixed(2)} per hour of ${sp.billing === 'session' ? 'meeting' : 'speech'} per audio source, at published prices.` : 'See the provider for current pricing.';
    const mic = h('select', { 'aria-label': 'Microphone' }, h('option', { value: s.audio.micDeviceId || 'default', text: 'Looking for microphones…' }));
    mic.addEventListener('change', () => save({ audio: { micDeviceId: mic.value } }));
    micOptions(mic);
    body = [panel('Speech', sp.streaming ? 'Live streaming: words appear as they are spoken.' : 'Per utterance: each sentence is transcribed when the speaker pauses, so text arrives a moment later than with a streaming provider.',
      h('div', { class: 'field stackfield' }, h('label', { text: 'Provider' }), h('div', { class: 'ctl' }, sttProvider, sttTest), sttResult, h('div', { class: 'help', text: price })),
      field('Words to get right', textInput((s.stt.keyterms || []).join(', '), (v) => save({ stt: { keyterms: v.split(',').map((x) => x.trim()).filter(Boolean) } }), { placeholder: 'Trivy, Argo CD, Vault, product and team names' }), 'Names and jargon that transcription tends to mishear.'),
      s.stt.provider === 'deepgram' && field('Options', [identify, suggest, toggle('Skip silence', s.stt.skipSilence !== false, (v) => save({ stt: { skipSilence: v } }), 'Saves cost. Turn off if quiet words are missed.')], null, 'stack'),
      h('details', { class: 'adv' }, h('summary', { text: 'Advanced' }),
        field('Model', textInput((s.stt.models || {})[s.stt.provider] || sp.defaultModel, (v) => save({ stt: { models: { [s.stt.provider]: v.trim() || sp.defaultModel } } }), { spellcheck: false, 'aria-label': 'Speech model' })),
        field('Language', textInput(s.stt.language, (v) => save({ stt: { language: v.trim() || 'en' } }), { placeholder: 'en' }), 'A code such as en, en-GB, fr or de. Deepgram also accepts "multi" for mixed languages.'))),
    panel('Audio sources', s.remote.enabled && s.remote.listen === 'room' ? "The recorder PC's microphone hears the whole room. The switches below are ignored in room mode." : 'Two sources are captured separately, which is how it knows who is speaking: the microphone is you, the computer audio is everyone else.',
      meetingChangeNote(),
      field('Microphone', mic, 'Any input works: built-in, USB, headset or an external microphone.'),
      field('Listen to', [toggle('Microphone', s.audio.captureMic !== false, (v) => save({ audio: { captureMic: v } })), toggle('Computer audio', s.audio.captureSystem !== false, (v) => save({ audio: { captureSystem: v } }), 'The other people in the call. Turn this off for an in-person meeting: the microphone is then treated as the whole room.')], null, 'stack'),
      field('Loudspeakers', toggle('Ignore computer audio picked up by the microphone', s.audio.echoFilter !== false, (v) => save({ audio: { echoFilter: v } }), 'Stops the other side being transcribed twice when you are not on headphones.')))];
  }

  if (settingsTab === 'remote') {
    body = [h('p', { class: 'remote-intro', text: "Use this when the meeting runs on another PC. Its recorder sends audio here over Tailscale." }),
    await remotePanel(), panel('On the other PC', null,
      h('ol', {},
        h('li', { text: 'Install Understudy Recorder on the PC that can hear or play the meeting.' }),
        h('li', { text: 'Install Tailscale on both PCs and sign in to the same account.' }),
        h('li', { text: 'Press Copy recorder settings here, then Paste and connect in the recorder.' }),
        h('li', { text: 'Start the meeting on this PC. The recorder shows Not connected until you start a test or a meeting.' })),
      h('p', { class: 'help foot', text: 'Understudy Recorder has a separate installer. Choose the source here in Settings > Other PC.' }))];
    if (my !== renderSeq) return;
  }

  if (settingsTab === 'behaviour') {
    const styles = await call('personalities:list');
    if (my !== renderSeq) return;
    const sync = await call('shared:info');
    if (my !== renderSeq) return;
    const style = h('select', { 'aria-label': 'Default style' }, styles.map((p) => h('option', { value: p.id, text: p.name, selected: p.id === s.copilot.personality })));
    style.addEventListener('change', () => save({ copilot: { personality: style.value } }));
    const every = h('input', { type: 'number', min: 20, max: 300, value: s.copilot.proactiveEverySec, style: 'max-width:96px', 'aria-label': 'Seconds between suggestions' });
    every.addEventListener('change', () => save({ copilot: { proactiveEverySec: Math.max(20, Number(every.value) || 45) } }));
    const stopAfter = h('input', { type: 'number', min: 0, max: 240, value: s.copilot.autoStopMinutes, style: 'max-width:96px', 'aria-label': 'Minutes of silence before the meeting ends' });
    stopAfter.addEventListener('change', () => save({ copilot: { autoStopMinutes: Math.max(0, Math.min(240, Number(stopAfter.value) || 0)) } }));
    const pct = Math.round((s.overlay.opacity || 0.94) * 100);
    const opacity = h('input', { type: 'range', min: 40, max: 100, value: pct, 'aria-label': 'Overlay opacity' });
    const opacityVal = h('span', { class: 'muted val', text: `${pct}%` });
    opacity.addEventListener('input', () => { opacityVal.textContent = `${opacity.value}%`; call('overlay:opacity', Number(opacity.value) / 100); });
    // One line says what the chosen mode does; the "Suggest every" row only matters in Suggest.
    const modeHelp = h('div', { class: 'help' });
    const everyField = field('Suggest every', [every, h('span', { class: 'muted', text: 's' })]);
    const showMode = (id) => { modeHelp.textContent = (MODES.find((m) => m[0] === id) || MODES[2])[2]; everyField.style.display = id === 'proactive' ? '' : 'none'; };
    showMode(s.copilot.autoMode);
    const modeField = field('Mode', segmented(MODES.map(([id, label]) => [id, label]), s.copilot.autoMode, (v) => { showMode(v); save({ copilot: { autoMode: v } }); }, 'multi'), modeHelp);
    modeField.classList.add('stackfield');
    const folderRow = field('Meetings folder', [h('div', { class: 'pathbox' }, midPath(cfg.meetingsDir)),
      btn('Change', null, () => call('meetings:chooseFolder').then(() => go('settings')).catch(fail), 'small'),
      h('button', { type: 'button', class: 'ib', title: 'Open the folder', 'aria-label': 'Open the Meetings folder', onclick: () => call('meetings:openFolder').catch(fail) }, icon('folder', 16))]);
    body = [panel('During a meeting', 'Mode and Default style can also be changed from the overlay while a meeting runs.',
      modeField, everyField,
      field('Default style', style),
      field('End after', [stopAfter, h('span', { class: 'muted', text: 'min of silence' })], '0 means never.'),
      folderRow),
    h('div', { class: 'stackcol' }, panel('Overlay', null,
      field('Screen sharing', toggle('Keep the overlay out of screen shares and recordings', s.overlay.hideFromCapture !== false, (v) => save({ overlay: { hideFromCapture: v } }), 'When you share your screen, other people see whatever is behind the overlay instead of your notes and transcript.')),
      field('Opacity', [opacity, opacityVal], 'Lower it to see the meeting through the overlay.')), syncPanel(sync))];
  }

  if (settingsTab === 'shortcuts') {
    const row = (key, label) => field(label, shortcutRecorder(key));
    body = [panel('Shortcuts', 'They work while Zoom, Teams or a browser has focus. Click one, then press the new combination. Backspace clears it.',
      row('answer', 'What to say'), row('screen', 'Read screen'), row('take', 'My take'), row('catchup', 'Catch up'), row('pause', 'Pause or resume listening'), row('toggleOverlay', 'Show or hide overlay')),
    h('p', { class: 'note', text: 'If another program already owns a combination, you are told when the meeting starts.' })];
  }

  if (settingsTab === 'claude') {
    const info = await call('claude:info');
    if (my !== renderSeq) return;
    const connector = panel(h('span', {}, 'Claude Desktop ', h('span', { class: `pill ${info.stale ? 'warn' : info.installed ? 'ok' : ''}`, text: info.stale ? 'needs updating' : info.installed ? 'connected' : 'not connected' })), 'Lets Claude read your meetings, notes and problem reports, tick off action items, add updates and save notes.',
      h('div', { class: 'row' },
        btn(info.stale ? 'Update connection' : info.installed ? 'Reconnect' : 'Connect Claude Desktop', 'plug', () => call('claude:install').then((r) => { toast(`Added to ${r.configPath}. Restart Claude Desktop to see the "understudy" tools.`, 'info', 12000); go('settings'); }).catch(fail), info.installed && !info.stale ? '' : 'primary'),
        btn('Copy configuration', 'copy', () => call('app:copy', info.snippet).then(() => toast('Configuration copied.')))),
      h('p', { class: 'help', style: 'margin:10px 0 0;font-size:12px;color:var(--faint)', text: info.claudeFound ? `Writes to ${info.configPath} and keeps a backup beside it.` : 'Claude Desktop was not found on this computer. Copy the configuration and add it to claude_desktop_config.json once it is installed.' }),
      h('details', { class: 'adv' }, h('summary', { text: 'Show configuration' }), h('pre', { class: 'snippet scr' }, h('code', { text: info.snippet }))));
    const others = panel('Other ways in', null,
      field('Claude Code', btn('Copy command', 'copy', () => call('app:copy', info.claudeCode).then(() => toast('Command copied. Run it in a terminal.')))),
      field('Anything else', h('span', { class: 'muted', text: 'Point it at the Meetings folder. The files are plain Markdown.' })));
    body = [connector, h('div', { class: 'stackcol' }, others, problemsPanel())];
  }

  if (my !== renderSeq) return;
  show(my, wrap('Settings', 'Changes are saved as you make them.', tabs, h('div', { class: `tabbody t-${settingsTab}`, role: 'tabpanel', 'aria-label': (SETTINGS_TABS.find(([id]) => id === settingsTab) || [])[1] }, ...body)));
  if (focusTab) { focusTab = false; const on = page.querySelector('.tabs button.on'); if (on) on.focus(); }
  if (keyFocus) { const el = page.querySelector(`input[data-secret="${keyFocus}"]`); keyFocus = null; if (el) el.focus(); }
};

// Settings > Claude > Problems: how many problems are open in the Issues folder, and a one-line form to report one by hand.
function problemsPanel() {
  const countEl = h('p', { class: 'probcount' });
  const msg = h('p', { class: 'probmsg', role: 'status', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', maxLength: 1000, placeholder: 'What went wrong?', 'aria-label': 'What went wrong?', autocomplete: 'off' });
  let busy = false;
  const say = (text, bad) => { msg.textContent = text || ''; msg.classList.toggle('bad', !!bad); };
  const refresh = () => call('issues:info').then((i) => { countEl.textContent = i.open ? `${i.open} open ${i.open === 1 ? 'problem' : 'problems'}.` : 'No open problems.'; }).catch(() => { countEl.textContent = ''; });
  const close = () => { form.hidden = true; input.value = ''; reportBtn.focus(); };
  const send = async () => {
    if (busy) return;
    busy = true; sendBtn.disabled = true;
    try { await call('issues:report', { note: input.value.trim() }); close(); say('Saved. Claude can see it in the Issues folder.'); refresh(); }
    catch (e) { say(e.message || String(e), true); input.focus(); }
    finally { busy = false; sendBtn.disabled = false; }
  };
  const sendBtn = h('button', { type: 'button', class: 'primary', onclick: send }, 'Send');
  const cancelBtn = h('button', { type: 'button', onclick: () => { say(''); close(); } }, 'Cancel');
  const form = h('div', { class: 'row nowrap probform', hidden: true }, input, sendBtn, cancelBtn);
  const reportBtn = btn('Report a problem', 'message', () => { say(''); form.hidden = false; input.focus(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); say(''); close(); }
  });
  refresh();
  return panel('Problems', 'Unexpected errors are saved in your Issues folder so Claude can look at them.',
    countEl,
    h('div', { class: 'row' }, btn('Open Issues folder', 'folder', () => call('issues:open').catch((e) => say(e.message || String(e), true))), reportBtn),
    form, msg);
}

// ====================================================================== events
window.api.on((m) => {
  switch (m.type) {
    case 'state': {
      live = m; renderNav();
      for (const note of page.querySelectorAll('.next-meeting')) note.hidden = !live.active;
      if (current === 'home') go('home');
      break;
    }
    case 'levels': if (onLevels) onLevels(m.levels); break;
    case 'profile-delta': if (profileStream) profileStream(m.delta); break;
    case 'meeting-ended':
      if (m.error) { toast(m.error, 'error', 20000); go('home'); }
      else if (m.file) { notesState.set(m.id, 'working'); meetingTab = 'notes'; go('meetings', m.id); } // the page itself says the notes are being written
      else { toast('The meeting ended with nothing said, so no file was written.', 'warn'); go('home'); }
      break;
    case 'notes': {
      const was = notesState.get(m.id) === 'working';
      if (m.status === 'working') { notesState.set(m.id, 'working'); notesMsg.set(m.id, m.message || ''); } else { notesState.delete(m.id); notesMsg.delete(m.id); }
      if (m.status === 'working' && meetingsCtx) { if (was) meetingsCtx.progress(m.id, m.message); else meetingsCtx.refresh(m.id); }
      if (m.status === 'done') toast(`Notes ready: ${m.title}`);
      if (m.status === 'error') toast(m.message, 'error', 12000);
      if (m.status !== 'working' && current === 'meetings') {
        if (meetingsCtx) { meetingsCtx.refresh(m.id); meetingsCtx.sync(); }
        else go('meetings', !selectedMeeting || selectedMeeting === m.id ? m.id : undefined);
      }
      break;
    }
    case 'images':
      imgNow = { state: m.state === 'done' ? '' : m.state, message: m.state === 'error' ? (m.message || '') : '', stats: m.stats || imgNow.stats };
      if (notesView && current === 'knowledge') notesView.drawImages();
      break;
    case 'speedtest': speedEvent(m); break;
    case 'navigate': { // from the overlay: open this page (and Settings tab)
      if (!pages[m.page]) break;
      if (m.page === 'settings' && SETTINGS_TABS.some(([id]) => id === m.tab)) settingsTab = m.tab;
      go(m.page);
      break;
    }
    case 'meetings-changed': if (current === 'meetings' && meetingsCtx) meetingsCtx.sync(); break;
    case 'recovered': toast(`${m.count} meeting${m.count === 1 ? ' was' : 's were'} recovered after the app closed unexpectedly.`, 'warn', 10000); break;
    case 'error': toast(m.message, 'error', 9000); break;
    default: break;
  }
});

// Coming back to the window: a meeting may have arrived while it was in the background.
window.addEventListener('focus', () => { if (current === 'meetings' && meetingsCtx) meetingsCtx.sync(); });

// A soft fade at the bottom edge of any scrolling panel that has more below, gone again at the end of the scroll.
const fadeWatched = new WeakSet();
let fadeQueued = false;
function fadeEdge(el) { el.classList.toggle('fade-b', el.scrollHeight - el.clientHeight - el.scrollTop > 3); }
function fadeAll() {
  fadeQueued = false;
  for (const el of page.querySelectorAll('.scr, .tabbody, .col')) {
    if (!fadeWatched.has(el)) { fadeWatched.add(el); el.addEventListener('scroll', () => fadeEdge(el), { passive: true }); }
    fadeEdge(el);
  }
}
function queueFade() { if (!fadeQueued) { fadeQueued = true; requestAnimationFrame(fadeAll); } }
new MutationObserver(queueFade).observe(page, { childList: true, subtree: true, characterData: true });
new ResizeObserver(queueFade).observe(page);

(async function boot() {
  document.body.classList.add('one-toast');
  document.getElementById('mark').append(icon('spark', 17));
  document.getElementById('navitems').replaceChildren(...NAV.map(([id, label, ic]) => h('button', { dataset: { page: id }, onclick: () => go(id) }, icon(ic, 17), label)));
  try { cfg = await call('settings:get'); applyTheme(cfg.settings.appearance.theme); } catch { applyTheme('system'); }
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(cfg ? cfg.settings.appearance.theme : 'system'));
  go('home');
})();
