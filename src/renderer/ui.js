'use strict';
// Helpers shared by the overlay and the main window (plain scripts, no bundler).

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function call(channel, ...args) {
  const r = await window.api.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// Inline **bold** and `code`, built as DOM nodes so model output can never inject markup.
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

function inline(text, { links = true } = {}) {
  const frag = document.createDocumentFragment();
  const re = /\*\*([^*\n]+)\*\*|(`+)([^`\n]+)\2|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(h('strong', { text: m[1] }));
    else if (m[3] != null) frag.append(h('code', { text: m[3] }));
    else if (links) frag.append(h('a', { href: m[5], text: m[4], target: '_blank', rel: 'noreferrer', title: m[5] }), h('span', { class: 'host', text: ` (${hostOf(m[5])})` }));
    else frag.append(`${m[4]} (${hostOf(m[5])})`);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// Small Markdown renderer: headings, bullet and numbered lists, task items,
// code fences and paragraphs. `answer: true` also styles the "Verify:" and
// "Assuming:" lines the copilot uses. `onTask(index, done, text, control)` turns each task item into a real
// checkbox (index counts task items from 0 in the order they appear); without it the output is unchanged.
let taskSeq = 0;
function setTaskBox(control, done) {
  control.setAttribute('aria-checked', done ? 'true' : 'false');
  const box = control.firstChild;
  if (box) box.classList.toggle('on', Boolean(done));
}

function taskItem(raw, done, fmt, index, onTask) {
  const m = raw.match(/^(.*?)\s*\(done:\s*(\d{4}-\d{2}-\d{2})\)\s*$/);
  const text = m ? m[1] : raw, doneOn = m ? m[2] : '';
  const shown = text.replace(/\s*\(due:\s*not stated\)/i, ''); // "not stated" is not worth showing; the saved line keeps it
  const labelId = `task-${(taskSeq += 1)}`;
  const control = h('button', { type: 'button', class: 'tick', role: 'checkbox', 'aria-checked': done ? 'true' : 'false', 'aria-labelledby': labelId, dataset: { task: String(index) } }, h('span', { class: `box${done ? ' on' : ''}` }));
  control.addEventListener('click', () => { const next = control.getAttribute('aria-checked') !== 'true'; setTaskBox(control, next); onTask(index, next, text, control); });
  const when = doneOn ? new Date(`${doneOn}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  return h('li', { class: 'task' }, control, h('span', { class: 'tasktext', id: labelId }, fmt(shown)), doneOn && h('span', { class: 'taskdate', title: `Done on ${doneOn}`, text: when === 'Invalid Date' ? doneOn : `done ${when}` }));
}

function renderMarkdown(text, { answer = false, onTask = null } = {}) {
  let tasks = 0;
  const root = document.createDocumentFragment();
  const fmt = (t) => inline(t, { links: !answer });
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let list = null, para = [], code = null, fence = '';
  const flushPara = () => {
    if (!para.length) return;
    const p = h('p');
    para.forEach((l, i) => { if (i) p.append(h('br')); p.append(fmt(l)); });
    root.append(p); para = [];
  };
  const flushList = () => { if (list) { root.append(list); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code) {
      const c = line.match(/^\s*(`{3,}|~{3,})$/); if (c && c[1][0] === fence[0] && c[1].length >= fence.length) { root.append(h('pre', {}, h('code', { text: code.join('\n') }))); code = null; fence = ''; } else code.push(raw);
      continue;
    }
    const f = line.match(/^\s*(`{3,}|~{3,})(.*)$/); if (f && (f[1][0] === '~' || !f[2].includes('`'))) { flushPara(); flushList(); code = []; fence = f[1]; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { flushPara(); flushList(); root.append(h(`h${Math.min(6, head[1].length + 1)}`, {}, fmt(head[2]))); continue; }
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      if (!list) list = h('ul');
      const task = item[1].match(/^\[( |x|X)\]\s+(.*)$/);
      if (task && onTask) list.append(taskItem(task[2], task[1] !== ' ', fmt, tasks++, onTask));
      else if (task) list.append(h('li', { class: 'task' }, h('span', { class: `box${task[1] === ' ' ? '' : ' on'}` }), fmt(task[2])));
      else list.append(h('li', {}, fmt(item[1])));
      continue;
    }
    const flag = answer && line.match(/^(Verify|Assuming):\s*(.*)$/i);
    if (flag) { flushPara(); flushList(); root.append(h('p', { class: `flag ${flag[1].toLowerCase()}` }, h('b', { text: `${flag[1][0].toUpperCase()}${flag[1].slice(1).toLowerCase()} ` }), fmt(flag[2]))); continue; }
    flushList();
    para.push(line);
  }
  if (code) root.append(h('pre', {}, h('code', { text: code.join('\n') })));
  flushPara(); flushList();
  return root;
}

function money(v) { return v == null ? '' : v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`; }

function toast(message, kind = 'info', ms = 6000) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  if (document.body.classList.contains('one-toast')) host.replaceChildren(); // the main window shows one at a time
  const el = h('div', { class: `toast ${kind}` }, message, h('button', { class: 'x', text: '×', title: 'Dismiss', onclick: () => el.remove() }));
  host.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// A two-step button for something that cannot be undone: the first click changes its words to `armed` for a few
// seconds, the second click runs action(event). Leaving the button, Escape or the time running out puts it back.
function armClick(button, armed, action, ms = 4000) {
  let timer = null, saved = null;
  const first = button.getAttribute('aria-label');
  const reset = () => {
    if (!saved) return;
    clearTimeout(timer);
    button.replaceChildren(...saved); saved = null;
    button.classList.remove('armed');
    if (first == null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', first);
  };
  button.addEventListener('click', (e) => {
    if (!saved) {
      saved = [...button.childNodes];
      button.replaceChildren(armed);
      button.classList.add('armed'); button.setAttribute('aria-label', armed);
      timer = setTimeout(reset, ms);
      return;
    }
    reset(); action(e);
  });
  button.addEventListener('blur', reset);
  button.addEventListener('keydown', (e) => { if (e.key === 'Escape' && saved) { e.stopPropagation(); reset(); } });
  return button;
}

function accelLabel(a) { return String(a || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + '); }

// ---------------------------------------------------------------- icons
// Static line icons (24 x 24, drawn with the current text colour).
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 3v3M16 3v3"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  persona: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  screen: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  message: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6.5L7 21v-4H6a2 2 0 0 1-2-2z"/>',
  bulb: '<path d="M9 17.5h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17h.01"/>',
  rewind: '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4.5l3 1.8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
  send: '<path d="M5 12h13M12.5 6l6 6-6 6"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l3 3M14 9l2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7 14h10"/>',
  wave: '<path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10.5v3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h5.4a1.5 1.5 0 0 0 1.5-1.5L17 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
};

function icon(name, size = 16) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

// An on/off switch with a label.
function toggle(label, checked, onchange, hint) {
  const input = h('input', { type: 'checkbox', checked, role: 'switch', onchange: () => onchange(input.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }, h('span', { class: 'thumb' })), h('span', { class: 'lbl' }, label, hint && h('small', { text: hint })));
}

// A row of mutually exclusive choices. options: [[value, label, title?]].
function segmented(options, value, onchange, cls = '') {
  const el = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  const set = (v) => { let any = false; for (const b of el.children) { const on = b.dataset.v === v; if (on) any = true; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; } if (!any && el.firstElementChild) el.firstElementChild.tabIndex = 0; };
  for (const [v, label, title] of options) el.append(h('button', { type: 'button', role: 'radio', dataset: { v }, title, onclick: () => { set(v); onchange(v); } }, label));
  // Arrow keys move between the choices, as they do in a native radio group.
  el.addEventListener('keydown', (e) => {
    const bs = [...el.children];
    const i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const j = step ? (i + step + bs.length) % bs.length : e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : null;
    if (j == null) return;
    e.preventDefault(); bs[j].focus(); bs[j].click();
  });
  set(value);
  el.setValue = set;
  return el;
}

// Stable colour slot for a speaker label, so each voice keeps its colour.
function speakerSlot(label) {
  let n = 0;
  for (const ch of String(label)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const m = String(label).match(/(\d+)\s*$/);
  return m ? ((Number(m[1]) - 1) % 5 + 5) % 5 : n % 5;
}

function applyTheme(theme) {
  const resolved = theme === 'light' || theme === 'dark' ? theme : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = resolved;
}

// ---------------------------------------------------------------- dropdown menu
// popMenu(anchor, items, opts): a menu under a button, one at a time.
//   items: [{ type, id, label, desc, badge, checked, disabled, reason, pinned, icon, onSelect(item) }]
//     type: 'header' | 'separator' | 'note' (plain text) | 'radio' | 'check' | 'action'
//     desc is a muted second line; badge a small pill on the right; a disabled item stays focusable and
//     shows `reason` under it; `pinned` items sit in a footer that stays visible while a long list
//     scrolls; `id` lets update() keep the focused item.
//   opts: { label: accessible name, onClose() }
// Choosing an item closes the menu (focus back on the anchor) and then calls onSelect.
// Returns { el, anchor, closed, update(items), close(returnFocus = true) }, or null when the anchor's own
// menu was open (the click on the anchor closes it). It also closes on Escape, Tab, a click elsewhere,
// the window losing focus, scrolling and resizing. The look is in app.css (.pm).
const _pm = { cur: null };
function closeMenu(returnFocus = false) { if (_pm.cur) _pm.cur.close(returnFocus); }

function popMenu(anchor, items, opts = {}) {
  if (_pm.cur) { const same = _pm.cur.anchor === anchor; _pm.cur.close(false); if (same) return null; }
  const menu = h('div', { class: 'pm', role: 'menu', tabindex: '-1', 'aria-label': opts.label });
  const list = h('div', { class: 'pm-list', role: 'none' });
  const foot = h('div', { class: 'pm-foot', role: 'none' });
  menu.append(list, foot);
  let els = [], typed = '', typedAt = 0;
  const ctl = { el: menu, anchor, closed: false, update, close };

  function row(it) {
    const checkable = it.type === 'radio' || it.type === 'check';
    const b = h('button', { type: 'button', class: `pm-item ${it.type}`, role: it.type === 'radio' ? 'menuitemradio' : it.type === 'check' ? 'menuitemcheckbox' : 'menuitem', tabindex: '-1' });
    if (checkable) b.setAttribute('aria-checked', it.checked ? 'true' : 'false');
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.id) b.dataset.pmid = it.id;
    b.append(...[
      checkable ? h('span', { class: 'pm-ind', 'aria-hidden': 'true' }, it.type === 'check' ? icon('check', 12) : null) : h('span', { class: 'pm-ico', 'aria-hidden': 'true' }, it.icon ? icon(it.icon, 15) : null),
      h('span', { class: 'pm-txt' }, h('span', { class: 'pm-lbl', text: it.label }), it.desc && h('span', { class: 'pm-desc', text: it.desc }), it.disabled && it.reason && h('span', { class: 'pm-reason', text: it.reason })),
      it.badge && h('span', { class: 'pm-badge', text: it.badge })].filter(Boolean));
    b.addEventListener('click', () => { if (it.disabled) return; close(true); if (it.onSelect) it.onSelect(it); });
    b.addEventListener('mousemove', () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); }); // one highlight, not hover plus focus
    return b;
  }

  function build(all) {
    const top = [], bottom = [];
    for (const it of all) {
      const into = it.pinned ? bottom : top;
      if (it.type === 'separator') into.push(h('div', { class: 'pm-sep', role: 'separator' }));
      else if (it.type === 'header') into.push(h('div', { class: 'pm-head', role: 'presentation', text: it.label }));
      else if (it.type === 'note') into.push(h('div', { class: 'pm-note', role: 'presentation', text: it.label }));
      else into.push(row(it));
    }
    list.replaceChildren(...top); foot.replaceChildren(...bottom); foot.hidden = !bottom.length;
    els = [...menu.querySelectorAll('.pm-item')];
  }

  // Under the anchor with the left edges aligned; shifted left, or above, when it would leave the window.
  function place() {
    const pad = 8, gap = 5;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const r = anchor.getBoundingClientRect();
    menu.style.maxHeight = 'none'; menu.style.left = '0px'; menu.style.top = '0px';
    menu.style.maxWidth = `${Math.min(380, vw - 2 * pad)}px`;
    menu.style.minWidth = `${Math.min(Math.max(r.width, 270), vw - 2 * pad)}px`;
    const w = menu.offsetWidth, natural = menu.offsetHeight;
    menu.style.left = `${Math.max(pad, Math.min(r.left, vw - pad - w))}px`;
    const below = vh - r.bottom - gap - pad, above = r.top - gap - pad;
    if (natural <= below || below >= above) { menu.style.top = `${r.bottom + gap}px`; menu.style.maxHeight = `${Math.max(80, below)}px`; }
    else { const hgt = Math.min(natural, Math.max(80, above)); menu.style.maxHeight = `${hgt}px`; menu.style.top = `${r.top - gap - hgt}px`; }
  }

  function update(all) {
    if (ctl.closed) return;
    const had = menu.contains(document.activeElement);
    const at = els.indexOf(document.activeElement), id = at >= 0 ? els[at].dataset.pmid : undefined, top = list.scrollTop;
    build(all); place();
    list.scrollTop = top;
    if (had) { const keep = (id && els.find((e) => e.dataset.pmid === id)) || els[Math.min(Math.max(at, 0), els.length - 1)]; if (keep) keep.focus({ preventScroll: true }); else menu.focus(); }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === 'Tab') { close(true); return; } // focus is back on the anchor, so the Tab carries on from there
    if (e.ctrlKey || e.metaKey || e.altKey || !els.length) return;
    const at = els.indexOf(document.activeElement);
    let to = null;
    if (e.key === 'ArrowDown') to = at < 0 ? 0 : (at + 1) % els.length;
    else if (e.key === 'ArrowUp') to = at < 0 ? els.length - 1 : (at + els.length - 1) % els.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = els.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key)) { // type the first letters of an item to jump to it
      const now = Date.now(); typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase(); typedAt = now;
      const order = [...els.slice(at + 1), ...els.slice(0, at + 1)];
      const hit = order.find((b) => b.querySelector('.pm-lbl').textContent.toLowerCase().startsWith(typed));
      if (hit) to = els.indexOf(hit);
    }
    if (to == null) return;
    e.preventDefault(); e.stopPropagation(); els[to].focus();
  }
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(false); }; // the anchor's own click toggles
  const onScroll = (e) => { if (!menu.contains(e.target)) close(false); };
  const onAway = () => close(false);

  function close(returnFocus = true) {
    if (ctl.closed) return;
    ctl.closed = true;
    if (_pm.cur === ctl) _pm.cur = null;
    document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onAway); window.removeEventListener('blur', onAway);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus && anchor.isConnected) anchor.focus();
    if (opts.onClose) opts.onClose();
  }

  build(items);
  document.body.append(menu);
  place();
  _pm.cur = ctl;
  anchor.setAttribute('aria-expanded', 'true');
  if (!anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-haspopup', 'menu');
  document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDown, true); document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onAway); window.addEventListener('blur', onAway);
  const first = els.find((b) => b.classList.contains('radio') && b.getAttribute('aria-checked') === 'true' && !b.hasAttribute('aria-disabled')) || els.find((b) => !b.hasAttribute('aria-disabled')) || els[0];
  (first || menu).focus();
  return ctl;
}
