'use strict';
// Drives the real Electron app with a fake microphone and local stand-ins for
// the cloud services. Usage: xvfb-run -a node test/e2e/run.js <speech.wav> <outDir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { mockLlm, mockDeepgram } = require('../mocks');
const { wavToPcm16, pcm16ToWav } = require('../../src/main/stt/wav');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [speechWav, outDir = path.join(os.tmpdir(), 'understudy-e2e')] = process.argv.slice(2);

// Chromium loops the fake microphone file on some platforms (Windows does).
// A clip with only a short pause at its end then never lets the voice gate
// close, so the speech stand-in never sees the end of an utterance. Three
// seconds of silence after the speech gives every loop a clear ending.
function withTrailingSilence(file, dir, seconds = 3) {
  const { pcm, sampleRate } = wavToPcm16(fs.readFileSync(file));
  const padded = new Int16Array(pcm.length + Math.round(sampleRate * seconds));
  padded.set(pcm, 0);
  const out = path.join(dir, 'speech-padded.wav');
  fs.writeFileSync(out, pcm16ToWav(padded, sampleRate));
  return out;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-data-'));
  const wav = withTrailingSilence(speechWav, data);
  const work = path.join(data, 'work'); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'secrets-rotation.md'), '# Secrets rotation\nStatic secrets rotate every 30 days through the pipeline. Database credentials are dynamic, issued by Vault with a 24 hour TTL.\n');
  fs.writeFileSync(path.join(work, 'image-scanning.md'), '# Image scanning\nEvery image is scanned with Trivy in the build stage. Critical CVEs fail the pipeline.\n');
  const llm = await mockLlm((body) => {
    const user = JSON.stringify(body.messages || '');
    if (user.includes('Write the notes in Markdown')) return 'TITLE: Pipeline secrets rotation\n\n## Summary\nWalked through how secrets rotation works in the deployment pipeline.\n\n## Decisions\n- Keep the 30 day rotation.\n\n## Action items\n### Mine\n- [ ] Share the rotation runbook (due: not stated)\n### Others\nNone recorded.\n\n## Open questions\nNone.\n\n## Notable details\n- Vault issues database credentials with a 24 hour TTL.\n\n## Follow-up message\nThanks all. We keep the 30 day rotation; I will share the runbook.';
    if (user.includes('Write a profile')) return '## Role and scope\nAde owns the deployment pipeline and its security controls.\n\n## Standing positions\nNo long-lived static keys.';
    if (user.includes('single word: ready')) return 'ready';
    return { text: 'Static secrets rotate every 30 days through the pipeline, and database credentials are dynamic from Vault.\n\n- Vault issues them with a **24 hour TTL**, so there is nothing long-lived to leak.\n- Rotation runs as a pipeline stage, not by hand.\n\nVerify: the exact rotation day for the payments service.', delayMs: 150 };
  });
  const dg = await mockDeepgram(['Can you walk us through how the deployment pipeline handles secrets rotation?', 'And what happens if the rotation job fails?']);
  fs.mkdirSync(path.join(data, 'ud'));
  fs.writeFileSync(path.join(data, 'ud', 'settings.json'), JSON.stringify({
    me: { name: 'Ade', role: 'DevSecOps engineer' },
    appearance: { theme: process.env.E2E_THEME || 'system' },
    llm: { baseUrls: { anthropic: llm.url } },
    audio: { captureMic: true, captureSystem: process.env.E2E_SYSTEM === '1' },
    library: { folders: [work] },
    meetingsDir: path.join(data, 'Meetings'),
  }));
  fs.writeFileSync(path.join(data, 'ud', 'secrets.json'), JSON.stringify({ anthropic: { plain: 'sk-test' }, deepgram: { plain: 'dg-test' } }));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..', '..'), '--no-sandbox', ...(process.env.E2E_SCALE ? [`--force-device-scale-factor=${process.env.E2E_SCALE}`] : [])],
    env: { ...process.env, UNDERSTUDY_DATA_DIR: path.join(data, 'ud'), UNDERSTUDY_STT_URL: dg.url, UNDERSTUDY_FAKE_AUDIO: wav, ANTHROPIC_BASE_URL: '' },
  });
  const logs = [];
  app.on('console', (m) => logs.push(`[main] ${m.text()}`));
  const win = await app.firstWindow();
  const watch = (p, name) => { p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${name}] ${m.type()}: ${m.text()}`); }); p.on('pageerror', (e) => logs.push(`[${name}] pageerror: ${e.message}`)); };
  const windows = async () => { const out = {}; for (const w of app.windows()) out[path.basename(new URL(w.url()).pathname)] = w; return out; };
  await sleep(1500);
  let w = await windows();
  const main = w['app.html'];
  watch(main, 'app'); if (w['capture.html']) watch(w['capture.html'], 'capture');
  await main.screenshot({ path: path.join(outDir, '1-home.png') });
  const result = { steps: {} };

  // Knowledge: indexed, search works, profile is written and streamed.
  await main.click('#navitems button[data-page=knowledge]');
  await main.waitForSelector('.kgrid');
  result.steps.libraryFiles = await main.textContent('.pagehead p');
  await main.fill('.panel input[type=search]', 'how do we rotate secrets');
  await main.waitForSelector('.hit');
  result.steps.searchTop = await main.textContent('.hit .src');
  const dialogs = [];
  main.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await main.click('text=Write it from my files');
  await main.waitForFunction(() => document.querySelector('#profile').value.includes('Standing positions'), null, { timeout: 8000 });
  await sleep(300);
  await main.screenshot({ path: path.join(outDir, '2-knowledge.png'), fullPage: false });

  // Settings: renders, model test round-trips.
  await main.click('#navitems button[data-page=settings]');
  await main.waitForSelector('.tabs');
  await main.screenshot({ path: path.join(outDir, '3a-settings-you.png') });
  await main.click('.tabs button:has-text("Answers")');
  await main.waitForSelector('text=Live answers');
  await main.locator('button:has-text("Test")').first().click();
  await main.waitForSelector('.help.ok', { timeout: 8000 });
  result.steps.llmTest = await main.locator('.help.ok').first().textContent();
  await main.screenshot({ path: path.join(outDir, '3-settings.png'), fullPage: false });
  for (const [tab, file] of [['Speech', '3b-settings-speech'], ['Shortcuts', '3c-settings-shortcuts'], ['Claude', '3d-settings-claude']]) { await main.click(`.tabs button:has-text("${tab}")`); await sleep(350); await main.screenshot({ path: path.join(outDir, `${file}.png`) }); }
  // The shortcut recorder: click, press a combination, and it is saved.
  await main.click('.tabs button:has-text("Shortcuts")');
  await main.locator('.keycap').nth(2).click();
  await main.keyboard.press('Control+Alt+KeyM');
  await sleep(400);
  result.steps.recordedShortcut = await main.locator('.keycap').nth(2).textContent();
  await main.click('#navitems button[data-page=styles]');
  await main.waitForSelector('.sgrid');
  await main.screenshot({ path: path.join(outDir, '4-styles.png') });

  // Start a meeting: the fake microphone plays speech, the mock transcribes it.
  await main.click('#navitems button[data-page=home]');
  await main.click('text=Start meeting');
  await sleep(1500);
  w = await windows();
  const overlay = w['overlay.html'];
  if (!overlay) throw new Error('overlay window did not open');
  watch(overlay, 'overlay');
  await overlay.waitForSelector('#tr-lines .turn:not(.live)', { timeout: 20000 });
  result.steps.firstTurn = await overlay.textContent('#tr-lines .turn:not(.live)');
  await main.screenshot({ path: path.join(outDir, '1b-home-live.png') });
  result.steps.audioBytesSent = dg.stats.bytes;
  // Microphone-only is treated as an in-person meeting, so the question that
  // was just heard should be answered without anyone pressing anything.
  await overlay.waitForSelector('.card.done', { timeout: 8000 });
  result.steps.autoCardLabel = await overlay.textContent('.card.done .label');
  result.steps.autoCardQuote = await overlay.textContent('.card.done .quote');
  await overlay.click('#actions button[data-action=say]');
  await overlay.waitForFunction(() => document.querySelectorAll('.card.done').length >= 2, null, { timeout: 8000 });
  result.steps.card = await overlay.textContent('.card.latest .body');
  result.steps.cardFiles = await overlay.textContent('.card.latest .foot');
  result.steps.foldedCards = await overlay.locator('.card.folded').count();
  await overlay.fill('#ask', 'what is the TTL on database credentials?');
  await overlay.press('#ask', 'Enter');
  await overlay.waitForFunction(() => document.querySelectorAll('.card.done').length >= 3, null, { timeout: 8000 });
  await overlay.click('#actions button[data-action=screen]');
  await sleep(1500);
  result.steps.cardsAfterScreen = await overlay.locator('.card').count();
  result.steps.screenCall = llm.calls.some((c) => JSON.stringify(c.body.messages || '').includes('"type":"image"'));
  result.steps.notice = (await overlay.locator('#notice').isHidden()) ? '' : await overlay.textContent('#notice');
  await overlay.screenshot({ path: path.join(outDir, '5-overlay.png') });

  // Pause stops audio; resume restarts it.
  const before = dg.stats.bytes;
  await overlay.click('#pause'); await sleep(1500);
  const paused = dg.stats.bytes;
  await sleep(1500);
  result.steps.pausedSendsNothing = dg.stats.bytes === paused;
  await overlay.click('#pause'); await sleep(2500);
  result.steps.resumedSends = dg.stats.bytes > paused;
  result.steps.sentBeforePause = before;

  // End: file written, notes generated, meetings page shows it.
  await overlay.click('#stop'); await overlay.click('#stop'); // the second click confirms
  await main.waitForSelector('.doc h3', { timeout: 15000 });
  await main.waitForFunction(() => document.querySelector('.detail h1') && document.querySelector('.detail h1').textContent.includes('Pipeline secrets rotation'), null, { timeout: 15000 });
  await sleep(400);
  await main.screenshot({ path: path.join(outDir, '6-meeting.png') });
  await main.click('.toolbar .seg button:has-text("Transcript")');
  await sleep(300);
  await main.screenshot({ path: path.join(outDir, '6b-transcript.png') });
  await main.fill('.searchbox input', 'rotation');
  await main.waitForSelector('.list .snip', { timeout: 5000 });
  result.steps.searchHits = await main.locator('.list .item').count();
  await main.click('#navitems button[data-page=home]');
  await sleep(500);
  await main.screenshot({ path: path.join(outDir, '7-home-after.png') });
  await main.click('#navitems button[data-page=settings]');
  await main.click('.tabs button:has-text("You")');
  await main.click('.seg button:has-text("Light")');
  await sleep(300);
  await main.click('#navitems button[data-page=home]');
  await sleep(500);
  await main.screenshot({ path: path.join(outDir, '8-home-light.png') });
  await main.click('#navitems button[data-page=meetings]');
  await sleep(500);
  await main.screenshot({ path: path.join(outDir, '9-meeting-light.png') });
  const day = fs.readdirSync(path.join(data, 'Meetings'))[0];
  result.steps.files = fs.readdirSync(path.join(data, 'Meetings', day));
  result.steps.fileHead = fs.readFileSync(path.join(data, 'Meetings', day, result.steps.files.find((f) => !f.startsWith('_'))), 'utf8').slice(0, 420);
  result.steps.uploadConfirm = dialogs[0];
  result.logs = logs;
  console.log(JSON.stringify(result, null, 2));
  await app.close();
  await llm.close(); await dg.close();
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
