import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import { MODEL_ID } from '../src/settings/semantic-search.js';

// One-off calibration tool, not part of the running dashboard. Prints the top scored fields for a
// batch of realistic non-literal queries against the actual 325-field corpus, so MIN_SCORE and
// SCORE_WINDOW in lib/semantic-search.js are set from real numbers instead of a guess.
const QUERIES = [
  'breeding speed',
  'no fly zone',
  'in game shop currency',
  'friendly fire',
  'server password',
  'how long until a base decays',
  'zombie apocalypse',
  'nonsense query xyzzy quux',
];

async function main() {
  const { pipeline, env } = await import('@huggingface/transformers');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  env.cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.model-cache');
  const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
  const corpusTexts = SETTINGS_FIELDS.map((field) =>
    [field.label, field.key, field.category, field.description, field.help].filter(Boolean).join(' . '),
  );
  console.log(`Embedding ${corpusTexts.length} fields...`);
  const corpusVectors = (await extractor(corpusTexts, { pooling: 'mean', normalize: true })).tolist();
  function dot(a, b) {
    let score = 0;
    for (let i = 0; i < a.length; i++) score += a[i] * b[i];
    return score;
  }
  for (const query of QUERIES) {
    const qVec = (await extractor([query], { pooling: 'mean', normalize: true })).tolist()[0];
    const scored = SETTINGS_FIELDS.map((field, index) => ({
      label: field.label,
      key: field.key,
      score: dot(qVec, corpusVectors[index]),
    }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    console.log(`\nQuery: "${query}"`);
    for (const result of scored) console.log(`  ${result.score.toFixed(4)}  ${result.label}  (${result.key})`);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
