'use strict';
// Decides, without a model call, whether something another person just said
// deserves an answer card. It has to be instant: the model call it gates is
// the slow part, so the gate itself must cost nothing.
//
// Speech-to-text punctuates what it hears, so the punctuation is the main
// signal: a sentence ending in "?" is a question, a sentence ending in "." is
// not, however it starts ("When we deployed it broke." is a statement). Only
// text with no punctuation at all falls back to the shape of the sentence.

// ---------------------------------------------------------------- text

// Two views of the same text, kept the same length so a position in one is a
// position in the other. `canonical` is what the card shows: composed (NFC) so
// a name typed as "Jose" + combining accent equals the spoken "José", and the
// Greek question mark (U+037E, which NFC would silently turn into ";") written
// as "?". `flatten` is what the rules read: curly apostrophes are plain ones
// and the fullwidth (？) and Arabic (؟) question marks are "?".
const canonical = (s) => String(s == null ? '' : s).replace(/\u037E/g, '?').normalize('NFC');
const flatten = (s) => s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\uFF1F\u061F]/g, '?');

// Sentence ends: ". ? !" followed by a space, and the CJK full stop and
// exclamation mark, or a "?" / "!" straight into Chinese or Japanese text,
// none of which are followed by a space.
const SENTENCE_BREAK = /(?<=[.?!])\s+|(?<=[\u3002\uFF01])\s*|(?<=[?!])(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
const NON_BREAKING_ABBR = /(?:^|[^\p{L}\p{N}])(?:mr|mrs|ms|miss|mx|dr|prof|e\.g|i\.e|vs)\.$/iu;
const ETC_ABBR = /(?:^|[^\p{L}\p{N}])etc\.$/iu;
function sentenceSpans(flat) {
  const spans = [];
  let from = 0;
  const push = (a, b) => {
    while (a < b && /\s/.test(flat[a])) a++;
    while (b > a && /\s/.test(flat[b - 1])) b--;
    if (b > a) spans.push([a, b]);
  };
  for (const m of flat.matchAll(SENTENCE_BREAK)) {
    if (flat[m.index - 1] === '.') {
      const tail = flat.slice(Math.max(from, m.index - 10), m.index);
      if (NON_BREAKING_ABBR.test(tail)) continue;
      const nextIdx = m.index + m[0].length;
      if (ETC_ABBR.test(tail) && nextIdx < flat.length && !/[\p{Lu}\u00BF]/u.test(flat[nextIdx])) continue;
    }
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, flat.length);
  return spans;
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

// Chinese and Japanese are written without spaces, so "how many words" has to
// be "how many characters": four of them are a sentence, as two words are.
const CJK_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const CJK_MIN_CHARS = 4;
function longEnough(s) {
  if (words(s) >= 2) return true;
  const m = s.match(CJK_CHARS);
  return Boolean(m) && m.length >= CJK_MIN_CHARS;
}

const FILLER_PREFIX = /^(?:(?:so|and|but|ok(?:ay)?|well|now|also|hey|um|uh|right|alright|yeah|sorry|just|then)[,\s]+)+/i;

// ---------------------------------------------------------------- logistics

// Things that are asked in every meeting and need no help. Each pattern
// describes the whole short housekeeping sentence (after the filler at its
// start and the punctuation at its end are taken off), never a fragment of it:
// "can you see my screen" is housekeeping, "do you see this error in the logs"
// is a question that happens to contain "see this".
const LOGISTICS_PREFIX = /^(?:(?:hello|hi|hey|everyone|everybody|folks|guys|good (?:morning|afternoon|evening)|so|and|but|ok(?:ay)?|well|now|um|uh|right|alright|yeah|sorry|just|then|also|excuse me|pardon me)[,\s]+)+/i;
const LOGISTICS_MAX_WORDS = 9;

const AUDIENCE = "(?:you|everyone|everybody|anyone|anybody|all|y'all|you all|you guys|folks)";
// Words that may trail a housekeeping sentence without changing what it is.
const POLITE_TAIL = "(?:\\s+(?:ok(?:ay)?|fine|alright|all right|clearly|properly|well|now|there|still|yet|again|please|guys|everyone|all|so far|too|today|quickly|real quick|quick))*";
const REQUEST_ACTIONS = [
  'go back(?: (?:one|a) (?:slide|page|step|bit))?',
  'go (?:forward|to the (?:next|previous|last) (?:slide|page))',
  'scroll(?: (?:up|down|back))?',
  'zoom(?: in| out)?',
  'make (?:it|that|the (?:text|font|slide|screen)) (?:bigger|larger|smaller)',
  '(?:repeat|say) (?:that|it|the question|the last (?:part|bit|thing)|what you (?:just )?said)(?: again)?',
  'say that again',
  'speak up',
  '(?:speak|talk) (?:a (?:bit|little) )?(?:louder|slower|more slowly|closer to the mic)',
  'slow down',
  '(?:un)?mute(?: yourself| your (?:mic|microphone))?',
  'turn (?:on|off) your (?:camera|video|mic|microphone)',
  'turn your (?:camera|video|mic|microphone) (?:on|off)',
  'turn (?:the|your) (?:volume|sound) (?:up|down)',
  '(?:share|present) (?:your|the|that|this) (?:screen|slides?|deck|window|presentation)',
  'stop sharing',
  '(?:put|drop|paste|post|send) (?:that|it|this|the link|a link|the (?:doc|document|slides|deck|invite)|your (?:email|number)) (?:in|into|on) the (?:chat|channel)',
  'send (?:me|us|everyone) (?:the|that|a) (?:link|invite|slides?|deck|calendar invite|meeting link)',
];
const WAIT_FOR = '(?:(?:a|another|one more|some more|a few|a couple of|five|ten|two|three)(?: more)? (?:minutes?|moments?|seconds?)|a (?:bit|moment|minute)|(?:for )?(?:a few|a couple of|some) (?:more )?(?:people|folks|others)|(?:for )?(?:the )?(?:others|rest|everyone|everybody|stragglers|folks|people)(?: to (?:join|arrive|get here|show up|dial in))?)';
const LOGISTICS = [
  // Hearing and seeing: "can you hear me okay", "can everyone see my screen", "can you see this".
  new RegExp(`^(?:can|could|do|did|will) ${AUDIENCE}(?: still| both)? (?:hear (?:me|us|him|her|them|that)|see (?:me|us|it|this|that|(?:my|our|the) (?:screen|slides?|window|deck|presentation|chat|whiteboard)|this (?:slide|page|screen|window|doc|document|link|diagram|chart)))${POLITE_TAIL}$`, 'iu'),
  // The state of the call: "am I muted", "are you on mute", "am I breaking up", "are you sharing your screen".
  new RegExp(`^(?:am i|are you|are we|is (?:he|she|it|everyone)|are they) (?:still |currently )?(?:on mute|muted|unmuted|frozen|lagging|breaking up|cutting out|audible|echoing|visible|sharing (?:my|your|the|our) screen)${POLITE_TAIL}$`, 'iu'),
  /^(?:you(?:'re| are)|i(?:'m| am)|we(?:'re| are)) (?:still |currently |both )?(?:on mute|muted|frozen|lagging|breaking up|cutting out|inaudible|echoing|not audible|a bit (?:quiet|choppy|laggy))$/iu,
  // "is my mic working", "is the sound okay".
  /^(?:is|are) (?:my|your|the|our) (?:audio|mic|microphone|sound|video|camera|connection|internet|wifi|screen|slides?) (?:ok(?:ay)?|good|fine|working|clear|coming through|loud enough|showing|visible|on|muted|lagging|frozen|cutting out|breaking up)(?: now| yet| again)?$/iu,
  // Recording and streaming: "is this recording", "are we live", "is it on", "is the recording on".
  /^(?:is|are) (?:it|this|that|we|the (?:meeting|call|session|recording|stream)) (?:being )?(?:recording|recorded|live|on|streaming|started|running)(?: now| yet| already)?$/iu,
  // Starting: "can I share my screen", "can we get started", "shall we take a five minute break".
  /^(?:can|may|shall|should|could) (?:i|we) (?:get (?:started|going)|begin|start(?: now| the (?:meeting|call|demo|recording|session))?|record(?: this| it| the (?:meeting|call|session))?|go ahead|kick (?:this|it|things) off|jump (?:in|right in)|dive in|take (?:a|the) (?:[\p{L}-]+ ){0,3}break|share(?: my| our| the)? screen|share my (?:slides?|deck|window))(?: now| then| first| everyone| guys| folks| please)*$/iu,
  new RegExp(`^(?:should we|shall we|can we|do we need to) (?:wait|hold off)(?: ${WAIT_FOR})?(?: now| then| please)*$`, 'iu'),
  /^(?:should we|shall we) give (?:it|them|people|folks|everyone) (?:a|another|one more|some more) (?:[\p{L}-]+ )?(?:minute|minutes|moment|moments|second|seconds|bit)$/iu,
  // Who is here: "is everyone ready", "is Bob joining us today", "who just joined", "who dropped".
  /^(?:is|are) (?:everyone|everybody|we all|all|anyone else|anybody else) (?:here|ready|on the call|on this call|on|in|joining|coming|set|good)(?: yet| now| to (?:start|begin|go|get started))?$/iu,
  /^(?:is|are) (?!(?:it|this|that|there|the|a|an|my|your|our)\b)[\p{L}'.-]+ (?:joining|coming|here|on the call|on this call|dialing in|dialling in|on yet|online)(?: us| in| yet| today| now| soon| late| too| as well| this (?:morning|afternoon))*$/iu,
  /^(?:are we|is (?:anyone|anybody)) (?:still )?(?:waiting (?:on|for) (?:anyone|anybody|someone|somebody|others|everyone)|missing (?:anyone|anybody|someone|somebody)|expecting (?:anyone|anybody|someone) else)$/iu,
  /^who(?: just| else| also)*(?:'s| is| are)?(?: just| else| also)* (?:joined|left|dropped(?: off| out)?|dialed in|dialled in|jumped on|here|on(?: the| this)? (?:call|line)|on|speaking|talking|joining|coming|missing)(?: us| the call| just now| now| there| again)*$/iu,
  // Small requests: "can you scroll down a bit", "can you put the link in the chat", "can you go back one slide".
  new RegExp(`^(?:can|could|would|will) ${AUDIENCE} (?:please )?(?:${REQUEST_ACTIONS.join('|')})(?: please| again| now| for (?:me|us)| a (?:bit|little)| one more time| quickly| real quick| quick)*$`, 'iu'),
  // "sorry, what was that"
  /^(?:what|pardon|say again|come again|huh|sorry)(?: was that| did you say| did you just say| was that again)?$/iu,
  // Small talk.
  /^how(?:'s| is| are) (?:it going|everyone(?: doing)?|everybody(?: doing)?|you(?: all| guys)?(?: doing)?|things|your (?:day|week|weekend|morning|afternoon))(?: today| so far| this morning)?$/iu,
  /^how was your (?:weekend|holiday|holidays|vacation|trip|day|week|morning|flight|commute|break)(?: so far| today)?$/iu,
  /^(?:does|did|will|do) (?:that|this|it|all (?:of )?that|all this) make sense(?: to (?:everyone|everybody|you|all|you all|you guys|folks))?(?: so far| there)?$/iu,
  /^(?:any|anything)(?: else| other| more)?(?: questions| business)?$/iu,
  /^(?:are we|is everyone|is everybody|everyone|everybody) (?:all )?(?:good|set|clear|ok(?:ay)?)(?: on that| with that| there)?$/iu,
];

function isLogistics(flatSentence) {
  if (words(flatSentence) > LOGISTICS_MAX_WORDS) return false;
  const body = flatSentence.replace(LOGISTICS_PREFIX, '').replace(/[\s?.!\u3002\uFF01]+$/, '');
  return LOGISTICS.some((r) => r.test(body));
}

// ---------------------------------------------------------------- asking

// "That makes sense, right?" asks nothing.
const TAG = /,?\s+(?:right|ok(?:ay)?|correct|yeah|no|huh|eh|you know|you know what i mean|isn'?t it|doesn'?t it|don'?t you think|make sense|yes)\s*\?$/i;
const FILLER_ONLY = /^(?:right|ok(?:ay)?|you know(?: what i mean)?|yeah|yes|no|sure|really|hm+|huh|sorry|what|pardon|isn'?t it|aren'?t they|make sense)[?.! ]*$/i;
const SINGLE_WORD_ASKS = new Set(['thoughts', 'blockers', 'concerns', 'questions', 'objections', 'updates', 'update', 'status', 'eta', 'opinions', 'feedback']);

// Asking without a question mark.
const INDIRECT = [
  /\b(?:walk|talk|take) (?:us|me) through\b/i,
  /^(?:please |can you |could you )?(?:tell|show|remind|give|share|send) (?:us|me)\b/i,
  /\bi'?d like to (?:hear|know|understand|see)\b/i,
  /\bit would help to (?:know|hear|understand)\b/i,
  /\bi(?:'m| am| was)?\s+(?:wondering|curious)\b/i,
  /\b(?:i'?m|i am|we'?re|we are) not (?:sure|clear) (?:what|how|why|whether|if)\b/i,
  /\bwhat are your (?:thoughts|views|concerns)\b/i,
  /\b(?:any|are there any) (?:concerns|objections|blockers|questions|thoughts|feedback|updates?)\b/i,
  /\blet'?s hear from\b/i,
  /\bover to you\b/i,
  /\bwant to (?:add|weigh in|jump in|chime in)\b/i,
];
const NEGATION = /\b(?:no|not|don'?t|doesn'?t|didn'?t|haven'?t|without|never|nothing)\b/i;

// The shape of a spoken question when nothing marks it as one.
const SHAPES = [
  /^(?:what|why|how|who|which)\s+(?:is|are|was|were|do|does|did|can|could|would|should|will|has|have|owns|handles|runs|approves|decides|signs|reviews)\b/i,
  /^where\s+(?:is|are|do|does|did|can|could|would|should|will)\b/i,
  /^when\s+(?:is|are|do|does|did|can|could|would|should|will)\s+(?:the|we|you|it|this|that|they|our)\b/i,
  /^how\s+(?:long|much|many|often|soon|big|far|come)\b/i,
  /^(?:can|could|would|should|do|does|did|is|are|will|have|has)\s+(?:you|we|i|they|it|this|that|there|anyone|someone|everyone|he|she)\b/i,
];
// Words that cannot end a sentence a person has finished saying. Spoken text with no punctuation
// that stops on one of them was cut off ("What do you think about" ... "moving the deploy to
// Thursday?"): the first half is not yet a question. Words that can end a whole question
// ("what should we do", "what is this", "who said that", "what could it be") are left out.
const DANGLING = new Set(['a', 'an', 'the', 'about', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'and', 'or', 'but', 'nor', 'if', 'which', 'is', 'are', 'was', 'were', 'am', 'can', 'could', 'would', 'should', 'will', 'shall', 'might', 'may', 'must', 'does', 'has', 'had', 'my', 'your', 'our', 'their', 'his', 'its', 'than', 'as', 'into', 'onto', 'under', 'between', 'during', 'because', 'while', 'whether']);
const LAST_WORD = /([\p{L}\p{M}']+)[\s,;:…—–-]*$/u;
// "what are you talking about", "what's going on": a preposition after an -ing verb ends a finished question.
const STRANDED_OK = /\b\p{L}+ing\s+(?:about|for|at|on|with|in)[\s,;:…—–-]*$/iu;
function endsMidSentence(core) {
  const m = LAST_WORD.exec(core);
  return Boolean(m) && DANGLING.has(m[1].toLowerCase()) && !STRANDED_OK.test(core);
}
const CLAUSE_SPLIT = /\b(?:and|so|but|okay|ok|right|yeah|then|sorry|well)[,\s]+/i;

// Where a spoken question can end: "?" (the fullwidth, Arabic and Greek marks
// were turned into it by `flatten` / `canonical`) and a leading Spanish "¿".
const opensQuestion = (s) => s.startsWith('\u00BF');

// ---------------------------------------------------------------- names

// Names that are also ordinary words. "Will what we deployed break?" is about
// a deployment, not a request to Will, so these names are only an address when
// the name is set off from the rest of the sentence (a comma, a colon, a dash)
// or is followed by "can you / will you ...", never by a bare question word.
const ORDINARY_WORD_NAMES = new Set(['will', 'mark', 'may', 'grant', 'dev', 'art', 'bill', 'rob', 'pat', 'sue', 'rich', 'hope', 'faith', 'grace', 'joy', 'rose', 'summer', 'dawn', 'eve', 'ray', 'jack', 'drew', 'chase', 'cash', 'frank', 'guy', 'don', 'page']);

// Unicode-aware word edges: \b only knows ASCII letters, so "José" and "Мария"
// would never end on a boundary.
const NOT_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_AFTER = '(?![\\p{L}\\p{N}])';
// "Tanaka-san" and "田中さん" are the name, said politely.
const HONORIFIC = '(?:-san|さん|様|さま|君|くん|ちゃん|先生)';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lowerKey = (s) => s.replace(/\s+/g, ' ').toLowerCase();
const letterCount = (s) => (s.match(/\p{L}/gu) || []).length;
const cleanName = (raw) => flatten(canonical(raw == null ? '' : String(raw))).replace(/\s+/g, ' ').trim();
const TITLE_WORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof']);
const isTitleWord = (w) => TITLE_WORDS.has(w.toLowerCase().replace(/\.+$/, ''));

// The user's own names: each one as given, plus the first and the last word of
// a name of several words ("Ade Okoye" is also "Ade" and "Okoye"). A single
// initial ("A.") or bare honorific ("Dr.") is not a name.
function userNames(names) {
  const out = [];
  const seen = new Set();
  const add = (n) => {
    const key = lowerKey(n);
    if (n.length >= 2 && !isTitleWord(n) && !seen.has(key)) { seen.add(key); out.push(n); }
  };
  for (const raw of names || []) {
    const name = cleanName(raw);
    const parts = name.split(' ');
    if (parts.every(isTitleWord)) continue;
    add(name);
    if (parts.length < 2) continue;
    const nonTitles = parts.filter((p) => !isTitleWord(p));
    if (!nonTitles.length) continue;
    const picks = nonTitles.length >= 2 ? [nonTitles[0], nonTitles[nonTitles.length - 1]] : [nonTitles[0]];
    for (const part of picks) if (letterCount(part) >= 2) add(part);
  }
  return out;
}

// The other people in the meeting, as { name, alts }: what to call each one
// and the words that may stand for it ("Priya Nair" is also "Priya").
// Anyone who is the user (by name or alias, or by first name) is left out.
function otherPeople(others, mine) {
  const out = [];
  const seen = new Set();
  for (const raw of others || []) {
    const name = cleanName(raw);
    const lower = lowerKey(name);
    const parts = name.split(' ');
    if (name.length < 2 || parts.every(isTitleWord) || mine.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    const alts = [name];
    const nonTitles = parts.filter((p) => !isTitleWord(p));
    const first = nonTitles[0] || '';
    if (first && first !== name && letterCount(first) >= 2 && !mine.has(lowerKey(first))) alts.push(first);
    out.push({ name, alts });
  }
  return out;
}

// How `text` can address a person. Words that may come before the name:
const LEAD_WORDS = 'hey|hi|hello|ok(?:ay)?|so|and|but|well|alright|all right|oh|sorry|excuse me|pardon me|good morning|good afternoon|good evening|yes|yeah|yep|yup|right|now|um|uh|er|hmm|please';
const LEAD = `(?:(?:${LEAD_WORDS}|thanks|thank you)[,\\u060C\\s]+)*`;
const LEAD_NO_THANKS = `(?:(?:${LEAD_WORDS})[,\\u060C\\s]+)*`;
// "Quick question for Ade:", "A question for Ade.", "This one is for Ade.", "For Ade:".
const FOR_PREFIX = '(?:(?:(?:a|one|my|another)\\s+)?(?:(?:quick|small|short|fast)\\s+)?(?:question|one|ask|point|thing)\\s+for|(?:this|that|the next|my next)\\s+(?:one|question)\\s+is\\s+for|for)\\s+';
// What may follow a name that is being spoken to: a comma, colon or dash (also
// the Arabic and ideographic commas), or the end of the sentence.
const AFTER_NAME = '(?=\\s*(?:[,\\u060C\\u3001\\uFF0C:\\uFF1A;?!.\\u2026\\u2014\\u2013]|-{2,}|-(?=\\s))|\\s*$)';
const MODAL_YOU = ',?\\s+(?:can|could|would|will|do|did|are|is)\\s+you\\b';
// A bare question word straight after the name: "Ade what do you think?".
const QUESTION_OPENERS = '(?:what|how|why|when|where|who|whose|which|can|could|would|should|does|do|did|are|is|has|have|will|any)';
// A name in the middle of a question: "What do you think, Ade, about the rollout?".
// Two commas around a name are an address only when the words before the first
// comma already open a question (no comma of their own, and not ending in a
// capitalised word, which would be a list item: "Who invited Tom, Ade, ...").
// What follows the second comma must not carry on a list ("Is it platform, Ade,
// or security?", "..., Ade, and Priya") and must be more than one bare word
// ("Is it platform, Ade, security?" is a list of three, "What do you think,
// Ade, about it?" is not). Because both commas are there, this holds for names
// that are ordinary words too.
const COMMA = '[,\\u060C\\u3001\\uFF0C]';
const MID_QUESTION_OPENERS = `(?:${QUESTION_OPENERS}|thoughts)`;
const MID_LIST_TAIL = `(?!\\s*(?:(?:and|or|nor|but)(?![\\p{L}\\p{N}])|&))(?!\\s*[^\\s,\\u060C\\u3001\\uFF0C]+\\s*(?:${COMMA}|[?!.]*\\s*$))`;
const TERMINAL_STATEMENT = /[.!\u3002\uFF01\u2026]\s*$/;
const TERMINAL_PUNCTUATION = /[?.!\u3002\uFF01\u2026]\s*$/;
// A bare name followed by an opener, with no punctuation anywhere ("Ade what do
// you think"), is a question only when what follows the name has the shape of
// one: the opener and then a subject or a wh-word ("what do", "can you", "how
// long"), so "Ade can do it" and "Ade did the rollout" stay statements.
const isQuestionShaped = (rest) => words(rest) >= 3 && SHAPES.some((r) => r.test(rest));

const LIST_SEPARATOR = '(?:\\s*[,\\u060C\\u3001\\uFF0C&+]\\s*(?:and\\s+)?|\\s+and\\s+)';
const MAX_LIST_EXTRA_NAMES = 5; // "Ade, Priya, Tom and Sam": bounds the work on a wall of names

// "ask / check with / loop in / hear from / over to / defer to" a name.
const HANDOVER_VERBS = 'ask|check with|loop in|hear from|over to|defer to';
// Said now, these hand the floor to the person. Said as a plan or a report
// they only mention them.
const PLAN_BEFORE = /(?:'ll|\bwill|\bwould|\bgoing to|\bgonna|\bneed to|\bhave to|\bplan to)\s+(?:(?:also|just|then|probably|still|really|definitely)\s+)*$/i;
const PLAN_EXEMPT_VERBS = new Set(['defer to', 'over to']); // "I'll defer to Ade on that" is a hand-over
const LATER_AFTER = /^(?:(?:again|too|then|just|also|first)\s+)?(?:later|tomorrow|tonight|soon|sometime|offline|separately|yesterday|earlier|next\s+(?:week|month|quarter|sprint|year|time|call|meeting|standup|session)|this\s+(?:afternoon|evening|week|weekend)|after\s+(?:the|this|that|today|our|we|i|lunch|everyone|everybody)\b|(?:on|by|until|till)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|by\s+(?:end of|eod|the end)|in\s+(?:a|an|\d+|one|two|three|a few|a couple of)\s+(?:minutes?|hours?|days?|weeks?|months?)\b)/i;

const YOU = Symbol('you');
const NO_ADDRESS = Object.freeze({ spokenFrom: 0, bare: false, you: false, handYou: false, onlyYou: false, others: [], onlyOthers: [] });

// Everything the rules need to know about the people in one call, compiled once
// (analyzeTurn runs on every transcript result with the same names).
class Matcher {
  constructor(names, others) {
    const mine = userNames(names);
    this.people = otherPeople(others, new Set(mine.map(lowerKey)));
    this.owners = new Map(); // lower-case name -> YOU or the other person's name
    const alts = [];
    const plain = []; // those that are not ordinary words
    const add = (alt, owner) => {
      const key = lowerKey(alt);
      if (this.owners.has(key)) return;
      this.owners.set(key, owner);
      alts.push(alt);
      if (!ORDINARY_WORD_NAMES.has(key)) plain.push(alt);
    };
    mine.forEach((n) => add(n, YOU));
    this.people.forEach((p) => p.alts.forEach((a) => add(a, p.name)));
    this.empty = alts.length === 0;
    if (this.empty) return;

    const pattern = (list) => list.sort((a, b) => b.length - a.length).map((a) => escapeRe(a).replace(/ /g, '\\s+')).join('|');
    const name = (list) => `${NOT_BEFORE}(?:${pattern(list)})(?:${HONORIFIC})?${NOT_AFTER}`;
    const NAME = name(alts);
    const LIST = `${NAME}(?:${LIST_SEPARATOR}${NAME}){0,${MAX_LIST_EXTRA_NAMES}}`;
    this.nameScan = new RegExp(`${NOT_BEFORE}(${pattern(alts)})(?:${HONORIFIC})?${NOT_AFTER}`, 'giu');
    // Spoken to, at the start of the sentence: "Ade,", "Oh Ade,", "For Ade:", "Ade and Priya,".
    this.atStart = new RegExp(`^${LEAD}(?:${FOR_PREFIX})?(${LIST})${AFTER_NAME}`, 'iu');
    this.beforeModal = new RegExp(`^${LEAD_NO_THANKS}(${LIST})(${MODAL_YOU})`, 'iu');
    // "Ade what do you think?" (not for names that are ordinary words). The
    // opener is only looked at, not consumed, so that what follows the name can
    // be judged on its own.
    const bareOpener = (last) => new RegExp(`^${LEAD_NO_THANKS}((?:${NAME}${LIST_SEPARATOR}){0,${MAX_LIST_EXTRA_NAMES}}${last})\\s+(?=${QUESTION_OPENERS}\\b)`, 'iu');
    this.beforeOpener = plain.length ? bareOpener(name(plain)) : null;
    // The same position for any name, ordinary words included: "Mark what is the
    // ETA" is a question, but it is not put to Mark.
    this.beforeAnyOpener = plain.length < alts.length ? bareOpener(NAME) : null;
    // "What do you think, Ade, about the rollout?" (see MID_LIST_TAIL).
    this.between = new RegExp(`^${LEAD_NO_THANKS}${MID_QUESTION_OPENERS}\\b([^,\\u060C\\u3001\\uFF0C]*)${COMMA}\\s*(${LIST})\\s*${COMMA}${MID_LIST_TAIL}`, 'iu');
    // At the end of the sentence: "What do you think, Ade?".
    this.atEnd = new RegExp(`[,\\u060C\\u3001\\uFF0C]\\s*(${LIST})\\s*[?!.]*\\s*$`, 'iu');
    this.handover = new RegExp(`${NOT_BEFORE}(${HANDOVER_VERBS})\\s+(${LIST})(?!'s?${NOT_AFTER})`, 'giu');
  }

  ownersIn(listText) {
    const out = [];
    for (const m of listText.matchAll(this.nameScan)) {
      const owner = this.owners.get(lowerKey(m[1]));
      if (owner !== undefined && !out.includes(owner)) out.push(owner);
    }
    return out;
  }

  // Who `s` (one flattened sentence) is spoken to, or hands the floor to.
  parse(s) {
    if (this.empty) return NO_ADDRESS;
    const hits = []; // { at, owner } in the order they are said
    let you = false; // spoken to, as opposed to handed over to
    const take = (at, listText) => this.ownersIn(listText).forEach((owner) => { if (owner === YOU) you = true; hits.push({ at, owner }); });
    const marked = s.endsWith('?') || opensQuestion(s);

    let only = null; // the people addressed, when the sentence is nothing but that
    let spokenFrom = 0; // where what is said begins, after "Priya, "
    const start = this.atStart.exec(s);
    if (start) {
      take(0, start[1]);
      const rest = s.slice(start[0].length);
      const separator = /^[\s,\u060C\u3001\uFF0C:\uFF1A;?!.\u2026\u2014\u2013-]*/.exec(rest)[0];
      spokenFrom = start[0].length + separator.length;
      if (separator.length === rest.length) only = this.ownersIn(start[1]);
    }
    const modal = this.beforeModal.exec(s);
    if (modal) take(0, modal[1]);
    const opener = marked && this.beforeOpener ? this.beforeOpener.exec(s) : null;
    if (opener) take(0, opener[1]);
    const end = this.atEnd.exec(s);
    if (end) take(end.index, end[1]);
    const middle = TERMINAL_STATEMENT.test(s) ? null : this.between.exec(s);
    if (middle && !/(?:^|\s)\p{Lu}\S*\s*$/u.test(middle[1])) take(middle.index + middle[0].length, middle[2]);

    // No punctuation at all: a name and an opener, then what the shape of the
    // rest says ("Ade what do you think", "Ade, can you take that one"). Only a
    // name that is not an ordinary word, or is set off from the sentence, is an
    // address; for the others it is a question to the room.
    let bare = false;
    if (!TERMINAL_PUNCTUATION.test(s) && !opensQuestion(s)) {
      const rests = [];
      if (start) rests.push(s.slice(spokenFrom));
      if (modal) rests.push(s.slice(modal[0].length - modal[2].length).replace(/^[\s,،、，]+/, ''));
      const plainOpener = this.beforeOpener ? this.beforeOpener.exec(s) : null;
      const anyOpener = plainOpener || (this.beforeAnyOpener ? this.beforeAnyOpener.exec(s) : null);
      if (anyOpener && isQuestionShaped(s.slice(anyOpener[0].length))) {
        bare = true;
        if (plainOpener) take(0, plainOpener[1]);
      }
      bare = bare || rests.some(isQuestionShaped);
    }

    const hand = []; // valid hand-overs
    for (const m of s.matchAll(this.handover)) {
      if (!isHandover(s, m)) continue;
      this.ownersIn(m[2]).forEach((owner) => { hand.push(owner); hits.push({ at: m.index, owner }); });
    }

    if (!hits.length) return bare ? { ...NO_ADDRESS, bare } : NO_ADDRESS;
    hits.sort((a, b) => a.at - b.at);
    const others = [];
    for (const h of hits) if (h.owner !== YOU && !others.includes(h.owner)) others.push(h.owner);
    return {
      spokenFrom,
      bare,
      you,
      handYou: hand.includes(YOU),
      onlyYou: Boolean(only) && only.includes(YOU),
      others,
      onlyOthers: only ? only.filter((o) => o !== YOU) : [],
    };
  }
}

// Is this "ask Ade" a hand-over now, or a plan, a report or a possessive?
function isHandover(s, m) {
  const verb = m[1].toLowerCase();
  const after = s.slice(m.index + m[0].length);
  const direct = after.trimStart().startsWith(':'); // "I'll ask Ade: what is the plan?" asks right away
  if (!direct && !PLAN_EXEMPT_VERBS.has(verb) && PLAN_BEFORE.test(s.slice(0, m.index))) return false;
  const segment = after.replace(/^\s+/, '').split(/[:;,?!.]/)[0];
  return !LATER_AFTER.test(segment);
}

// The compiled rules for one set of names, remembered because the names hardly
// ever change between one result and the next.
const matchers = new Map();
const MATCHER_CACHE_SIZE = 8;
function matcherFor(names, others) {
  const key = JSON.stringify([(names || []).map(String), (others || []).map(String)]);
  let m = matchers.get(key);
  if (!m) {
    if (matchers.size >= MATCHER_CACHE_SIZE) matchers.delete(matchers.keys().next().value);
    m = new Matcher(names, others);
    matchers.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------- one sentence

// { asking, from, to } for one flattened sentence: whether it asks, and which
// part of it carries the question (the whole sentence, or one clause of it).
// `p` is what parse() found in it.
function classifyFlat(s, p) {
  const out = { asking: false, from: 0, to: s.length };
  if (!s || FILLER_ONLY.test(s)) return out;
  // Housekeeping ("Priya, can you hear me?" is ignored), unless it is spoken
  // to the user by name: "Ade, can you hear me?" is for Ade.
  if (!p.you && isLogistics(s.slice(p.spokenFrom))) return out;

  if (s.replace(TAG, '.') !== s) return out; // a tag question on a statement

  const core = s.replace(FILLER_PREFIX, '') || s;
  const coreAt = s.length - core.length;
  const last = core.slice(-1);
  // No punctuation and cut off in the middle of a sentence: not (yet) a question, however it began.
  if (!/[?.!。！]/.test(last) && !opensQuestion(core) && endsMidSentence(core)) return out;
  const indirect = INDIRECT.some((r) => {
    const m = r.exec(core);
    if (!m) return false;
    return !NEGATION.test(core.slice(0, m.index));
  });

  if (last === '?' || opensQuestion(core)) {
    const bare = core.replace(/[?\s]+$/, '').toLowerCase();
    if (longEnough(core) || SINGLE_WORD_ASKS.has(bare) || p.you) out.asking = true;
    return out;
  }
  if (indirect) { out.asking = true; return out; }
  if (last === '.' || last === '!' || last === '\u3002' || last === '\uFF01') return out; // punctuated as a statement

  if (p.bare) { out.asking = true; return out; } // a name and an opener, judged by shape in parse()

  // No punctuation: judge by shape, clause by clause.
  const clauses = [core, ...core.split(CLAUSE_SPLIT).slice(1)];
  let searchFrom = 0;
  for (const c of clauses) {
    const t = c.trim();
    const at = core.indexOf(t, searchFrom);
    if (at >= 0) searchFrom = at + t.length;
    if (words(t) >= 3 && SHAPES.some((r) => r.test(t))) {
      out.asking = true;
      if (at >= 0) { out.from = coreAt + at; out.to = coreAt + at + t.length; }
      return out;
    }
  }
  return out;
}

// { asking, ask } for one sentence.
function classify(sentence, names) {
  const shown = canonical(sentence).trim();
  const c = classifyFlat(flatten(shown), matcherFor(names, []).parse(flatten(shown)));
  return { asking: c.asking, ask: shown.slice(c.from, c.to) };
}

function splitSentences(text) {
  const shown = canonical(text);
  return sentenceSpans(flatten(shown)).map(([a, b]) => shown.slice(a, b));
}

// Is `text` addressing one of `names`?
function mentionsAny(text, names) {
  const m = matcherFor(names, []);
  return splitSentences(text).some((s) => {
    const p = m.parse(flatten(s));
    return p.you || p.handYou;
  });
}

const MODES = ['manual', 'mine', 'questions', 'proactive'];

// Returns { fire, question, mentioned, reason, ask, target, addressee, why, pass }.
// `ask` is the sentence that carries the question.
// `target` says who the question is for: 'you', 'other' (put to someone else by
// name, `addressee`) or 'room' (anyone); '' when nothing was asked. `why` says
// how it was known to be for you. `pass` is true when there is a question the
// mode chose not to answer, so the app can offer it instead of answering it.
// `others` are the other people known to be in the meeting; `context` says
// whether it is a one-to-one call and whether you spoke just before this.
function analyzeTurn(text, { names = [], mode = 'questions', others = [], context = {} } = {}) {
  const clean = String(text || '').trim();
  const res = { fire: false, question: false, mentioned: false, reason: '', ask: clean, target: '', addressee: '', why: '', pass: false };
  if (!clean) return res;

  const shown = canonical(clean);
  const flat = flatten(shown);
  const matcher = matcherFor(names, others);
  const rows = sentenceSpans(flat).map(([a, b]) => {
    const s = flat.slice(a, b);
    const p = matcher.parse(s);
    return { a, s, p, c: classifyFlat(s, p) };
  });

  // Which asking sentence is for you? If any asking sentence in the turn is,
  // you win (the last such sentence); otherwise the last asking sentence is
  // the one judged. A sentence is for you when it addresses you, when the
  // sentence before it is only your name, or when it hands over to you.
  let lastAsk = -1, youAsk = -1, youWhy = '', handedYouAt = -1;
  rows.forEach((row, i) => {
    const before = i > 0 ? rows[i - 1].p : null;
    if (row.p.you || row.p.handYou) res.mentioned = true;
    if (row.p.handYou) handedYouAt = i;
    if (!row.c.asking) return;
    lastAsk = i;
    if (row.p.you || (before && before.onlyYou)) { youAsk = i; youWhy = 'name'; }
    else if (row.p.handYou) { youAsk = i; youWhy = 'directed'; }
  });
  res.question = lastAsk >= 0 || handedYouAt >= 0;
  const shownAsk = (i) => { const r = rows[i]; return shown.slice(r.a + r.c.from, r.a + r.c.to); };

  if (res.question) {
    if (youAsk >= 0) {
      res.target = 'you'; res.why = youWhy; res.ask = shownAsk(youAsk);
    } else if (handedYouAt > lastAsk) { // a hand-over to you ("Over to Ade."), even after an earlier question
      res.target = 'you'; res.why = rows[handedYouAt].p.you ? 'name' : 'directed';
      if (lastAsk >= 0) res.ask = shown.slice(rows[lastAsk].a + rows[lastAsk].c.from);
    } else {
      // Judged on the sentence that asks, and on the one just before it.
      res.ask = shownAsk(lastAsk);
      const sentence = rows[lastAsk].p;
      const before = lastAsk > 0 ? rows[lastAsk - 1].p : null;
      const other = sentence.others[0] || (before && before.onlyOthers[0]) || '';
      if (other) { res.target = 'other'; res.addressee = other; }
      else if (res.mentioned) { res.target = 'you'; res.why = 'name'; }
      else if (context && context.oneToOne) { res.target = 'you'; res.why = 'one-to-one'; }
      else if (context && context.afterMe) { res.target = 'you'; res.why = 'after-you'; }
      else res.target = 'room';
    }
  }

  if (mode === 'manual') { res.reason = 'manual mode'; return res; }
  if (res.question) {
    res.fire = mode === 'mine' ? res.target === 'you' : res.target !== 'other';
    res.pass = !res.fire;
    res.reason = res.target === 'you' ? 'question to you' : res.target === 'other' ? 'question to someone else' : 'question';
    return res;
  }
  res.reason = res.mentioned ? 'mentioned' : 'statement';
  return res;
}

module.exports = { analyzeTurn, mentionsAny, splitSentences, classify, MODES };
