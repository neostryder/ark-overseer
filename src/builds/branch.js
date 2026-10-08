import fs from 'node:fs';
import path from 'node:path';
import { nowIso, transaction } from '../db/index.js';
import { backupServer } from '../scheduler/backup.js';
import { runInstall } from '../steamcmd/handlers.js';
import { MESSAGES as IMPORT_MESSAGES } from '../import/phase0.js';
import { BRANCH_NAME, isTestBranch, resumeMods, suspendMods } from './history.js';
import { branchLabel } from './watch.js';

export const MESSAGES = {
  noInstall: 'The install was not found.',
  badBranch: 'Choose a Steam branch by name.',
  sameBranch: 'This install already runs on that branch.',
  unknownBranch: 'Steam does not list that branch. Check Steam for new builds first.',
  running: 'Stop the servers that use this install first.',
  needsAck:
    'Moving to a test branch can change saved worlds in a way the live game cannot read back. Confirm that a backup is enough, or add a test copy instead.',
  inCluster:
    'A server in a cluster cannot move to a test branch, because test servers cannot join live servers. Remove it from the cluster first.',
  clusterMix: 'Servers on a test branch and servers on the live game cannot share a cluster.',
  noBackup: 'The backup before the switch failed, so the branch was not changed. {reason}',
  backingUp: 'Backing up every server on this install before the switch.',
  switching: 'Switching to {branch}.',
  failed: 'The switch to {branch} did not finish, so this install stays on {old}. {reason}',
  done: 'This install now runs on {branch}.',
};
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// Every map folder that holds saves, so a switch backs up the worlds of maps the server is not on now too.
export function savedMaps(installPath, fsOps = fs) {
  const folder = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks');
  try {
    return fsOps
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Whether an install on `branch` may share this cluster with the servers on its other installs. A cluster is
// all live or all test, never both. `installId` leaves out the install being moved.
export function clusterBranchProblem(db, clusterId, branch, installId = null) {
  const others = db
    .prepare(
      'SELECT i.branch FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.cluster_id = ? AND i.id IS NOT ? GROUP BY i.branch',
    )
    .all(clusterId, installId);
  return others.some((row) => isTestBranch(row.branch) !== isTestBranch(branch)) ? MESSAGES.clusterMix : null;
}

// Decides a switch before any job is queued, so the reason reaches the person at once. Returns the install and
// its servers, or throws an error with a status.
export function checkSwitch(db, installId, params = {}) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const install = db.prepare('SELECT * FROM installs WHERE id = ?').get(installId);
  if (!install) throw fail(404, MESSAGES.noInstall);
  if (install.source === 'steam-client') throw fail(409, IMPORT_MESSAGES.steamClientInstall);
  const branch = params.branch;
  if (typeof branch !== 'string' || !BRANCH_NAME.test(branch)) throw fail(400, MESSAGES.badBranch);
  if (branch === install.branch) throw fail(409, MESSAGES.sameBranch);
  if (branch !== 'public' && !db.prepare('SELECT 1 FROM steam_builds WHERE branch = ?').get(branch))
    throw fail(409, MESSAGES.unknownBranch);
  const servers = db.prepare('SELECT * FROM servers WHERE install_id = ? ORDER BY id').all(installId);
  // 'unknown' counts as active: the server may be up with Overseer not knowing it.
  if (servers.some((server) => ['running', 'starting', 'stopping', 'unknown'].includes(server.observed_state)))
    throw fail(409, MESSAGES.running);
  if (isTestBranch(branch) && !isTestBranch(install.branch) && params.acknowledged !== true)
    throw fail(409, MESSAGES.needsAck);
  if (isTestBranch(branch) !== isTestBranch(install.branch)) {
    for (const server of servers) {
      if (server.cluster_id == null) continue;
      if (isTestBranch(branch) && params.allowCluster !== true) throw fail(409, MESSAGES.inCluster);
      const problem = clusterBranchProblem(db, server.cluster_id, branch, install.id);
      if (problem && params.allowCluster !== true) throw fail(409, problem);
    }
  }
  return { install, servers, branch };
}

export function createBranchHandlers({
  db,
  dataDir,
  steamcmd,
  rcon,
  getRconPassword,
  now = () => Date.now(),
  fsOps = fs,
}) {
  return {
    'install.switch_branch': async (ctx) => {
      const { job, params = {}, signal, progress } = ctx;
      const { install, servers, branch } = checkSwitch(db, job.installId, params);
      const old = install.branch;
      const toTest = isTestBranch(branch);
      // Every server gets a backup of its settings and of every map that has saves, before anything changes.
      progress?.(0.02, MESSAGES.backingUp);
      for (const server of servers) {
        const maps = savedMaps(install.path, fsOps);
        const targets = maps.length ? maps : [server.map];
        for (const [index, map] of targets.entries()) {
          try {
            await backupServer({
              db,
              server: { ...server, install_path: install.path },
              dataDir,
              reason: 'pre_update',
              rcon,
              getRconPassword,
              isRunning: async () => false,
              now,
              jobId: job.id,
              signal,
              map,
              // Settings go in with the first map's backup only.
              include: index === 0 ? {} : { config: false },
            });
          } catch (error) {
            // A server with nothing to back up has nothing to lose.
            if (error.code !== 'EMPTY_BACKUP') throw new Error(fill(MESSAGES.noBackup, { reason: error.message }));
          }
        }
      }
      progress?.(0.1, fill(MESSAGES.switching, { branch: branchLabel(branch) }));
      db.prepare('UPDATE installs SET branch = ?, updated_at = ? WHERE id = ?').run(branch, nowIso(), install.id);
      let result;
      try {
        result = await runInstall({ db, steamcmd }, ctx, 'update', { reason: 'branch_switch', validate: true });
      } catch (error) {
        // The old files are normally intact after a failed or cancelled download, so the install stays on
        // the branch it had. The next update or validate repairs it if it is not.
        db.prepare('UPDATE installs SET branch = ?, updated_at = ? WHERE id = ?').run(old, nowIso(), install.id);
        throw new Error(
          fill(MESSAGES.failed, { branch: branchLabel(branch), old: branchLabel(old), reason: error.message }),
        );
      }
      // Mods follow the branch: suspended on a test branch (unless kept on purpose), resumed on the way back.
      transaction(db, () => {
        // The install's servers now, not the ones when the switch began: one added during a long download follows the branch too.
        for (const server of db.prepare('SELECT id FROM servers WHERE install_id = ? ORDER BY id').all(install.id)) {
          const row = db.prepare('SELECT settings_json FROM servers WHERE id = ?').get(server.id);
          const next = toTest
            ? params.keepMods === true
              ? row.settings_json
              : suspendMods(row.settings_json)
            : resumeMods(row.settings_json);
          if (next !== row.settings_json)
            db.prepare('UPDATE servers SET settings_json = ?, updated_at = ? WHERE id = ?').run(
              next,
              nowIso(),
              server.id,
            );
        }
      });
      return {
        branch,
        from: old,
        buildId: result.buildId,
        message: fill(MESSAGES.done, { branch: branchLabel(branch) }),
      };
    },
  };
}
