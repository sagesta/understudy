'use strict';
// Heading-aware markdown chunker. Each chunk keeps the heading path it sits
// under so retrieval can show (and score on) where the text came from.

function isYamlFrontmatter(fm) {
  if (!fm || fm.length > 4000) return false;
  let keys = 0, seenKey = false;
  for (const raw of fm.split('\n')) {
    const trim = raw.trim();
    if (!trim || trim.startsWith('#')) continue;
    if (/^[A-Za-z_][\w-]*:[ \t]*(?:.*)?$/.test(raw)) { keys += 1; seenKey = true; continue; }
    if (seenKey && /^(?:[ \t]+\S|-[ \t]+\S)/.test(raw)) continue;
    return false;
  }
  return keys > 0;
}

function stripFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m || !isYamlFrontmatter(m[1])) return { body: text, title: null };
  const fm = m[1];
  const t = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return { body: text.slice(m[0].length), title: t ? t[1] : null };
}

function splitBlocks(lines) {
  // Paragraph-level blocks; fenced code stays in one block.
  const blocks = [];
  let cur = [];
  let fence = null;
  const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } };
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      cur.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; flush(); }
      continue;
    }
    if (f) { flush(); fence = f[1]; cur.push(line); continue; }
    if (line.trim() === '') { flush(); continue; }
    cur.push(line);
  }
  flush();
  return blocks;
}

function safeCut(str, from, maxLen) {
  let end = Math.min(str.length, from + maxLen);
  if (end < str.length && end > from + 1) {
    const code = str.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return end;
}

function hardSplit(block, maxChars) {
  // Last resort for a single oversized block: cut on line boundaries without splitting UTF-16 surrogate pairs.
  const out = [];
  let cur = '';
  for (const line of block.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) { out.push(cur); cur = ''; }
    if (line.length > maxChars) {
      for (let i = 0; i < line.length;) {
        const end = safeCut(line, i, maxChars);
        out.push(line.slice(i, end));
        i = end;
      }
      continue;
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) out.push(cur);
  return out;
}

function chunkMarkdown(text, opts = {}) {
  const maxChars = opts.maxChars || 1400;
  // A huge file is chunked in slices: later slices carry on under the headings the previous one ended in.
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const { body, title } = opts.noFrontmatter ? { body: clean, title: null } : stripFrontmatter(clean);
  const lines = body.split('\n');

  // Pass 1: split into sections at headings (ignoring '#' inside code fences).
  const sections = [];
  let stack = opts.startHeadings ? opts.startHeadings.map((t, i) => ({ level: i + 1, text: t })) : (title ? [{ level: 0, text: title }] : []);
  let cur = { headings: stack.map((h) => h.text), lines: [] };
  let fence = null;
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      cur.lines.push(line);
      continue;
    }
    if (f) { fence = f[1]; cur.lines.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      sections.push(cur);
      const level = h[1].length;
      stack = stack.filter((s) => s.level < level);
      stack.push({ level, text: h[2].trim() });
      cur = { headings: stack.map((s) => s.text), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);

  // Pass 2: pack each section's blocks into chunks of at most maxChars.
  const chunks = [];
  for (const sec of sections) {
    const blocks = splitBlocks(sec.lines).flatMap((b) => (b.length > maxChars ? hardSplit(b, maxChars) : [b]));
    let buf = '';
    for (const b of blocks) {
      if (buf && buf.length + b.length + 2 > maxChars) { chunks.push({ headings: sec.headings, text: buf }); buf = ''; }
      buf += (buf ? '\n\n' : '') + b;
    }
    if (buf.trim()) chunks.push({ headings: sec.headings, text: buf });
  }
  return chunks;
}

module.exports = { chunkMarkdown, stripFrontmatter };
