import test from 'node:test';
import assert from 'node:assert/strict';
import { tryFastAnswer } from '../backend/tools/fast-answer.mjs';

test('answers pure arithmetic instantly', () => {
  const r = tryFastAnswer('calculate 25*4+7');
  assert.equal(r.kind, 'calculation');
  assert.match(r.answer, /107/);
  assert.equal(r.ok, true);
});

test('answers phrased arithmetic instantly', () => {
  assert.match(tryFastAnswer('what is 12 times 12').answer, /144/);
  assert.match(tryFastAnswer('20 plus 5').answer, /25/);
  assert.match(tryFastAnswer('100 divided by 4').answer, /25/);
});

test('converts units instantly and only within the same dimension', () => {
  const miles = tryFastAnswer('5 km to miles');
  assert.equal(miles.kind, 'conversion');
  assert.match(miles.answer, /3\.106/);
  // temperature by formula
  const c = tryFastAnswer('convert 100 f to c');
  assert.match(c.answer, /37\.77/);
  assert.match(tryFastAnswer('how many minutes in 2 hours').answer, /120/);
  // volume, area, and speed dimensions
  assert.match(tryFastAnswer('2 liters to gallons').answer, /0\.528/);
  assert.match(tryFastAnswer('1 acre to hectares').answer, /0\.404/);
  assert.match(tryFastAnswer('60 mph to kmh').answer, /96\.56/);
  // cross-dimension is not a conversion — falls to the model
  assert.equal(tryFastAnswer('5 apples to oranges'), null);
});

test('computes percentages instantly', () => {
  const r = tryFastAnswer('15% of 240');
  assert.equal(r.kind, 'percentage');
  assert.match(r.answer, /36/);
});

test('answers the current time and date instantly', () => {
  assert.equal(tryFastAnswer('what time is it').kind, 'time');
  assert.equal(tryFastAnswer('what time is it now').kind, 'time');
  assert.equal(tryFastAnswer('what is the date today').kind, 'date');
  assert.equal(tryFastAnswer('what day is it').kind, 'date');
});

test('falls through to the model for anything that needs reasoning', () => {
  for (const msg of [
    'Tell me a joke',
    'what files are in my Downloads folder',
    'summarize my emails',
    'is 5 km greater than 3 miles',
    'what are the times for the meeting',
    'list my calendar events',
    'write a poem about the sea',
  ]) {
    assert.equal(tryFastAnswer(msg), null, `should fall through: ${msg}`);
  }
});

test('reports a failed pure computation deterministically without the model', () => {
  const r = tryFastAnswer('1/0');
  assert.equal(r.kind, 'calculation');
  assert.equal(r.ok, false);
  assert.match(r.answer, /Could not compute/);
});

test('ignores empty and over-long input', () => {
  assert.equal(tryFastAnswer(''), null);
  assert.equal(tryFastAnswer('   '), null);
  assert.equal(tryFastAnswer('calculate 1+1 ' + 'x'.repeat(300)), null);
});
