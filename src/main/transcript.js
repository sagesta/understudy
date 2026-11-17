'use strict';
const { tokenize, Bm25Index } = require('./knowledge/bm25');

const MERGE_GAP_MS = 2500;
// A turn stops growing at about 80 to 90 seconds of speech (150 words a minute is roughly 900
// characters a minute): past either limit the same voice starts a new turn. Without a limit one
// presentation is one turn of tens of thousands of characters, and everything that reads the whole
// turn (analysis, answer requests, autosave, redraws) grows with it. The cut falls between two results.
const TURN_MAX_CHARS = 1200;
const TURN_MAX_MS = 90000;
const grown = (t, at) => t.text.length > TURN_MAX_CHARS || at - t.t > TURN_MAX_MS;
// A short "yeah" or "mm-hmm" from someone else does not end the speaker's
// sentence: when they carry on, their words rejoin the turn from before it.
const INTERJECTION_MAX_WORDS = 3;  // a turn this short, from anyone, counts as an interjection
const INTERJECTIONS_SPANNED = 2;   // ...and a speaker may carry on across at most this many of them
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
function wordCount(s) {
  const str = String(s == null ? '' : s);
  const cjk = str.match(CJK_RE);
  if (!cjk) return str.split(/\s+/).filter(Boolean).length;
  const rest = str.replace(CJK_RE, ' ').replace(/[\p{P}\p{S}]+/gu, ' ');
  return cjk.length + rest.split(/\s+/).filter(Boolean).length;
}
const SHORT_QUESTION_RE = /[?？\u061F\u037E\u00BF]|\b(?:what|why|how|when|where|who|whose|which|blockers|thoughts|concerns|questions|status|eta)\b/i;
const isInterjectionTurn = (t) => !t.gap && wordCount(t.text) <= INTERJECTION_MAX_WORDS && !SHORT_QUESTION_RE.test(t.text);
const normSpeakerCompare = (s) => String(s == null ? '' : s).normalize('NFC').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

// The end of `text`: at most `max` characters (counting `mark`, which leads a cut text), starting
// where a sentence starts. A text with no sentence end in reach is cut at a word and led by "…".
function tailFromSentence(text, max, mark = '') {
  text = String(text);
  if (text.length <= max) return text;
  const budget = Math.max(1, max - mark.length);
  const from = text.length - budget;
  const re = /[.?!]["')\]]*\s+/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (m && m.index + m[0].length < text.length) return mark + text.slice(m.index + m[0].length);
  const room = Math.max(1, max - 1);
  const word = text.indexOf(' ', text.length - room);
  return '…' + text.slice(word < 0 ? text.length - room : word + 1);
}

function pad(n) { return String(n).padStart(2, '0'); }
function clock(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

// True when `text` (heard on the microphone) is just the meeting audio being
// picked up from the speakers. Compares against what the system channel
// produced in the last few seconds.
function isEcho(text, recentThem) {
  const a = new Set(tokenize(text));
  const plain = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // A short reply ("Option B.", "Yes, use Terraform.") is not judged by shared
  // words: only a near-verbatim repeat of what was just heard counts as echo.
  if (a.size < 5) return plain.length > 12 && recentThem.some((r) => r.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').includes(plain));
  for (const r of recentThem) {
    const b = new Set(tokenize(r));
    if (!b.size) continue;
    let common = 0;
    for (const t of a) if (b.has(t)) common++;
    if (common / a.size >= 0.8) return true;
  }
  return false;
}

// A speaker name typed by a person (or suggested by the model) becomes part of
// the saved Markdown and of prompts, so it is kept short and free of anything
// that could break the "**[time] Name:**" line format. '' means "no name".
function cleanSpeakerName(name) {
  return String(name == null ? '' : name)
    .replace(/\s+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\p{Cf}/gu, '') // zero-width characters, bidi overrides and the like
    .replace(/[*\[\]:#_`<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(.{40}).*$/su, '$1') // 40 characters, not 40 UTF-16 units: no half an emoji
    .trim();
}

class Transcript {
  // `myNames`: the person's own name and aliases, which no other voice may be given (see setName).
  constructor({ myLabel = 'Me', echoFilter = true, myNames = [] } = {}) {
    this.myNames = (Array.isArray(myNames) ? myNames : []).filter((x) => typeof x === 'string' && x.trim());
    this.turns = [];
    this.names = new Map(); // speakerKey -> name chosen by the user
    this.myLabel = myLabel;
    this.echoFilter = echoFilter;
    this.partials = { me: '', them: '' };
    this._recentThem = []; // [{ t, text }]
    this._seq = 0;
    this.themLabels = new Set(); // every diarized label a 'them' turn has carried (not 'Them', names, or gap markers)
    this.epochLabels = new Map(); // epoch -> Set of diarized labels heard in that connection
  }

  setPartial(channel, text) {
    this.partials[channel] = text || '';
    if (channel === 'them' && text) this._noteThem(text, true, Date.now());
  }

  _noteThem(text, partial, at) {
    this._recentThem = this._recentThem.filter((r) => at - r.t < 4000 && !(partial && r.partial));
    this._recentThem.push({ t: at, text, partial });
  }

  // Returns { turn, merged } or null when the text was dropped as echo.
  // `epoch` ("<openSeq>.<connection>") says which provider connection the
  // speaker label belongs to: Deepgram numbers speakers afresh on every
  // connection, so "Speaker 1" in two epochs is not assumed to be one person.
  // `gap` marks a note that speech was skipped: it is always a turn of its own, never merges
  // either way, takes the channel's default label and is not a voice.
  addFinal(channel, text, speaker, at = Date.now(), epoch = '0.0', { gap = false } = {}) {
    // One line: a provider that sends newlines must not be able to start a fake heading or turn in the saved file.
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    this.partials[channel] = '';
    if (gap) {
      const label = channel === 'me' ? this.myLabel : 'Them';
      const turn = { id: ++this._seq, t: at, end: at, channel, speaker: label, speakerKey: `gap:${channel}`, label, text: clean, gap: true };
      this.turns.push(turn);
      return { turn, merged: false };
    }
    if (channel === 'them') this._noteThem(clean, false, at);
    // Echo reaches the microphone within a couple of seconds of being heard;
    // anything older is the user's own speech.
    if (channel === 'me' && this.echoFilter && isEcho(clean, this._recentThem.filter((r) => at - r.t < 3000).map((r) => r.text))) return null;

    const label = channel === 'me' ? this.myLabel : (speaker || 'Them');
    const speakerKey = channel === 'me' ? 'me' : `${epoch}:${label}`;
    const last = this.turns[this.turns.length - 1];
    if (last && last.channel === channel && last.speakerKey === speakerKey && at - last.end < MERGE_GAP_MS && !grown(last, at)) {
      last.text += ' ' + clean;
      last.end = at;
      return { turn: last, merged: true };
    }
    // The same voice carrying on after a short interjection by someone else
    // (any channel): the words go back into the turn they continue, and the
    // interjection stays where it was said. The earlier turn's end moves on,
    // which is also what lets a third piece rejoin it past the same interjection.
    const before = this._beforeInterjections(channel, speakerKey, at);
    if (before) {
      before.text += ' ' + clean;
      before.end = at;
      return { turn: before, merged: true };
    }
    const display = (channel !== 'me' && this.names.get(speakerKey)) || label;
    const turn = { id: ++this._seq, t: at, end: at, channel, speaker: display, speakerKey, label, text: clean };
    this.turns.push(turn);
    if (channel === 'them' && label !== 'Them') {
      this.themLabels.add(label);
      let set = this.epochLabels.get(epoch);
      if (!set) { set = new Set(); this.epochLabels.set(epoch, set); }
      set.add(label);
    }
    return { turn, merged: false };
  }

  isOneToOne() {
    if (this.themLabels.size !== 1) return false;
    for (const set of this.epochLabels.values()) if (set.size > 1) return false;
    const distinctNames = new Set();
    for (const n of this.names.values()) { const k = normSpeakerCompare(n); if (k) distinctNames.add(k); }
    return distinctNames.size <= 1;
  }

  // The turn this voice was speaking before the last one or two interjections,
  // when it is still close enough in time to be the same sentence; else null.
  _beforeInterjections(channel, speakerKey, at) {
    const turns = this.turns;
    let i = turns.length - 1, spanned = 0;
    while (i >= 0 && spanned < INTERJECTIONS_SPANNED && turns[i].speakerKey !== speakerKey && isInterjectionTurn(turns[i])) { i--; spanned++; }
    const t = turns[i];
    return spanned && t && t.channel === channel && t.speakerKey === speakerKey && at - t.end < MERGE_GAP_MS && !grown(t, at) ? t : null;
  }

  // Name (or, with '', un-name) one voice. Past turns are rewritten so the
  // transcript, prompts and saved file all agree. Returns the changed turns.
  setName(key, name) {
    if (key === 'me') throw new Error('Your own name is set in Settings.');
    if (!this.turns.some((t) => t.speakerKey === key && !t.gap)) throw new Error('That speaker is not in this meeting.');
    const clean = cleanSpeakerName(name);
    // Another voice under the person's own name could not be told from them. (Another voice's name is allowed:
    // two labels for one person are joined that way.)
    if (clean && this.myNames.some((n) => normSpeakerCompare(n) === normSpeakerCompare(clean))) throw new Error('That is your own name. Choose another.');
    if (clean) this.names.set(key, clean); else this.names.delete(key);
    const changed = [];
    for (const t of this.turns) {
      if (t.speakerKey !== key) continue;
      const display = clean || t.label;
      if (t.speaker !== display) { t.speaker = display; changed.push(t); }
    }
    return changed;
  }

  // Every voice heard on the meeting audio, in order of first appearance.
  speakerList() {
    const out = new Map();
    for (const t of this.turns) {
      if (t.speakerKey === 'me' || t.gap) continue;
      let e = out.get(t.speakerKey);
      if (!e) {
        e = { key: t.speakerKey, label: t.label, name: this.names.get(t.speakerKey) || '', display: '', turns: 0, firstAt: t.t, epoch: t.speakerKey.slice(0, t.speakerKey.indexOf(':')) };
        out.set(t.speakerKey, e);
      }
      e.turns++;
      e.display = e.name || e.label;
    }
    return [...out.values()];
  }

  speakers() { return [...new Set(this.turns.filter((t) => !t.gap).map((t) => t.speaker))]; }

  // Most recent turns that fit in maxChars, oldest first, for the prompt.
  forPrompt(opts) { return this.window(opts).text; }

  // The same, with `first`: where the oldest turn in the text sits (turns.length when none is in it),
  // so a caller can tell which turns the text already holds.
  window({ maxChars = 9000, sinceMs = 0, includePartials = true } = {}) {
    const lines = [];
    let used = 0, turnLines = 0, first = this.turns.length;
    if (includePartials) {
      for (const ch of ['them', 'me']) {
        if (!this.partials[ch]) continue;
        const head = `[now] ${ch === 'me' ? this.myLabel : 'Them'} (still speaking): `;
        const line = head + tailFromSentence(this.partials[ch], Math.max(100, Math.floor(maxChars / 4) - head.length), '…');
        lines.push(line); used += line.length;
      }
    }
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (sinceMs && t.end < sinceMs) continue; // not "break": a turn that carried on past an interjection ends later than the turn after it
      let line = `[${clock(t.t)}] ${t.speaker}: ${t.text}`;
      if (used + line.length > maxChars) {
        if (turnLines) break;
        // The newest turn alone is too long: keep its end, so the latest words are always there.
        const head = `[${clock(t.t)}] ${t.speaker}: `;
        line = head + tailFromSentence(t.text, Math.max(100, maxChars - used - head.length), '…');
      }
      lines.push(line); used += line.length; turnLines++; first = i;
    }
    return { text: lines.reverse().join('\n'), first };
  }

  toMarkdown() {
    return this.turns.map((t) => `**[${clock(t.t)}] ${t.speaker}:** ${t.text}`).join('\n\n');
  }

  toPlain() {
    return this.turns.map((t) => `[${clock(t.t)}] ${t.speaker}: ${t.text}`).join('\n');
  }
}

// ---------- recall: what was said earlier in the meeting ----------
// An answer request holds the recent stretch of the transcript. This finds the few older turns that
// relate to the question, so "what did we agree about the rollback earlier?" can be answered two hours in.
// The whole transcript is never sent: at most RECALL_MAX_TURNS turns and RECALL_MAX_CHARS characters.
const RECALL_MAX_TURNS = 4;
const RECALL_MAX_CHARS = 2400;   // the selected lines together, about 10% of the 24,000-character request
const RECALL_TURN_CHARS = 600;   // one turn is quoted up to this long, around its best sentence
const RECALL_REPLY_CHARS = 300;  // the turn after a match is added whole when it is by someone else and this short
// Relevance is the summed idf of the question's words that a turn shares. idf is about ln(N / turns
// holding the word), so the sum measures how unlikely it is that a turn has those words by chance:
// at the bar below only a few turns of a four-hour meeting would match by luck, and the best of
// them has to be a good match as well. A word found in a handful of turns clears it alone; common
// words need company. A long question (or the recent talk, which stands in for one
// when an action has none) has many words, some of which any old turn shares by chance, so the bar
// also rises to a fifth of the question's whole weight.
const RECALL_STRENGTH = 0.8;     // times ln(turns indexed)
const RECALL_SHARE = 0.2;
const RECALL_LOOSE = 2;          // times the bar, and the share of the weight, for recent talk standing in for a question: a rare word in common is not a topic
const RECALL_COMMON = 2;         // words with a lower idf (in more than about one turn in seven) say nothing and are the costliest to look up: left out
const RECALL_QUERY_WORDS = 10;   // a long question or a stretch of recent talk is looked up by its rarest words: they decide, and have the shortest lookups
const RECALL_CANDIDATES = 24;    // how many matches beyond the recent window are looked at
const RECALL_SETTLED_TURNS = 3;  // a turn can still grow while it is among the last three (itself and two interjections)
const RECALL_CHECK_TAIL = 8;     // how many of the newest indexed turns are re-checked on every result

class MeetingRecall {
  constructor(transcript) {
    this.transcript = transcript;
    this.index = new Bm25Index();
    this.docs = [];   // doc number -> { turn, pos, len } (null once replaced): the turn itself, so its label is read when used
    this.next = 0;    // turns before this position have been looked at
  }

  // Index the turns that can no longer change: not among the last few, and past the merge gap. Cheap
  // enough to run on every transcript result (one tokenisation of one turn, usually).
  sync(now = Date.now()) {
    const turns = this.transcript.turns;
    this._refresh(Math.max(0, this.docs.length - RECALL_CHECK_TAIL));
    const limit = turns.length - RECALL_SETTLED_TURNS;
    while (this.next < limit) {
      const t = turns[this.next];
      if (now - t.end < MERGE_GAP_MS) break;
      this._add(t, this.next++);
    }
  }

  _add(t, pos) {
    if (t.gap) return; // a note that speech was skipped is not speech
    const tokens = tokenize(t.text);
    if (!tokens.length) return;
    this.docs[this.index.add(tokens)] = { turn: t, pos, len: t.text.length };
  }

  // A turn that changed after it was indexed (it should not, but a turn carried on across an
  // interjection or loaded from an older file might) is indexed again from its present words.
  _refresh(from = 0) {
    for (let i = from; i < this.docs.length; i++) {
      const e = this.docs[i];
      if (!e || e.len === e.turn.text.length) continue;
      this.index.remove(i);
      this.docs[i] = null;
      this._add(e.turn, e.pos);
    }
    // Removed documents leave their postings behind: start afresh once they outnumber the live ones.
    if (this.index.dead.size > 64 && this.index.dead.size > this.index.size) {
      const live = this.docs.filter(Boolean);
      this.index = new Bm25Index();
      this.docs = [];
      for (const e of live) this._add(e.turn, e.pos);
    }
  }

  _inOlder(postings, first) {
    for (let i = 0; i < postings.length; i += 2) {
      const doc = postings[i];
      if (this.index.dead.has(doc)) continue;
      const e = this.docs[doc];
      if (e && e.pos < first) return true;
    }
    return false;
  }

  // A selection made for recent talk standing in for a question (held to twice the bar) found something
  // real. Other older turns on the same matter, at the ordinary bar, belong with it: the figure an old reply
  // confirmed may have been corrected since, and the correction shares most of its words with the recent talk
  // but not the reply's own. They have to share a rare word with a turn already picked, so the extra bar
  // lowers nothing for turns that merely resemble the talk. Newest first (a correction beats the old
  // reply, whichever fits when the budgets bite), then back in time order by the caller. Nothing here runs
  // when nothing cleared the higher bar.
  _withRelated(found, st, { first, shared, normalBar }) {
    const turns = this.transcript.turns;
    const N = this.index.size;
    const linked = new Set();
    for (const pos of st.chosen.keys()) {
      for (const t of new Set(tokenize(turns[pos].text))) {
        const df = this.index.df.get(t) || 0;
        if (df > 0 && Math.log(1 + Math.max(0, N - df + 0.5) / (df + 0.5)) >= RECALL_COMMON) linked.add(t);
      }
    }
    if (!linked.size) return;
    const extra = [];
    for (const h of found) {
      const e = this.docs[h.doc];
      if (!e || e.pos >= first || st.chosen.has(e.pos) || shared[h.doc] < normalBar) continue;
      if (tokenize(e.turn.text).some((t) => linked.has(t))) extra.push(e.pos);
    }
    if (!extra.length) return;
    const group = [...new Set([...st.chosen.keys(), ...extra])].sort((a, b) => b - a);
    const wasWhole = new Set(st.wholes);
    st.wholes.clear();
    st.reset();
    for (const pos of group) if (!st.take(pos, wasWhole.has(pos))) { if (st.chosen.size >= RECALL_MAX_TURNS) break; }
  }

  // The turns to show above the recent part, as ready lines: { text, turns }, or null when nothing
  // clears the bar. `first` is the position of the oldest turn already in the recent part (those are
  // never chosen); `query` is the question, or, with `loose`, the recent talk standing in for one.
  select({ query, loose = false, first }) {
    const turns = this.transcript.turns;
    if (!this.index.size || first <= 0) return null;
    this._refresh(0);
    const qt = tokenize(query);
    const N = this.index.size;
    const idf = new Map();
    for (const t of new Set(qt)) {
      const p = this.index.postings.get(t);
      const df = this.index.df.get(t) || 0;
      const w = df > 0 ? Math.log(1 + Math.max(0, N - df + 0.5) / (df + 0.5)) : 0;
      // A word is only worth looking up if some turn before the recent part has it.
      if (w >= RECALL_COMMON && p && this._inOlder(p, first)) idf.set(t, w);
    }
    if (!idf.size) return null;
    if (idf.size > RECALL_QUERY_WORDS) for (const [t] of [...idf].sort((a, b) => b[1] - a[1]).slice(RECALL_QUERY_WORDS)) idf.delete(t);
    let weight = 0;
    for (const w of idf.values()) weight += w;
    const k = loose ? RECALL_LOOSE : 1;
    const normalBar = Math.max(RECALL_STRENGTH * Math.log(N + 1), RECALL_SHARE * weight);
    const bar = normalBar * k;
    // How much of the question's weight each turn shares: one pass over the postings of its words.
    const shared = new Float64Array(this.docs.length);
    for (const [t, w] of idf) {
      const p = this.index.postings.get(t);
      for (let i = 0; i < p.length; i += 2) {
        const doc = p[i];
        if (!this.index.dead.has(doc) && doc < shared.length) shared[doc] += w;
      }
    }
    // Ranked by BM25; the turns of the recent part are in the index too, so look past them.
    const found = this.index.search(qt.filter((t) => idf.has(t)), Math.min(N, RECALL_CANDIDATES + turns.length - first));
    const chosen = new Map(); // position -> text shown
    let chars = 0;
    const wholes = new Set(); // positions shown whole (the reply to a match)
    const take = (pos, whole) => {
      const t = turns[pos];
      const head = `[${clock(t.t)}] ${t.speaker}: `;
      const room = Math.min(RECALL_TURN_CHARS, RECALL_MAX_CHARS - chars - head.length - 1);
      if (chosen.size >= RECALL_MAX_TURNS || room < (whole ? 1 : 120)) return false;
      const body = whole ? t.text : around(t.text, idf, room);
      if (body.length > room) return false;
      chosen.set(pos, body);
      if (whole) wholes.add(pos);
      chars += head.length + body.length + 1;
      return true;
    };
    for (const h of found) {
      const e = this.docs[h.doc];
      if (!e || e.pos >= first || chosen.has(e.pos) || shared[h.doc] < bar) continue;
      if (!take(e.pos, false)) { if (chosen.size >= RECALL_MAX_TURNS) break; continue; }
      // The reply to a question often carries the fact.
      const r = turns[e.pos + 1];
      if (r && e.pos + 1 < first && !r.gap && r.speakerKey !== e.turn.speakerKey && r.text.length <= RECALL_REPLY_CHARS && wordCount(r.text) >= 2 && !chosen.has(e.pos + 1)) take(e.pos + 1, true);
    }
    if (loose && chosen.size) this._withRelated(found, { chosen, wholes, take, reset: () => { chosen.clear(); chars = 0; } }, { first, shared, normalBar });
    if (!chosen.size) return null;
    // Back in the order they were said; the label is read now, so a renamed speaker shows the new name.
    const lines = [...chosen.keys()].sort((a, b) => a - b).map((pos) => `[${clock(turns[pos].t)}] ${turns[pos].speaker}: ${chosen.get(pos)}`);
    return { text: lines.join('\n'), turns: lines.length };
  }
}

// `text` cut to at most `max` characters around its best sentence: the sentence that shares the most
// weight with the question, then its neighbours while they fit. Cuts are marked with "…".
function around(text, weights, max) {
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.?!]["')\]]*)\s+/);
  const score = sentences.map((s) => { let n = 0; for (const t of new Set(tokenize(s))) n += weights.get(t) || 0; return n; });
  let best = 0;
  for (let i = 1; i < sentences.length; i++) if (score[i] > score[best]) best = i;
  let lo = best, hi = best, len = sentences[best].length;
  if (len > max - 2) {
    // One long sentence: cut at words, a little before the first word that matters.
    const s = sentences[best];
    const at = Math.max(0, ...[...weights.keys()].map((t) => s.toLowerCase().indexOf(t)).filter((x) => x >= 0).sort((a, b) => a - b).slice(0, 1));
    let from = Math.max(0, at - Math.floor(max / 4));
    if (from > 0) { const w = s.indexOf(' ', from); from = w < 0 ? from : w + 1; }
    let to = Math.min(s.length, from + max - 2);
    if (to < s.length) { const w = s.lastIndexOf(' ', to); to = w > from ? w : to; }
    return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`;
  }
  for (;;) {
    const before = lo > 0 ? sentences[lo - 1].length + 1 : Infinity, after = hi < sentences.length - 1 ? sentences[hi + 1].length + 1 : Infinity;
    // Grow towards the neighbour that matters more (the one after, when equal): what follows a statement often completes it.
    const next = (hi < sentences.length - 1 ? score[hi + 1] : -1) >= (lo > 0 ? score[lo - 1] : -1) ? 'after' : 'before';
    const add = next === 'after' ? after : before;
    if (add === Infinity || len + add + 2 > max) {
      const other = next === 'after' ? before : after;
      if (other === Infinity || len + other + 2 > max) break;
      if (next === 'after') { lo--; len += before; } else { hi++; len += after; }
      continue;
    }
    if (next === 'after') { hi++; len += after; } else { lo--; len += before; }
  }
  return `${lo > 0 ? '…' : ''}${sentences.slice(lo, hi + 1).join(' ')}${hi < sentences.length - 1 ? '…' : ''}`;
}

module.exports = { Transcript, MeetingRecall, isEcho, clock, cleanSpeakerName, tailFromSentence, wordCount, MERGE_GAP_MS, TURN_MAX_CHARS, TURN_MAX_MS, RECALL_MAX_TURNS, RECALL_MAX_CHARS };
