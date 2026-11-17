'use strict';
/* global h, call, renderMarkdown, money, accelLabel, icon, segmented, speakerSlot */

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
      Promise.resolve(window.api.invoke('issues:rendererError', { where: 'overlay', name: cut(name, 100), message, stack: cut(stack, 6000) })).catch(() => {});
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

const $ = (id) => document.getElementById(id);
const ACTIONS = [
  { id: 'say', label: 'What to say', icon: 'message', key: 'answer', primary: true },
  { id: 'take', label: 'My take', icon: 'bulb', key: 'take' },
  { id: 'followup', label: 'Ask them', icon: 'help', tip: 'Questions I could ask' },
  { id: 'catchup', label: 'Catch up', icon: 'rewind', key: 'catchup' },
  { id: 'screen', label: 'Read screen', icon: 'screen', key: 'screen' },
];
const CARD_ICON = { answer: 'message', say: 'message', take: 'bulb', followup: 'help', catchup: 'rewind', screen: 'screen', ask: 'spark', proactive: 'bolt' };

const cards = new Map(); // id -> { data, el, open }
let latestId = null;
let turns = [];
let partial = { me: '', them: '' };
let startMs = 0;
let myLabel = 'Me';
let shortcuts = {};
let liveModel = '';
let mentionTurn = 0;
let mentionTimer = null;
let lastCost = null;
let paused = false;
let modeSeg = null;
let capture = { me: 'off', them: 'off' };
let room = false;
let activeChannels = ['me', 'them'];
let ending = false;

// ---------------------------------------------------------------- notices
// One line under the controls. A connection notice (kind 'conn') follows the
// state of the audio and clears itself; any other message can be dismissed and
// never replaces it, so the thing that matters most stays where you look.
let noticeKind = '';
function showNotice(content, bad, kind = 'msg') {
  const n = $('notice');
  const empty = content == null || content === '' || (Array.isArray(content) && !content.length);
  n.hidden = empty;
  n.className = bad ? 'bad' : '';
  n.replaceChildren();
  noticeKind = empty ? '' : kind;
  if (empty) return;
  n.append(h('span', {}, ...[].concat(content)));
  if (kind !== 'conn') n.append(h('button', { text: '×', 'aria-label': 'Dismiss', onclick: () => showNotice('') }));
}
const transient = (content, bad) => { if (noticeKind !== 'conn') showNotice(content, bad); };

// A rejected or missing key is something to fix in Settings: say so and link to it.
const PROVIDERS = ['Anthropic', 'OpenAI', 'Gemini', 'Deepgram', 'AssemblyAI', 'Groq'];
const MODEL_PROVIDER = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', google: 'Gemini' };
function keyProblem(message) {
  const m = String(message || '');
  const named = PROVIDERS.find((p) => new RegExp(`\\b${p}\\b`, 'i').test(m)) || MODEL_PROVIDER[String(liveModel).split('/')[0].toLowerCase()] || 'Your AI provider';
  const none = /^No API key saved for\s+([^.]+)/i.exec(m);
  if (none) return `No ${none[1].trim()} key.`;
  if (/rejected (the|your) (api )?key|key (was )?not accepted|(^|\D)(401|403)(\D|$)|invalid[^.]*api[- ]key/i.test(m)) return `${named} rejected your key.`;
  return null;
}
const openKeys = () => call('app:show', { page: 'settings', tab: 'keys' }).catch(() => {});
// A model the provider will not use for this key or request: the fix is to pick another one in Settings > Answers.
const MODEL_SENTENCE = /does not have that model|does not recogni[sz]e this model|could not use that request|request is too large for this model/i;
const openModels = () => call('app:show', { page: 'settings', tab: 'ai' }).catch(() => {});
// What an error says: the plain sentence and the link when it is a key or model problem, otherwise the message as it came.
function errorNodes(message) {
  const k = keyProblem(message);
  if (!k) {
    const text = String(message || 'Something went wrong.');
    if (!MODEL_SENTENCE.test(text)) return [text];
    return [`${text} `, h('button', { type: 'button', class: 'linkish', text: 'Open Settings > Answers.', onclick: (e) => { e.stopPropagation(); openModels(); } })];
  }
  return [`${k} `, h('button', { type: 'button', class: 'linkish', text: 'Open Settings > API keys.', onclick: (e) => { e.stopPropagation(); openKeys(); } })];
}

// ---------------------------------------------------------------- connection
// What the overlay knows today: each speech stream reports 'reconnecting' while
// it retries and 'listening' once it is back ('closed' is final: the provider
// refused it, or it was stopped); the audio capture reports 'lost' (retrying),
// 'on' and 'error' (gave up). A stream still reconnecting after GIVE_UP_MS, or
// one that says it keeps dropping, is treated as not coming back by itself.
const GIVE_UP_MS = 20000;
const sttDown = { me: null, them: null };   // null | 'trying' | 'gaveup'
const sttTimer = { me: null, them: null };
const sttKeyMsg = { me: '', them: '' };     // the last "key rejected" error from a stream
const capMsg = { me: '', them: '' };        // what the capture said when it failed
let renderState = () => {};

function linkStatus(ch) {
  if (paused) return null;
  if (sttDown[ch] === 'gaveup' || capture[ch] === 'error') return 'gaveup';
  if (sttDown[ch] === 'trying' || capture[ch] === 'lost') return 'trying';
  return null;
}
const lostChannel = () => (linkStatus('them') ? 'them' : linkStatus('me') ? 'me' : null);

function setSttDown(ch, value) {
  clearTimeout(sttTimer[ch]);
  sttDown[ch] = value;
  if (value === 'trying') sttTimer[ch] = setTimeout(() => setSttDown(ch, 'gaveup'), GIVE_UP_MS);
  if (!value) sttKeyMsg[ch] = '';
  renderConnection();
}
function resetConnection() {
  for (const ch of ['me', 'them']) { clearTimeout(sttTimer[ch]); sttDown[ch] = null; sttKeyMsg[ch] = ''; capMsg[ch] = ''; }
}

function renderConnection() {
  const ch = lostChannel();
  renderState();
  setMeter('m-me', lastLevels.me, meterState('me'));
  setMeter('m-them', lastLevels.them, meterState('them'));
  if (!ch) { if (noticeKind === 'conn') showNotice(''); return; }
  const gone = linkStatus(ch) === 'gaveup';
  let content;
  if (!gone) content = `Lost ${ch === 'them' ? 'the meeting audio' : 'the microphone'}. Reconnecting.`;
  else if (sttKeyMsg[ch] && keyProblem(sttKeyMsg[ch])) content = errorNodes(sttKeyMsg[ch]);
  else if (capture[ch] === 'error' && capMsg[ch]) content = capMsg[ch];
  else content = `Not transcribing ${ch === 'them' ? 'computer audio' : 'the microphone'}. Pause and resume to retry.`;
  showNotice(content, gone, 'conn');
}

// ---------------------------------------------------------------- transcript
// Rows are kept per turn and only touched when something about them changed.
// Live text arrives many times a second, and rebuilding the rows each time
// would swallow a click on a speaker's name (or wipe a name being typed).
const rowEls = new Map(); // turn id -> <p>
let editing = null;       // { id, key, row } while a speaker name is being typed

function buildRow(t) {
  // A marker that speech was skipped: a quiet note, with no speaker and nothing to rename.
  if (t.gap) return h('p', { class: 'turn gap' }, t.text || '');
  const who = t.channel === 'them' && t.speakerKey
    ? h('button', { type: 'button', class: 'who', title: 'Click to name this speaker', 'aria-label': `Rename ${t.speaker}`, text: t.speaker, onclick: () => startRename(t) })
    : h('span', { class: 'who', text: t.speaker });
  return h('p', { class: 'turn' }, who, t.text || '');
}

function turnRow(id, t, extra = '') {
  const sig = `${t.channel}|${t.speaker}|${t.speakerKey || ''}|${t.gap ? 'gap' : ''}`;
  let el = rowEls.get(id);
  // The row being edited keeps its input, whatever happens to the turn meanwhile.
  if (!el || (el.dataset.sig !== sig && !(editing && editing.id === id))) {
    el = buildRow(t);
    el.dataset.sig = sig;
    rowEls.set(id, el);
  }
  // Colour follows the provider's label, so a voice keeps its colour once it has a name.
  el.className = t.gap ? `turn gap ${extra}` : `turn ${t.channel === 'me' ? 'me' : `s${speakerSlot(t.label || t.speaker)}`} ${extra}`;
  const text = el.lastChild;
  if (text.nodeValue !== (t.text || '')) text.nodeValue = t.text || '';
  return el;
}

// Make the box hold exactly these nodes, moving as few as possible so that
// focus and an open input survive.
function syncRows(box, rows) {
  const want = new Set(rows);
  for (const c of [...box.children]) if (!want.has(c)) c.remove();
  rows.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null); });
}

function renderTranscript() {
  const box = $('tr-lines');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const rows = turns.slice(-8).map((t) => turnRow(t.id, t, t.id === mentionTurn ? 'hit' : ''));
  for (const ch of ['them', 'me']) {
    if (partial[ch]) rows.push(turnRow(`partial-${ch}`, { channel: ch, speaker: ch === 'me' ? myLabel : 'Them', text: partial[ch] }, 'live'));
  }
  // If the turn being renamed has scrolled out of the last few, keep it until the edit ends.
  if (editing && !rows.includes(editing.row)) rows.unshift(editing.row);
  if (!rows.length) rows.push(h('p', { class: 'empty', text: 'Listening. Words appear here as people speak.' }));
  for (const [id, el] of rowEls) if (!rows.includes(el)) rowEls.delete(id);
  syncRows(box, rows);
  if (stick) box.scrollTop = box.scrollHeight;
}

// Display names live on the speaker list, so a rename also reaches turns the event did not carry.
function applyNames(list) {
  const display = new Map((list || []).map((s) => [s.key, s.display]));
  for (const t of turns) if (t.speakerKey && display.has(t.speakerKey)) t.speaker = display.get(t.speakerKey);
}

// Click a name, type a new one. Enter or leaving the box saves, Escape cancels,
// and an empty box takes the name away again.
function startRename(t) {
  if (editing) return;
  const row = rowEls.get(t.id);
  const btn = row && row.querySelector('button.who');
  if (!btn) return;
  const current = t.label && t.speaker !== t.label ? t.speaker : '';
  const input = h('input', { type: 'text', class: 'who-edit', value: current, placeholder: t.label || 'Name', maxLength: 40, 'aria-label': 'Speaker name', autocomplete: 'off' });
  input.spellcheck = false;
  let done = false;
  const finish = (save, refocus) => {
    if (done) return;
    done = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    editing = null;
    row.dataset.sig = ''; // rebuild the row with its button
    if (save && value !== current) {
      call('meeting:renameSpeaker', t.speakerKey, value)
        .then((list) => { if (Array.isArray(list)) { applyNames(list); renderTranscript(); } })
        .catch((err) => transient(err.message, true));
    }
    renderTranscript();
    if (refocus) { const again = rowEls.get(t.id); const b = again && again.querySelector('button.who'); if (b) b.focus(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
  });
  input.addEventListener('blur', () => finish(true, false));
  editing = { id: t.id, key: t.speakerKey, row };
  btn.replaceWith(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------- the strip: name suggestions and passed questions
// Both want an answer from you, so they share ONE line that shows the newest of
// either; a "+1" says another is waiting behind it.
let arrival = 0;
const suggestions = new Map(); // id -> { id, key, label, name, evidence, n }
const suggestionEls = new Map();

function suggestionRow(s) {
  let el = suggestionEls.get(s.id);
  if (el) return el;
  const answer = (accept) => {
    const buttons = el.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    call('meeting:suggestion', s.id, accept)
      .then(() => { suggestions.delete(s.id); renderStrip(); })
      .catch((err) => { buttons.forEach((b) => { b.disabled = false; }); transient(err.message, true); });
  };
  el = h('div', { class: 'sugg', role: 'group', 'aria-label': `Suggested name for ${s.label}` },
    h('span', { class: 'sg-who' }, s.label, ' might be ', h('b', { text: s.name })),
    h('span', { class: 'sg-ev', title: s.evidence || '', text: s.evidence ? `“${s.evidence}”` : '' }),
    h('button', { type: 'button', class: 'primary', 'aria-label': `Use the name ${s.name} for ${s.label}`, text: 'Use', onclick: () => answer(true) }),
    h('button', { type: 'button', class: 'ghost', 'aria-label': `Dismiss the suggestion for ${s.label}`, text: 'No', onclick: () => answer(false) }));
  suggestionEls.set(s.id, el);
  return el;
}

// A question the app left alone (put to someone else, or not meant for you in Mine mode).
// Answer turns it into a normal card; the cross only hides the row here.
let passed = null;        // { id, ask, speaker, target, addressee, at, n } or null
let passedHidden = null;  // id the reader dismissed
let passedEl = null;      // the row for `passed`, kept while it stays the same question

// The same words as the card the question would become.
const askedLabel = (target, addressee) => (target === 'room' ? 'Asked to the room' : target === 'you' ? 'Asked of you' : addressee ? `Asked of ${addressee}` : 'Asked of someone else');

function passedRow(p) {
  if (passedEl && passedEl.dataset.id === String(p.id)) return passedEl;
  const text = `${askedLabel(p.target, p.addressee)}: “${p.ask}”`;
  const answer = h('button', { type: 'button', class: 'primary', 'aria-label': 'Answer this question anyway', text: 'Answer' });
  answer.addEventListener('click', () => {
    answer.disabled = true;
    call('meeting:answerPassed', p.id)
      .then(() => { if (passed && passed.id === p.id) { passed = null; renderStrip(); } })
      .catch((err) => { answer.disabled = false; transient(err.message, true); });
  });
  const dismiss = h('button', { type: 'button', class: 'ghost', 'aria-label': 'Dismiss', title: 'Dismiss', text: '×', onclick: () => { passedHidden = p.id; renderStrip(); } });
  passedEl = h('div', { class: 'pass', dataset: { id: String(p.id) } }, h('span', { class: 'pass-text', title: text, text }), answer, dismiss);
  return passedEl;
}

const moreBadge = h('span', { class: 'more' });

function renderStrip() {
  const box = $('strip');
  const items = [...suggestions.values()].map((s) => ({ n: s.n, row: () => suggestionRow(s) }));
  if (passed && passed.id !== passedHidden) items.push({ n: passed.n, row: () => passedRow(passed) });
  items.sort((a, b) => b.n - a.n);
  for (const id of [...suggestionEls.keys()]) if (!suggestions.has(id)) suggestionEls.delete(id);
  if (!passed || passed.id === passedHidden) passedEl = null;
  box.hidden = !items.length;
  moreBadge.remove();
  if (!items.length) { syncRows(box, []); return; }
  const row = items[0].row();
  syncRows(box, [row]);
  if (items.length > 1) {
    moreBadge.textContent = `+${items.length - 1}`;
    moreBadge.title = `${items.length - 1} more waiting`;
    row.insertBefore(moreBadge, row.querySelector('button'));
  }
}

// Accept the question either flat on the event or nested under `passed`, as the suggestions are.
function takePassed(m) {
  const p = m.passed && typeof m.passed === 'object' ? m.passed : m;
  if (p.id == null || !p.ask) return;
  if (passed && passed.id === p.id) return;
  passed = { id: p.id, ask: String(p.ask), speaker: p.speaker || '', target: p.target === 'room' || p.target === 'you' ? p.target : 'other', addressee: p.addressee || '', at: p.at || 0, n: ++arrival };
  renderStrip();
}

// ---------------------------------------------------------------- cards
function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim()).find(Boolean) || '';
}

function footer(d) {
  const foot = h('div', { class: 'foot' });
  for (const f of d.files || []) foot.append(h('span', { title: `From your files: ${f}` }, icon('file', 12), h('span', { text: f.split(/[\\/]/).pop() })));
  for (const s of d.sources || []) foot.append(h('a', { href: s.url, title: s.url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); call('app:openExternal', s.url); } }, icon('globe', 12), h('span', { text: s.title })));
  if (d.note) foot.append(h('span', { text: d.note }));
  return foot.childNodes.length ? foot : null;
}

const isFolded = (entry) => !(entry.open != null ? entry.open : entry.data.id === latestId);
const selectionIn = (el) => { const s = window.getSelection(); return Boolean(s && !s.isCollapsed && el.contains(s.anchorNode)); };

// Everything that changes the card's structure. While only the text grows,
// the card's buttons stay in place so clicks and selections are not lost.
function cardSig(entry) {
  const d = entry.data;
  return [d.status, Boolean(d.text), d.statusText || '', isFolded(entry), d.id === latestId, d.target || '', d.addressee || '', d.error || '', d.note || '', (d.sources || []).length, (d.files || []).length, Boolean(d.check)].join('|');
}

// Who an automatic answer was for. Cards from a shortcut or a typed question have no target and keep their own label.
function cardLabel(d) {
  if (d.reason === 'you were mentioned') return 'You were mentioned';
  if (d.target === 'you') return 'Asked of you';
  if (d.target === 'room') return 'Asked to the room';
  if (d.target === 'other') return d.addressee ? `Asked of ${d.addressee}` : 'Asked of someone else';
  return d.reason === 'question to you' ? 'Asked of you' : d.label;
}

function buildCard(entry) {
  const d = entry.data;
  const el = entry.el;
  const you = d.target === 'you' || d.reason === 'question to you' || d.reason === 'you were mentioned';
  const folded = isFolded(entry);
  el.className = `card ${d.status}${d.id === latestId ? ' latest' : ''}${you ? ' you' : ''}${folded ? ' folded' : ''}`;
  const label = cardLabel(d);
  const toggleFold = () => { entry.open = isFolded(entry); buildCard(entry); };

  const tools = h('span', { class: 'tools' });
  if (d.status === 'streaming') tools.append(h('button', { title: 'Stop writing', 'aria-label': 'Stop writing', onclick: (e) => { e.stopPropagation(); call('meeting:cancelCard', d.id); } }, icon('stop', 14)));
  else if (d.text) {
    const copy = h('button', { class: 'copy', title: 'Copy', 'aria-label': 'Copy answer', onclick: (e) => { e.stopPropagation(); call('app:copy', d.text); copy.classList.add('done'); copy.replaceChildren(icon('check', 14)); setTimeout(() => { copy.classList.remove('done'); copy.replaceChildren(icon('copy', 14)); }, 1200); } }, icon('copy', 14));
    tools.append(copy);
  }
  // An open answer folds away; a folded one can be removed.
  tools.append(folded
    ? h('button', { title: 'Remove', 'aria-label': 'Remove this answer', onclick: (e) => { e.stopPropagation(); removeCard(d.id); } }, icon('x', 14))
    : h('button', { title: 'Fold', 'aria-label': 'Fold this answer', onclick: (e) => { e.stopPropagation(); entry.open = false; buildCard(entry); } }, icon('chevron', 14)));

  const time = h('span', { class: 'time', title: 'Time to the first word', text: d.firstTokenMs != null ? `${(d.firstTokenMs / 1000).toFixed(1)}s` : '' });
  const preview = h('span', { class: 'preview', text: firstLine(d.text) || d.quote || '' });
  const top = h('div', { class: 'top', role: 'button', tabindex: '0', 'aria-expanded': String(!folded), title: folded ? 'Show this answer' : 'Fold this answer',
    onclick: toggleFold, onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleFold(); } } },
  h('span', { class: 'label' }, icon(CARD_ICON[d.action] || 'message', 13), label), preview, time, tools);

  const body = h('div', { class: 'body' });
  if (d.text) body.append(renderMarkdown(d.text, { answer: true }));
  const kids = [top];
  if (d.quote) kids.push(h('p', { class: 'quote', text: d.quote }));
  kids.push(body);
  if (d.status === 'streaming' && (!d.text || d.statusText)) {
    kids.push(h('div', { class: 'thinking' }, d.text ? null : [h('i'), h('i'), h('i')], d.statusText ? h('span', { text: `${d.statusText}…` }) : null));
  }
  if (d.status === 'error') kids.push(h('div', { class: 'err' }, ...errorNodes(d.error)));
  if (d.status === 'cancelled') kids.push(h('div', { class: 'err muted', text: d.note || (d.text ? '' : 'Stopped.') }));
  // The answer talks about how the user's own organisation does things and no file backs it (session.js sets check).
  if (d.status === 'done' && d.check && d.text) kids.push(h('p', { class: 'check', text: 'Mentions how your company does things: check it before you say it.' }));
  const foot = d.status === 'done' ? footer(d) : null;
  if (foot) kids.push(foot);
  el.replaceChildren(...kids);
  entry.refs = { body, preview, time };
  entry.sig = cardSig(entry);
}

// Called for every piece of streamed text.
function updateStreaming(entry) {
  if (!entry.refs || entry.sig !== cardSig(entry)) { buildCard(entry); return; }
  const d = entry.data;
  // Leave the text alone while the reader has part of it selected.
  if (!selectionIn(entry.el)) entry.refs.body.replaceChildren(renderMarkdown(d.text, { answer: true }));
  entry.refs.preview.textContent = firstLine(d.text) || d.quote || '';
  if (d.firstTokenMs != null) entry.refs.time.textContent = `${(d.firstTokenMs / 1000).toFixed(1)}s`;
}

function emptyHint() {
  const box = $('cards');
  const existing = box.querySelector('.hint');
  if (cards.size) { if (existing) existing.remove(); return; }
  const mode = modeSeg ? modeSeg.dataset.value : '';
  const text = mode === 'manual' ? 'Answers appear when you ask for them.'
    : mode === 'mine' ? 'An answer appears here when a question is meant for you.'
      : 'An answer appears here when someone asks a question.';
  if (existing && existing.dataset.text === text) return;
  if (existing) existing.remove(); // the mode changed: say what that mode does
  const key = shortcuts.answer ? accelLabel(shortcuts.answer) : '';
  box.append(h('div', { class: 'hint', dataset: { text } }, icon('spark', 26), h('b', { text: 'Ready' }),
    text,
    key ? h('div', { style: 'margin-top:8px' }, h('kbd', { text: key }), ' for what to say next') : null));
}

function removeCard(id) {
  const e = cards.get(id);
  if (!e) return;
  e.el.remove(); cards.delete(id);
  if (latestId === id) { latestId = [...cards.keys()].pop() ?? null; const n = cards.get(latestId); if (n) buildCard(n); }
  emptyHint();
}

function foldOld() {
  for (const e of cards.values()) if (e.data.id !== latestId && e.open === true && !e.el.matches(':hover') && !selectionIn(e.el)) { e.open = null; buildCard(e); }
}

function showNewPill() {
  if ($('newpill')) return;
  const b = h('button', { id: 'newpill', class: 'newpill', onclick: () => { b.remove(); $('cards').scrollTo({ top: 0 }); foldOld(); } }, icon('chevron', 12), 'New answer');
  $('cards').prepend(b);
}

function addCard(d) {
  const known = cards.get(d.id);
  if (known) { known.data = { ...known.data, ...d }; buildCard(known); return; }
  const box = $('cards');
  const nearTop = box.scrollTop < 40;
  const previous = cards.get(latestId);
  // Someone reading the answer above must not have it folded or scrolled away.
  const reading = Boolean(previous) && (!nearTop || previous.el.matches(':hover') || selectionIn(previous.el));
  latestId = d.id;
  const entry = { data: d, el: h('article', {}), open: null, refs: null, sig: '' };
  cards.set(d.id, entry);
  if (previous) { previous.open = reading ? true : null; buildCard(previous); }
  buildCard(entry);
  const pill = $('newpill');
  box.insertBefore(entry.el, pill ? pill.nextSibling : box.firstChild);
  if (nearTop) box.scrollTop = 0; else showNewPill();
  emptyHint();
  const ids = [...cards.keys()];
  while (ids.length > 14) { const old = ids.shift(); if (old === latestId) break; cards.get(old).el.remove(); cards.delete(old); } // the meeting moves on
}

let drawQueued = new Set();
function queueDraw(id) {
  // Text arrives in many small pieces; update at most once per frame.
  if (!drawQueued.size) requestAnimationFrame(() => { const ids = drawQueued; drawQueued = new Set(); for (const i of ids) { const e = cards.get(i); if (e) updateStreaming(e); } });
  drawQueued.add(id);
}

// ---------------------------------------------------------------- chrome
const lastLevels = { me: 0, them: 0 };
const meterState = (ch) => (room && ch === 'me' ? (lostChannel() ? 'error' : (capture.me !== 'off' ? capture.me : capture.them)) : linkStatus(ch) ? 'error' : capture[ch]);
function setMeter(id, level, state) {
  const el = $(id);
  lastLevels[id === 'm-me' ? 'me' : 'them'] = level;
  const lit = level > 0.0005 ? Math.max(1, Math.min(5, Math.ceil(Math.sqrt(level) * 6))) : 0;
  el.classList.toggle('dead', state === 'error' || state === 'lost');
  el.querySelectorAll('i').forEach((seg, i) => seg.classList.toggle('on', i < lit));
}
function syncMeters() {
  const me = $('m-me'), them = $('m-them');
  const who = me && me.querySelector('b');
  if (who) who.textContent = room ? 'Room' : 'You';
  if (me) { me.title = room ? 'Room microphone' : 'Microphone'; me.hidden = !room && !activeChannels.includes('me'); }
  if (them) them.hidden = room || !activeChannels.includes('them');
}

function renderMeta() {
  const total = lastCost ? lastCost.llm + lastCost.stt : null;
  $('meta').replaceChildren(
    h('span', { title: 'Model used for live answers', text: liveModel ? liveModel.split('/').pop() : '' }),
    h('span', { title: 'Estimate from published prices: speech plus AI', text: total == null ? '' : total < 0.01 ? 'under 1 cent so far' : `about ${money(total)} so far` }));
}

function applyState(s) {
  paused = Boolean(s.paused);
  document.body.classList.toggle('paused', paused);
  $('pause').replaceChildren(icon(paused ? 'play' : 'pause', 15));
  $('pause').title = `${paused ? 'Resume' : 'Pause'}${shortcuts.pause ? ` (${accelLabel(shortcuts.pause)})` : ''}`;
  $('pause').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  if (s.meta) startMs = s.meta.startMs;
  if (s.room != null) room = Boolean(s.room);
  if (Array.isArray(s.channels) && s.channels.length) activeChannels = s.channels;
  syncMeters();
  if (modeSeg && s.autoMode) { modeSeg.setValue(s.autoMode); modeSeg.dataset.value = s.autoMode; }
  if (s.personality) $('style').value = s.personality;
  if (s.cost) lastCost = s.cost;
  if (paused) for (const ch of ['me', 'them']) { clearTimeout(sttTimer[ch]); sttDown[ch] = null; }
  renderMeta();
  renderConnection();
}

// The header says one thing at a time: paused, lost audio, a mention, or listening.
// Paused is said here and nowhere else.
renderState = function renderStateImpl() {
  const lost = lostChannel();
  document.body.classList.toggle('lost', Boolean(lost));
  $('state').textContent = paused ? 'Paused' : lost ? (lost === 'them' ? 'Not hearing the meeting' : 'Not hearing you') : document.body.classList.contains('mentioned') ? 'You were mentioned' : 'Listening';
  $('state').title = paused ? 'Nothing is being recorded or sent.' : '';
};

function flashMention(turnId) {
  mentionTurn = turnId;
  document.body.classList.add('mentioned');
  renderState();
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => { document.body.classList.remove('mentioned'); renderState(); }, 6000);
  renderTranscript();
}

async function init() {
  const [s, cfg] = await Promise.all([call('meeting:state'), call('settings:get')]);
  myLabel = cfg.settings.me.name || 'Me';
  shortcuts = s.shortcuts || {};
  liveModel = s.models.live;
  capture = s.capture || capture;
  room = Boolean(s.room);
  activeChannels = Array.isArray(s.channels) && s.channels.length ? s.channels : ['me', 'them'];

  modeSeg = segmented([['manual', 'On request', 'Only answer when I ask'], ['mine', 'Mine', 'Only answer questions meant for me'], ['questions', 'Questions', 'Answer questions, except ones put to someone else by name'], ['proactive', 'Suggest', 'Answer questions, and speak up when something matters']], s.autoMode, (v) => { modeSeg.dataset.value = v; call('meeting:set', { autoMode: v }); emptyHint(); });
  modeSeg.dataset.value = s.autoMode;
  modeSeg.setAttribute('aria-label', 'Mode');
  for (const b of modeSeg.children) b.title = `Mode: ${b.title.charAt(0).toLowerCase()}${b.title.slice(1)}`;
  $('mode').replaceChildren(modeSeg);
  $('style').replaceChildren(...s.personalities.map((p) => h('option', { value: p.id, text: p.name, title: p.description })));

  $('actions').replaceChildren(...ACTIONS.map((a) => h('button', { class: a.primary ? 'primary' : '', dataset: { action: a.id }, title: a.key && shortcuts[a.key] ? `${a.tip || a.label} (${accelLabel(shortcuts[a.key])})` : (a.tip || a.label) }, icon(a.icon, 17), h('span', { text: a.label }))));
  $('hide').replaceChildren(icon('minus', 15));
  $('hide').title = `Hide overlay${shortcuts.toggleOverlay ? ` (${accelLabel(shortcuts.toggleOverlay)} shows it again)` : ''}`;
  $('stop').replaceChildren(icon('stop', 12), 'End');
  $('stop').title = 'End meeting and save';
  $('asksend').replaceChildren(icon('send', 15));
  $('tr-toggle').replaceChildren(icon('chevron', 12), h('span', { text: 'Transcript' }));
  if (!$('stylepick').querySelector('svg')) $('stylepick').prepend(icon('persona', 15));

  turns = s.turns || [];
  applyNames(s.speakers);
  partial = { me: '', them: '' };
  editing = null; rowEls.clear();
  suggestions.clear(); suggestionEls.clear();
  for (const x of s.suggestions || []) suggestions.set(x.id, { ...x, n: ++arrival });
  passed = s.passed && s.passed.id != null ? { ...s.passed, n: ++arrival } : null; passedHidden = null; passedEl = null;
  renderStrip();
  cards.clear(); latestId = null; $('cards').replaceChildren();
  for (const c of s.cards || []) addCard(c);
  resetConnection();
  applyState(s);
  emptyHint();
  renderTranscript();
}

// ---------------------------------------------------------------- events
window.api.on((m) => {
  switch (m.type) {
    case 'state':
      if (m.active && m.meta && m.meta.startMs !== startMs) { showNotice(''); init(); break; } // a new meeting starts clean
      applyState(m); break;
    case 'partial': partial[m.channel] = m.text; renderTranscript(); break;
    case 'turn': {
      const i = turns.findIndex((t) => t.id === m.turn.id);
      if (i === -1) turns.push(m.turn); else turns[i] = m.turn;
      if (turns.length > 60) turns = turns.slice(-60);
      renderTranscript(); break;
    }
    case 'speakers': {
      for (const t of m.turns || []) { const i = turns.findIndex((x) => x.id === t.id); if (i !== -1) turns[i] = t; }
      applyNames(m.speakers);
      renderTranscript(); break;
    }
    case 'speaker-suggestion': if (m.suggestion) { const had = suggestions.get(m.suggestion.id); suggestions.set(m.suggestion.id, { ...m.suggestion, n: had ? had.n : ++arrival }); renderStrip(); } break;
    case 'speaker-suggestion-clear': suggestions.delete(m.id); renderStrip(); break;
    case 'passed': takePassed(m); break;
    case 'passed-clear': if (passed && passed.id === m.id) { passed = null; renderStrip(); } break;
    case 'mention': flashMention(m.turn.id); break;
    case 'card': addCard(m); break;
    case 'card-delta': {
      const e = cards.get(m.id);
      if (!e) break;
      if (m.delta) e.data.text += m.delta;
      if (m.statusText != null) e.data.statusText = m.statusText;
      queueDraw(m.id); break;
    }
    case 'card-done': { const e = cards.get(m.id); if (e) { e.data = { ...e.data, ...m }; buildCard(e); } break; }
    case 'card-remove': {
      const e = cards.get(m.id);
      // A newer question replaced an answer that was still being written: keep what there was, folded.
      if (e && e.data.text && e.data.status !== 'done') {
        e.data.status = 'cancelled'; e.data.note = 'Replaced by a newer question.'; e.open = null; buildCard(e);
        setTimeout(() => removeCard(m.id), 20000);
      } else removeCard(m.id);
      break;
    }
    case 'levels': setMeter('m-me', room ? Math.max(m.levels.me || 0, m.levels.them || 0) : m.levels.me, meterState('me')); setMeter('m-them', m.levels.them, meterState('them')); break;
    case 'capture':
      capture = m.status;
      for (const ch of ['me', 'them']) if (capture[ch] === 'error' && m.message) capMsg[ch] = m.message;
      renderConnection(); break;
    case 'stt-state': {
      const ch = m.channel === 'me' ? 'me' : 'them';
      if (m.state === 'reconnecting') { if (!sttDown[ch]) setSttDown(ch, 'trying'); }
      else if (m.state === 'listening' || m.state === 'ready') { sttKeyMsg[ch] = ''; if (sttDown[ch]) setSttDown(ch, null); }
      else if (m.state === 'closed') {
        // Pausing closes the streams a moment before the pause itself is announced.
        setTimeout(() => { if (!paused && !ending) setSttDown(ch, 'gaveup'); }, 700);
      }
      break;
    }
    case 'cost': lastCost = m; renderMeta(); break;
    case 'error': {
      const ch = m.channel === 'me' ? 'me' : 'them';
      if (m.where === 'stt' && m.channel) {
        if (keyProblem(m.message)) { sttKeyMsg[ch] = m.message; renderConnection(); }
        // A drop is already shown from the stream's state; the raw line adds nothing.
        else if (/connection problem|closed the stream|Reconnecting/i.test(m.message)) break;
        else if (/keeps dropping/i.test(m.message)) { setSttDown(ch, 'gaveup'); break; }
        if (linkStatus(ch)) break;
      }
      transient(errorNodes(m.message), true);
      break;
    }
    case 'hint': transient(m.message, false); break;
    default: break;
  }
});

setInterval(() => {
  if (!startMs) return;
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hh = Math.floor(s / 3600);
  $('clock').textContent = `${hh ? `${hh}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (b) call('meeting:action', b.dataset.action, {}).catch((err) => transient(err.message, true));
});
$('askform').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('ask').value.trim();
  if (!v) return;
  $('ask').value = '';
  call('meeting:action', 'ask', { typed: v }).catch((err) => transient(err.message, true));
});
$('style').addEventListener('change', () => call('meeting:set', { personality: $('style').value }));
$('pause').addEventListener('click', () => call(paused ? 'meeting:resume' : 'meeting:pause').catch((err) => transient(err.message, true)));
$('hide').addEventListener('click', () => call('overlay:toggle', false));
// Ending a meeting takes two clicks, so a slip next to Pause or Hide does nothing.
let stopArmed = null;
function disarmStop() { stopArmed = null; document.body.classList.remove('arming'); $('stop').classList.remove('armed'); $('stop').replaceChildren(icon('stop', 12), 'End'); }
$('stop').addEventListener('click', () => {
  if (!stopArmed) { document.body.classList.add('arming'); $('stop').classList.add('armed'); $('stop').replaceChildren(icon('stop', 12), 'Click again to end'); stopArmed = setTimeout(disarmStop, 3500); return; }
  clearTimeout(stopArmed); disarmStop();
  $('stop').disabled = true;
  ending = true;
  call('meeting:stop').catch((err) => transient(err.message, true)).finally(() => { $('stop').disabled = false; ending = false; });
});
$('cards').addEventListener('scroll', () => { const pill = $('newpill'); if (pill && $('cards').scrollTop < 40) pill.remove(); });
// In a short window the transcript starts folded behind its toggle, so speaker labels stay one click away.
// What was chosen in a tall window is remembered; a short window always starts folded.
const shortWindow = window.matchMedia('(max-height: 560px)');
let trClosedTall = false;
try { trClosedTall = Boolean(localStorage.getItem('transcript-closed')); } catch { /* storage unavailable */ }
function setTranscriptClosed(closed) {
  $('transcript').classList.toggle('closed', closed);
  $('tr-toggle').setAttribute('aria-expanded', closed ? 'false' : 'true');
}
$('tr-toggle').addEventListener('click', () => {
  const closed = !$('transcript').classList.contains('closed');
  setTranscriptClosed(closed);
  if (!shortWindow.matches) {
    trClosedTall = closed;
    try { localStorage.setItem('transcript-closed', closed ? '1' : ''); } catch { /* storage unavailable */ }
  }
});
shortWindow.addEventListener('change', () => setTranscriptClosed(shortWindow.matches ? true : trClosedTall));
setTranscriptClosed(shortWindow.matches ? true : trClosedTall);

init().catch((e) => showNotice(e.message, true));
