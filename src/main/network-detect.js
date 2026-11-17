'use strict';
const os = require('node:os');
const { isIP } = require('node:net');

function tailscaleAddresses(interfaces) {
  const v4 = new Set(), v6 = new Set();
  try {
    // Keep the default lookup inside the guard because the OS can refuse enumeration.
    if (interfaces === undefined) interfaces = os.networkInterfaces();
    if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces)) return [];
    for (const entries of Object.values(interfaces)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.internal || typeof entry.address !== 'string') continue;
          const address = entry.address.replace(/%[\w.-]+$/, ''), family = isIP(address);
          if (address.includes('%') || (address !== entry.address && family !== 6)) continue;
          if (family === 4) {
            const n = address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
            if (n >= 0x64400000 && n <= 0x647fffff) v4.add(address);
          } else if (family === 6) {
            // These three non-zero hextets cannot be hidden by IPv6 zero compression.
            const [a, b, c] = address.split(':').map((part) => parseInt(part, 16));
            if (a === 0xfd7a && b === 0x115c && c === 0xa1e0) v6.add(address);
          }
        } catch { /* A malformed entry must not hide other interfaces. */ }
      }
    }
    return [...v4].sort().concat([...v6].sort());
  } catch { return []; }
}

function isTailscaleOrLoopback(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 45 || raw.includes('%')) return false;
  const v4Ok = (a, b) => a === 127 || (a === 100 && b >= 64 && b <= 127);
  const fam = isIP(raw);
  if (fam === 4) {
    const p = raw.split('.').map(Number);
    return p.length === 4 && v4Ok(p[0], p[1]);
  }
  if (fam !== 6) return false;
  let head = raw.toLowerCase(), v4Tail = null;
  if (head.includes('.')) {
    const idx = head.lastIndexOf(':');
    const v4 = head.slice(idx + 1);
    if (isIP(v4) !== 4) return false;
    const b = v4.split('.').map(Number);
    v4Tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    head = head.slice(0, idx);
    if (head.endsWith(':')) head += ':';
  }
  const halves = head.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':').map((x) => parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map((x) => parseInt(x, 16)) : [];
  if (v4Tail) right.push(...v4Tail);
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return false;
  const h = [...left, ...new Array(fill).fill(0), ...right];
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return true;
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) return v4Ok(h[6] >> 8, h[6] & 0xff);
  return h[0] === 0xfd7a && h[1] === 0x115c && h[2] === 0xa1e0;
}

module.exports = { tailscaleAddresses, isTailscaleOrLoopback };
