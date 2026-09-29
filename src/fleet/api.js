import fs from 'node:fs/promises';
import path from 'node:path';
import { transaction } from '../db/transaction.js';
import { checkActionOptions } from '../clusters/core.js';
import { activeFor, checkClone, checkDestination, checkFleet, checkFolder, freeSpace, MESSAGES } from './core.js';
import { clonePasswords } from './secrets.js';

export function registerFleetRoutes({ router, db, jobs, protectedRoute, must, error, serverRow }) {
  const free = (members, target) => {
    if (activeFor(db, members, target)) throw error(409, MESSAGES.busy);
  };
  router.add('GET', '/api/host/free-space', async ({ query }) => {
    const target = checkFolder(query.path);
    const server = query.serverId == null ? null : must(serverRow(db, query.serverId));
    return freeSpace(target, server?.install_path);
  });
  router.add('GET', '/api/host/folders', async ({ query }) => {
    const folder = /^[A-Za-z]:[\\/]$/.test(query.path) ? path.win32.normalize(query.path) : checkFolder(query.path);
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => {
      throw error(400, MESSAGES.folderUnreadable);
    });
    // The directory entries carry their own type. An lstat of each one would fail on files Windows
    // keeps locked, such as pagefile.sys at a drive root. Junctions report as links and are left out.
    const folders = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: path.win32.join(folder, entry.name) }));
    return { path: folder, parent: path.win32.dirname(folder), folders };
  });
  router.add(
    'POST',
    '/api/servers/:id/clone',
    protectedRoute(
      'server.clone',
      'server',
      async ({ params, body }) => {
        const source = must(serverRow(db, params.id));
        const input = checkClone(body, db);
        await checkDestination(db, input.path, source.install_path, fs, { copyWorld: input.copyWorld });
        return transaction(db, () => {
          free([source], input.path);
          const at = new Date().toISOString();
          const id = Number(
            db
              .prepare(
                "INSERT INTO installs (created_at, updated_at, host_id, path, branch, state, source) VALUES (?, ?, ?, ?, ?, 'missing', 'steamcmd')",
              )
              .run(at, at, source.host_id, input.path, source.install_branch ?? 'public').lastInsertRowid,
          );
          try {
            const { adminPassword, joinPassword, ...publicInput } = input;
            const job = jobs.enqueue('server.clone', publicInput, {
              serverId: source.id,
              installId: id,
              targets: { servers: [source.id], installs: [source.install_id, id], paths: [input.path] },
            });
            if (adminPassword !== undefined || joinPassword !== undefined)
              clonePasswords(db).set(job.id, { adminPassword, joinPassword });
            return { ...job, jobId: job.id };
          } catch (cause) {
            db.prepare('DELETE FROM installs WHERE id = ?').run(id);
            throw cause;
          }
        });
      },
      (ctx) => ({ path: ctx.body.path, copyWorld: ctx.body.copyWorld === true, name: ctx.body.name }),
    ),
  );
  router.add(
    'POST',
    '/api/servers/:id/move',
    protectedRoute(
      'server.move',
      'server',
      async ({ params, body }) => {
        const server = must(serverRow(db, params.id));
        const target = checkFolder(body?.path);
        const options = checkActionOptions({ countdownMinutes: body?.countdownMinutes, announce: body?.announce });
        await checkDestination(db, target, server.install_path);
        return transaction(db, () => {
          free([server], target);
          const job = jobs.enqueue(
            'server.move',
            { path: target, ...options },
            {
              serverId: server.id,
              installId: server.install_id,
              targets: { servers: [server.id], installs: [server.install_id], paths: [target] },
            },
          );
          return { ...job, jobId: job.id };
        });
      },
      (ctx) => ({ path: ctx.body.path }),
    ),
  );
  router.add(
    'POST',
    '/api/fleet/actions',
    protectedRoute(
      'fleet.action',
      'fleet',
      ({ body }) => {
        const checked = checkFleet(body, db);
        return transaction(db, () => {
          free(checked.members);
          const job = jobs.enqueue(
            'fleet.action',
            {
              action: checked.action,
              serverIds: checked.serverIds,
              countdownMinutes: checked.countdownMinutes,
              announce: checked.announce,
            },
            {
              targets: {
                servers: checked.members.map((m) => m.id),
                installs: checked.members.map((m) => m.install_id),
              },
            },
          );
          return { ...job, jobId: job.id };
        });
      },
      (ctx) => ({ action: ctx.body.action, serverIds: ctx.body.serverIds }),
    ),
  );
}
