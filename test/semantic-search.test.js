import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rankFields,
  MIN_SCORE,
  SCORE_WINDOW,
  RESULT_LIMIT,
  MODEL_ID,
  modelCachePath,
  corpusCachePath,
} from '../src/settings/semantic-search.js';

// Each search test gets its own cache directory so a file left from an earlier run cannot satisfy
// the first embed, and so tests do not write into the repo's model cache.
async function withTempModelCache(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-embed-'));
  const previous = process.env.OVERSEER_MODEL_CACHE;
  process.env.OVERSEER_MODEL_CACHE = root;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.OVERSEER_MODEL_CACHE;
    else process.env.OVERSEER_MODEL_CACHE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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
  await withTempModelCache(async () => {
    const scores = { best: 0.95, close: 0.95 - SCORE_WINDOW / 2, far: 0.95 - SCORE_WINDOW * 2 };
    const { extractor } = fakeExtractor(scores);
    const results = await rankFields('QUERY', fieldsFor(scores), { extractor });
    assert.deepEqual(
      results.map((r) => r.key),
      ['best', 'close'],
    );
  });
});

test('nothing above MIN_SCORE returns no results', async () => {
  await withTempModelCache(async () => {
    const scores = { weak: MIN_SCORE - 0.01, weaker: MIN_SCORE - 0.2 };
    const { extractor } = fakeExtractor(scores);
    assert.deepEqual(await rankFields('QUERY', fieldsFor(scores), { extractor }), []);
  });
});

test('at most RESULT_LIMIT results are returned', async () => {
  await withTempModelCache(async () => {
    const scores = Object.fromEntries(Array.from({ length: RESULT_LIMIT + 5 }, (_, i) => [`f${i}`, 0.9]));
    const { extractor } = fakeExtractor(scores);
    assert.equal((await rankFields('QUERY', fieldsFor(scores), { extractor })).length, RESULT_LIMIT);
  });
});

test('the corpus is embedded once per field list', async () => {
  await withTempModelCache(async () => {
    const scores = { a: 0.9, b: 0.8 };
    const { extractor, calls } = fakeExtractor(scores);
    const fields = fieldsFor(scores);
    await rankFields('QUERY', fields, { extractor });
    await rankFields('QUERY', fields, { extractor });
    // One corpus embedding (2 texts) and two single-text queries.
    assert.deepEqual(calls, [2, 1, 1]);
    fs.rmSync(corpusCachePath(), { force: true });
    await rankFields('QUERY', fields, { extractor });
    assert.deepEqual(calls, [2, 1, 1, 1]);
  });
});

test('a new field list with the same texts reuses the corpus cache', async () => {
  await withTempModelCache(async () => {
    const scores = { a: 0.9, b: 0.8 };
    const { extractor, calls } = fakeExtractor(scores);
    const fields = fieldsFor(scores);
    const first = await rankFields('QUERY', fields, { extractor });
    const cacheDir = path.resolve(process.env.OVERSEER_MODEL_CACHE);
    assert.equal(path.dirname(corpusCachePath()), cacheDir);
    const saved = JSON.parse(fs.readFileSync(corpusCachePath(), 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.modelId, MODEL_ID);
    assert.equal(saved.dimension, 2);
    assert.equal(saved.entries.length, fields.length);
    assert.deepEqual(
      fs.readdirSync(cacheDir).filter((name) => name.includes('.tmp-')),
      [],
    );
    const second = await rankFields(
      'QUERY',
      fields.map((field) => ({ ...field })),
      { extractor },
    );
    // The copied list is a memory miss. The file supplies the corpus, and the query is embedded live.
    assert.deepEqual(calls, [2, 1, 1]);
    assert.deepEqual(second, first);
  });
});

test('a changed field text misses the corpus cache', async () => {
  await withTempModelCache(async () => {
    const scores = { a: 0.9, b: 0.8 };
    const { extractor, calls } = fakeExtractor(scores);
    await rankFields('QUERY', fieldsFor(scores), { extractor });
    const changed = [
      { key: 'a', label: 'a' },
      { key: 'b', label: 'b', description: 'edited' },
    ];
    await rankFields('QUERY', changed, { extractor });
    assert.deepEqual(calls, [2, 1, 2, 1]);
  });
});

test('a corrupt or stale corpus cache is ignored and rebuilt', async () => {
  const mutations = [
    () => fs.writeFileSync(corpusCachePath(), '{'),
    (saved) => {
      saved.version = 2;
    },
    (saved) => {
      saved.modelId = 'other-model';
    },
    (saved) => {
      saved.corpusHash = 'deadbeef';
    },
    (saved) => {
      saved.dimension += 1;
    },
    (saved) => {
      saved.entries.pop();
    },
    (saved) => {
      saved.entries[0].vector = [1];
    },
    (saved) => {
      saved.entries[0].vector = saved.entries[0].vector.map(String);
    },
    (saved) => {
      saved.entries[0].key = 'other';
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await withTempModelCache(async () => {
      const scores = { a: 0.9, b: 0.8 };
      const { extractor, calls } = fakeExtractor(scores);
      const fields = fieldsFor(scores);
      const first = await rankFields('QUERY', fields, { extractor });
      if (index === 0) mutate();
      else {
        const saved = JSON.parse(fs.readFileSync(corpusCachePath(), 'utf8'));
        mutate(saved);
        fs.writeFileSync(corpusCachePath(), JSON.stringify(saved));
      }
      const second = await rankFields(
        'QUERY',
        fields.map((field) => ({ ...field })),
        { extractor },
      );
      assert.deepEqual(calls, [2, 1, 2, 1]);
      assert.deepEqual(second, first);
      const rebuilt = JSON.parse(fs.readFileSync(corpusCachePath(), 'utf8'));
      assert.equal(rebuilt.version, 1);
      assert.equal(rebuilt.modelId, MODEL_ID);
      assert.equal(rebuilt.entries.length, fields.length);
    });
  }
});

test('a failed corpus embedding is retried on the next search', async () => {
  await withTempModelCache(async () => {
    const scores = { a: 0.9 };
    const { extractor: working } = fakeExtractor(scores);
    let fail = true;
    const extractor = async (texts, options) => {
      if (fail) throw new Error('model unavailable');
      return working(texts, options);
    };
    const fields = fieldsFor(scores);
    await assert.rejects(rankFields('QUERY', fields, { extractor }), /model unavailable/);
    assert.equal(fs.existsSync(corpusCachePath()), false);
    fail = false;
    assert.deepEqual(
      (await rankFields('QUERY', fields, { extractor })).map((r) => r.key),
      ['a'],
    );
    assert.equal(fs.existsSync(corpusCachePath()), true);
  });
});
