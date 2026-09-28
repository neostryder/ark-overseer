import fs from 'node:fs';
import path from 'node:path';
import { snapshotFiles } from '../import/phase0.js';
import { serverPaths } from '../supervisor/launch.js';

export const MESSAGES = {
  emptyBackup: 'There were no save or settings files to back up.',
  saveFailed: 'The server did not save the world first, so the backup holds its last save.',
  missingWorld: 'The world save folder was not found.',
  missingConfig: 'The settings folder was not found.',
};

function collectFiles(folder, prefix, output) {
  if (!fs.existsSync(folder)) return false;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        output.push({ path: full, relPath: `${prefix}/${path.relative(folder, full).split(path.sep).join('/')}` });
    }
  };
  walk(folder);
  return true;
}

export async function backupServer({
  db,
  server,
  dataDir,
  reason,
  rcon,
  getRconPassword,
  isRunning,
  now = () => Date.now(),
  jobId = null,
  signal,
}) {
  const skipped = [];
  if (await isRunning(server.id)) {
    try {
      const password = await getRconPassword(server);
      await rcon({ host: '127.0.0.1', port: server.rcon_port, password, command: 'SaveWorld' });
    } catch {
      skipped.push(MESSAGES.saveFailed);
    }
  }
  const paths = serverPaths(server.install_path),
    sources = [];
  const world = path.join(server.install_path, 'ShooterGame', 'Saved', 'SavedArks', server.map);
  if (!collectFiles(world, `SavedArks/${server.map}`, sources)) skipped.push(MESSAGES.missingWorld);
  if (!collectFiles(paths.configDir, 'Config/WindowsServer', sources)) skipped.push(MESSAGES.missingConfig);
  if (!sources.length) throw new Error(MESSAGES.emptyBackup);
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('.', '-');
  const base = path.join(dataDir, 'backups', `server-${server.id}`, `${stamp}-${reason}`);
  // snapshotFiles refuses a folder that already exists, so a second backup in the same millisecond
  // gets a numbered folder rather than failing.
  let snapshot;
  for (let attempt = 0; !snapshot; attempt++) {
    try {
      snapshot = await snapshotFiles(sources, attempt ? `${base}-${attempt + 1}` : base, { signal });
    } catch (error) {
      if (attempt >= 9 || !/already exists/.test(error.message)) throw error;
    }
  }
  const createdAt = new Date(now()).toISOString();
  const result = db
    .prepare(
      'INSERT INTO backups (created_at, server_id, job_id, reason, path, size_bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(createdAt, server.id, jobId, reason, snapshot.path, snapshot.sizeBytes, snapshot.sha256);
  return {
    backupId: Number(result.lastInsertRowid),
    path: snapshot.path,
    sizeBytes: snapshot.sizeBytes,
    files: snapshot.files,
    skipped,
  };
}

export function pruneBackups({ db, serverId, keep, dataDir }) {
  const rows = db
    .prepare(
      "SELECT id, path FROM backups WHERE server_id = ? AND reason IN ('scheduled', 'manual') ORDER BY created_at DESC, id DESC",
    )
    .all(serverId);
  const root = path.resolve(dataDir, 'backups');
  const remove = db.prepare('DELETE FROM backups WHERE id = ?');
  for (const row of rows.slice(keep)) {
    const target = path.resolve(row.path);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    remove.run(row.id);
  }
}
