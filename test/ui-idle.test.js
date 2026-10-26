import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDuration, extendLabel, readWhole, unitWord } from '../public/js/lib/idle.js';

test('the page says 1 hour and 2 hours, 1 minute and 30 minutes, 1 day and 3 days', () => {
  assert.equal(unitWord(1, 'hour'), 'hour');
  assert.equal(unitWord(2, 'hour'), 'hours');
  assert.equal(describeDuration(1, 'minute'), '1 minute');
  assert.equal(describeDuration(30, 'minute'), '30 minutes');
  assert.equal(describeDuration(3, 'day'), '3 days');
});

test('the Leave it running button names the chosen time in agreeing words', () => {
  assert.equal(extendLabel(1, 'hour'), 'Leave it running for 1 hour more, then shut down if nobody is on');
  assert.equal(extendLabel(6, 'hour'), 'Leave it running for 6 hours more, then shut down if nobody is on');
});

test('a time box accepts only a whole number of 1 or more', () => {
  assert.equal(readWhole('2'), 2);
  assert.equal(readWhole(' 15 '), 15);
  for (const bad of ['', '0', '-1', '1.5', 'abc']) assert.equal(readWhole(bad), null, bad);
});
