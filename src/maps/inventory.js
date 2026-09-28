import fs from 'node:fs';
import path from 'node:path';

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// The names of the map folders under SavedArks, as they are spelled on disk.
export function saveFolders(installPath) {
  const root = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks');
  return listDir(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// One entry per map folder under SavedArks. Windows file names ignore case, so a folder or world file
// spelled differently from the map id still counts. This only reads; nothing here is ever written.
export function saveInventory({ installPath, currentMap, catalog }) {
  const root = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks');
  const known = new Map((catalog?.maps ?? []).map((map) => [map.id.toLowerCase(), map]));
  const current = String(currentMap ?? '').toLowerCase();
  const saves = listDir(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folder = path.join(root, entry.name);
      const files = listDir(folder).filter((file) => file.isFile());
      const world = files.find((file) => file.name.toLowerCase() === `${entry.name}.ark`.toLowerCase());
      let stat = null;
      if (world)
        try {
          stat = fs.statSync(path.join(folder, world.name));
        } catch {
          /* the server may be rewriting it; the map is then listed without a world file */
        }
      const count = (extension) => files.filter((file) => file.name.toLowerCase().endsWith(extension)).length;
      const map = known.get(entry.name.toLowerCase());
      return {
        mapId: entry.name,
        name: map?.name ?? entry.name,
        kind: map?.kind ?? null,
        current: entry.name.toLowerCase() === current,
        worldBytes: stat ? stat.size : null,
        lastSavedAt: stat ? stat.mtime.toISOString() : null,
        profiles: count('.arkprofile'),
        tribes: count('.arktribe'),
      };
    });
  return saves.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.lastSavedAt ?? '').localeCompare(a.lastSavedAt ?? '') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.mapId.localeCompare(b.mapId, undefined, { sensitivity: 'base' }),
  );
}
