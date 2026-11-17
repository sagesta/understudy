'use strict';
// A safety net after the fact (see session.js, where a card is finished): does a finished answer state, in the present tense,
// something about how the user's own organisation does things ("we already rotate keys", "in our setup we sign images")?
// If no file backs it, the card is marked so the owner glances at it before saying it.
//
// Pure text rules, no model call. It is tuned on real model answers (test/fixtures/claims-corpus.json) to catch what the
// model invents without crying wolf on advice and hypotheticals:
//   - the answer is cut into clauses; a clause that asks, defers ("I don't have that in front of me", "let me check") or sits
//     in quotes never counts;
//   - a clause where "if / when / should / could / want to / going to ..." comes before the verb is a hypothetical or advice;
//   - a sentence that opens with if / when / whether / unless ... is a condition, not a claim.
// claimsAboutUsMatches(text) returns the clauses that matched (for tests and debugging), claimsAboutUs(text) a yes or no.

// Practice verbs. Each is written as its base form; the forms "uses", "used", "using", "ran", "kept" ... are built from it.
const VERBS = [
  'use', 'run', 'rely on', 'deploy', 'enforce', 'rotate', 'sign', 'scan', 'store', 'keep', 'monitor', 'track', 'patch',
  'block', 'require', 'pin', 'encrypt', 'back up', 'host', 'own', 'manage', 'handle', 'log', 'push', 'pull', 'pay', 'review',
  'test', 'verify',
  // Added while tuning on real answers: the practice verbs those answers actually used.
  'update', 'apply', 'check', 'build', 'generate', 'send', 'write', 'create', 'start with', 'look at', 'focus on', 'threat model',
  'evaluate', 'try', 'choose', 'pick', 'go with', 'decide on', 'drop', 'move to', 'switch to', 'migrate to', 'flip', 'tie', 'follow',
  'treat', 'validate', 'restrict', 'limit', 'audit', 'alert on', 'tag', 'approve', 'sync', 'protect',
];
const IRREGULAR = { have: ['had'], run: ['ran', 'running'], keep: ['kept'], pay: ['paid'], pick: ['picked'], choose: ['chose', 'chosen'], 'go with': ['went with'], 'decide on': ['decided on'],
  'rely on': ['relied on', 'relying on'], 'back up': ['backed up', 'backing up'], 'start with': ['started with', 'starting with'], 'look at': ['looked at', 'looking at'], 'focus on': ['focused on', 'focusing on'],
  'move to': ['moved to', 'moving to'], 'switch to': ['switched to', 'switching to'], 'migrate to': ['migrated to', 'migrating to'], 'alert on': ['alerted on', 'alerting on'], 'threat model': ['threat modelled', 'threat modelling', 'threat modeled', 'threat modeling'],
  try: ['tried', 'tries', 'trying'], tie: ['tied', 'tying'], pin: ['pinned', 'pinning'], log: ['logged', 'logging'], scan: ['scanned', 'scanning'], drop: ['dropped', 'dropping'], flip: ['flipped', 'flipping'], tag: ['tagged', 'tagging'], 'sync': ['synced', 'syncing'] };
function forms(v) {
  const [head, ...rest] = v.split(' ');
  const tail = rest.length ? ` ${rest.join(' ')}` : '';
  const e = head.endsWith('e');
  const cy = /[^aeiou]y$/.test(head);
  const stem = cy ? head.slice(0, -1) : head;
  const out = new Set([
    head,
    cy ? `${stem}ies` : `${head}s`,
    ...(cy ? [] : [`${head}es`]),
    cy ? `${stem}ied` : (e ? `${head}d` : `${head}ed`),
    e ? `${head.slice(0, -1)}ing` : `${head}ing`,
  ].map((w) => w + tail));
  for (const x of IRREGULAR[v] || []) out.add(x);
  return [...out];
}
const VERB = `(?:${[...new Set(VERBS.flatMap(forms))].sort((a, b) => b.length - a.length).join('|')})`;
const ADV = "(?:(?:already|still|currently|also|always|only|now|generally|usually|typically|normally|just|actually|really|all)\\s+)*";
const NEG = "(?:(?:don't|do not|doesn't|does not|never|haven't|have not|hasn't)\\s+)?";
// "we have to", "we have a call" are not practices.
const NOT_HAVE = "(?!to\\b|a (?:call|meeting|minute|moment|few|look)|time\\b|questions?\\b|everything\\b|enough\\b|the (?:time|floor)\\b)";
const ING = '(?:using|running|relying|deploying|enforcing|rotating|signing|scanning|storing|keeping|monitoring|tracking|patching|blocking|requiring|pinning|encrypting|hosting|managing|handling|logging|pushing|pulling|updating|checking|reviewing|testing|verifying|following|applying|building|generating|writing|tagging|syncing)';

const PATTERNS = [
  // "we already use", "we don't have", "our team keeps", "we used", "we're still deploying".
  new RegExp(`\\b(?:we|our (?:team|squads?))\\s+${ADV}${NEG}(?:${VERB}(?![\\w'])|(?:have|has|had)\\s+${NOT_HAVE}\\w)`, 'g'),
  new RegExp(`\\b(?:we|our (?:team|squads?))(?:'re| are)\\s+${ADV}${ING}\\b`, 'g'),
  new RegExp(`\\bin our (?:setup|environment|pipeline|stack|estate|clusters?|org|team|company)\\b`, 'g'),
  // "our clusters are", "our pipeline runs", "our registry uses".
  new RegExp(`\\bour (?:clusters?|pipelines?|registry|registries|policy|policies|environment|tenant|subscriptions?|repos?|setup|stack|production|prod|squads?|team)\\s+${ADV}(?:is|are|has|have|runs?|uses?|does|did)\\b`, 'g'),
  // "we've rolled out", "I've already migrated".
  /\b(?:we|i)(?:'ve| have) (?:already )?(?:rolled|migrated|switched|enabled|enforced|moved|set up|deployed)\b/g,
  // "the pipeline already pushes", "our clusters still run": no "we", the answer just states how it is.
  /\b(?:the |our )?(?:pipelines?|clusters?|registry|policies|tenant|platform)\s+(?:already|still|currently)\s+\w+/g,
  // "against our public key", "from our trust store".
  /\b(?:against|from|with|using) our (?:public |cosign |signing |private |root )*(?:keys?|trust store|key vault|vault)\b/g,
  // "Kyverno is in Enforce mode on all production clusters", "the injector is in place on all clusters".
  /\b(?:is|are) (?:already |currently |now |still )?(?:in place|in (?:enforce|audit) mode|rolled out|turned on|switched on|enforced|enabled)\s+(?:on|in|across)\s+(?:all|every|most|the|our|production|prod)\b/g,
];

// Before the verb, in the same clause: a condition, a wish, advice or a promise to check. None of these states a practice.
const HEDGE = /\b(?:if|before|when|whenever|whether|unless|until|once|should|could|would|can|cannot|might|may|want to|wants to|need to|needs to|going to|plan to|planning to|let me check|let me look|i will|i'll|we'll|so that|guarantees?|ensures?|means that|lets|allows|makes sure|suppose|assuming|imagine|rather than|instead of|try to|aim to|(?:risk|danger|problem|worry) (?:is|was|would be|being|that|here is)|there is a (?:risk|danger|problem|worry)|worst case)\b|'d\b/;
// A relative clause ("the code we reviewed", "what we run") describes a thing, not a practice.
const RELATIVE = /\b(?:what|which|whatever|everything|anything|code|whoever|things)\s+$/;
// A whole clause that asks or buys time.
const DEFER = /\b(?:in front of (?:me|us)|(?:to|on|at) hand|let me (?:check|find out|look|confirm)|i'll (?:check|find out|confirm|get back|come back|look)|come back to you|get back to you|off the top of my head|off hand|offhand|don't know yet|not sure (?:yet|off)|check with|i can check|i can look|i can confirm)\b/;
const OPENS_CONDITION = /^(?:if|when|whenever|whether|unless|until|once|assuming|suppose|supposing|in case|provided|imagine|say|even if)\b/;

function clauses(text) {
  const t = String(text == null ? '' : text)
    .replace(/[“”«»]/g, '"').replace(/[‘’`´]/g, "'")
    .replace(/"[^"\n]*"/g, ' ')                       // a sentence in quotes is somebody's words, not a claim
    .replace(/^[ \t]*(?:[-*•]+|\d{1,2}[.)])[ \t]+/gm, '') // markdown bullets and numbering
    .replace(/[*_#>]+/g, ' ');
  const out = [];
  for (const sentence of t.split(/\n+|(?<=[.!?])\s+/)) {
    const s = sentence.trim();
    if (!s || /\?\s*$/.test(s) || OPENS_CONDITION.test(s.toLowerCase())) continue;
    for (const c of s.split(/\s*(?:[,;:]|\s[-–—]\s|\sbut\s|\sbecause\s|\swhile\s|\sso\s|\swhich\s|\sand\s+(?=(?:[iI]\b|[iI]'|[lL]et me\b)))\s*/)) {
      const clause = c.trim();
      if (clause && !DEFER.test(clause.toLowerCase())) out.push(clause);
    }
  }
  return out;
}

function claimsAboutUsMatches(text) {
  const found = [];
  for (const clause of clauses(text)) {
    const c = clause.toLowerCase();
    let hit = false;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(c)); ) {
        const before = c.slice(0, m.index);
        if (!HEDGE.test(before) && !RELATIVE.test(before)) { hit = true; break; }
        if (m[0].length === 0) re.lastIndex++;
      }
      if (hit) break;
    }
    if (hit) found.push(clause.slice(0, 160));
  }
  return found;
}

const claimsAboutUs = (text) => claimsAboutUsMatches(text).length > 0;

module.exports = { claimsAboutUs, claimsAboutUsMatches };
