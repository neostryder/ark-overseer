import fs from 'node:fs/promises';
import path from 'node:path';
import { readBackup, readManifest, resolveInside, isBelow } from './read.js';
import { checkRestore, RestoreError } from './restore.js';
import {
  SnapshotError,
  findSnapshot,
  readSnapshot,
  saveSnapshot,
  renameSnapshot,
  deleteSnapshot,
  diffSettings,
} from './settings-snapshots.js';
import { serverPaths } from '../supervisor/launch.js';

export const API_MESSAGES = {
  badNote: 'A note can be up to 200 characters, with no line breaks.',
  keepSafety:
    'Only manual and scheduled backups can be deleted. Backups taken before an update, a restore, an import or a map change are kept.',
};
// Jobs that change files under a server while it is down or being changed, so the dashboard's Start, Stop and
// Restart wait for them.
export const FILE_JOBS = ['server.switch_map', 'server.restore', 'server.settings_restore'];
const NOTE_MAX = 200;
const ACTIVE = new Set(['running', 'starting', 'unknown']);

// The routes for restoring backups and for named settings snapshots. `messages` is the app's API_MESSAGES.
export function registerBackupRoutes({
  router,
  db,
  dataDir,
  jobs,
  supervisor,
  protectedRoute,
  must,
  error,
  serverRow,
  messages,
}) {
  const backupOf = (serverId, backupId) =>
    db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(backupId, serverId) ?? must(null);
  const fromError = (cause) => {
    if (cause instanceof RestoreError || cause instanceof SnapshotError)
      return error(cause.status, cause.message, { code: cause.code });
    return cause;
  };
  // No await between this check and the enqueue that follows it, so two requests cannot both find the
  // server free.
  const assertFree = (server) => {
    const busy = db
      .prepare("SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND (server_id = ? OR install_id = ?) LIMIT 1")
      .get(server.id, server.install_id);
    if (busy) throw error(409, messages.jobRunning);
  };
  const restoreQueued = (serverId) =>
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM jobs WHERE kind IN ('server.restore', 'server.settings_restore') AND state IN ('queued', 'running') AND server_id = ? LIMIT 1",
        )
        .get(serverId),
    );

  router.add('GET', '/api/servers/:id/backups', async ({ params }) => {
    must(serverRow(db, params.id));
    return Promise.all(
      db
        .prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC, id DESC')
        .all(params.id)
        .map(async (row) => {
          let map = row.map ?? null,
            fileCount = 0,
            restorable = false,
            problem = null;
          try {
            const info = await readBackup(row, { dataDir, players: false });
            fileCount = info.files.length;
            restorable = true;
            if (!map && info.map) {
              map = info.map;
              // A backup from before maps were recorded: the manifest says which, and the row remembers.
              db.prepare('UPDATE backups SET map = ? WHERE id = ? AND map IS NULL').run(map, row.id);
            }
          } catch (cause) {
            problem = cause.message;
            try {
              // A backup that cannot be restored still shows its file count when it is one of ARK Overseer's
              // own folders: the import snapshots live beside the backups. Any other path counts no files.
              const folder = resolveInside(dataDir, 'snapshots', row.path);
              fileCount = (await readManifest(folder)).files.length;
            } catch {
              /* a backup without a readable file list, or outside ARK Overseer's folders, counts no files */
            }
          }
          return { ...row, map, note: row.note ?? null, files: fileCount, fileCount, restorable, problem };
        }),
    );
  });

  router.add('GET', '/api/servers/:id/backups/:backupId', async ({ params }) => {
    must(serverRow(db, params.id));
    const row = backupOf(params.id, params.backupId);
    let info;
    try {
      info = await readBackup(row, { dataDir });
    } catch (cause) {
      throw error(409, cause.message, { code: 'not_restorable' });
    }
    const shape = (items) => items.map(({ id, size, modifiedAt }) => ({ id, size, modifiedAt }));
    return {
      id: row.id,
      created_at: row.created_at,
      reason: row.reason,
      note: row.note ?? null,
      map: info.map,
      fileCount: info.files.length,
      worldFiles: info.world.length,
      settingsFiles: info.settings.length,
      profiles: shape(info.profiles),
      tribes: shape(info.tribes),
    };
  });

  router.add(
    'POST',
    '/api/servers/:id/backups/:backupId/restore',
    protectedRoute(
      'backup.restore',
      'server',
      async ({ params, body }) => {
        const server = must(serverRow(db, params.id));
        let check;
        try {
          check = await checkRestore({ db, dataDir, server, params: { ...body, backupId: params.backupId } });
        } catch (cause) {
          throw fromError(cause);
        }
        assertFree(server);
        // A running server is warned by the same countdown its scheduled restart uses.
        const schedule = db
          .prepare("SELECT options_json FROM schedules WHERE server_id = ? AND kind = 'restart'")
          .get(server.id);
        const options = schedule ? JSON.parse(schedule.options_json) : {};
        const job = jobs.enqueue(
          'server.restore',
          {
            backupId: check.row.id,
            scope: check.scope,
            ...(check.scope === 'players' ? { profiles: check.profiles, tribes: check.tribes } : {}),
            ...(options.countdownMinutes ? { countdownMinutes: options.countdownMinutes } : {}),
            ...(options.announce ? { announce: options.announce } : {}),
          },
          { serverId: server.id, installId: server.install_id },
        );
        return { ...job, differentMap: check.differentMap, map: check.map };
      },
      (ctx) => ({ backupId: ctx.params.backupId, scope: ctx.body.scope }),
    ),
  );

  router.add(
    'PATCH',
    '/api/servers/:id/backups/:backupId',
    protectedRoute(
      'backup.note',
      'server',
      ({ params, body }) => {
        must(serverRow(db, params.id));
        const row = backupOf(params.id, params.backupId);
        const note = body.note === null || body.note === undefined ? '' : body.note;
        if (typeof note !== 'string' || note.trim().length > NOTE_MAX || /[\x00-\x1f\x7f]/.test(note))
          throw error(400, API_MESSAGES.badNote);
        const clean = note.trim() || null;
        db.prepare('UPDATE backups SET note = ? WHERE id = ?').run(clean, row.id);
        return { id: row.id, note: clean };
      },
      (ctx) => ({ backupId: ctx.params.backupId }),
    ),
  );

  router.add(
    'DELETE',
    '/api/servers/:id/backups/:backupId',
    protectedRoute(
      'backup.delete',
      'server',
      async ({ params }) => {
        must(serverRow(db, params.id));
        const row = backupOf(params.id, params.backupId);
        if (!['manual', 'scheduled'].includes(row.reason)) throw error(409, API_MESSAGES.keepSafety);
        // A restore may be reading this backup, or may have just made the safety backup it would roll back to.
        if (restoreQueued(params.id)) throw error(409, messages.jobRunning);
        const target = path.resolve(row.path);
        if (isBelow(path.resolve(dataDir, 'backups'), target)) await fs.rm(target, { recursive: true, force: true });
        db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
        return { deleted: true };
      },
      (ctx) => ({ backupId: ctx.params.backupId }),
    ),
  );

  // ---- named settings snapshots ----

  router.add('GET', '/api/servers/:id/settings-snapshots', async ({ params }) => {
    must(serverRow(db, params.id));
    return Promise.all(
      db
        .prepare('SELECT * FROM settings_snapshots WHERE server_id = ? ORDER BY created_at DESC, id DESC')
        .all(params.id)
        .map(async (row) => {
          let files = 0,
            usable = false;
          try {
            files = (await readSnapshot(row, { dataDir })).files.length;
            usable = true;
          } catch {
            /* an unreadable snapshot is listed as unusable */
          }
          return { id: row.id, name: row.name, created_at: row.created_at, size_bytes: row.size_bytes, files, usable };
        }),
    );
  });

  router.add(
    'POST',
    '/api/servers/:id/settings-snapshots',
    protectedRoute(
      'settings.snapshot.save',
      'server',
      async ({ params, body }) => {
        const server = must(serverRow(db, params.id));
        try {
          return await saveSnapshot({ db, dataDir, server, name: body.name });
        } catch (cause) {
          throw fromError(cause);
        }
      },
      (ctx) => ({ name: ctx.body.name }),
    ),
  );

  router.add('GET', '/api/servers/:id/settings-snapshots/:snapshotId/diff', async ({ params }) => {
    const server = must(serverRow(db, params.id));
    try {
      const snapshot = await readSnapshot(findSnapshot(db, server.id, params.snapshotId), { dataDir });
      return await diffSettings(snapshot.folder, serverPaths(server.install_path).configDir);
    } catch (cause) {
      throw fromError(cause);
    }
  });

  router.add(
    'POST',
    '/api/servers/:id/settings-snapshots/:snapshotId/restore',
    protectedRoute(
      'settings.snapshot.restore',
      'server',
      async ({ params }) => {
        const server = must(serverRow(db, params.id));
        let row;
        try {
          row = findSnapshot(db, server.id, params.snapshotId);
          await readSnapshot(row, { dataDir });
        } catch (cause) {
          throw fromError(cause);
        }
        assertFree(server);
        const job = jobs.enqueue(
          'server.settings_restore',
          { snapshotId: row.id },
          { serverId: server.id, installId: server.install_id },
        );
        return { ...job, appliesAtRestart: ACTIVE.has(supervisor.status(server.id)?.observedState) };
      },
      (ctx) => ({ snapshotId: ctx.params.snapshotId }),
    ),
  );

  router.add(
    'PATCH',
    '/api/servers/:id/settings-snapshots/:snapshotId',
    protectedRoute(
      'settings.snapshot.rename',
      'server',
      ({ params, body }) => {
        must(serverRow(db, params.id));
        try {
          return renameSnapshot({ db, serverId: params.id, id: params.snapshotId, name: body.name });
        } catch (cause) {
          throw fromError(cause);
        }
      },
      (ctx) => ({ snapshotId: ctx.params.snapshotId, name: ctx.body.name }),
    ),
  );

  router.add(
    'DELETE',
    '/api/servers/:id/settings-snapshots/:snapshotId',
    protectedRoute(
      'settings.snapshot.delete',
      'server',
      async ({ params }) => {
        must(serverRow(db, params.id));
        // A restore may be reading the snapshot.
        if (restoreQueued(params.id)) throw error(409, messages.jobRunning);
        try {
          return await deleteSnapshot({ db, dataDir, serverId: params.id, id: params.snapshotId });
        } catch (cause) {
          throw fromError(cause);
        }
      },
      (ctx) => ({ snapshotId: ctx.params.snapshotId }),
    ),
  );
}
