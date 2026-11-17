'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../src/main/knowledge/library');
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const start = app.indexOf('function agoText('), end = app.indexOf('\nlet dirtyCheck', start);
assert.ok(start >= 0 && end > start);
const agoText = new Function(app.slice(start, end) + '; return agoText;')();
const day = 86400000, now = Date.UTC(2026, 10, 16, 12);

for (const [age, expected] of [[0, 'today'], [5 / 24, 'today'], [1, 'yesterday'], [2, '2 days ago'], [13, '13 days ago'], [14, '2 weeks ago'], [15, '2 weeks ago'], [42, '6 weeks ago'], [60, '2 months ago'], [90, '3 months ago'], [-1, 'today']]) {
  test(`agoText: ${age} days`, () => assert.equal(agoText(now - age * day, now), `Newest file changed ${expected}.`));
}
for (const value of [0, undefined, NaN]) test('agoText: no date for ' + value, () => assert.equal(agoText(value, now), ''));

test('Knowledge shows age only for marked folders, with a reminder strictly after 14 days', () => {
  const source = app.slice(app.indexOf('  const pinned = lib.pinned || [];'), app.indexOf('  const skipped =', app.indexOf('  const pinned = lib.pinned || [];')));
  const make = new Function('lib', 'Date', 'plural', 'agoText', source + '; return pinNote + ageNote;');
  const info = { files: 2, chars: 24000, omitted: 0 };
  const say = (days, pinned = ['facts']) => make({ pinned, pinnedInfo: { ...info, newestMs: now - days * day } }, { now: () => now }, (n, one, many) => `${n} ${n === 1 ? one : many}`, agoText);
  assert.match(say(15), /Newest file changed 2 weeks ago\. Check that these are still right\./);
  assert.doesNotMatch(say(14), /Check that/);
  assert.match(say(14 + 1 / day), /Check that/);
  assert.doesNotMatch(say(90, []), /Newest file|Check that/);
  assert.match(app, /class: 'privacy', text: pinNote \+ ageNote/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.match(main, /pinnedInfo: \(\(\{ items, chars, omitted, newestMs \}\) => \(\{ files: items.length, chars, omitted, newestMs \}\)\)/);
});

test('pinned newestMs uses only included files and cached modification times', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-pin-age-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const facts = path.join(root, 'facts'), other = path.join(root, 'other');
  fs.mkdirSync(facts); fs.mkdirSync(other);
  for (const [dir, file, text, age] of [[facts, 'older.md', 'Older fact.', 40], [facts, 'newer.md', 'Newer fact.', 20], [facts, 'over-limit.md', 'Long fact. '.repeat(1000), 2], [facts, 'empty.txt', '', 50], [other, 'other.md', 'Other fact.', 0]]) {
    const target = path.join(dir, file); fs.writeFileSync(target, text); fs.utimesSync(target, (now - age * day) / 1000, (now - age * day) / 1000);
  }
  const library = new Library();
  await library.reindex([{ dir: facts, label: 'Facts', kind: 'work' }, { dir: other, label: 'Other', kind: 'work' }]);
  // Removal after indexing proves pinned() uses the cached facts without statting or reading the files.
  fs.rmSync(facts, { recursive: true, force: true });
  const pinned = library.pinned([facts], { maxChars: 100 });
  assert.equal(pinned.newestMs, now - 20 * day); assert.equal(pinned.items.length, 3); assert.equal(pinned.omitted, 1);
  assert.equal(library.pinned([facts]).newestMs, now - 2 * day);
  for (const dirs of [[], undefined, [path.join(root, 'missing')]]) assert.equal(library.pinned(dirs).newestMs, 0);
  assert.equal(library.pinned([facts], { maxChars: 0 }).newestMs, 0);
});
