'use strict';
// Removes things that look like credentials before any text from the user's
// files is indexed, shown, or sent to an AI provider. Notes and runbooks pick
// up tokens over time; none of them are needed to answer a question.
//
// This runs on every file the library reads, in the main process, and the files
// are semi-trusted (a clone, a download, a synced folder). So the cost has to be
// linear in the text whatever the text is:
//   - no pattern puts a lazy or greedy run in front of a second run of the same
//     characters that can be retried from many starting points (the old key
//     pattern did, and 360 KB of "token-" took 87 s);
//   - a run is only ever scanned once per start, and starts cannot sit inside
//     the run they would scan (see ASSIGN and the JWT scan below);
//   - what has to look for an end marker (a private key) uses indexOf with a
//     remembered position, never a lazy "anything up to the end" pattern.
// test/diagrams-hardening.test.js pins both the results (against the old
// patterns, on a corpus) and the time (adversarial 400,000-character slices).

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/y;
const MAX_KEY_SPAN = 64 * 1024;       // a key whose END line is further away than this is treated as having none
const MAX_OPEN_KEY = 4000;            // what is removed after a BEGIN line that has no END line

// "-----BEGIN ... PRIVATE KEY-----" up to its END line. A BEGIN line without an END line (a label that was cut
// short, a file that was cut in two) still removes what follows it, to the first blank line or MAX_OPEN_KEY
// characters, because the part that is left would otherwise be the key.
function removeKeys(text) {
  if (!text.includes('-----BEGIN ')) return { text, n: 0 };
  let out = '', last = 0, n = 0, m;
  let endAt = -2;                     // the next "-----END " not yet passed: -2 unknown, -1 none left
  KEY_BEGIN.lastIndex = 0;
  while ((m = KEY_BEGIN.exec(text))) {
    const from = m.index + m[0].length;
    let stop = -1;
    if (endAt !== -1 && endAt < from) endAt = text.indexOf('-----END ', from);
    while (endAt >= 0 && endAt - from <= MAX_KEY_SPAN) {
      KEY_END.lastIndex = endAt;
      const t = KEY_END.exec(text);
      if (t) { stop = endAt + t[0].length; break; }
      endAt = text.indexOf('-----END ', endAt + 1);      // an END line of something else
    }
    if (stop < 0) {
      const limit = Math.min(text.length, from + MAX_OPEN_KEY);
      const blank = /\r?\n[ \t]*\r?\n/.exec(text.slice(from, limit));
      stop = blank ? from + blank.index : limit;
    }
    out += text.slice(last, m.index) + '[removed: private key]';
    last = stop; n++;
    KEY_BEGIN.lastIndex = stop;
  }
  return { text: out + text.slice(last), n };
}

// JSON web tokens: eyJ<header>.<payload>.<signature>, each part at least 10 URL-safe characters. Scanned by hand
// because the regular expression for it retries its three runs from every "eyJ" that follows a "-", which is
// quadratic on "eyJ-eyJ-eyJ-...". Here the end of a run is remembered, so every character is looked at once.
const isWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isUrlSafe = (c) => isWord(c) || c === 45;
function removeJwts(text, mark) {
  let i = text.indexOf('eyJ');
  if (i < 0) return { text, n: 0 };
  const len = text.length;
  let out = '', last = 0, n = 0, runFrom = -1, runTo = -1;
  const endOfRun = (p) => {
    if (p >= runFrom && p < runTo) return runTo;
    let e = p;
    while (e < len && isUrlSafe(text.charCodeAt(e))) e++;
    runFrom = p; runTo = e;
    return e;
  };
  while (i >= 0) {
    if (i === 0 || !isWord(text.charCodeAt(i - 1))) {
      const p1 = i + 3, e1 = endOfRun(p1);
      if (e1 - p1 >= 10 && text.charCodeAt(e1) === 46) {
        const p2 = e1 + 1, e2 = endOfRun(p2);
        if (e2 - p2 >= 10 && text.charCodeAt(e2) === 46) {
          const p3 = e2 + 1, e3 = endOfRun(p3);
          let q = e3;                  // the signature ends where a word boundary falls (the old \b), longest first
          for (; q >= p3 + 10; q--) {
            const a = q > 0 && isWord(text.charCodeAt(q - 1)), b = q < len && isWord(text.charCodeAt(q));
            if (a !== b) break;
          }
          if (q >= p3 + 10) {
            out += text.slice(last, i) + mark; last = q; n++;
            i = text.indexOf('eyJ', q);
            continue;
          }
        }
      }
      i = text.indexOf('eyJ', e1 + 1);
      continue;
    }
    i = text.indexOf('eyJ', i + 1);
  }
  return { text: out + text.slice(last), n };
}

// Whether the text before "://" at `at` ends in a scheme as the old pattern read it: a run of letters, digits,
// "+", "." and "-" in which a letter stands at a word boundary.
function schemeBefore(text, at) {
  let r = at;
  while (r > 0 && at - r < 4000 && /[A-Za-z0-9+.-]/.test(text[r - 1])) r--;
  for (let q = r; q < at; q++) {
    if (/[A-Za-z]/.test(text[q]) && (q === 0 || !isWord(text.charCodeAt(q - 1)))) return true;
  }
  return false;
}

const TOKENS = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{18,}\b/g, 'GitLab token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g, 'API key'],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, 'Groq API key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\bhv[sb]\.[A-Za-z0-9_-]{24,}\b/g, 'Vault token'],
  ['jwt', 'JWT'],
  // The scheme is not part of the pattern (a pattern that starts at every word boundary and reads a scheme is
  // quadratic on "a.a.a.a."); schemeBefore checks it backwards from "://".
  [/:\/\/[^\s:@/]+:([^\s@/]{3,})@/g, 'password in URL', 1, schemeBefore],
];

// key = value / key: value lines whose key says the value is a secret. The key is one run of name characters
// that contains one of the words; the lookahead finds the word without consuming, so the run itself is read
// once, from the character after the boundary, and cannot be re-entered part way along.
const WORDS = 'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth';
const ASSIGN = new RegExp(
  '((?:^|[\\s"\'`{,(])(?=[A-Za-z0-9_.-]*?(?:' + WORDS + '))[A-Za-z0-9_.-]+["\'`]?\\s*[:=]\\s*)(["\'`]?)([^\\s"\'`,;}{)]{6,})\\2', 'gi');
// HTTP auth schemes ("Authorization: Bearer <tok>", "Authorization: Token <tok>", "Authorization: Basic <b64>"),
// where ASSIGN below would otherwise stop on the scheme word itself, plus standalone "Bearer <token>".
const AUTH_SCHEME = /((?:^|[\s"'`{,(])(?=[A-Za-z0-9_.-]*?(?:auth|token))[A-Za-z0-9_.-]+["'`]?[ \t]*[:=][ \t]*["'`]?(?:Bearer|Token|Basic)[ \t]+)([^\s"'`,;}{)]{6,})/gi;
const BEARER = /(\b(?:Bearer|BEARER)[ \t]+)([A-Za-z0-9._~+/=-]{16,})(?=$|[\s"'`,;}{)])/g;
// Values that are clearly placeholders or references, not secrets.
const HARMLESS = /^(?:\$\{?[A-Za-z_][\w.]*\}?|\{\{[^}]*\}\}|<[^>]*>|%[A-Za-z_]+%|\*+|x{3,}|null|none|true|false|changeme|redacted|required|optional|string|your[-_a-z]*|example[-_a-z]*|secretKeyRef|valueFrom|vault:.*|arn:.*|\/[\w./-]+)$/i;

function isKeyLike(value, allowPunct = false) {
  if (HARMLESS.test(value) || value.startsWith('[removed:')) return false;
  if (/\d/.test(value) || /[A-Z]/.test(value.slice(1))) return true;
  if (allowPunct && /[+/=._-]/.test(value)) return true;
  return value.length >= 16 && !/^[a-z]+$/.test(value);
}

function redactSecrets(text) {
  let n = 0;
  let out = String(text);
  const keys = removeKeys(out);
  out = keys.text; n += keys.n;
  for (const [re, what, group, check] of TOKENS) {
    if (re === 'jwt') {
      const j = removeJwts(out, `[removed: ${what}]`);
      out = j.text; n += j.n;
      continue;
    }
    out = out.replace(re, (m, g1, at) => {
      if (check && !check(out, at)) return m;
      n++;
      // the password is the part just before the "@": replacing the first copy of it would hit the user name when the two are the same
      return group ? `${m.slice(0, m.length - 1 - g1.length)}[removed: ${what}]@` : `[removed: ${what}]`;
    });
  }
  out = out.replace(AUTH_SCHEME, (m, lead, value) => {
    if (!isKeyLike(value, true)) return m;
    n++;
    return `${lead}[removed: secret]`;
  });
  out = out.replace(BEARER, (m, lead, value) => {
    if (!isKeyLike(value, true) && value.length < 24) return m;
    if (HARMLESS.test(value) || value.startsWith('[removed:')) return m;
    n++;
    return `${lead}[removed: secret]`;
  });
  out = out.replace(ASSIGN, (m, lead, quote, value) => {
    if (HARMLESS.test(value) || value.startsWith('[removed:')) return m;
    // Prose such as "token: rotated weekly" is not a secret; require something key-like.
    if (!/\d/.test(value) && !/[A-Z]/.test(value.slice(1)) && value.length < 16) return m;
    n++;
    return `${lead}${quote}[removed: secret]${quote}`;
  });
  return { text: out, count: n };
}

module.exports = { redactSecrets };
