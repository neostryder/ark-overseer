import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from '../import/phase0.js';

export const MESSAGES = {
  outside: 'That backup is not inside the backup folder, so it is not used.',
  noManifest: 'The backup has no file list (snapshot.json), so it cannot be used.',
  tooLarge: "The backup's file list is over 20 MB, so it is not used.",
  badManifest: "The backup's file list could not be read.",
  duplicateFile: "This backup lists {file} twice, so ARK Overseer won't use it.",
  severalMaps: "This backup holds saves from more than one map, so ARK Overseer won't use it.",
  missing: '{file} is missing from the {what}.',
  changed: '{file} in the {what} no longer matches the hash taken when it was saved.',
  cancelled: 'The job was cancelled.',
};

export const WORLD_ROOT = 'SavedArks';
export const CONFIG_PREFIX = 'Config/WindowsServer';
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const PLAYER_FILE = /^(.+)\.(arkprofile|arktribe)$/i;

export class BackupError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// True when `target` is `root` itself or below it. Windows paths ignore case, and path.relative knows that.
export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// Strictly below: the backups folder itself is never a backup.
export function isBelow(root, target) {
  return isInside(root, target) && path.relative(root, target) !== '';
}

// The real folder of a backup or snapshot, or an error when the row points anywhere outside `<dataDir>/<area>`.
// Both sides go through realpath, so a link or a short 8.3 name cannot lead out of the folder.
export function resolveInside(dataDir, area, folder) {
  let real;
  try {
    const root = fs.realpathSync(path.join(dataDir, area));
    real = fs.realpathSync(folder);
    if (!isBelow(root, real)) real = null;
  } catch {
    real = null;
  }
  if (!real) throw new BackupError(MESSAGES.outside, 'outside');
  return real;
}

// A relPath ends up in file paths, so it has to be a plain relative path under one of the two known roots.
function validRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 400 || /[\\:\x00-\x1f]/.test(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  return (parts[0] === WORLD_ROOT && parts.length >= 3) || relPath.startsWith(`${CONFIG_PREFIX}/`);
}

// The manifest of a backup folder, checked. Nothing here writes.
export async function readManifest(folder, name = 'snapshot.json') {
  const file = path.join(folder, name);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new BackupError(MESSAGES.noManifest, 'no_manifest');
  }
  if (stat.size > MAX_MANIFEST_BYTES) throw new BackupError(MESSAGES.tooLarge, 'too_large');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new BackupError(MESSAGES.badManifest, 'bad_manifest');
  }
  if (!manifest || !Array.isArray(manifest.files)) throw new BackupError(MESSAGES.badManifest, 'bad_manifest');
  const files = [];
  const names = new Set();
  const maps = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      !validRelPath(entry.relPath) ||
      !Number.isFinite(entry.size) ||
      entry.size < 0 ||
      !/^[0-9a-f]{64}$/i.test(String(entry.sha256))
    )
      throw new BackupError(MESSAGES.badManifest, 'bad_manifest');
    // Windows paths ignore case, so two entries that differ only by case name the same file.
    const key = entry.relPath.toLowerCase();
    if (names.has(key))
      throw new BackupError(fill(MESSAGES.duplicateFile, { file: entry.relPath.split('/').pop() }), 'bad_manifest');
    names.add(key);
    if (entry.relPath.startsWith(`${WORLD_ROOT}/`)) maps.add(entry.relPath.split('/')[1].toLowerCase());
    if (maps.size > 1) throw new BackupError(MESSAGES.severalMaps, 'bad_manifest');
    const modified = entry.mtime ?? entry.modifiedAt;
    files.push({
      relPath: entry.relPath,
      size: entry.size,
      sha256: entry.sha256.toLowerCase(),
      ...(typeof modified === 'string' && Number.isFinite(Date.parse(modified)) ? { modifiedAt: modified } : {}),
    });
  }
  return { createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null, files };
}

// What a backup holds: its map, its files by kind, and every player and tribe file with its id. Files are
// listed from the manifest and never hashed here.
export async function readBackup(row, { dataDir, players = true }) {
  const folder = resolveInside(dataDir, 'backups', row.path);
  const manifest = await readManifest(folder);
  const fromManifest = manifest.files.find((file) => file.relPath.startsWith(`${WORLD_ROOT}/`))?.relPath.split('/')[1];
  const map = row.map || fromManifest || null;
  const inWorld = (file) => map !== null && file.relPath.startsWith(`${WORLD_ROOT}/${map}/`);
  const world = manifest.files.filter(inWorld);
  const settings = manifest.files.filter((file) => file.relPath.startsWith(`${CONFIG_PREFIX}/`));
  const named = async (extension) => {
    const found = [];
    for (const file of world) {
      const parts = file.relPath.split('/');
      const match = parts.length === 3 ? PLAYER_FILE.exec(parts[2]) : null;
      if (match && match[2].toLowerCase() === extension)
        found.push({ id: match[1], relPath: file.relPath, size: file.size, modifiedAt: file.modifiedAt ?? null });
    }
    return Promise.all(
      found.map(async (item) => {
        if (item.modifiedAt) return item;
        try {
          return {
            ...item,
            modifiedAt: (await fsp.stat(path.join(folder, ...item.relPath.split('/')))).mtime.toISOString(),
          };
        } catch {
          return item;
        }
      }),
    );
  };
  return {
    folder,
    createdAt: manifest.createdAt,
    map,
    files: manifest.files,
    world,
    settings,
    profiles: players ? await named('arkprofile') : [],
    tribes: players ? await named('arktribe') : [],
  };
}

// The files a restore of this scope reads. `profiles` and `tribes` are lists of ids for the players scope.
export function selectFiles(info, { scope, profiles = [], tribes = [] }) {
  if (scope === 'players') {
    const wantedProfiles = new Set(profiles),
      wantedTribes = new Set(tribes);
    return {
      world: [],
      settings: [],
      players: [
        ...info.profiles.filter((item) => wantedProfiles.has(item.id)),
        ...info.tribes.filter((item) => wantedTribes.has(item.id)),
      ].map((item) => info.world.find((file) => file.relPath === item.relPath)),
    };
  }
  return {
    world: scope === 'world' || scope === 'everything' ? info.world : [],
    settings: scope === 'settings' || scope === 'everything' ? info.settings : [],
    players: [],
  };
}

// Hashes each listed file under `folder` and compares it with its manifest entry. It reads and never writes.
export async function verifyFiles(folder, files, signal, what = 'backup') {
  let checked = 0;
  for (const file of files) {
    if (signal?.aborted) throw signal.reason ?? new Error(MESSAGES.cancelled);
    const actual = await hashFile(path.join(folder, ...file.relPath.split('/'))).catch((error) => {
      if (error.code === 'ENOENT')
        throw new BackupError(fill(MESSAGES.missing, { file: file.relPath, what }), 'missing');
      throw error;
    });
    if (actual.sha256 !== file.sha256 || actual.size !== file.size)
      throw new BackupError(fill(MESSAGES.changed, { file: file.relPath, what }), 'changed');
    checked++;
  }
  return { ok: true, checked };
}

// Hashes every file the scope needs and compares it with the manifest.
export async function verifyBackup(row, { dataDir, scope, profiles, tribes, signal, info }) {
  const backup = info ?? (await readBackup(row, { dataDir }));
  const selected = selectFiles(backup, { scope, profiles, tribes });
  return verifyFiles(backup.folder, [...selected.world, ...selected.settings, ...selected.players], signal);
}
