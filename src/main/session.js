'use strict';
const { EventEmitter } = require('node:events');
const { Transcript, MeetingRecall, cleanSpeakerName, tailFromSentence, wordCount } = require('./transcript');
const { analyzeTurn, splitSentences, classify, MODES } = require('./triggers');
const { systemPrompt, userPromptParts, ACTIONS } = require('./prompts');
const { isOrgQuestion } = require('./org-question');
const { claimsAboutUs } = require('./claims');
const { createStream, billedMinutes, PROVIDERS: STT } = require('./stt');
const { newMeta, hm } = require('./meetings/store');
const { buildNamePrompt, parseNameSuggestions } = require('./speaker-names');
const { tokenize } = require('./knowledge/bm25');
const { samePath } = require('./knowledge/library');

const AUTO_SETTLE_MS = 900;   // wait this long after a question for the speaker to finish
const AUTO_MAX_WAIT_MS = 3500;
// Name suggestions run rarely: a check costs a model call, and names only come up in introductions.
const NAME_CHECK_EVERY_MS = 45000; // at most one check this often
const NAME_CHECK_MIN_TURNS = 4;    // ...and only after this many new turns from the other side
const NAME_CHECK_MAX = 25;         // ...and at most this many per meeting
const NAME_WINDOW_TURNS = 40;      // how much of the conversation each check reads
const SPEAKER_RESTART_HINT = 'Speaker numbers restart after a pause, so name the speakers again if the labels have changed.';
// A question the app chose not to answer stays on offer this long.
const PASSED_LIFE_MS = 30000;
// "Straight after you spoke": the other person's turn began within this long of your last one ending.
const AFTER_ME_MS = 20000;
// Two people asking at once each get an answer; a third question replaces the older of the two.
const MAX_AUTO_ANSWERS = 2;
// A turn this short, from anyone, is an interjection ("mm-hmm", "okay right"). What the user said
// before "straight after you spoke" must be more than that.
const INTERJECTION_WORDS = 3;
const AFTER_ME_MIN_WORDS = 4;
// Analysis reads the end of a turn, from the start of a sentence: a turn is capped in size by the
// transcript, but nothing here should depend on that.
const ANALYSE_CHARS = 1500;
const UNFINISHED_CHARS = 600;  // how much of the previous turn's last unfinished sentence is carried over a cut
// What an answer request quotes of the question: the end of it, from a sentence start.
const ASK_MAX_CHARS = 500;
// A question's key is remembered for as long as its turn can still grow: a turn grows only while it
// is among the last few (itself plus at most two interjections), so keys of older turns are forgotten.
const ASK_MEMORY_TURNS = 6;
// Anyone in the meeting can make the app call the model by asking questions without pause. At most
// this many automatic answers in any rolling minute; a question beyond that is offered, not answered.
const AUTO_LIMIT = 6;
const AUTO_WINDOW_MS = 60000;
// A question put to the user (by name, handed over, or straight after they spoke) is the one thing
// the app must not stay silent about, so those have a higher cap of their own, counted apart from the others. It still bounds the model calls one
// participant can cause.
const AUTO_LIMIT_YOU = 12;
// A turn by the same voice that starts this soon after one that ended mid-sentence carries that
// sentence on: "What do you think about" ... "moving the deploy to Thursday?".
const OPEN_SENTENCE_GAP_MS = 8000;
// How much of the transcript an answer request holds, selection from earlier in the meeting included.
const PROMPT_CHARS = 24000;
// The actions that answer something may look back over the whole meeting. Not catchup (the last few
// minutes, by definition) and not proactive (it reads the last part of the conversation, and a
// background check should not go digging).
const RECALL_ACTIONS = new Set(['answer', 'say', 'take', 'followup', 'screen', 'ask']);
const EARLIER_MARK = '[Earlier in this meeting, selected because it relates to the question]';
const RECENT_MARK = '[Most recent part of the meeting]';
// A file is named on a card ("from your files") only when it really helped: the actions that answer something, a
// question of at least this many distinct terms, and a passage that matched at least this many of them and scores at
// least this share of the best passage's score. The prompt still gets every hit; this only decides the chip.
const FILE_ACTIONS = new Set(['answer', 'ask', 'say', 'take', 'screen']);
const FILE_MIN_QUERY_TERMS = 3;
const FILE_MIN_MATCHED = 2;
const FILE_MIN_SCORE_SHARE = 0.4;
// Web-search notes say something about the key or the model, not about one answer: shown once in a meeting.
const ONCE_PER_MEETING = /^Web search is not /;
// Only a question put to the user can ask for a company fact, so only these get the guard against invented ones.
const GUARDED_ACTIONS = new Set(['answer', 'ask']);
const HOLDING_NOTE = 'Not in your files or the meeting: a holding line.';
const DEFERRAL_RE = /\b(?:in front of (?:me|us)|(?:to|on|at) hand|let me (?:check|find out|look|confirm)|i'?ll (?:check|find out|confirm|get back|come back|look)|come back to you|get back to you|off the top of my head|off ?hand|don'?t know yet|not sure (?:yet|off)|check with|i can (?:check|look|confirm))\b/i;
// A safety net after the fact: an answer that says how the user's own organisation does things, with no strong file behind it,
// is marked (card.check) so the overlay tells the owner to check it before saying it. Not for a recap, a screen or a background check.
const CHECK_ACTIONS = new Set(['answer', 'ask', 'say', 'take', 'followup']);
function strongFiles(hits, query) {
  if (!hits.length || new Set(tokenize(query)).size < FILE_MIN_QUERY_TERMS) return [];
  const top = Math.max(...hits.map((h) => h.score || 0));
  const files = hits.filter((h) => (h.matched || 0) >= FILE_MIN_MATCHED && (h.score || 0) >= top * FILE_MIN_SCORE_SHARE).map((h) => h.rel);
  return [...new Set(files)].slice(0, 4);
}
const wordsIn = wordCount;
const normaliseMode = (m) => (MODES.includes(m) ? m : 'questions');

// One running meeting: audio in, transcript out, answer cards generated on
// questions, hotkeys and timers.
//
// Events (all carry a plain object):
//   state, partial, turn, card, card-delta, card-done, card-remove, mention, error, cost,
//   speakers, speaker-suggestion, speaker-suggestion-clear, hint,
//   passed, passed-clear
class MeetingSession extends EventEmitter {
  constructor({ settings, library, store, llm, getProfile, getPersonality, sttBaseUrl }) {
    super();
    this.settings = settings;
    this.library = library;
    this.store = store;
    this.llm = llm;
    this.getProfile = getProfile;
    this.getPersonality = getPersonality;
    this.sttBaseUrl = sttBaseUrl;
    this.active = false;
    this.stopping = false;     // the streams are being flushed; finals are still accepted
    this.idleWarned = false;
    this.paused = false;
    this.meta = null;
    this.transcript = null;
    this.recall = null;        // the search over this meeting's earlier turns: made at start, dropped at stop
    this.streams = {};
    this.cards = new Map();
    this.cardSeq = 0;
    this._notesShown = new Set(); // the once-per-meeting card notes already shown (see ONCE_PER_MEETING)
    this.autoCard = null;      // the newest automatic answer
    this.autoCards = [];       // [{ card, speakerKey }]: automatic answers being written, oldest first
    this.pendingAuto = new Map(); // turn id -> { analysis, turn, first, timer }: questions waiting to settle
    this.recentAsks = new Map();  // question key -> { at, turnId }
    this.autoLimit = AUTO_LIMIT;  // tunable so tests need not wait
    this.autoLimitYou = AUTO_LIMIT_YOU; // the same, for questions put to the user
    this.autoWindowMs = AUTO_WINDOW_MS;
    this._autoTimes = [];         // when the automatic answers of the last minute started (room and other questions)
    this._autoTimesYou = [];      // ...and those to the user
    this.lastAutoAt = 0;
    this.proactiveTimer = null;
    this.proactiveMark = 0;
    this.cost = { llm: 0, llmKnown: true, inputTokens: 0, outputTokens: 0, sttMinutes: 0, stt: 0 };
    this.sttElapsed = 0;
    this.sttStartedAt = 0;
    this.personality = 'default';
    this.autoMode = 'questions';
    this.sttErrorAt = {};
    this.openSeq = 0;          // how many times the streams have been opened (start + every resume)
    this.suggestions = new Map();  // id -> { id, key, label, name, evidence }: name suggestions awaiting an answer
    this.dismissedNames = new Set(); // `${key}|${lowercased name}` the user said no to
    this.suggestionSeq = 0;
    // Tunable so tests need not wait; there is deliberately no setting for these.
    this.nameCheckEveryMs = NAME_CHECK_EVERY_MS;
    this.nameCheckMinTurns = NAME_CHECK_MIN_TURNS;
    this.nameCheckMax = NAME_CHECK_MAX;
    this._nameCheck = { running: false, abort: null, lastAt: 0, mark: 0, count: 0 };
    // The one question the app did not answer on its own (put to someone else,
    // or not meant for the user in "Mine" mode), kept on offer for a short while.
    this.passed = null;
    this._passedMeta = null;
    this.passedSeq = 0;
    this.passedLifeMs = PASSED_LIFE_MS;
    this._passedTimer = null;
  }

  names() {
    const me = this.settings.get().me;
    // Whatever was saved (a number, a string, nothing) must not make every transcript result throw.
    const m = me && typeof me === 'object' ? me : {};
    const aliases = Array.isArray(m.aliases) ? m.aliases : typeof m.aliases === 'string' ? m.aliases.split(/[,;\n]/) : [];
    return [m.name, ...aliases].filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  }

  snapshot() {
    return {
      active: this.active,
      paused: this.paused,
      meta: this.meta,
      autoMode: this.autoMode,
      personality: this.personality,
      room: Boolean(this.room),
      turns: this.transcript ? this.transcript.turns.slice(-200) : [],
      cards: [...this.cards.values()].filter((c) => c.visible).slice(-30),
      cost: this.costSummary(),
      channels: Object.keys(this.streams),
      speakers: this.transcript ? this.transcript.speakerList() : [],
      suggestions: [...this.suggestions.values()],
      passed: this.passed || null,
    };
  }

  start({ title, channels, room = false }) {
    if (this.stopping) throw new Error('The previous meeting is still being saved. Try again in a moment.');
    if (this.active) throw new Error('A meeting is already running.');
    const s = this.settings.get();
    this.sttErrorAt = {};
    this.idleWarned = false;
    this.openSeq = 0;
    this._resetSuggestions();
    this.meta = newMeta(title && title.trim());
    this.transcript = new Transcript({ myLabel: s.me.name || 'Me', echoFilter: s.audio.echoFilter !== false, myNames: [s.me.name, ...(Array.isArray(s.me.aliases) ? s.me.aliases : [])] });
    this.recall = new MeetingRecall(this.transcript);
    this.cards = new Map();
    this.cardSeq = 0;
    this._notesShown = new Set();
    this.autoCard = null;
    this.autoCards = [];
    this._clearPending();
    this.recentAsks = new Map();
    this._autoTimes = [];
    this._autoTimesYou = [];
    this.cost = { llm: 0, llmKnown: true, inputTokens: 0, outputTokens: 0, sttMinutes: 0, stt: 0 };
    this.sttElapsed = 0;
    this.personality = s.copilot.personality || 'default';
    this.autoMode = normaliseMode(s.copilot.autoMode);
    this._dropPassed(false);
    this.channels = channels && channels.length ? channels : ['me', 'them'];
    this.room = room;
    this.paused = false;
    this.proactiveMark = Date.now();
    try {
      this.store.beginLive(this.meta);
    } catch (e) {
      this.active = false;
      throw e;
    }
    this.active = true;
    this._openStreams();
    this._startProactive();
    this.lastSpeechAt = Date.now();
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      const limit = Number(this.settings.get().copilot.autoStopMinutes);
      if (!this.active || this.stopping || this.paused || !(limit > 0)) return;
      const silent = Date.now() - this.lastSpeechAt;
      const warnLead = limit > 2 ? 2 : limit * 0.5;
      if (silent > limit * 60000) { clearInterval(this.idleTimer); this.emit('idle', { minutes: limit }); }
      else if (silent > (limit - warnLead) * 60000 && !this.idleWarned) { this.idleWarned = true; this.emit('idle-warning', { minutes: limit, inMinutes: warnLead }); }
      else if (silent < Math.min(30000, (limit - warnLead) * 30000)) this.idleWarned = false;
    }, 15000);
    this.emit('state', this.snapshot());
    return this.meta;
  }

  _openStreams() {
    const s = this.settings.get();
    this.sttStartedAt = Date.now();
    // Each opening is its own "epoch" for speaker labels: Deepgram numbers
    // speakers afresh on every connection, so a label is only meaningful
    // together with the opening (and reconnect) it came from.
    const seq = ++this.openSeq;
    if (seq > 1 && this.transcript.names.size) this.emit('hint', { message: SPEAKER_RESTART_HINT });
    for (const ch of this.channels) {
      let stream;
      try {
        stream = createStream(s.stt, (n) => this.settings.getSecret(n), ch, { baseUrlOverride: this.sttBaseUrl });
      } catch (e) { this.emit('error', { where: 'stt', message: e.message }); continue; }
      stream.on('partial', (text) => this._onPartial(ch, text));
      let seenConnection = 0;
      stream.on('final', (f) => {
        const connection = f.epoch || 0;
        // The provider dropped and reconnected on its own: its speaker numbers may have restarted.
        if (ch === 'them' && seenConnection && connection > seenConnection && this.transcript.names.size) this.emit('hint', { message: SPEAKER_RESTART_HINT });
        seenConnection = connection;
        this._onFinal(ch, f.text, f.speaker, `${seq}.${connection}`, Boolean(f.gap));
      });
      stream.on('error', (e) => {
        // A notice (transcription running behind, caught up) is news, not a fault: shown as a hint, never throttled.
        if (e && e.notice) { this.emit('hint', { message: e.message }); return; }
        // The same failure repeats on every reconnect; report it at most every 20 s per channel.
        const now = Date.now();
        if (now - (this.sttErrorAt[ch] || 0) < 20000) return;
        this.sttErrorAt[ch] = now;
        this.emit('error', { where: 'stt', channel: ch, message: e.message });
      });
      stream.on('state', (st) => this.emit('stt-state', { channel: ch, state: st }));
      stream.start();
      this.streams[ch] = stream;
    }
  }

  async _closeStreams() {
    const streams = Object.values(this.streams);
    this.streams = {};
    const elapsed = (Date.now() - this.sttStartedAt) / 1000;
    await Promise.all(streams.map((st) => st.stop().catch(() => {}).finally(() => {
      if (typeof st.removeAllListeners === 'function') st.removeAllListeners();
    })));
    for (const st of streams) {
      const minutes = billedMinutes(st, elapsed);
      this.cost.sttMinutes += minutes;
      const rate = STT[st.providerId] && STT[st.providerId].perMinute;
      if (rate != null) this.cost.stt += minutes * rate;
    }
  }

  costSummary() {
    // Include audio from streams that are still open.
    let minutes = this.cost.sttMinutes, stt = this.cost.stt;
    const elapsed = (Date.now() - this.sttStartedAt) / 1000;
    for (const st of Object.values(this.streams)) {
      const m = billedMinutes(st, elapsed);
      minutes += m;
      const rate = STT[st.providerId] && STT[st.providerId].perMinute;
      if (rate != null) stt += m * rate;
    }
    return { llm: this.cost.llm, llmKnown: this.cost.llmKnown, stt, sttMinutes: minutes, inputTokens: this.cost.inputTokens, outputTokens: this.cost.outputTokens };
  }

  pushAudio(channel, pcm) {
    if (!this.active || this.stopping || this.paused) return;
    const st = this.streams[channel];
    if (st) st.send(pcm);
  }

  async pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this._abortNameCheck();
    this._clearPending();
    this._dropPassed();
    await this._closeStreams(); // nothing is sent or billed while paused
    this.transcript.setPartial('me', ''); this.transcript.setPartial('them', '');
    this.emit('state', this.snapshot());
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.lastSpeechAt = Date.now();
    this._openStreams();
    this.emit('state', this.snapshot());
  }

  setAutoMode(mode) { this.autoMode = normaliseMode(mode); if (this.autoMode === 'manual') this._clearPending(); this._startProactive(); this.emit('state', this.snapshot()); }
  setPersonality(id) { if (typeof id !== 'string') return; this.personality = id; this.emit('state', this.snapshot()); }

  // ---------- transcript ----------
  _onPartial(channel, text) {
    if (!this.active) return;
    if (text && text !== '…') this.lastSpeechAt = Date.now();
    this.transcript.setPartial(channel, text);
    this.emit('partial', { channel, text });
    if (!this.stopping && channel === 'them' && text && text !== '…') for (const p of [...this.pendingAuto.values()]) this._scheduleAuto(p.analysis, p.turn, true);
  }

  // `gap`: the speech stream's note that speech was skipped. It is kept like any turn, so the saved
  // file shows the gap, but it is not speech: it is not analysed and does not count as someone speaking.
  _onFinal(channel, text, speaker, epoch, gap = false) {
    if (!this.active) return;
    if (!gap) this.lastSpeechAt = Date.now();
    const res = this.transcript.addFinal(channel, text, speaker, Date.now(), epoch, { gap });
    this.emit('partial', { channel, text: '' });
    if (!res) return; // echo of the meeting audio picked up by the microphone
    try { this.recall.sync(Date.now()); } catch { /* looking back is a convenience: it must never cost a transcript result */ }
    this.store.appendLive(this.meta.id, { type: 'turn', turn: res.turn });
    this.emit('turn', { turn: res.turn, merged: res.merged });
    // The streams flush their last words as they close, on pause and on stop: those words are kept,
    // but nothing is answered or checked for names on the strength of them.
    if (gap || channel !== 'them' || this.stopping || this.paused) return;
    this._maybeSuggestNames();

    // Judge the whole turn so far: a question is often split across two results.
    const analysis = this._analyse(res.turn);
    if (analysis.mentioned) this.emit('mention', { turn: res.turn });
    if (analysis.fire || analysis.pass) this._scheduleAuto(analysis, res.turn, false);
    else { if (this.pendingAuto.has(res.turn.id)) this._scheduleAuto(this.pendingAuto.get(res.turn.id).analysis, res.turn, true); }
  }

  // Each turn settles on its own timer: a question in another turn never displaces
  // one that is still settling, while the same turn growing extends its own.
  _scheduleAuto(analysis, turn, extend) {
    const key = turn.id;
    const old = this.pendingAuto.get(key);
    const first = old ? old.first : Date.now();
    if (old) clearTimeout(old.timer);
    const wait = extend && Date.now() - first > AUTO_MAX_WAIT_MS ? 0 : AUTO_SETTLE_MS;
    this.pendingAuto.set(key, { analysis, turn, first, timer: setTimeout(() => this._fireAuto(key), wait) });
  }

  _clearPending() {
    for (const p of this.pendingAuto.values()) clearTimeout(p.timer);
    this.pendingAuto = new Map();
  }

  _fireAuto(key) {
    const p = this.pendingAuto.get(key);
    this.pendingAuto.delete(key);
    // Switching to "On request" while a question settles means: do not answer it.
    if (!p || !this.active || this.paused || this.autoMode === 'manual') return;
    // Re-read the turn: it may have grown while we waited.
    const analysis = this._analyse(p.turn);
    const a = analysis.fire || analysis.pass ? analysis : p.analysis;
    // The same words in a later turn are a new question ("What do you think?"
    // comes up many times); the same turn is answered once, however long it goes on.
    const now = Date.now();
    this._forgetOldAsks();
    const askKey = this._askKey(p.turn, a);
    if (this.recentAsks.has(askKey)) return;
    const ask = tailFromSentence(a.ask, ASK_MAX_CHARS);
    this._autoTimes = this._autoTimes.filter((t) => now - t < this.autoWindowMs);
    this._autoTimesYou = this._autoTimesYou.filter((t) => now - t < this.autoWindowMs);
    // Named, handed over to, or asked straight after the user spoke. A question that is "for you" only
    // because one person is on the call (one-to-one) says nothing about who it is for: it counts as any other.
    const toYou = a.target === 'you' && a.why !== 'one-to-one';
    const used = toYou ? this._autoTimesYou : this._autoTimes;
    if (!a.fire || used.length >= (toYou ? this.autoLimitYou : this.autoLimit)) {
      // A question the mode leaves alone, or one beyond the limit for this minute: offer it,
      // do not answer it. It is remembered under its own key so a later answer to it is not blocked.
      const passKey = `pass|${askKey}`;
      if (this.recentAsks.has(passKey)) return;
      this.recentAsks.set(passKey, { at: now, turnId: p.turn.id });
      this._setPassed({ turnId: p.turn.id, ask, speaker: p.turn.speaker, target: a.target, addressee: a.addressee, askKey, speakerKey: p.turn.speakerKey });
      return;
    }
    this.recentAsks.set(askKey, { at: now, turnId: p.turn.id });
    used.push(now);
    this._dropPassed();
    // A newer question from the same voice (a rephrase, or carrying on) replaces the
    // answer still being written for it. A question from someone else gets its own
    // answer beside it, but never more than MAX_AUTO_ANSWERS at once: the oldest gives way.
    this.autoCards = this.autoCards.filter((x) => x.card.status === 'streaming');
    const same = this.autoCards.find((x) => x.speakerKey === p.turn.speakerKey);
    if (same) { this.cancelCard(same.card.id, true); this.autoCards = this.autoCards.filter((x) => x !== same); }
    while (this.autoCards.length >= MAX_AUTO_ANSWERS) this.cancelCard(this.autoCards.shift().card.id, true);
    this.lastAutoAt = Date.now();
    this.autoCard = this.runAction('answer', { ask, speaker: p.turn.speaker, reason: a.reason, target: a.target, addressee: a.addressee }, { auto: true });
    this.autoCard.askKey = askKey; // forgotten if the answer fails, so the question can be asked again
    this.autoCards.push({ card: this.autoCard, speakerKey: p.turn.speakerKey });
  }

  // One question, one key: the turn it was asked in plus its words. A turn that only names the user
  // ("Let's ask Ade about it") has the whole turn as its ask, which changes with every result, so
  // those share one key per turn.
  _askKey(turn, a) {
    const words = a.directedOnly ? '\u0000directed' : a.ask.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    return `${turn.id}|${words}`;
  }

  // Keys are forgotten once their turn can no longer grow, not after a time: a speaker who carries on
  // for twenty minutes must not hear the same question answered again.
  _forgetOldAsks() {
    const turns = this.transcript.turns;
    const newest = turns.length ? turns[turns.length - 1].id : 0;
    for (const [k, v] of this.recentAsks) if (v.turnId <= newest - ASK_MEMORY_TURNS) this.recentAsks.delete(k);
  }

  // Who the words in `turn` are for, judged from what the session knows about
  // the meeting. Free and instant: no model is asked.
  _analyse(turn) {
    const { others, context } = this._targeting(turn);
    const names = this.names();
    const text = this._analysisText(turn);
    const res = analyzeTurn(text, { names, mode: this.autoMode, others, context });
    if (res.question) res.directedOnly = !splitSentences(text).some((x) => classify(x, names).asking); // asked by naming the user, not by a question
    return res;
  }

  // What analysis reads: the end of the turn from a sentence start, and, for a turn that carries on
  // the same voice's previous one (cut for length, or begun within OPEN_SENTENCE_GAP_MS of a turn that
  // stopped mid-sentence), that turn's last unfinished sentence in front, so a question that
  // straddles the cut or a pause is seen whole. The transcript itself keeps the two turns apart.
  _analysisText(turn) {
    const body = tailFromSentence(turn.text, ANALYSE_CHARS);
    if (body.length !== turn.text.length) return body;
    const turns = this.transcript.turns;
    const i = this._indexOf(turn);
    const prev = i > 0 ? turns[i - 1] : null;
    if (!prev || prev.gap || prev.speakerKey !== turn.speakerKey || turn.t - prev.end >= OPEN_SENTENCE_GAP_MS || /[.?!]["')\]]*\s*$/.test(prev.text)) return body;
    const m = /^[\s\S]*[.?!]["')\]]*\s+/.exec(prev.text);
    const open = tailFromSentence(m ? prev.text.slice(m[0].length) : prev.text, UNFINISHED_CHARS);
    return `${open} ${body}`;
  }

  // Where `turn` sits, found from the end: the turn being judged is nearly always one of the last few.
  _indexOf(turn) {
    const turns = this.transcript.turns;
    let i = turns.length - 1;
    while (i >= 0 && turns[i] !== turn) i--;
    return i;
  }

  // `others`: every name the user has given to a voice.
  // `oneToOne`: speakers are being told apart and only one voice has ever been
  //   heard on the meeting audio. Without that the app cannot know how many
  //   people are on the call, so it never assumes two.
  // `afterMe`: the user spoke just before this turn began.
  // Neither is true in an in-person (room) meeting: one microphone hears everyone.
  _targeting(turn) {
    const turns = this.transcript.turns;
    const others = [...new Set(this.transcript.names.values())];
    const context = { oneToOne: false, afterMe: false };
    if (this.room) return { others, context };
    // The transcript tracks diarized labels across epochs so this is not a scan of every turn.
    if (turn.label && turn.label !== 'Them') context.oneToOne = this.transcript.isOneToOne();
    // Look back past interjections (a "mm-hmm" from anyone, the user included) to what the user
    // really said: a grunt is not "I just spoke", so it must be a sentence of its own.
    let i = this._indexOf(turn) - 1;
    while (i >= 0 && wordsIn(turns[i].text) <= INTERJECTION_WORDS) i--;
    const prev = i >= 0 ? turns[i] : null;
    context.afterMe = Boolean(prev && !prev.gap && prev.channel === 'me' && wordsIn(prev.text) >= AFTER_ME_MIN_WORDS && turn.t - prev.end <= AFTER_ME_MS);
    return { others, context };
  }

  // ---------- the passed question ----------
  _setPassed({ turnId, ask, speaker, target, addressee, askKey = '', speakerKey = '' }) {
    clearTimeout(this._passedTimer);
    const passed = { id: ++this.passedSeq, turnId, ask, speaker, target, addressee: addressee || '', at: Date.now() };
    this.passed = passed;
    this._passedMeta = { askKey, speakerKey };
    this._passedTimer = setTimeout(() => this._dropPassed(true, passed.id), this.passedLifeMs);
    if (this._passedTimer.unref) this._passedTimer.unref();
    this.emit('passed', passed); // a newer one replaces the older without a clear
  }

  _dropPassed(announce = true, id = null) {
    const p = this.passed;
    if (!p || (id != null && p.id !== id)) return;
    clearTimeout(this._passedTimer);
    this._passedTimer = null;
    this.passed = null;
    this._passedMeta = null;
    if (announce) this.emit('passed-clear', { id: p.id });
  }

  // The user asked for the answer to the question that was passed over.
  answerPassed(id) {
    const p = this.passed;
    const meta = this._passedMeta;
    if (!p || p.id !== Number(id)) throw new Error('That question is no longer waiting.');
    this._dropPassed();
    if (meta && meta.askKey) this.recentAsks.set(meta.askKey, { at: Date.now(), turnId: p.turnId });
    const reason = p.target === 'other' ? 'question to someone else' : p.target === 'you' ? 'question to you' : 'question';
    const card = this.runAction('answer', { ask: p.ask, speaker: p.speaker, reason, target: p.target, addressee: p.addressee }, { auto: false });
    if (meta && meta.askKey) card.askKey = meta.askKey;
    return card;
  }

  _startProactive() {
    clearInterval(this.proactiveTimer);
    this.proactiveTimer = null;
    if (!this.active || this.stopping || this.autoMode !== 'proactive') return;
    this.proactiveMark = Date.now();
    const every = Math.max(20, Number(this.settings.get().copilot.proactiveEverySec) || 45) * 1000;
    this.proactiveTimer = setInterval(() => {
      if (!this.active || this.paused) return;
      if ([...this.cards.values()].some((c) => c.status === 'streaming')) return;
      if (Date.now() - this.lastAutoAt < 20000) return;
      const fresh = this.transcript.turns.filter((t) => t.channel === 'them' && t.end > this.proactiveMark).reduce((n, t) => n + t.text.length, 0);
      if (fresh < 250) return;
      this.proactiveMark = Date.now();
      this.runAction('proactive', {}, { auto: true });
    }, every);
  }

  // ---------- speaker names ----------
  // Name (or, with '', un-name) one voice. Earlier turns are rewritten too.
  renameSpeaker(key, name) {
    if (!this.active || !this.transcript) throw new Error('No meeting is running.');
    const changed = this.transcript.setName(key, name);
    this.store.appendLive(this.meta.id, { type: 'names', names: Object.fromEntries(this.transcript.names) });
    for (const s of [...this.suggestions.values()]) if (s.key === key) this._dropSuggestion(s.id);
    if (this.passed) {
      const t = this.transcript.turns.find((x) => x.id === this.passed.turnId);
      if (t && t.speakerKey === key && this.passed.speaker !== t.speaker) {
        this.passed = { ...this.passed, speaker: t.speaker };
        this.emit('passed', this.passed);
      }
    }
    const speakers = this.transcript.speakerList();
    this.emit('speakers', { speakers, turns: changed });
    return speakers;
  }

  // ---- name suggestions: the plumbing. The engine that decides *what* to suggest ----
  // ---- (src/main/speaker-names.js) only ever calls _addSuggestion().             ----
  _resetSuggestions() {
    this.suggestions = new Map();
    this.dismissedNames = new Set();
    this.suggestionSeq = 0;
    this._abortNameCheck();
    this._nameCheck = { running: false, abort: null, lastAt: 0, mark: 0, count: 0 }; // lastAt: when a check last started; mark: last turn id it covered
  }

  _abortNameCheck() {
    const c = this._nameCheck;
    if (c && c.abort) c.abort.abort();
  }

  // Called after every final on the meeting-audio channel while the meeting is live.
  // Decides whether it is time to ask the model who the unnamed voices might be.
  // Never throws and never blocks the transcript: a failed check is simply skipped.
  _maybeSuggestNames() {
    const c = this._nameCheck;
    if (!this.active || this.paused || this.stopping || !this.transcript) return;
    if (this.settings.get().stt.suggestNames === false) return;
    if (c.running || c.count >= this.nameCheckMax || Date.now() - c.lastAt < this.nameCheckEveryMs) return;
    const turns = this.transcript.turns;
    let fresh = 0;
    for (let i = turns.length - 1; i >= 0 && turns[i].id > c.mark; i--) if (turns[i].channel === 'them' && !turns[i].gap) fresh++;
    if (fresh < this.nameCheckMinTurns) return;
    // Voices that already have a suggestion waiting are not asked about again.
    const waiting = new Set([...this.suggestions.values()].map((s) => s.key));
    const prompt = buildNamePrompt({ turns: turns.slice(-NAME_WINDOW_TURNS).filter((t) => !t.gap), names: this.transcript.names, myLabel: this.transcript.myLabel, userNames: this.names(), skip: waiting });
    if (!Object.keys(prompt.tags).length) return; // nobody to name (or no diarization)
    c.lastAt = Date.now();
    c.mark = turns[turns.length - 1].id;
    c.count++;
    c.running = true;
    c.abort = new AbortController();
    this._runNameCheck(c, this.transcript, prompt)
      .catch(() => { /* silent: the next check tries again */ })
      .finally(() => { c.running = false; c.abort = null; });
  }

  async _runNameCheck(c, transcript, prompt) {
    const live = (this.settings.get().llm && this.settings.get().llm.live) || {};
    // Models whose thinking is disabled in live mode need only 400 output tokens; reasoning models spend part of the budget thinking.
    const nonThinkingAnthropic = live.provider === 'anthropic' && /claude-3|haiku-4-5|sonnet-4-[0256]|opus-4-[01256]|haiku-5-5|sonnet-5(?!-5)|opus-4-[78]/i.test(String(live.model || ''));
    const maxTokens = nonThinkingAnthropic ? 400 : 1500;
    const result = await this.llm.streamChat('live', {
      system: prompt.system, userText: prompt.userText, maxTokens, signal: c.abort.signal, webSearch: false,
    }).catch((e) => {
      if (e && e.kind === 'aborted') return null;
      throw e;
    });
    // The meeting ended (or a new one began) while the model was thinking.
    if (!result || !this.active || this.transcript !== transcript || this._nameCheck !== c) return;
    this.cost.inputTokens += result.usage.input + result.usage.cached;
    this.cost.outputTokens += result.usage.output;
    if (result.cost == null) this.cost.llmKnown = false; else this.cost.llm += result.cost;
    this.emit('cost', this.costSummary());
    if (this.stopping) return;
    for (const s of parseNameSuggestions(result.text, { tags: prompt.tags, windowText: prompt.windowText, userNames: this.names(), dismissedNames: this.dismissedNames })) this._addSuggestion(s);
  }

  // Returns the suggestion that was queued, or null when it was refused: unknown
  // or already-named speaker, a name the user already dismissed, a duplicate, or
  // a speaker that already has a suggestion waiting.
  _addSuggestion({ key, label, name, evidence }) {
    if (!this.active || !this.transcript || key === 'me') return null;
    const clean = cleanSpeakerName(name).normalize('NFC');
    if (!clean) return null;
    if (this.transcript.names.has(key) || !this.transcript.turns.some((t) => t.speakerKey === key)) return null;
    const norm = clean.replace(/[\u2018\u2019\u02BC]/g, "'").toLowerCase();
    if (this.dismissedNames.has(`${key}|${norm}`) || this.dismissedNames.has(`${key}|${clean.toLowerCase()}`)) return null;
    for (const s of this.suggestions.values()) if (s.key === key) return null; // one at a time per speaker
    const suggestion = { id: ++this.suggestionSeq, key, label: String(label || ''), name: clean, evidence: String(evidence || '').replace(/\s+/g, ' ').trim().slice(0, 140) };
    this.suggestions.set(suggestion.id, suggestion);
    this.emit('speaker-suggestion', { suggestion });
    return suggestion;
  }

  _dropSuggestion(id) {
    if (this.suggestions.delete(id)) this.emit('speaker-suggestion-clear', { id });
  }

  // The user's answer to a suggestion. A "no" is remembered so it is not offered again.
  resolveSuggestion(id, accept) {
    const s = this.suggestions.get(Number(id));
    if (!s) return false;
    this._dropSuggestion(s.id);
    if (!accept) {
      this.dismissedNames.add(`${s.key}|${s.name.replace(/[\u2018\u2019\u02BC]/g, "'").toLowerCase()}`);
      this.dismissedNames.add(`${s.key}|${s.name.toLowerCase()}`);
      return true;
    }
    this.renameSpeaker(s.key, s.name);
    return true;
  }

  // ---------- answer cards ----------
  runAction(action, params = {}, { auto = false, image = null } = {}) {
    // Own keys only: 'constructor' or '__proto__' would otherwise find something on the prototype.
    const def = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
    if (!def) throw new Error(`Unknown action: ${String(action)}`);
    if (!this.active || this.stopping) throw new Error('No meeting is running.');
    const quiet = action === 'proactive'; // shown only once we know it is not a SKIP
    const card = {
      id: ++this.cardSeq, action, label: def.label, auto,
      quote: params.ask || params.typed || '', reason: params.reason || '',
      target: ['you', 'room', 'other'].includes(params.target) ? params.target : '', addressee: String(params.addressee || '').slice(0, 60),
      text: '', status: 'streaming', statusText: '', sources: [], files: [],
      startedAt: Date.now(), firstTokenMs: null, visible: !quiet, error: '',
    };
    card.abort = new AbortController();
    this.cards.set(card.id, card);
    if (card.visible) this.emit('card', this._public(card));
    const transcript = this.transcript;
    this._generate(card, action, params, image, transcript).catch((e) => {
      if (this.transcript !== transcript || card.status === 'cancelled' || this.cards.get(card.id) !== card) return;
      card.status = 'error'; card.error = e.message;
      if (card.askKey) this.recentAsks.delete(card.askKey);
      if (card.visible) this.emit('card-done', this._public(card));
    });
    return card;
  }

  _public(card) { const { abort, ...rest } = card; return rest; }

  cancelCard(id, remove = false) {
    const card = this.cards.get(id);
    if (!card) return;
    if (card.status === 'streaming') { card.status = 'cancelled'; card.abort.abort(); }
    if (remove) { card.visible = false; this.emit('card-remove', { id }); }
    else this.emit('card-done', this._public(card));
  }

  _pendingSayFocus() {
    const turns = this.transcript && this.transcript.turns;
    if (!turns || !turns.length) return '';
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.gap) continue;
      if (t.channel === 'me') {
        if (wordsIn(t.text) <= INTERJECTION_WORDS) continue;
        return '';
      }
      const a = this._analyse(t);
      return a.question ? tailFromSentence(a.ask, ASK_MAX_CHARS) : '';
    }
    return '';
  }

  // The transcript block of a request: the recent part, within PROMPT_CHARS. When part of the meeting
  // has fallen out of it and a few of those older turns relate to the question, they come first, under
  // a line saying so, and take their share of the same budget. Otherwise it is the recent part alone.
  _transcriptFor(action, params, sinceMs, sayFocus = '') {
    const tr = this.transcript;
    const win = tr.window({ maxChars: PROMPT_CHARS, sinceMs });
    if (sinceMs || !this.recall || !RECALL_ACTIONS.has(action) || win.first <= 0) return win.text;
    let pick = null;
    try {
      this.recall.sync(Date.now());
      const ask = String(params.ask || params.typed || sayFocus || '');
      // No question of its own (what to say next, my take): the last few turns stand in, held to a higher bar.
      pick = this.recall.select({ query: ask || tr.turns.slice(-4).map((t) => t.text).join(' ').slice(-600), loose: !ask, first: win.first });
    } catch { /* the request is built without it */ }
    if (!pick) return win.text;
    const head = `${EARLIER_MARK}\n${pick.text}\n${RECENT_MARK}\n`;
    // The recent part is cut to what is left, and cut again if its line breaks (not counted in its budget) push the whole over.
    let budget = PROMPT_CHARS - head.length, recent = tr.window({ maxChars: budget, sinceMs });
    for (let i = 0; i < 3 && head.length + recent.text.length > PROMPT_CHARS; i++) {
      budget -= head.length + recent.text.length - PROMPT_CHARS;
      recent = tr.window({ maxChars: budget, sinceMs });
    }
    return head + recent.text;
  }

  async _generate(card, action, params, image, sessionTranscript = this.transcript) {
    const s = this.settings.get();
    const def = ACTIONS[action];
    const sinceMs = action === 'catchup' ? Date.now() - (params.minutes || 3) * 60000 : 0;
    const sayFocus = !params.ask && !params.typed && action === 'say' ? this._pendingSayFocus() : '';
    // Roughly the last 25 minutes of talk; older turns drop off the front, bar the few that relate to the question.
    const transcript = this._transcriptFor(action, params, sinceMs, sayFocus);

    // The question being answered (or, for what-to-say-next, any pending question on the floor).
    const focus = params.ask || params.typed || sayFocus || '';
    const guard = GUARDED_ACTIONS.has(action) ? (isOrgQuestion(focus) ? 'org' : (focus ? 'lite' : null)) : null;
    let hits = [], pinned = [];
    if (def.needsKnowledge && this.library.chunkCount) {
      const recent = sessionTranscript.turns.slice(-4).map((t) => t.text).join(' ').slice(-600);
      // The question itself is repeated so it outweighs the surrounding talk.
      const query = `${focus} ${focus} ${recent}`;
      // Folders marked "always include" go in whole; filter against active folders so stale removed entries are ignored.
      const allowedDirs = Array.isArray(s.library.folders) && s.library.folders.length
        ? s.library.folders
        : (this.library.folders || []).filter((f) => !f.optional).map((f) => f.dir);
      const activePinned = (s.library.pinned || []).filter((p) => allowedDirs.some((f) => samePath(f, p)));
      const pin = this.library.pinned(activePinned);
      pinned = pin.items;
      const extra = pin.files.size * 3;
      hits = this.library.search(query, { k: 6 + extra, maxChars: extra ? 5200 + pin.chars : 5200 });
      card.files = FILE_ACTIONS.has(action) ? strongFiles(hits, query) : [];
      if (pin.files.size) {
        let used = 0;
        hits = hits.filter((h) => {
          if (pin.files.has(h.file)) return false;
          if (used + h.text.length > 5200 && used > 0) return false;
          used += h.text.length;
          return true;
        }).slice(0, 6);
      }
    }
    const system = systemPrompt({ name: s.me.name, role: s.me.role, profile: this.getProfile(), personality: this.getPersonality(this.personality) });
    // The pinned notes lead the user turn and do not change between questions: Anthropic is told to cache that much (userCacheChars).
    const { prefix, rest } = userPromptParts({ action, transcript, hits, pinned, params, title: this.meta.autoTitle ? '' : this.meta.title, room: this.room, guard });
    const userText = prefix + rest;

    let held = '';
    let decided = action !== 'proactive';
    const stale = () => this.transcript !== sessionTranscript || card.status === 'cancelled' || this.cards.get(card.id) !== card;
    const result = await this.llm.streamChat('live', {
      system, userText, userCacheChars: prefix.length,
      images: image ? [image] : [],
      // Not for a recap, and not for the quiet background check (action 'proactive'): neither waits for a search. Not for a
      // question about the organisation either: the web does not know it, and a search would only tempt a guess.
      webSearch: s.llm.webSearch !== false && action !== 'catchup' && action !== 'proactive' && guard !== 'org',
      signal: card.abort.signal,
      onStatus: (st) => { if (stale()) return; card.statusText = st; if (card.visible) this.emit('card-delta', { id: card.id, statusText: st }); },
      onText: (delta) => {
        if (stale()) return;
        if (card.firstTokenMs == null) card.firstTokenMs = Date.now() - card.startedAt;
        if (!decided) {
          held += delta;
          if (held.trim().length < 5) return;
          decided = true;
          if (/^\s*SKIP/i.test(held)) { card.skip = true; return; } // let it finish: the request is paid for either way
          card.visible = true; card.text = held;
          this.emit('card', this._public(card));
          return;
        }
        if (card.skip) return;
        card.text += delta;
        this.emit('card-delta', { id: card.id, delta });
      },
    }).catch((e) => {
      if (e.kind === 'aborted') return null;
      throw e;
    });

    if (this.transcript !== sessionTranscript) return;
    if (card.skip || (!decided && /^\s*SKIP/i.test(held)) || (action === 'proactive' && !card.visible)) {
      this.cards.delete(card.id);
      if (result) { this.cost.inputTokens += result.usage.input + result.usage.cached; this.cost.outputTokens += result.usage.output; if (result.cost == null) this.cost.llmKnown = false; else this.cost.llm += result.cost; this.emit('cost', this.costSummary()); }
      return;
    }
    if (!result || stale()) return; // cancelled or replaced
    card.status = 'done';
    card.statusText = '';
    card.sources = (result.sources || []).slice(0, 4);
    card.model = result.model;
    card.totalMs = Date.now() - card.startedAt;
    if (result.truncated) card.note = 'The answer was cut off at the length limit.';
    const notes = (result.notes || []).filter((n) => {
      if (!ONCE_PER_MEETING.test(n)) return true;
      if (this._notesShown.has(n)) return false;
      this._notesShown.add(n);
      return true;
    });
    if (notes.length) card.note = notes.join(' ');
    // A guarded question with no file behind it gets a holding line, unless pinned notes answered it directly without deferring.
    if (guard === 'org' && !card.files.length && (!pinned.length || DEFERRAL_RE.test(card.text.replace(/[\u2018\u2019\u02BC`´]/g, "'")))) {
      card.note = `${card.note ? `${card.note} ` : ''}${HOLDING_NOTE}`;
    }
    if (CHECK_ACTIONS.has(action) && !card.files.length && claimsAboutUs(card.text)) card.check = true;
    if (image) card.note = `${card.note ? `${card.note} ` : ''}A picture of your screen was sent to ${(require('./llm').PROVIDERS[result.provider] || { label: result.provider }).label.split(' (')[0]}.`;
    this.cost.inputTokens += result.usage.input + result.usage.cached;
    this.cost.outputTokens += result.usage.output;
    if (result.cost == null) this.cost.llmKnown = false; else this.cost.llm += result.cost;
    this.emit('card-done', this._public(card));
    this.emit('cost', this.costSummary());
    // Old answers are not kept forever.
    if (this.cards.size > 60) for (const [id, c] of this.cards) { if (this.cards.size <= 60) break; if (c.status !== 'streaming') this.cards.delete(id); }
  }

  // ---------- finish ----------
  async stop() {
    if (!this.active || this.stopping) return null;
    // Stay active until the speech provider has handed back the last words, so
    // they reach the transcript; and keep this meeting's own objects, so a new
    // meeting started in the meantime can never be mixed up with it.
    this.stopping = true;
    const meta = this.meta;
    const transcript = this.transcript;
    clearInterval(this.proactiveTimer);
    clearInterval(this.idleTimer);
    this._clearPending();
    this._abortNameCheck();
    this._dropPassed();
    for (const s of [...this.suggestions.values()]) this._dropSuggestion(s.id);
    for (const c of this.cards.values()) if (c.status === 'streaming') { c.status = 'cancelled'; c.abort.abort(); }
    try { await this._closeStreams(); } catch { /* what was heard is already in the transcript */ }
    const end = new Date();
    meta.end = hm(end);
    meta.durationMin = Math.max(1, Math.round((end.getTime() - meta.startMs) / 60000));
    meta.speakers = transcript.speakers();
    const result = { meta, transcriptMd: transcript.toMarkdown(), transcriptPlain: transcript.toPlain(), turns: transcript.turns.length, cost: this.costSummary(), file: null, saveError: '' };
    if (result.turns) {
      try {
        result.file = this.store.save(meta, '', result.transcriptMd);
        this.store.endLive(meta.id);
      } catch (e) {
        // Keep the autosave: it is recovered the next time the app starts.
        result.saveError = `The transcript could not be saved to ${this.store.dir} (${e.message}). A copy is kept and will be recovered the next time Understudy starts.`;
      }
    } else this.store.endLive(meta.id);
    this.active = false;
    this.stopping = false;
    this.recall = null; // the search index goes with the meeting
    this.emit('state', this.snapshot());
    return result;
  }
}

module.exports = { MeetingSession };
