import fs from 'node:fs/promises';
import path from 'node:path';
import { transaction } from '../db/transaction.js';
import { checkFolder, folderKey, MESSAGES } from './core.js';

const serverRow = (db, id) =>
  db
    .prepare(
      'SELECT s.*, i.path AS install_path, i.source AS install_source FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
    )
    .get(id);
const running = (supervisor, id) =>
  ['running', 'starting', 'stopping', 'unknown'].includes(supervisor.status(id)?.observedState);
const abortIf = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new Error(MESSAGES.cancelled);
};
const inside = (parent, child) => child === parent || child.startsWith(`${parent}\\`);
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 250 };

// Checks that a server's install folder can be deleted, and returns it, or null when it is already gone.
// The folder is only ever removed after every one of these checks holds.
export async function checkRemovable(db, server, { dataDir, fsOps = fs, cwd = process.cwd() }) {
  const fail = (message) => Object.assign(new Error(message), { status: 409 });
  if (server.install_source === 'steam-client') throw fail(MESSAGES.removeSteam);
  let folder;
  try {
    folder = checkFolder(server.install_path);
  } catch {
    throw fail(MESSAGES.removeUnsafe);
  }
  const own = folderKey(folder);
  const others = db.prepare('SELECT path FROM installs WHERE id != ?').all(server.install_id);
  const installs = others.map((row) => folderKey(row.path));
  const ownData = [dataDir, cwd].filter(Boolean).map(folderKey);
  // A folder that holds another install, or that sits inside one, is never deleted. Neither is one that
  // holds ARK Overseer's own data or its working folder.
  if (installs.some((other) => inside(own, other) || inside(other, own)) || ownData.some((other) => inside(own, other)))
    throw fail(MESSAGES.removeUnsafe);
  let info;
  try {
    info = await fsOps.lstat(folder);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
  if (info.isSymbolicLink()) throw fail(MESSAGES.removeLink);
  if (!info.isDirectory()) throw fail(MESSAGES.removeUnsafe);
  return folder;
}

async function deleteFolder(folder, { signal, progress, fsOps }) {
  const entries = await fsOps.readdir(folder);
  for (const [index, name] of entries.entries()) {
    abortIf(signal);
    await fsOps.rm(path.join(folder, name), RM);
    progress(0.1 + (0.8 * (index + 1)) / entries.length, MESSAGES.removeProgress);
  }
  abortIf(signal);
  await fsOps.rm(folder, RM);
}

export function createRemovalHandlers({ db, dataDir, supervisor, drift, fsOps = fs, cwd }) {
  return {
    'server.remove': async ({ job, params, signal, progress }) => {
      const server = serverRow(db, job.serverId);
      if (!server) throw new Error(MESSAGES.missing);
      if (running(supervisor, server.id)) throw new Error(MESSAGES.removeRunning);
      const deleteFiles = params.deleteFiles === true;
      const installPath = server.install_path;
      if (deleteFiles) {
        const folder = await checkRemovable(db, server, { dataDir, fsOps, cwd });
        progress(0.05, MESSAGES.removeProgress);
        if (folder) {
          try {
            await deleteFolder(folder, { signal, progress, fsOps });
          } catch (cause) {
            if (signal.aborted) throw cause;
            throw new Error(MESSAGES.removeFailed.replace('{folder}', folder));
          }
        }
        await fsOps.rm(path.join(dataDir, 'backups', `server-${server.id}`), RM);
        db.prepare('DELETE FROM backups WHERE server_id = ?').run(server.id);
      }
      abortIf(signal);
      await drift.removeBaseline(server.id);
      await fsOps.rm(path.join(dataDir, 'settings-snapshots', `server-${server.id}`), RM);
      transaction(db, () => {
        db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
        db.prepare('DELETE FROM installs WHERE id = ?').run(server.install_id);
      });
      supervisor.forget?.(server.id);
      return {
        name: server.name,
        deleteFiles,
        message: deleteFiles ? MESSAGES.removedDeleted : MESSAGES.removedKept.replace('{folder}', installPath),
      };
    },
  };
}
