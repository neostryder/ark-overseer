import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../util/fsutil.js';

export const MESSAGES = {
  invalid: 'The map catalog is not in the expected format.',
  fetchFailed: 'Could not refresh the map catalog',
  notHttps: 'The map catalog address must start with https://.',
  tooLarge: 'The map catalog is larger than 256 KB.',
  badStatus: 'The map catalog server answered with status',
};

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog.json');
const MAX_MAPS = 200;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A map id ends up in a folder name and in URLs, so it stays to plain characters.
const ID = /^[A-Za-z0-9_]{1,64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

const fail = (where, reason) => new TypeError(`${MESSAGES.invalid} (${where}: ${reason})`);

// Returns the catalog with only the fields this app reads, or throws. A catalog fetched from a URL is
// untrusted input, so nothing it carries beyond these fields is kept.
export function validateCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('catalog', 'not an object');
  if (!Number.isInteger(value.version) || value.version < 1) throw fail('version', 'not a positive integer');
  if (!Array.isArray(value.maps)) throw fail('maps', 'not a list');
  if (value.maps.length > MAX_MAPS) throw fail('maps', `more than ${MAX_MAPS} entries`);
  const seen = new Set();
  const maps = value.maps.map((entry, index) => {
    const at = `maps[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(at, 'not an object');
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) throw fail(`${at}.id`, 'not a valid map id');
    if (seen.has(entry.id)) throw fail(`${at}.id`, 'duplicate id');
    seen.add(entry.id);
    if (typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 60 || CONTROL.test(entry.name))
      throw fail(`${at}.name`, 'not 1 to 60 characters without control characters');
    if (entry.kind === 'official') {
      if (!Number.isInteger(entry.steamAppId) || entry.steamAppId < 1) throw fail(`${at}.steamAppId`, 'not an integer');
      if (entry.modId !== undefined) throw fail(`${at}.modId`, 'an official map has no mod id');
      return { id: entry.id, name: entry.name, kind: 'official', steamAppId: entry.steamAppId };
    }
    if (entry.kind === 'mod') {
      if (typeof entry.modId !== 'string' || !/^\d{1,20}$/.test(entry.modId))
        throw fail(`${at}.modId`, 'not digits only');
      if (entry.steamAppId !== undefined) throw fail(`${at}.steamAppId`, 'a mod map has no Steam app id');
      return { id: entry.id, name: entry.name, kind: 'mod', modId: entry.modId };
    }
    throw fail(`${at}.kind`, 'not official or mod');
  });
  return { version: value.version, maps };
}

const isHttps = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

function readCatalogFile(file) {
  try {
    return validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// The body is read in pieces so a server that never stops sending is cut off at the limit rather than
// held in memory. A fetch stand-in that only offers text() is read whole.
async function readLimited(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > limit) throw new Error(MESSAGES.tooLarge);
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error(MESSAGES.tooLarge);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(MESSAGES.tooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The published copy of the bundled catalog. A newer map list reaches every install from here without a
// release; OVERSEER_CATALOG_URL replaces it, and an empty value turns the refresh off.
export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/neostryder/ark-overseer/main/src/maps/catalog.json';

export function createCatalog({
  dataDir,
  url = process.env.OVERSEER_CATALOG_URL ?? DEFAULT_CATALOG_URL,
  fetch = globalThis.fetch,
  log = console.error,
}) {
  const cacheFile = path.join(dataDir, 'map-catalog.json');
  const bundled = readCatalogFile(BUNDLED);
  if (!bundled) throw new Error(`${MESSAGES.invalid} (bundled copy)`);
  let etag = null;
  // The newest valid copy wins, so a cached copy that predates an app update never hides the update's own.
  const pick = () => {
    const cached = readCatalogFile(cacheFile);
    return cached && cached.version > bundled.version ? cached : bundled;
  };
  let current = pick();

  async function refresh() {
    if (!url) return false;
    try {
      if (!isHttps(url)) throw new Error(MESSAGES.notHttps);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
      });
      // A redirect must not leave https behind.
      if (response.url && !isHttps(response.url)) throw new Error(MESSAGES.notHttps);
      if (response.status === 304) return false;
      if (response.status !== 200) throw new Error(`${MESSAGES.badStatus} ${response.status}.`);
      const text = await readLimited(response, MAX_BYTES);
      const fetched = validateCatalog(JSON.parse(text));
      const newer = fetched.version > current.version;
      if (newer) writeFileAtomic(cacheFile, JSON.stringify(fetched, null, 2));
      // The tag is kept only once the copy is safe, so a failed write is fetched again in full.
      etag = response.headers?.get?.('etag') || etag;
      if (newer) current = fetched;
      return newer;
    } catch (error) {
      log(`${MESSAGES.fetchFailed}: ${error.message}`);
      return false;
    }
  }

  return { get: () => current, refresh };
}

// Checks for a newer catalog now and then once a day, without keeping the process alive. The returned
// function stops the timer.
export function scheduleCatalogRefresh(catalog, { setTimer = setInterval, clearTimer = clearInterval } = {}) {
  catalog.refresh();
  const timer = setTimer(() => catalog.refresh(), DAY_MS);
  timer.unref?.();
  return () => clearTimer(timer);
}
