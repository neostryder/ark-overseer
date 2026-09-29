import fs from 'node:fs/promises';
import path from 'node:path';
import { baselineDir } from '../settings/baseline.js';
import { MESSAGES } from './core.js';

export function recordClonePath(db, jobId, target, file, kind) {
  const relative = path.relative(target, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(MESSAGES.badFolder);
  db.prepare('INSERT OR IGNORE INTO pending_clone_paths (job_id, relative_path, kind) VALUES (?, ?, ?)').run(
    jobId,
    relative,
    kind,
  );
}

export async function cleanClone({ db, dataDir, jobId, fsOps = fs, drift }) {
  const pending = db.prepare('SELECT * FROM pending_clones WHERE job_id = ?').get(jobId);
  if (!pending) return;
  const paths = db.prepare('SELECT relative_path, kind FROM pending_clone_paths WHERE job_id = ?').all(jobId);
  paths.sort((a, b) => b.relative_path.length - a.relative_path.length);
  for (const entry of paths) {
    const file = path.resolve(pending.target_path, entry.relative_path);
    const relative = path.relative(pending.target_path, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (entry.kind === 'file') await fsOps.rm(file, { force: true });
    else
      await fsOps.rmdir(file).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
      });
  }
  if (pending.created_root) await fsOps.rm(pending.target_path, { recursive: true, force: true });
  if (pending.server_id) {
    const server = db.prepare('SELECT install_id FROM servers WHERE id = ?').get(pending.server_id);
    if (server?.install_id === pending.install_id) {
      await fsOps.rm(baselineDir(dataDir, pending.server_id), { recursive: true, force: true });
      drift?.forgetBaseline?.(pending.server_id);
      db.prepare('DELETE FROM servers WHERE id = ?').run(pending.server_id);
    }
  }
  db.prepare('DELETE FROM installs WHERE id = ? AND path = ?').run(pending.install_id, pending.target_path);
  completeClone(db, jobId);
}

export function completeClone(db, jobId) {
  db.prepare('DELETE FROM pending_clone_paths WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM pending_clones WHERE job_id = ?').run(jobId);
}

export async function reconcileInterruptedClones({ db, dataDir, fsOps = fs }) {
  for (const row of db
    .prepare("SELECT p.job_id FROM pending_clones p JOIN jobs j ON j.id = p.job_id WHERE j.state = 'succeeded'")
    .all())
    completeClone(db, row.job_id);
  const jobs = db
    .prepare(
      "SELECT id, install_id, params_json FROM jobs WHERE kind = 'server.clone' AND state IN ('running', 'interrupted')",
    )
    .all();
  for (const job of jobs) {
    if (db.prepare('SELECT 1 FROM pending_clones WHERE job_id = ?').get(job.id)) {
      await cleanClone({ db, dataDir, jobId: job.id, fsOps });
      continue;
    }
    const install = db.prepare('SELECT path FROM installs WHERE id = ?').get(job.install_id);
    if (
      install?.path === JSON.parse(job.params_json).path &&
      !db.prepare('SELECT 1 FROM servers WHERE install_id = ?').get(job.install_id)
    )
      db.prepare('DELETE FROM installs WHERE id = ?').run(job.install_id);
  }
}

export function reconcilePendingMoves({ db }) {
  const pending = db.prepare('SELECT * FROM pending_moves').all();
  const recovered = [];
  for (const row of pending) {
    const server = db.prepare('SELECT install_id FROM servers WHERE id = ?').get(row.server_id);
    const install = server && db.prepare('SELECT path FROM installs WHERE id = ?').get(server.install_id);
    if (install && [row.source_path, row.target_path].includes(install.path)) {
      db.prepare('UPDATE servers SET desired_state = ? WHERE id = ?').run(
        row.was_running ? 'running' : 'stopped',
        row.server_id,
      );
      recovered.push({
        serverId: row.server_id,
        wasRunning: Boolean(row.was_running),
        pathUpdated: install.path === row.target_path,
        stage: row.stage,
      });
    }
    db.prepare('DELETE FROM pending_moves WHERE job_id = ?').run(row.job_id);
  }
  return recovered;
}
