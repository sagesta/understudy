'use strict';
// Writes a file for every crash, so there is something to read afterwards.
// One file per incident: <logs>/crash-<time>-<kind>.log. Nothing is sent anywhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactSecrets } = require('./knowledge/redact');

const KEEP = 30; // newest crash files kept
const MAX_PER_MINUTE = 20; // a crash loop must not fill the disk

// Keys and tokens must never end up in a file the user might share.
function scrub(text) {
  return redactSecrets(String(text)).text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…[hidden]')
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}/g, 'gsk_…[hidden]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza…[hidden]')
    .replace(/\b(Bearer|Token|Basic)[ \t]+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [hidden]')
    .replace(/((?:api[_-]?key|apikey|authorization|x-api-key|secret|token)["']?[ \t]*[:=][ \t]*["']?)(?!\[removed:)[^\s"',}]{8,}/gi, '$1[hidden]');
}

function describe(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (err && typeof err === 'object') { try { return JSON.stringify(err, null, 2); } catch { /* fall through */ } }
  return String(err);
}

class CrashLog {
  constructor(dir, info = {}) {
    this.dir = dir;
    this.info = info;
    this.recent = [];
    // Set by main.js to (error, where, kind) => void: the Issues folder (src/main/issues.js) hears of the same
    // crashes. The local log below is written first and is kept either way.
    this.reporter = null;
  }

  // Tells the Issues folder. Never throws, and never reports the crash log's own problems.
  report(err, where, kind) {
    try { if (typeof this.reporter === 'function') this.reporter(err, where, kind); } catch { /* reporting must never be the thing that crashes */ }
  }

  // Returns the file written, or null when nothing could be written.
  write(kind, details) {
    try {
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t < 60000);
      if (this.recent.length >= MAX_PER_MINUTE) return null;
      this.recent.push(now);
      fs.mkdirSync(this.dir, { recursive: true });
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const safeKind = String(kind).replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
      let file = path.join(this.dir, `crash-${stamp}-${safeKind}.log`);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(this.dir, `crash-${stamp}-${safeKind}-${i}.log`);
      const body = typeof details === 'string' ? details : describe(details);
      const mem = process.memoryUsage();
      const lines = [
        `Understudy crash report: ${kind}`,
        `Time:      ${new Date(now).toString()}`,
        `Version:   ${this.info.version || 'unknown'}`,
        `Electron:  ${process.versions.electron || 'n/a'}  Node ${process.versions.node}  Chrome ${process.versions.chrome || 'n/a'}`,
        `System:    ${process.platform} ${process.arch} ${os.release()}`,
        `Uptime:    ${Math.round(process.uptime())}s   Heap: ${Math.round(mem.heapUsed / 1048576)} MB   RSS: ${Math.round(mem.rss / 1048576)} MB`,
        ...(this.info.context ? [`State:     ${(() => { try { return this.info.context(); } catch { return 'not started yet'; } })()}`] : []),
        '',
        scrub(body),
        '',
      ];
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      this.prune();
      return file;
    } catch { return null; /* logging must never be the thing that crashes */ }
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => /^crash-.*\.log$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - KEEP))) { try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }

  // Hooks the process and every Electron window/child process.
  attach(app) {
    process.on('uncaughtException', (err, origin) => { this.write('uncaught-exception', `Origin: ${origin}\n${describe(err)}`); this.report(err, 'main', 'crash'); });
    process.on('unhandledRejection', (reason) => { this.write('unhandled-rejection', describe(reason)); this.report(reason, 'main', 'crash'); });
    app.on('render-process-gone', (_e, wc, d) => {
      let url = ''; try { url = wc.getURL(); } catch { /* destroyed */ }
      this.write('renderer-gone', `Page: ${url}\nReason: ${d.reason}\nExit code: ${d.exitCode}`);
      // A window process that died (not one that was closed or ended on purpose).
      if (d.reason !== 'clean-exit' && d.reason !== 'killed') this.report({ name: 'RendererProcessGone', message: `A window process ended unexpectedly (${d.reason}, exit code ${d.exitCode}).` }, 'main', 'crash');
    });
    app.on('child-process-gone', (_e, d) => {
      this.write('child-process-gone', `Type: ${d.type}\nName: ${d.name || ''}\nReason: ${d.reason}\nExit code: ${d.exitCode}`);
      if (d.reason !== 'clean-exit' && d.reason !== 'killed') this.report({ name: 'ChildProcessGone', message: `A ${d.type} process ended unexpectedly (${d.reason}, exit code ${d.exitCode}).` }, 'main', 'crash');
    });
    app.on('web-contents-created', (_e, wc) => {
      wc.on('unresponsive', () => { let url = ''; try { url = wc.getURL(); } catch { /* destroyed */ } this.write('window-unresponsive', `Page: ${url}`); });
      wc.on('preload-error', (_ev, p, err) => this.write('preload-error', `Preload: ${p}\n${describe(err)}`));
      // Uncaught errors inside the pages show up as error-level console messages.
      wc.on('console-message', (_ev, level, message, line, source) => {
        if (level === 3 && /^Uncaught |Unhandled (promise )?rejection/i.test(message)) {
          this.write('renderer-error', `${message}\n    at ${source}:${line}`);
          // A page that never started (a syntax error in its script) cannot report itself; the others do (issues:rendererError).
          if (/^Uncaught SyntaxError/.test(message)) this.report({ name: 'SyntaxError', message: message.replace(/^Uncaught /, ''), stack: `    at ${source}:${line}` }, 'renderer:page', 'error');
        }
      });
    });
  }
}

module.exports = { CrashLog, scrub };
