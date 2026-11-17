'use strict';
// The thread that reads large diagrams for diagrams.js (see "Off the main thread" there). It does one job at a
// time and answers each with the same shape the inline functions return; it never throws out of a job, and the
// main thread ends it if a job takes too long, so nothing here needs its own timer.
const { parentPort } = require('node:worker_threads');

if (parentPort) {
  const d = require('./diagrams');
  parentPort.on('message', (m) => {
    let result;
    try {
      if (m.op === 'convert') result = d.convertDiagram(m.text, m.kind, { name: m.name, budgetMs: m.budgetMs, maxInflated: m.maxInflated, maxText: m.maxText });
      else if (m.op === 'fences') result = d.describeFences(m.text, { totalMs: m.totalMs, perFenceMs: m.perFenceMs });
      else if (m.op === 'spin') { const end = Date.now() + m.ms; while (Date.now() < end) { /* a job that does not finish, for the tests of the timeout */ } result = 'spun'; }
      else result = { error: 'unknown job' };
    } catch (e) {
      result = { error: String((e && e.message) || e) };
    }
    parentPort.postMessage({ id: m.id, result });
  });
  parentPort.postMessage({ ready: true });
}
