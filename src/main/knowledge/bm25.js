'use strict';
// Small in-memory BM25 index. Lexical search suits engineering notes well:
// the terms that matter (tool names, service names, error codes) are exact.

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
  'just me my no not of on or our she so some than that the their them then there these they this to too us was we were what when where ' +
  'which who why will with would you your yeah okay ok um uh like really about also any all get got going go gonna thing things think know ' +
  'well right one want need').split(' '));

function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1);
  return t;
}

const NON_ASCII = /[^\x00-\x7f]/;
const ASCII_TOK = /[a-z0-9][a-z0-9_.+#/-]*[a-z0-9+#]|[a-z0-9]/g;
const UNICODE_TOK = /[\p{L}\p{N}][\p{L}\p{N}_.+#/-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CJK_RUN = /\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+/gu;

function pushUnicodePart(out, p) {
  if (STOP.has(p)) return;
  if (/^[a-z0-9]+$/.test(p)) {
    if (p.length > 1 || /\d/.test(p)) out.push(stem(p));
    return;
  }
  if (CJK_CHAR.test(p)) {
    for (const m of p.matchAll(CJK_RUN)) {
      const run = m[0];
      if (run.length === 1) out.push(run);
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    const nonCjk = p.split(CJK_RUN).filter((s) => s.length > 1 && !STOP.has(s));
    for (const s of nonCjk) out.push(/^[a-z0-9]+$/.test(s) ? stem(s) : s);
    return;
  }
  if (p.length > 1 || /\p{N}/u.test(p)) out.push(p);
}

function tokenize(text) {
  const out = [];
  const str = String(text);
  if (!NON_ASCII.test(str)) {
    const raw = str.toLowerCase().match(ASCII_TOK) || [];
    for (const tok of raw) {
      const parts = tok.split(/[_.\/-]+/).filter(Boolean);
      if (parts.length > 1) {
        // Keep the compound ("ci/cd", "node.js") and index its parts too.
        out.push(tok);
        for (const p of parts) if (!STOP.has(p) && p.length > 1) out.push(stem(p));
      } else if (!STOP.has(tok) && (tok.length > 1 || /\d/.test(tok))) {
        out.push(stem(tok));
      }
    }
    return out;
  }
  const norm = str.normalize('NFKD').replace(/[\u0300-\u036f]+/g, '').normalize('NFC').toLowerCase();
  const raw = norm.match(UNICODE_TOK) || [];
  for (const tok of raw) {
    const parts = tok.split(/[_.\/-]+/).filter(Boolean);
    if (parts.length > 1) {
      out.push(tok);
      for (const p of parts) pushUnicodePart(out, p);
    } else {
      pushUnicodePart(out, tok);
    }
  }
  return out;
}

class Bm25Index {
  constructor({ k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    this.postings = new Map(); // term -> [docIdx, tf, docIdx, tf, ...]
    this.df = new Map();       // term -> live document count
    this.docTerms = [];        // docIdx -> unique terms (cleared on remove)
    this.docLen = [];
    this.totalLen = 0;
    this.dead = new Set();     // removed documents; their postings are skipped until the index is rebuilt
    this.live = 0;
  }

  get size() { return this.live; }

  add(tokens) {
    const idx = this.docLen.length;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const terms = [];
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) { p = []; this.postings.set(t, p); }
      p.push(idx, n);
      this.df.set(t, (this.df.get(t) || 0) + 1);
      terms.push(t);
    }
    this.docTerms.push(terms);
    this.docLen.push(tokens.length);
    this.totalLen += tokens.length;
    this.live++;
    return idx;
  }

  remove(idx) {
    if (this.dead.has(idx) || idx < 0 || idx >= this.docLen.length) return;
    this.dead.add(idx);
    this.totalLen -= this.docLen[idx];
    this.live--;
    const terms = this.docTerms[idx];
    this.docTerms[idx] = null;
    if (terms) {
      for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        const next = (this.df.get(t) || 0) - 1;
        if (next > 0) this.df.set(t, next); else this.df.delete(t);
      }
    }
  }

  search(queryTokens, k = 8) {
    const N = this.live;
    if (!N) return [];
    const avg = this.totalLen / N;
    const scores = new Map();
    const qtf = new Map();
    for (const t of queryTokens) qtf.set(t, (qtf.get(t) || 0) + 1);
    for (const [t, qn] of qtf) {
      const p = this.postings.get(t);
      const df = this.df.get(t) || 0;
      if (!p || !df) continue;
      const idf = Math.log(1 + Math.max(0, N - df + 0.5) / (df + 0.5));
      const qw = 1 + Math.log(qn);
      for (let i = 0; i < p.length; i += 2) {
        const d = p[i], f = p[i + 1];
        if (this.dead.has(d)) continue;
        const s = idf * qw * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.docLen[d] / avg));
        scores.set(d, (scores.get(d) || 0) + s);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([doc, score]) => ({ doc, score }));
  }
}

module.exports = { Bm25Index, tokenize, stem };
