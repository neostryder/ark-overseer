import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rankFields, MIN_SCORE, SCORE_WINDOW, RESULT_LIMIT, modelCachePath } from '../src/settings/semantic-search.js';

test('model cache path honors OVERSEER_MODEL_CACHE', () => {
  const previous = process.env.OVERSEER_MODEL_CACHE;
  process.env.OVERSEER_MODEL_CACHE = 'C:\\service-model-cache';
  try {
    assert.equal(modelCachePath(), path.resolve('C:\\service-model-cache'));
  } finally {
    if (previous === undefined) delete process.env.OVERSEER_MODEL_CACHE;
    else process.env.OVERSEER_MODEL_CACHE = previous;
  }
});

// A fake extractor: each text maps to a 2-D unit vector whose angle from the query sets its score.
// Corpus texts start with the field label, so the label picks the score.
function fakeExtractor(scores) {
  const calls = [];
  const vectorFor = (score) => [score, Math.sqrt(1 - score * score)];
  const extractor = async (texts) => {
    calls.push(texts.length);
    return { tolist: () => texts.map((text) => (text === 'QUERY' ? [1, 0] : vectorFor(scores[text.split(' . ')[0]]))) };
  };
  return { extractor, calls };
}

const fieldsFor = (scores) => Object.keys(scores).map((label) => ({ key: label, label }));

test('results come best first and stop at the score window', async () => {
  const scores = { best: 0.95, close: 0.95 - SCORE_WINDOW / 2, far: 0.95 - SCORE_WINDOW * 2 };
  const { extractor } = fakeExtractor(scores);
  const results = await rankFields('QUERY', fieldsFor(scores), { extractor });
  assert.deepEqual(
    results.map((r) => r.key),
    ['best', 'close'],
  );
});

test('nothing above MIN_SCORE returns no results', async () => {
  const scores = { weak: MIN_SCORE - 0.01, weaker: MIN_SCORE - 0.2 };
  const { extractor } = fakeExtractor(scores);
  assert.deepEqual(await rankFields('QUERY', fieldsFor(scores), { extractor }), []);
});

test('at most RESULT_LIMIT results are returned', async () => {
  const scores = Object.fromEntries(Array.from({ length: RESULT_LIMIT + 5 }, (_, i) => [`f${i}`, 0.9]));
  const { extractor } = fakeExtractor(scores);
  assert.equal((await rankFields('QUERY', fieldsFor(scores), { extractor })).length, RESULT_LIMIT);
});

test('the corpus is embedded once per field list', async () => {
  const scores = { a: 0.9, b: 0.8 };
  const { extractor, calls } = fakeExtractor(scores);
  const fields = fieldsFor(scores);
  await rankFields('QUERY', fields, { extractor });
  await rankFields('QUERY', fields, { extractor });
  // One corpus embedding (2 texts) and two single-text queries.
  assert.deepEqual(calls, [2, 1, 1]);
  await rankFields('QUERY', [...fields], { extractor });
  assert.deepEqual(calls, [2, 1, 1, 2, 1]);
});

test('a failed corpus embedding is retried on the next search', async () => {
  const scores = { a: 0.9 };
  const { extractor: working } = fakeExtractor(scores);
  let fail = true;
  const extractor = async (texts, options) => {
    if (fail) throw new Error('model unavailable');
    return working(texts, options);
  };
  const fields = fieldsFor(scores);
  await assert.rejects(rankFields('QUERY', fields, { extractor }), /model unavailable/);
  fail = false;
  assert.deepEqual(
    (await rankFields('QUERY', fields, { extractor })).map((r) => r.key),
    ['a'],
  );
});
