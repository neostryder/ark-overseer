import test from 'node:test';
import assert from 'node:assert/strict';
import { PULL_MAX, PULL_THRESHOLD, pullDistance, pullPhase } from '../public/js/lib/pull-refresh.js';

test('a pull is damped, capped, and never negative', () => {
  assert.equal(pullDistance(-20), 0);
  assert.equal(pullDistance(0), 0);
  assert.equal(pullDistance(100), 50);
  assert.equal(pullDistance(1000), PULL_MAX);
});

test('a pull is ready only past the threshold', () => {
  assert.equal(pullPhase(0), 'idle');
  assert.equal(pullPhase(PULL_THRESHOLD - 1), 'pulling');
  assert.equal(pullPhase(PULL_THRESHOLD), 'ready');
  assert.ok(pullDistance(1000) >= PULL_THRESHOLD);
});
