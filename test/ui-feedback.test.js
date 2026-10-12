import test from 'node:test';
import assert from 'node:assert/strict';
import { buzz, chirp, feedbackOn, setFeedback, signal } from '../public/js/lib/feedback.js';

const memory = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('vibration starts on and sound starts off, and a saved choice wins', () => {
  const storage = memory();
  assert.equal(feedbackOn('haptics', storage), true);
  assert.equal(feedbackOn('sound', storage), false);
  setFeedback('haptics', false, storage);
  setFeedback('sound', true, storage);
  assert.equal(feedbackOn('haptics', storage), false);
  assert.equal(feedbackOn('sound', storage), true);
});

test('a browser that cannot keep the choice or cannot vibrate does not break an action', () => {
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(feedbackOn('haptics', broken), true);
  assert.doesNotThrow(() => setFeedback('haptics', false, broken));
  assert.equal(buzz('done', { localStorage: memory(), navigator: {} }), false);
  assert.equal(chirp('done', { localStorage: memory() }), false);
});

test('a buzz is sent only when the switch is on, with a different pattern for a failure', () => {
  const sent = [];
  const env = { localStorage: memory(), navigator: { vibrate: (pattern) => (sent.push(pattern), true) } };
  assert.equal(buzz('done', env), true);
  assert.equal(buzz('failed', env), true);
  setFeedback('haptics', false, env.localStorage);
  assert.equal(buzz('done', env), false);
  assert.deepEqual(sent, [[18], [30, 60, 30]]);
});

test('signal does nothing when both switches are off', () => {
  const sent = [];
  const env = { localStorage: memory(), navigator: { vibrate: (pattern) => sent.push(pattern) } };
  setFeedback('haptics', false, env.localStorage);
  signal('failed', env);
  assert.deepEqual(sent, []);
});
