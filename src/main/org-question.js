'use strict';
// Guard against invented company facts (see prompts.js, userPrompt's guard, and session.js _generate).
//
// isOrgQuestion(text) says whether a spoken question asks for a fact about the user's own organisation: what is in use,
// counts, dates, owners, history, status, what someone has open. Only their files or the meeting can answer that, so the
// reply must not state it from the model's own guess. Design:
//   - No model call and no latency: a list of rules over the lower-cased, filler-stripped sentence.
//   - Precision over recall. A miss leaves the model's default behaviour (the system prompt still defers such questions and
//     the lighter guard still applies); a false hit defers a question the user is expected to answer. So how-it-works,
//     should-we, what-would-you and meeting-logistics questions must never fire. On the labelled fixtures
//     (test/fixtures/org-questions.json) it fires on none of the professional and housekeeping sentences and on most
//     organisational ones; the test holds the measured floor.
//   - orgRule(text) returns the name of the rule that fired, or '' (for tests and debugging).
const norm = (t) => ` ${String(t || '').toLowerCase().replace(/[’`]/g, "'")
  .replace(/\b(what|who|where|when|how|that|it|there)'?s\b/g, '$1 is').replace(/\b(we|you)'re\b/g, '$1 are').replace(/\b(we|you)'ve\b/g, '$1 have')
  .replace(/[^a-z0-9' ]+/g, ' ').replace(/\b(?:u[hm]+|erm*|hmm+|you know|i mean|sort of|kind of)\b/g, ' ').replace(/\s+/g, ' ').trim()} `;
const ADV = '(?:still |really |even |also |all |now |then |ever |actually |already |currently |just |guys |folks )*';
// Meeting logistics: never an organisation fact. Narrowed so "recording logs", "offline backups" or "licences left" are not mistaken for housekeeping.
const HOUSE = /\b(?:time (?:do we have|have we got)|(?:time|minutes?|mins?) (?:(?:do|have) we (?:have |got )?)?left|(?:have|got) (?:\w+ )?(?:time|minutes?|mins?) left|(?:see|share|sharing) (?:my|your|the) screen|hear me|on mute|taking (?:the )?(?:notes|minutes)|recording (?:this|the (?:call|meeting|session)|today)|are we recording $|agenda|next (?:meeting|call|sync|slot)|(?:take|taking) (?:this|it|that) offline|move on|a (?:quick )?(?:minute|moment|sec|second)|on the call|dial(?:led)? in|the invite|hard stop)\b/;
// Advice words: a span holding one of these is a recommendation or product question, not a question of fact.
const ADVICE = /\b(?:should|would|could|can|shall|need|best|right way|safe|recommend\w*|better|worth|sensible|good idea|by default|supported|generally available|deprecated)\b/;
// Hypothetical conditions ("If we pin by SHA, do we still get updates?"): not an org fact unless anchored to current reality ("today", "already").
const COND_BEFORE = /\b(?:if|suppos(?:e|ing)|assuming) (?:we|you|our|your)\b/;
const REAL_NOW = /\b(?:today|currently|right now|at the moment|these days|already)\b/;
const isHypo = (before, rest) => COND_BEFORE.test(before) && !REAL_NOW.test(`${before} ${rest}`);
// After "do/did/are/have we": verbs that make it a judgement, a how-to or logistics rather than a practice.
const NOT_WE = new RegExp(`^ ${ADV}(?:need|want|have to|care|think|agree (?:that|then|$)|trust|risk|better off|sure|saying|talking|overthinking|ok\\b|okay|good\\b|done\\b|happy|all set|waiting for (?:anyone|someone|people|others)|starting|ready|finished\\b|lose|lost|cover|covered|get through|miss|consider|considered|thought about|think about|mean|expect|feel|prefer|have (?:time|anything else|any other|any more|more questions|everyone|quorum|a view|an opinion)|know (?:if|whether|what|why|how) (?!many|much|often))`);
const HOWTO = new RegExp(`^ ${ADV}(?:best |then |now )*(?:fix|solve|stop|prevent|avoid|get|make|go about|move|migrate|roll|approach|ensure|mitigate|improve|tackle|address|deal with|find out|tell|prove|check|verify|start|begin|set up|configure|enable|implement|test|debug|do (?:that|this|it)\\b)`);
// After "do/did/are/have you": only verbs that ask what the user's side runs, holds or did ("you" is often generic).
const YOU_OK = new RegExp(`^ ${ADV}(?:us(?:e|ing|ed)|run|running|ran|have (?!a (?:view|take|preference|opinion|feeling|sense|recommendation|favourite|rule of thumb)|an opinion|any (?:thoughts|views|preference|concerns|questions|recommendations|advice|tips|ideas?|objections)|time|to\\b)|had|stor(?:e|ing)|keep|keeping|sign|signing|scan|scanning|deploy(?:ing|ed)?|rotat(?:e|ing|ed)|enforc(?:e|ing)|host|hosting|own|log|logging|monitor(?:ing)?|track(?:ing)?|patch(?:ing)?|test(?:ing|ed)|tried|try|evaluat(?:e|ed|ing)|looked at|look at|rolled|roll out|enabled?|migrated?|started|finish(?:ed)?|done|been through|review(?:ed)?|raised?|open(?:ed)?|fix(?:ed)?|check(?:ed)?|sen[dt]|decided?|pick(?:ed)?|choose|chose|on\\b|planning|doing|going to|get a chance|manag(?:e|ing)|handl(?:e|ing)|block(?:ing)?|requir(?:e|ing)|pin(?:ning)?|encrypt(?:ing)?|back(?:ing)? up)`);
const NOT_POSS = '(?!best|only|next|main|biggest|view|take|opinion|thinking|preference|recommendation|advice|thoughts|concern|worry|point|question|screen|mic|camera|audio|video|hand|approach\\b|experience|stance|position|feeling|read\\b|gut|options?\\b|alternative|favourite|name)';
const each = (s, re, ok) => { for (const m of s.matchAll(re)) if (ok(s.slice(m.index + m[0].length), m, s.slice(0, m.index))) return true; return false; };

const POSS_FAST = new RegExp(`\\b(?:do|does|did|is|are|was|were|has|have|had)(?:n't)? (?:our|your) ${NOT_POSS}\\w+`);
const POSS_RE = new RegExp(`\\b(do|does|did|is|are|was|were|has|have|had)(?:n't)? (?:our|your) ${NOT_POSS}\\w+`, 'g');
const WHATOUR_FAST = new RegExp(`\\bwhat (?:is|are|was|were) (?:our|your) ${NOT_POSS}\\w+`);
const WHATOUR_RE = new RegExp(`\\bwhat (is|are|was|were) (?:our|your) ${NOT_POSS}\\w+`, 'g');

const RULES = [
  // Practice, state and history: "do we use", "did we evaluate", "are we still deploying by tag", "how do we rotate".
  ['we', (s, cond) => each(s, /\b(do|did|are|were|have|had)(?:n't)? we\b/g, (rest, m, before) => !NOT_WE.test(rest)
    && !(cond && (m[1] === 'do' || m[1] === 'are' || m[1] === 'have') && isHypo(before, rest))
    && !(m[1] === 'do' && /\bhow $/.test(before) && HOWTO.test(rest)) && !(m[1] === 'do' && /\bwhat $/.test(before) && /^ (?:do|need|say)\b/.test(rest)) && !(m[1] === 'do' && /^ (?:\w+ )?go\b/.test(rest)))],
  // "do you use", "have you tried", "did you get a chance", "are you still on": not after "how" (generic you).
  ['you', (s, cond) => each(s, /\b(do|did|are|were|have|had) you\b/g, (rest, m, before) => YOU_OK.test(rest)
    && !(cond && (m[1] === 'do' || m[1] === 'are' || m[1] === 'have') && isHypo(before, rest))
    && !(/^do you$/.test(m[0]) && /\b(?:how|when|why|where) $/.test(before)))],
  // "does our pipeline", "has your squad", "how does your team", "what is our RTO".
  ['poss', (s, cond) => (cond ? each(s, POSS_RE, (rest, m, before) => !(/^(?:do|does|is|are|has|have)$/.test(m[1]) && isHypo(before, rest))) : POSS_FAST.test(s))],
  ['whatour', (s, cond) => (cond ? each(s, WHATOUR_RE, (rest, m, before) => !(/^(?:is|are)$/.test(m[1]) && isHypo(before, rest))) : WHATOUR_FAST.test(s))],
  // Counts and frequency of our things, unless it asks what the number should be.
  ['count', (s, cond) => each(s, /\bhow (?:many|much|often|long|far|big|old)\b(.{0,90}?)\b(?:we|our|ours|us|you guys|your (?:team|squad|side|org|clusters?|pipelines?|repos?|estate|environment|tenant|subscriptions?))\b/g,
    (rest, m, before) => !ADVICE.test(m[1]) && !/^ (?:need|want|have to)\b/.test(rest) && !(cond && isHypo(before, `${m[1]} ${rest}`)))],
  // "which version of Kyverno is on our clusters", "what is running in our prod".
  ['where', (s, cond) => each(s, /\b(?:which|what) (.{0,50}?\b(?:is|are|was|were|runs?|running)\b.{0,30}?)\b(?:on|in|across|for|at) (?:our|your)\b/g, (rest, m, before) => !ADVICE.test(m[1]) && !(cond && isHypo(before, `${m[1]} ${rest}`)))],
  // Ownership and who did it.
  ['who', (s) => /\bwho (?:currently |still |actually |now )?(?:owns?|owned|approved|approves|holds?|decided|decides|signed off|signs off|maintains|manages|runs|looks after|has access|has (?:that|this|it|the \w+) open|is on call|is responsible|is accountable|is the owner|is looking after|is leading|leads|is driving|picked|chose|wrote|built|set up|configured|is doing|is handling|do (?:i|we) (?:ask|talk to|go to))\b/.test(s)
    && !/\b(?:us or|or us|or (?:is (?:it|that) )?(?:microsoft|azure|aws|google|the (?:vendor|provider|cloud provider)))\b/.test(s)],
  // History told as a clause, "which of our", "ours".
  ['hist', (s) => /\b(?:when|after|since|before|until) we (?:tried|rolled|moved|migrated|switched|enabled|enforced|turned|did|had|ran|went|last|first|started|introduced|adopted|dropped|looked)\b/.test(s)
    || /\b(?:which|any|some|all|most|many|none|what (?:share|percentage|proportion)) of (?:our|your)\b/.test(s) || /\b(?:what|who|where|how|which)\b.{0,40}\bours\b/.test(s)
    || /\bis (?:that|this|it) what we\b/.test(s) || /\bwho\b.{0,40}\b(?:at the moment|currently|today|right now|these days)\b/.test(s)],
  // Schedule.
  ['when', (s) => each(s, /\bwhen (?:(?:will|did|are|were|is|was) (?:you|we|your|our|the team|they|that|this|it|the)|can (?:your|we|the team|you (?:have|get|finish|deliver|start|share|send|look|do (?:it|that)|make)))\b/g,
    (rest) => !/^ (?:\w+ )?(?:a |the )?(?:right|best|good|appropriate|sensible|worth|safe|ok|better|recommended|necessary|needed|supposed)\b/.test(rest))],
  // Status, targets and progress.
  ['status', (s) => /\bwhat (?:is|was|are) (?:the|our|your) (?:current |latest |actual |target |agreed )?(?:status|state of play|eta|rto|rpo|slas?|slos?|timeline|deadline|budget|retention|headcount|coverage|progress|plan for|roadmap|backlog|mttr|patch window|on call|rota)\b/.test(s)
    || /\b(?:any (?:update|news|progress)|where are we|where did we (?:land|get to)|how far (?:along )?(?:are|have) (?:we|you)|how are we (?:doing|getting on|looking)) (?:on|with|for)\b/.test(s)],
  // "is that live yet", "has the policy been enforced everywhere".
  ['done', (s) => each(s, /\b(?:is|are|was|were|has|have|did|does)\b(.{0,50}?\b(?:rolled out|gone live|go live|in prod(?:uction)?|turned on|switched on|enabled|enforced|deployed|migrated|signed off|decommissioned|onboarded|live|done|finished|fixed|patched|merged|closed)\b.{0,25}?)\b(?:yet|already|everywhere|today|right now|at the moment|currently)\b/g, (rest, m) => !ADVICE.test(m[1]))],
  // What someone else has or did.
  ['anyone', (s) => each(s, /\b(?:has|have|did|do|does|is|are|were) (?:anyone|anybody|someone|somebody|the (?:\w+ )?(?:squads?|teams?|soc|devs|developers|engineers|auditors?))\b/g,
    (rest) => !/^ (?:here |else )?(?:know|think|have (?:a|any) (?:questions?|thoughts?|views?|objections?|concerns?)|want|else|object|mind|disagree|agree|need|have to|seen|heard|catch|got (?:a|any)|still (?:there|here|on))\b/.test(rest))],
];
const CLAUSE_SPLIT = /[.?!;]+|,\s*|\s+(?:and|but|so)\s+/i;
function orgRule(text) {
  let s = norm(text);
  if (HOUSE.test(s)) {
    const raw = String(text || '');
    if (!CLAUSE_SPLIT.test(raw)) return '';
    const rest = raw.split(CLAUSE_SPLIT).filter((c) => c.trim() && !HOUSE.test(norm(c)));
    if (!rest.length) return '';
    s = norm(rest.join(' '));
  }
  const cond = COND_BEFORE.test(s);
  const r = RULES.find(([, f]) => f(s, cond));
  return r ? r[0] : '';
}
const isOrgQuestion = (text) => !!orgRule(text);
module.exports = { isOrgQuestion, orgRule };
