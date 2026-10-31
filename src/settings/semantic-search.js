import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../util/fsutil.js';

// Semantic fallback for the settings search box: when the live keyword filter finds nothing,
// this ranks every curated field against the query by embedding similarity instead. Fully local -
// no API key, no per-query network call, no cloud billing. The model loads once, lazily, on the
// first semantic search the manager receives (not at startup), and then stays resident in this
// process until the manager exits.
//
// Model: onnx-community/granite-embedding-97m-multilingual-r2-ONNX, a transformers.js-ready mirror
// of IBM's Granite Embedding Multilingual R2 (Apache 2.0, released 2026-04-29). Chosen for being
// current, small (97M params, 384-dim, runs comfortably on CPU) and already benchmarked as the
// strongest sub-100M open embedding model available at the time this was written.
export const MODEL_ID = 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX';
export function modelCachePath() {
  return path.resolve(
    process.env.OVERSEER_MODEL_CACHE ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.model-cache'),
  );
}

// Bump this when the file layout changes. A mismatch is a miss, same as a corrupt file.
const CACHE_VERSION = 1;

export function corpusCachePath() {
  return path.join(modelCachePath(), 'settings-corpus-embeddings.json');
}

// Measured directly against this model on the dashboard's own 325-field corpus (see
// tools/tune-semantic-search.js): a pure-gibberish query still scored 0.64 against the best-fitting
// field, while every real paraphrase query tested (breeding speed, no fly zone, friendly fire,
// server password, base decay, in-game shop currency) cleared 0.65 on its best match. 0.65 is the
// line found there - it is not a universal constant, and a corpus edit or model swap means
// re-running that tool rather than assuming this number still holds.
export const MIN_SCORE = 0.65;
export const SCORE_WINDOW = 0.06;
export const RESULT_LIMIT = 12;

let extractorPromise = null;
const corpora = new WeakMap();
const DEFAULT_EXTRACTOR = {};

// A failed load (no network on first use, a corrupt cache) is forgotten rather than cached, so the
// next search tries again instead of failing until the manager restarts.
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = modelCachePath();
      return pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
    })();
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

export function fieldCorpusText(field) {
  return [field.label, field.key, field.category, field.section, field.description, field.help]
    .filter(Boolean)
    .join(' . ');
}

// JSON.stringify keeps each field text's boundary exact. A joined string would hash two different
// corpora the same when one text contained the separator.
function corpusFingerprint(texts) {
  return crypto.createHash('sha256').update(JSON.stringify(texts)).digest('hex');
}

function vectorShapeOk(vector, dimension) {
  return (
    Array.isArray(vector) &&
    vector.length === dimension &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

// A restart should not embed the corpus again when the model and the field texts are unchanged.
// A file that fails the version, model, hash, length or dimension checks is a miss. The next
// successful embed replaces it. A miss never throws: search still runs from a fresh embed.
function readCachedCorpus(fields, texts) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(corpusCachePath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== CACHE_VERSION) return null;
  if (parsed.modelId !== MODEL_ID) return null;
  if (parsed.corpusHash !== corpusFingerprint(texts)) return null;
  if (!Number.isInteger(parsed.dimension) || parsed.dimension < 1) return null;
  if (!Array.isArray(parsed.entries) || parsed.entries.length !== fields.length) return null;
  for (let index = 0; index < fields.length; index++) {
    const entry = parsed.entries[index];
    if (!entry || entry.key !== fields[index].key || !vectorShapeOk(entry.vector, parsed.dimension)) return null;
  }
  return parsed.entries.map((entry) => entry.vector);
}

function writeCachedCorpus(texts, entries) {
  const dimension = entries[0]?.vector?.length;
  if (!Number.isInteger(dimension) || dimension < 1) return;
  if (!entries.every((entry) => vectorShapeOk(entry.vector, dimension))) return;
  const payload = {
    version: CACHE_VERSION,
    modelId: MODEL_ID,
    corpusHash: corpusFingerprint(texts),
    dimension,
    entries: entries.map((entry) => ({ key: entry.key, vector: entry.vector })),
  };
  try {
    writeFileAtomic(corpusCachePath(), JSON.stringify(payload));
  } catch {
    // The in-memory corpus still serves this process when the cache directory cannot be written.
  }
}

function dotProduct(a, b) {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

// The corpus is embedded once per field list and extractor, then held for the life of the process.
// A memory miss reads the on-disk vectors when the model and the exact field texts still match.
function getCorpus(fields, extractor, cacheKey) {
  let byExtractor = corpora.get(fields);
  if (!byExtractor) {
    byExtractor = new Map();
    corpora.set(fields, byExtractor);
  }
  if (!byExtractor.has(cacheKey)) {
    const pending = (async () => {
      const texts = fields.map(fieldCorpusText);
      const cached = readCachedCorpus(fields, texts);
      if (cached) return fields.map((field, index) => ({ key: field.key, vector: cached[index] }));
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const vectors = output.tolist();
      const entries = fields.map((field, index) => ({ key: field.key, vector: vectors[index] }));
      writeCachedCorpus(texts, entries);
      return entries;
    })();
    pending.catch(() => byExtractor.delete(cacheKey));
    byExtractor.set(cacheKey, pending);
  }
  return byExtractor.get(cacheKey);
}

// Returns [] when nothing clears MIN_SCORE: no result is the right answer for a query with no real
// match, rather than a forced best guess.
export async function rankFields(query, fields, { extractor: injectedExtractor } = {}) {
  const extractor = injectedExtractor || (await getExtractor());
  const cacheKey = injectedExtractor || DEFAULT_EXTRACTOR;
  const corpus = await getCorpus(fields, extractor, cacheKey);
  const queryOutput = await extractor([query], { pooling: 'mean', normalize: true });
  const queryVector = queryOutput.tolist()[0];
  const scored = corpus
    .map((entry) => ({ key: entry.key, score: dotProduct(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score);
  const bestScore = scored[0]?.score;
  if (bestScore === undefined || bestScore < MIN_SCORE) return [];
  const cutoff = Math.max(MIN_SCORE, bestScore - SCORE_WINDOW);
  return scored.filter((entry) => entry.score >= cutoff).slice(0, RESULT_LIMIT);
}
