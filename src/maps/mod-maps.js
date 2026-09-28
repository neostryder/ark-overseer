import fs from 'node:fs';
import path from 'node:path';
import { modsFolder, isInside, entries } from './art.js';

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const UPLUGIN_MAX_BYTES = 256 * 1024;
const CACHE_MS = 60 * 1000;
const NAME_MAX = 60;
// ASA's playable maps end this way; test maps and sub-levels in the same mod do not.
const MAP_ID = /^[A-Za-z0-9_]+_WP$/;
// The same limit as a map id anywhere else, counting the _WP.
const MAP_ID_MAX = 64;
const CONTROL = /[\x00-\x1f\x7f]/g;
const cache = new Map();

export function clearModMapCache() {
  cache.clear();
}

const isDir = (entry) => entry.isDirectory() || entry.isSymbolicLink();
const isFile = (entry) => entry.isFile() || entry.isSymbolicLink();

// Reads up to `limit` bytes of a file that must resolve inside `root`. Returns null for anything else.
function readInside(root, file, limit) {
  try {
    const real = fs.realpathSync(file);
    if (!isInside(root, real)) return null;
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, limit);
    const fd = fs.openSync(real, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > limit };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const cleanName = (value) =>
  typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';

// Only a CurseForge page is worth linking to.
function curseForgeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return host === 'curseforge.com' || host.endsWith('.curseforge.com') ? url.href : null;
  } catch {
    return null;
  }
}

// The map ids a manifest lists: one line per file, a path then a tab then a timestamp.
function manifestMapIds({ text, truncated }) {
  const lines = text.split(/\r?\n/);
  // A manifest cut at the size limit ends in half a line, which is dropped rather than read.
  if (truncated) lines.pop();
  const ids = new Set();
  for (const line of lines) {
    const file = line.split('\t')[0].trim();
    if (!/\.umap$/i.test(file)) continue;
    const id = file.split(/[\\/]/).pop().slice(0, -'.umap'.length);
    if (id.length <= MAP_ID_MAX && MAP_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

// The newest <modId>_<fileId> folder for each mod, by modification time as findModPreview does.
function newestFolders(mods) {
  const newest = new Map();
  for (const entry of entries(mods)) {
    const match = /^(\d{1,20})_/.exec(entry.name);
    if (!match || !isDir(entry)) continue;
    let time;
    try {
      const stat = fs.statSync(path.join(mods, entry.name));
      if (!stat.isDirectory()) continue;
      time = stat.mtimeMs;
    } catch {
      continue;
    }
    const held = newest.get(match[1]);
    if (
      !held ||
      time > held.time ||
      (time === held.time && entry.name.localeCompare(held.name, undefined, { numeric: true }) > 0)
    )
      newest.set(match[1], { name: entry.name, time });
  }
  return newest;
}

// A mod holding several maps names each after the mod and its id. The id is kept whole and the mod's name
// is shortened to fit.
function mapName(friendly, id, several) {
  if (!several) return friendly;
  const suffix = `: ${id}`;
  const room = NAME_MAX - suffix.length;
  return room >= 1 ? `${friendly.slice(0, room).trimEnd()}${suffix}` : id;
}

// Every plugin folder in the mod is read. One that cannot be parsed or leaves its folder is skipped and the
// others still count.
function readMod(root, mods, modId, folder) {
  const top = path.join(mods, folder);
  const found = [];
  const seen = new Set();
  for (const plugin of entries(top)) {
    if (!isDir(plugin)) continue;
    const dir = path.join(top, plugin.name);
    const files = entries(dir).filter(isFile);
    const uplugin = files.find((file) => file.name.toLowerCase().endsWith('.uplugin'));
    const manifest = files.find((file) => file.name.toLowerCase() === 'manifest_ufsfiles_win64.txt');
    if (!uplugin || !manifest) continue;
    const descriptor = readInside(root, path.join(dir, uplugin.name), UPLUGIN_MAX_BYTES);
    const listing = readInside(root, path.join(dir, manifest.name), MANIFEST_MAX_BYTES);
    if (!descriptor || !listing) continue;
    let info;
    try {
      info = JSON.parse(descriptor.text);
    } catch {
      continue;
    }
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    const friendly = cleanName(info.FriendlyName) || `Mod ${modId}`;
    const marketplaceUrl = curseForgeUrl(info.MarketplaceURL);
    for (const id of manifestMapIds(listing))
      if (!seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        found.push({ id, friendly, marketplaceUrl });
      }
  }
  return found.map(({ id, friendly, marketplaceUrl }) => ({
    id,
    name: mapName(friendly, id, found.length > 1),
    kind: 'mod',
    modId,
    marketplaceUrl,
  }));
}

// The maps held by CurseForge mods that ASA has already downloaded to this install, so they have a name
// and a picture without a CurseForge key. Maps from mods that are not downloaded yet come from the
// CurseForge API in Phase 3, which plugs in where the results are merged into the catalog (withModMaps).
// This only reads, and it stays inside the Mods folder. The answer is kept for a minute.
export function findModMaps(installPath, { now = Date.now } = {}) {
  const key = path.resolve(String(installPath)).toLowerCase();
  const held = cache.get(key);
  if (held && now() - held.at < CACHE_MS) return held.maps.map((map) => ({ ...map }));
  let maps = [];
  try {
    const mods = modsFolder(installPath);
    const root = fs.realpathSync(mods);
    // The Mods folder itself could be a link; it has to stay inside the install too.
    if (isInside(fs.realpathSync(installPath), root)) {
      const seen = new Set();
      for (const [modId, { name }] of newestFolders(mods))
        for (const map of readMod(root, mods, modId, name))
          if (!seen.has(map.id.toLowerCase())) {
            seen.add(map.id.toLowerCase());
            maps.push(map);
          }
    }
  } catch {
    maps = [];
  }
  cache.set(key, { at: now(), maps });
  return maps.map((map) => ({ ...map }));
}

// The catalog with the maps found on this install added. A catalog entry wins over a found map with the
// same id. Windows folder names ignore case, so ids are compared without regard to it.
export function withModMaps(catalogData, installPath, findMods = findModMaps) {
  const known = new Set(catalogData.maps.map((map) => map.id.toLowerCase()));
  const found = findMods(installPath).filter((map) => !known.has(map.id.toLowerCase()));
  return { ...catalogData, maps: [...catalogData.maps, ...found] };
}
