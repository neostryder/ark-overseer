import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/fsutil.js';

const HIT_MS = 7 * 24 * 60 * 60 * 1000;
// A failed lookup is remembered briefly, so a broken network doesn't cost a request on every page view.
const MISS_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const MOD_DEPTH = 3;

// The address is only ever handed to the browser, and only for a host Steam serves its pictures from.
export function validateArtUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!url.hostname.endsWith('.steamstatic.com')) return null;
  return url.href;
}

async function readText(response, limit) {
  if (Number(response.headers?.get?.('content-length')) > limit) throw new Error('The response is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error('The response is too large.');
  return text;
}

// Steam's store address for a picture carries a content hash that changes, so the address is looked up
// and remembered here instead of being written into the catalog.
export function createArtResolver({ dataDir, fetch = globalThis.fetch, now = Date.now, log = console.error }) {
  const cacheFile = path.join(dataDir, 'map-art.json');
  const pending = new Map();
  let cache = null;
  const load = () => {
    if (cache) return cache;
    cache = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      for (const [id, entry] of Object.entries(saved))
        if (/^\d+$/.test(id) && Number.isFinite(entry?.at))
          cache.set(id, { url: validateArtUrl(entry.url), at: entry.at });
    } catch {
      /* no cache yet, or an unreadable one: it is rebuilt as lookups happen */
    }
    return cache;
  };
  const remember = (id, url) => {
    load().set(id, { url, at: now() });
    try {
      writeFileAtomic(cacheFile, JSON.stringify(Object.fromEntries(cache)));
    } catch (error) {
      log(`Could not save the map picture cache: ${error.message}`);
    }
    return url;
  };
  async function lookup(id) {
    try {
      const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (response.status !== 200) throw new Error(`Steam answered with status ${response.status}.`);
      const body = JSON.parse(await readText(response, MAX_BYTES));
      const url = validateArtUrl(body?.[id]?.data?.header_image);
      if (!url) throw new Error('Steam gave no usable picture address.');
      return remember(id, url);
    } catch (error) {
      log(`Could not look up the picture for Steam app ${id}: ${error.message}`);
      return remember(id, null);
    }
  }
  return {
    async resolve(steamAppId) {
      if (!Number.isInteger(steamAppId) || steamAppId < 1) return null;
      const id = String(steamAppId);
      const known = load().get(id);
      if (known && now() - known.at < (known.url ? HIT_MS : MISS_MS)) return known.url;
      if (!pending.has(id))
        pending.set(
          id,
          lookup(id).finally(() => pending.delete(id)),
        );
      return pending.get(id);
    },
  };
}

export function modsFolder(installPath) {
  return path.join(installPath, 'ShooterGame', 'Binaries', 'Win64', 'ShooterGame', 'Mods', '83374');
}

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

// ASA downloads each mod into <modId>_<fileId> and keeps its picture at <anything>/Preview/preview_image.png.
// The newest folder is the current version. The picture is found by a shallow search, and the result must
// resolve inside the Mods folder, so a link placed in a mod cannot point elsewhere.
export function findModPreview(installPath, modId) {
  if (!/^\d{1,20}$/.test(String(modId))) return null;
  const mods = modsFolder(installPath);
  let root;
  try {
    root = fs.realpathSync(mods);
    // The Mods folder itself could be a link; it has to stay inside the install too.
    if (!isInside(fs.realpathSync(installPath), root)) return null;
  } catch {
    return null;
  }
  const newest = entries(mods)
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith(`${modId}_`))
    .flatMap((entry) => {
      // A folder removed or a link broken since the listing is skipped rather than failing the lookup.
      try {
        const stat = fs.statSync(path.join(mods, entry.name));
        return stat.isDirectory() ? [{ name: entry.name, time: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
  if (!newest) return null;
  // Links are followed here on purpose: the check on the final path is what keeps them inside.
  let level = [path.join(mods, newest.name)];
  for (let depth = 1; depth <= MOD_DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level)
      for (const entry of entries(dir)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name.toLowerCase() === 'preview') {
          const file = entries(full).find(
            (item) => (item.isFile() || item.isSymbolicLink()) && item.name.toLowerCase() === 'preview_image.png',
          );
          if (file) {
            try {
              const real = fs.realpathSync(path.join(full, file.name));
              if (isInside(root, real) && fs.statSync(real).size <= PREVIEW_MAX_BYTES) return real;
            } catch {
              /* a broken link is skipped */
            }
          }
        }
        next.push(full);
      }
    level = next;
  }
  return null;
}
