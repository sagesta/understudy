'use strict';
// Drives the real overlay page in Chromium with a stand-in for the app's
// bridge, and checks the behaviour the UI review measured as broken:
// clicks while an answer streams, folding what is being read, small windows,
// ending a meeting by accident, and keyboard use.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { chromium } = require('playwright');

const file = url.pathToFileURL(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html')).href;
const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-overlay-'));
fs.mkdirSync(outDir, { recursive: true });
const state = { active: true, paused: false, meta: { startMs: Date.now(), title: 'Test', start: '10:00' }, autoMode: 'questions', personality: 'default', turns: [], cards: [], cost: null, personalities: [{ id: 'default', name: 'As I am', description: '' }], shortcuts: { answer: 'Alt+Shift+A', pause: 'Alt+Shift+P' }, models: { live: 'anthropic/claude-haiku-5-5' }, capture: { me: 'on', them: 'on' } };
const long = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} explains one more detail about how the rotation works.`).join(' ');

(async () => {
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge' }));
  const results = {};
  const open = async (w, h) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.addInitScript((st) => {
      window.__calls = [];
      const handlers = [];
      window.api = {
        invoke: async (ch, ...args) => { window.__calls.push([ch, ...args]); if (ch === 'meeting:state') return { ok: true, value: st }; if (ch === 'settings:get') return { ok: true, value: { settings: { me: { name: 'Ade' } } } }; return { ok: true, value: true }; },
        on: (fn) => { handlers.push(fn); return () => {}; },
        sendAudio() {}, captureStatus() {},
      };
      window.__emit = (m) => handlers.forEach((fn) => fn(m));
    }, state);
    await page.goto(file);
    await page.waitForSelector('#actions button');
    return page;
  };

  // 1. Stop works while text streams quickly
  {
    const page = await open(460, 680);
    await page.evaluate(() => window.__emit({ type: 'card', id: 1, action: 'answer', label: 'Answer', status: 'streaming', text: 'Start. ', quote: 'A question?', files: [], sources: [], startedAt: Date.now() }));
    const stream = page.evaluate(() => new Promise((resolve) => { let n = 0; const t = setInterval(() => { window.__emit({ type: 'card-delta', id: 1, delta: `word${n} ` }); if (++n > 400) { clearInterval(t); resolve(); } }, 20); }));
    await page.waitForTimeout(300);
    const box = await page.locator('.card.streaming .tools button').first().boundingBox();
    let registered = 0;
    for (let i = 0; i < 12; i++) {
      const before = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'meeting:cancelCard').length);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
      const after = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'meeting:cancelCard').length);
      if (after > before) registered++;
      await page.waitForTimeout(40);
    }
    results.stopClicksRegistered = `${registered} of 12 at one token every 20 ms (was 0 of 20)`;
    // text selection survives incoming text
    const sel = await page.evaluate(async () => {
      const body = document.querySelector('.card .body p');
      const r = document.createRange(); r.selectNodeContents(body); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      const len = String(s).length;
      await new Promise((r2) => setTimeout(r2, 300));
      return { before: len, after: String(window.getSelection()).length };
    });
    results.selectionKept = sel.after > 0 && sel.after >= sel.before;
    await stream;
    await page.close();
  }

  // 2. A new answer while reading an old one
  {
    const page = await open(460, 680);
    await page.evaluate((t) => { window.__emit({ type: 'card', id: 1, action: 'answer', label: 'Answer', status: 'done', text: t, quote: 'q', files: [], sources: [] }); }, long(60));
    await page.evaluate(() => { document.getElementById('cards').scrollTop = 250; });
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => ({ top: document.getElementById('cards').scrollTop, h: document.querySelector('.card').offsetHeight }));
    await page.evaluate(() => window.__emit({ type: 'card', id: 2, action: 'answer', label: 'Answer', status: 'streaming', text: 'A new question came in.', quote: 'q2', files: [], sources: [] }));
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ top: document.getElementById('cards').scrollTop, firstFolded: document.querySelectorAll('.card')[1].classList.contains('folded'), pill: Boolean(document.getElementById('newpill')) }));
    results.readingNotDisturbed = { scrollBefore: before.top, scrollAfter: after.top, oldAnswerStillOpen: !after.firstFolded, newAnswerPill: after.pill };
    await page.click('#newpill');
    await page.waitForTimeout(200);
    results.pillScrollsToNewest = await page.evaluate(() => document.getElementById('cards').scrollTop < 5);
    await page.close();
  }

  // 3. Small windows
  for (const [w, h] of [[380, 420], [460, 480], [460, 680]]) {
    const page = await open(w, h);
    await page.evaluate(() => { window.__emit({ type: 'card', id: 1, action: 'answer', label: 'Answer', status: 'done', text: 'Short answer.', quote: 'q', files: [], sources: [] }); window.__emit({ type: 'error', message: 'Something went wrong with the speech connection for the meeting audio: this is a rather long message that wraps onto several lines.' }); });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { cardsH: Math.round(r('cards').height), askBottom: Math.round(r('ask').bottom), win: window.innerHeight, scrollW: document.documentElement.scrollWidth, winW: window.innerWidth, say: document.querySelector('#actions button.primary span:not([style*="none"])') && [...document.querySelectorAll('#actions button.primary span')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent).join('') }; });
    results[`${w}x${h}`] = { cardAreaPx: m.cardsH, askBoxInside: m.askBottom <= m.win, noSideScroll: m.scrollW <= m.winW, primaryLabel: m.say };
    await page.screenshot({ path: path.join(outDir, `overlay-${w}x${h}.png`) });
    await page.close();
  }

  // 4. Ending needs two clicks
  {
    const page = await open(460, 680);
    await page.click('#stop');
    const afterFirst = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'meeting:stop').length);
    await page.click('#stop');
    const afterSecond = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'meeting:stop').length);
    results.endNeedsTwoClicks = afterFirst === 0 && afterSecond === 1;
    await page.close();
  }

  // 5. Keyboard: fold and unfold an answer, move through the mode control with the arrow keys
  {
    const page = await open(460, 680);
    await page.evaluate(() => { for (const id of [1, 2]) window.__emit({ type: 'card', id, action: 'answer', label: 'Answer', status: 'done', text: `Answer ${id}.`, quote: 'q', files: [], sources: [] }); });
    await page.waitForTimeout(100);
    const folded = () => page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.classList.contains('folded')));
    const initial = await folded();                       // newest card first: [open, folded]
    await page.focus('.card.folded .top'); await page.keyboard.press('Enter');
    const afterOpen = await folded();
    await page.focus('.card:not(.folded) .top >> nth=0'); await page.keyboard.press('Space');
    const afterFold = await folded();
    await page.focus('#mode button.on'); await page.keyboard.press('ArrowRight');
    const mode = await page.evaluate(() => document.querySelector('#mode button.on').dataset.v);
    results.keyboard = { foldedAtStart: initial, afterEnterOnFolded: afterOpen, afterSpaceOnOpen: afterFold, modeAfterArrowRight: mode };
    await page.close();
  }

  // 6. Question targeting: card labels, the passed-question strip, the four-way mode switch at the narrowest width
  {
    const page = await open(380, 600);
    await page.evaluate(() => {
      window.__emit({ type: 'card', id: 11, action: 'answer', label: 'Answer', status: 'done', text: 'A', reason: 'question', target: 'other', addressee: 'Priya', files: [], sources: [] });
      window.__emit({ type: 'card', id: 12, action: 'answer', label: 'Answer', status: 'done', text: 'B', reason: 'question', target: 'room', files: [], sources: [] });
      window.__emit({ type: 'passed', id: 7, ask: 'What is the ETA?', speaker: 'Sam', target: 'other', addressee: 'Priya', at: Date.now() });
    });
    const labels = await page.evaluate(() => [...document.querySelectorAll('.card .label')].map((e) => e.textContent));
    const strip = await page.evaluate(() => ({ shown: !document.getElementById('strip').hidden, text: document.querySelector('.pass-text').textContent }));
    await page.evaluate(() => window.__emit({ type: 'passed', id: 8, ask: 'Anyone?', speaker: 'Sam', target: 'room', at: Date.now() }));
    const replaced = await page.evaluate(() => document.querySelector('.pass-text').textContent);
    // A question put to the user that was passed over (the flood guard) says so: "Asked of you", not "someone else".
    await page.evaluate(() => window.__emit({ type: 'passed', id: 10, ask: 'Ade, what is your view on the timeline?', speaker: 'Sam', target: 'you', at: Date.now() }));
    const toYou = await page.evaluate(() => document.querySelector('.pass-text').textContent);
    results.passedToYouSaysYou = toYou.startsWith('Asked of you:') && !/someone else/.test(toYou);
    await page.click('.pass .primary');
    const answered = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'meeting:answerPassed'));
    await page.evaluate(() => { window.__emit({ type: 'passed', id: 9, ask: 'Again?', target: 'room' }); window.__emit({ type: 'passed-clear', id: 9 }); });
    const clearedHidden = await page.evaluate(() => document.getElementById('strip').hidden);
    const fit = await page.evaluate(() => { const seg = document.querySelector('#mode .seg'); return { options: seg.children.length, clipped: [...seg.children].some((b) => b.scrollWidth > b.clientWidth) || seg.scrollWidth > seg.clientWidth }; });
    results.targeting = { labels, strip, replaced, toYou, answered, clearedHidden, fit };
    await page.close();
  }

  // 7. Connection lost and back, the one-line strip, hint wording, key errors, small labels
  {
    const page = await open(380, 420);
    const text = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return e && !e.hidden ? e.textContent : ''; }, sel);
    const emit = (m) => page.evaluate((x) => window.__emit(x), m);
    await emit({ type: 'stt-state', channel: 'them', state: 'reconnecting' });
    const reconnecting = { header: await text('#state'), notice: await text('#notice'), dotAmber: await page.evaluate(() => document.body.classList.contains('lost')) };
    await emit({ type: 'stt-state', channel: 'them', state: 'listening' });
    const recovered = { header: await text('#state'), notice: await text('#notice') };
    await emit({ type: 'stt-state', channel: 'them', state: 'reconnecting' });
    await emit({ type: 'error', where: 'stt', channel: 'them', message: 'Deepgram keeps dropping the connection. Still retrying; check the network and your Deepgram account.' });
    const gaveUp = { header: await text('#state'), notice: await text('#notice') };
    const fits = await page.evaluate(() => { const n = document.getElementById('notice'); return n.scrollHeight <= n.clientHeight + 1; });
    await emit({ type: 'stt-state', channel: 'them', state: 'listening' });
    // Paused is said once, in the header.
    await page.evaluate(() => window.__emit({ type: 'state', paused: true }));
    const paused = { header: await text('#state'), notice: await text('#notice'), inTranscript: await text('#tr-lines') };
    await page.evaluate(() => window.__emit({ type: 'state', paused: false }));
    // One line for a suggestion and a passed question, the newest first, with +1 for the other.
    await emit({ type: 'passed', id: 21, ask: 'Can you share the runbook?', target: 'other', addressee: 'Priya' });
    await emit({ type: 'speaker-suggestion', suggestion: { id: 31, key: 'k', label: 'Speaker 1', name: 'Priya Nair', evidence: 'Priya here' } });
    const strip = await page.evaluate(() => { const s = document.getElementById('strip'); return { rows: s.querySelectorAll('.sugg, .pass').length, text: s.textContent, badge: (s.querySelector('.more') || {}).textContent, oneLine: s.getBoundingClientRect().height < 44 }; });
    await emit({ type: 'speaker-suggestion-clear', id: 31 });
    const hint = await page.evaluate(() => ({ text: document.querySelector('.pass-text').textContent, badge: Boolean(document.querySelector('.more')) }));
    await emit({ type: 'card', id: 41, action: 'say', label: 'What to say', status: 'error', error: 'Anthropic rejected the API key (or the key lacks access to this model).', files: [], sources: [] });
    const errText = await text('.card .err');
    await page.click('.card .err button');
    const opened = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'app:show'));
    // A model problem ("does not have that model") offers Settings > Answers; a rate limit is just the sentence.
    await emit({ type: 'card', id: 42, action: 'ask', label: 'Asked', status: 'error', error: 'Gemini does not have that model for your key. Choose another model in Settings > Answers.', files: [], sources: [] });
    await page.evaluate(() => { window.__calls.length = 0; });
    const errCard = (needle) => page.locator('.card .err', { hasText: needle });
    const modelBtn = errCard('does not have that model').locator('button');
    const modelErr = { text: await errCard('does not have that model').textContent(), buttons: await modelBtn.count(), label: await modelBtn.first().textContent() };
    await modelBtn.first().click();
    modelErr.appShow = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'app:show'));
    await emit({ type: 'card', id: 43, action: 'ask', label: 'Asked', status: 'error', error: 'Gemini: rate limit or credit reached. Try again in a moment.', files: [], sources: [] });
    const limitErr = { text: await errCard('rate limit or credit').textContent(), buttons: await errCard('rate limit or credit').locator('button').count() };
    if (modelErr.buttons !== 1 || modelErr.label !== 'Open Settings > Answers.' || JSON.stringify(modelErr.appShow) !== JSON.stringify([['app:show', { page: 'settings', tab: 'ai' }]]) || limitErr.buttons !== 0) throw new Error('model error link: ' + JSON.stringify({ modelErr, limitErr }));
    const actions = await page.evaluate(() => [...document.querySelectorAll('#actions button')].map((b) => b.textContent));
    const tips = await page.evaluate(() => ({ mode: document.getElementById('mode').title, meters: [document.getElementById('m-me').title, document.getElementById('m-them').title], pause: document.getElementById('pause').title }));
    const transcriptFolded = await page.evaluate(() => ({ closed: document.getElementById('transcript').classList.contains('closed'), toggleVisible: document.getElementById('tr-toggle').offsetHeight > 0 }));
    results.connectionAndStrip = { modelErr, limitErr, reconnecting, recovered, gaveUp, gaveUpNoticeNotClipped: fits, paused, strip, hint, errText, appShowCalls: opened, actions, tips, transcriptFolded };
    await page.close();
  }

  // 8. The "check it" line: one muted line under an answer that has check, before the sources; a late flag redraws the card; a folded card hides it
  for (const [w, h] of [[380, 420], [460, 680]]) {
    const page = await open(w, h);
    const emit = (m) => page.evaluate((x) => window.__emit(x), m);
    const checks = () => page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => ({ shown: [...c.querySelectorAll('.check')].filter((e) => e.offsetHeight > 0).length, folded: c.classList.contains('folded') })));
    const answer = 'Pin by SHA.\n\n- We already rotate keys every 90 days and sign every image in the pipeline, so a pinned action fits how our team works with Kyverno on production.';
    await emit({ type: 'card', id: 51, action: 'answer', label: 'Answer', status: 'done', text: 'Pin by SHA, because a tag can move.', quote: 'q', files: [], sources: [] });
    const without = await checks();
    await emit({ type: 'card', id: 52, action: 'answer', label: 'Answer', status: 'done', text: answer, quote: 'q', files: [], sources: [{ url: 'https://example.com/a', title: 'Pinning actions' }], note: 'A picture of your screen was sent to Gemini.', check: true });
    const withCheck = await checks();
    const layout = await page.evaluate(() => {
      const c = document.querySelector('.card:not(.folded)');
      const line = c.querySelector('.check'), foot = c.querySelector('.foot'), body = c.querySelector('.body');
      const cs = getComputedStyle(line);
      return { text: line.textContent, tag: line.tagName, order: [...c.children].map((e) => e.className.split(' ')[0]), clipped: line.scrollWidth > line.clientWidth + 1, lines: Math.round(line.offsetHeight / parseFloat(cs.lineHeight)), px: cs.fontSize, colour: cs.color, svg: line.querySelectorAll('svg, img').length, bodyBottom: Math.round(body.getBoundingClientRect().bottom), lineTop: Math.round(line.getBoundingClientRect().top), footTop: Math.round(foot.getBoundingClientRect().top), sideScroll: document.documentElement.scrollWidth > window.innerWidth };
    });
    await page.evaluate(() => { document.getElementById('cards').scrollTop = 1e5; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `overlay-check-${w}x${h}.png`) });
    // A card finished without the flag, then flagged by a late card-done: it redraws with the line.
    await emit({ type: 'card', id: 53, action: 'ask', label: 'Asked', status: 'streaming', text: 'We run Trivy', quote: 'q', files: [], sources: [] });
    await emit({ type: 'card-done', id: 53, action: 'ask', label: 'Asked', status: 'done', text: 'We run Trivy on every build.', quote: 'q', files: [], sources: [], check: true });
    const late = await checks();
    const allText = await page.evaluate(() => [...document.querySelectorAll('.check')].map((e) => e.textContent));
    results[`checkLine ${w}x${h}`] = { without, withCheck, layout, late, allText };
    if (without[0].shown !== 0 || withCheck.length !== 2 || withCheck[0].shown !== 1 || withCheck[1].shown !== 0 || !withCheck[1].folded) throw new Error(`check line wrong at ${w}x${h}: ${JSON.stringify({ without, withCheck })}`);
    if (layout.text !== 'Mentions how your company does things: check it before you say it.' || layout.tag !== 'P' || layout.clipped || layout.lines > 2 || layout.svg || layout.sideScroll) throw new Error(`check line layout wrong at ${w}x${h}: ${JSON.stringify(layout)}`);
    if (!(layout.bodyBottom <= layout.lineTop && layout.lineTop < layout.footTop)) throw new Error(`check line out of order at ${w}x${h}`);
    if (late[0].shown !== 1 || allText.length !== 2) throw new Error(`late flag did not redraw at ${w}x${h}: ${JSON.stringify({ late, allText })}`);
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
