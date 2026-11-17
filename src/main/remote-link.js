'use strict';
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const WebSocket = require('ws');

const SAMPLES = 1600, FRAME_BYTES = 3205, MAX_PREAUTH_SOCKETS = 8, MAX_FORWARD_GAP = 36000;
const COMMANDS = new Set(['start', 'pause', 'resume', 'stop']);
const noop = () => {};
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
function normPeerIp(addr) {
  if (typeof addr !== 'string' || !addr) return 'local';
  const low = addr.toLowerCase();
  return low.startsWith('::ffff:') && isIP(low.slice(7)) === 4 ? low.slice(7) : low;
}
const mac = (token, nonce) => crypto.createHmac('sha256', token).update(nonce).digest();
const status = (msg) => {
  if (typeof msg.state !== 'string' || (msg.hint !== undefined && typeof msg.hint !== 'string')) return null;
  return { state: msg.state.slice(0, 200), ...(msg.hint === undefined ? {} : { hint: msg.hint.slice(0, 200) }) };
};
function positive(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
}
function checkToken(token) {
  if (typeof token !== 'string' || !token.length) throw new TypeError('A token is required');
}
function json(data) {
  try {
    const msg = JSON.parse(data.toString());
    return msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.t === 'string' ? msg : null;
  } catch { return null; }
}
function send(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(data, (err) => { if (err) ws.terminate(); }); return true; }
  catch { ws.terminate(); return false; }
}

function createListener({ token, host = '127.0.0.1', port = 0, onAudio = noop, onGap = noop,
  onStatus = noop, onState = noop, helloMs = 3000, lockMs = 60000, pingMs = 5000 }) {
  checkToken(token);
  for (const [name, value] of Object.entries({ helloMs, lockMs, pingMs })) positive(name, value);
  // Missing counters are lost; dropped counts received audio rejected as malformed or duplicate.
  const totals = { blocks: 0, dropped: 0, duplicates: 0, lost: 0, badFrames: 0, badHellos: 0 };
  const last = [null, null], sockets = new Map(), peerLocks = new Map();
  let server, listening, closing, current = null, lastSid = null, heartbeat, closed = false, bindPort = port;

  function failed(ctx) {
    if (ctx.auth || ctx.failed) return;
    ctx.failed = true;
    totals.badHellos++;
    const now = Date.now();
    if (peerLocks.size > 64) {
      for (const [k, v] of peerLocks) if (now >= v.lockedUntil && v.failures.every((t) => now - t >= 60000)) peerLocks.delete(k);
    }
    let entry = peerLocks.get(ctx.peerKey);
    if (!entry) { entry = { failures: [], lockedUntil: 0 }; peerLocks.set(ctx.peerKey, entry); }
    entry.failures = entry.failures.filter((time) => now - time < 60000);
    entry.failures.push(now);
    if (entry.failures.length >= 5) { entry.lockedUntil = now + lockMs; entry.failures = []; }
  }
  function retire(ws, ctx, code = 1008) {
    ctx.dead = true;
    clearTimeout(ctx.hello);
    if (ctx.kill || ws.readyState === WebSocket.CLOSED) return;
    ws.close(code);
    // A peer that cannot complete the close handshake must not accumulate sockets.
    ctx.kill = setTimeout(() => ws.terminate(), 1000);
    ctx.kill.unref();
  }
  function connection(ws, req) {
    const remoteAddr = req?.socket?.remoteAddress;
    if (remoteAddr !== undefined && !isTailscaleOrLoopback(remoteAddr)) {
      ws.on('error', noop);
      ws.terminate();
      return;
    }
    let preAuth = 0;
    for (const c of sockets.values()) if (!c.auth && !c.dead) preAuth++;
    if (preAuth >= MAX_PREAUTH_SOCKETS) {
      ws.on('error', noop);
      ws.terminate();
      return;
    }
    const peerKey = normPeerIp(remoteAddr);
    const ctx = { auth: false, failed: false, dead: false, alive: true, peerKey };
    sockets.set(ws, ctx);
    ws.on('error', () => { if (!closing && !ctx.dead) failed(ctx); ws.terminate(); });
    ws.on('close', () => {
      clearTimeout(ctx.hello); clearTimeout(ctx.kill);
      sockets.delete(ws);
      if (current === ws) { current = null; onState('disconnected'); }
    });
    ws.on('pong', () => { ctx.alive = true; });
    const lock = peerLocks.get(peerKey);
    if (closing || (lock && Date.now() < lock.lockedUntil)) { retire(ws, ctx); return; }
    const nonce = crypto.randomBytes(16).toString('hex');
    ctx.hello = setTimeout(() => { failed(ctx); retire(ws, ctx); }, helloMs);
    ctx.hello.unref();
    ws.on('message', (data, binary) => {
      if (ctx.dead || closing || ws.readyState !== WebSocket.OPEN) return;
      if (!ctx.auth) {
        const msg = !binary && json(data);
        const valid = msg && msg.t === 'hello' && typeof msg.pc === 'string' && msg.pc.length <= 30 &&
          typeof msg.sid === 'string' && /^[a-f\d]{8,32}$/i.test(msg.sid) &&
          typeof msg.mac === 'string' && /^[a-f\d]{64}$/i.test(msg.mac) &&
          crypto.timingSafeEqual(mac(token, nonce), Buffer.from(msg.mac, 'hex'));
        if (!valid) { failed(ctx); retire(ws, ctx); return; }
        clearTimeout(ctx.hello);
        ctx.auth = true;
        // A new recorder process restarts its counters; reconnects must retain outage gaps.
        if (msg.sid !== lastSid) { last.fill(null); lastSid = msg.sid; }
        const previous = current;
        current = ws;
        if (previous && previous !== ws) retire(previous, sockets.get(previous), 4000);
        // The prefix prevents a reflected hello from proving the server's identity.
        send(ws, JSON.stringify({ t: 'ready', proof: mac(token, 'server:' + nonce).toString('hex') }));
        onState('connected');
        return;
      }
      if (current !== ws) return;
      if (binary) {
        if (data.length !== FRAME_BYTES || data[0] > 1) { totals.badFrames++; totals.dropped++; return; }
        const ch = data[0], channel = ch ? 'them' : 'me', counter = data.readUInt32BE(1);
        const distance = last[ch] === null ? 1 : (counter - last[ch]) >>> 0;
        // Serial arithmetic treats a small forward wrap as progress, and stale frames as duplicates.
        if (!distance || distance >= 0x80000000) { totals.duplicates++; totals.dropped++; return; }
        if (distance > MAX_FORWARD_GAP) { totals.badFrames++; totals.dropped++; return; }
        last[ch] = counter;
        if (distance > 1) { totals.lost += distance - 1; onGap(channel, distance - 1); }
        // The five-byte header leaves PCM unaligned; decoding also fixes the wire byte order.
        const pcm = new Int16Array(SAMPLES);
        for (let i = 0; i < SAMPLES; i++) pcm[i] = data.readInt16LE(5 + i * 2);
        totals.blocks++;
        onAudio(channel, pcm);
      } else {
        const msg = json(data);
        if (!msg) { retire(ws, ctx); return; }
        if (msg.t === 'status') { const value = status(msg); if (value) onStatus(value); }
      }
    });
    send(ws, JSON.stringify({ t: 'challenge', nonce }));
  }
  function listen() {
    if (closed) { server = undefined; listening = closing = undefined; closed = false; }
    if (closing) return Promise.reject(new Error('The listener is closing'));
    if (listening) return listening;
    if (!isTailscaleOrLoopback(host)) return Promise.reject(new Error('Remote listener requires a Tailscale or loopback address'));
    listening = new Promise((resolve, reject) => {
      let bound = false;
      server = new WebSocket.Server({ host, port: bindPort, maxPayload: 8192, perMessageDeflate: false });
      server.on('error', (err) => { if (!bound) reject(err); else close(); });
      server.on('connection', connection);
      server.once('listening', () => {
        bound = true;
        if (!closing) {
          heartbeat = setInterval(() => {
            for (const [ws, ctx] of sockets) {
              if (ctx.dead || !ctx.alive) { ws.terminate(); continue; }
              ctx.alive = false;
              if (ws.readyState === WebSocket.OPEN) ws.ping(noop);
            }
          }, pingMs);
          heartbeat.unref();
          onState('waiting');
        }
        bindPort = server.address().port;
        resolve({ port: bindPort });
      });
    });
    return listening;
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      // Await a pending bind too, so close immediately after listen cannot leak a port.
      if (listening) { try { await listening; } catch { /* a failed bind has nothing to release */ } }
      clearInterval(heartbeat);
      const ended = [];
      for (const [ws, ctx] of sockets) {
        ended.push(new Promise((resolve) => ws.once('close', resolve)));
        clearTimeout(ctx.hello); clearTimeout(ctx.kill);
        ctx.dead = true; ws.terminate();
      }
      if (current) { current = null; onState('disconnected'); }
      if (server) await new Promise((resolve) => server.close(resolve));
      await Promise.all(ended);
      closed = true;
    })();
    return closing;
  }
  return {
    listen, close,
    command(name, extra) {
      const flags = {};
      if (name === 'start' || name === 'resume') for (const key of ['mic', 'room']) {
        if (typeof extra?.[key] === 'boolean') flags[key] = extra[key];
      }
      return !closing && COMMANDS.has(name) && !!current && send(current, JSON.stringify({ t: name, ...flags }));
    },
    stats() { return { connected: !closing && !!current && current.readyState === WebSocket.OPEN, ...totals }; }
  };
}

function createSender({ url, token, pc = 'PC', onCommand = noop, onState = noop,
  reconnectMs = 2000, keepBlocks = 50, maxBufferedBytes = 96000 }) {
  checkToken(token);
  positive('reconnectMs', reconnectMs);
  if (!Number.isSafeInteger(keepBlocks) || keepBlocks < 0) throw new TypeError('keepBlocks must be a non-negative integer');
  if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) throw new TypeError('maxBufferedBytes must be non-negative');
  const sid = crypto.randomBytes(16).toString('hex');
  const totals = { sent: 0, dropped: 0, reconnects: 0 }, counters = [0, 0], queue = new Array(keepBlocks);
  let socket = null, running = false, authenticated = false, retry, deadline, head = 0, queued = 0, generation = 0;
  function schedule() {
    if (!running || retry || socket) return;
    retry = setTimeout(() => { retry = null; if (running) { totals.reconnects++; connect(); } }, reconnectMs);
    retry.unref();
  }
  function transmit(frame) {
    if (socket.bufferedAmount > maxBufferedBytes) { totals.dropped++; return false; }
    if (!send(socket, frame)) { totals.dropped++; return false; }
    totals.sent++;
    return true;
  }
  function connect() {
    const attempt = ++generation;
    onState('connecting');
    // State callbacks may stop and restart the sender before this attempt opens a socket.
    if (!running || generation !== attempt) return;
    let ws;
    try { ws = new WebSocket(url, { maxPayload: 8192, perMessageDeflate: false, handshakeTimeout: 3000 }); }
    catch { onState('disconnected'); schedule(); return; }
    socket = ws;
    let nonce;
    deadline = setTimeout(() => ws.terminate(), 3000);
    deadline.unref();
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      if (socket !== ws) return;
      clearTimeout(deadline);
      socket = null; authenticated = false;
      onState('disconnected'); schedule();
    });
    ws.on('message', (data, binary) => {
      if (socket !== ws || !running || ws.readyState !== WebSocket.OPEN) return;
      const msg = !binary && json(data);
      if (!msg) { ws.terminate(); return; }
      if (!authenticated) {
        if (!nonce && msg.t === 'challenge' && typeof msg.nonce === 'string' && /^[a-f\d]{32}$/i.test(msg.nonce)) {
          nonce = msg.nonce;
          send(ws, JSON.stringify({ t: 'hello', mac: mac(token, nonce).toString('hex'), pc: String(pc).slice(0, 30), sid }));
        } else if (nonce && msg.t === 'ready' && typeof msg.proof === 'string' && /^[a-f\d]{64}$/i.test(msg.proof) &&
          crypto.timingSafeEqual(mac(token, 'server:' + nonce), Buffer.from(msg.proof, 'hex'))) {
          clearTimeout(deadline); authenticated = true;
          while (queued) {
            const frame = queue[head]; queue[head] = undefined;
            head = (head + 1) % keepBlocks; queued--;
            transmit(frame);
          }
          if (running && socket === ws && ws.readyState === WebSocket.OPEN) onState('connected');
        } else ws.terminate();
      } else if (COMMANDS.has(msg.t)) onCommand(msg.t, { mic: msg.mic === true, room: msg.room === true });
    });
  }
  return {
    start() { if (!running) { running = true; connect(); } },
    stop() {
      generation++;
      running = false; clearTimeout(retry); clearTimeout(deadline); retry = null;
      const ws = socket; socket = null; authenticated = false;
      if (ws) { ws.terminate(); onState('disconnected'); }
    },
    push(channel, pcm) {
      if ((channel !== 'me' && channel !== 'them') || !(pcm instanceof Int16Array) || pcm.length !== SAMPLES)
        throw new TypeError('Audio must be 1600 Int16 samples for me or them');
      const ch = channel === 'them' ? 1 : 0, frame = Buffer.allocUnsafe(FRAME_BYTES);
      frame[0] = ch; frame.writeUInt32BE(counters[ch], 1); counters[ch] = (counters[ch] + 1) >>> 0;
      for (let i = 0; i < SAMPLES; i++) frame.writeInt16LE(pcm[i], 5 + i * 2);
      if (authenticated && socket && socket.readyState === WebSocket.OPEN) return transmit(frame);
      if (!keepBlocks) { totals.dropped++; return false; }
      if (queued === keepBlocks) {
        totals.dropped++; queue[head] = frame; head = (head + 1) % keepBlocks;
      } else { queue[(head + queued) % keepBlocks] = frame; queued++; }
      return false;
    },
    sendStatus(value) {
      const msg = value && status(value);
      return !!msg && authenticated && !!socket && send(socket, JSON.stringify({ t: 'status', ...msg }));
    },
    stats() { return { ...totals, queued }; }
  };
}

module.exports = { createListener, createSender };
