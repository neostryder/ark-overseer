import { nowIso } from '../db/index.js';
import fs from 'node:fs';
import { MESSAGES } from '../import/phase0.js';

// Installs, updates or validates an install with SteamCMD. The install job handlers and the scheduled
// automatic update both call this, so an update behaves the same whichever one starts it.
export async function runInstall({ db, steamcmd }, ctx, mode) {
  // A manifest that cannot be read counts as not installed. An exception here would leave the
  // install stuck in its in-progress state.
  const manifestOf = (dir) => {
    try {
      return steamcmd.readManifest(dir);
    } catch {
      return null;
    }
  };
  const requireFiles = (dir) => {
    try {
      return fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  };
  const setState = db.prepare('UPDATE installs SET state = ?, updated_at = ? WHERE id = ?');
  const setInstalled = db.prepare('UPDATE installs SET state = ?, build_id = ?, updated_at = ? WHERE id = ?');
  const id = ctx.job.installId;
  if (id == null) throw new Error('Install job is missing installId');
  const row = db.prepare('SELECT * FROM installs WHERE id = ?').get(id);
  if (!row) throw new Error(`Install ${id} was not found`);
  // SteamCMD writing into a Steam library would fight Steam over the same files and manifest.
  if (row.source === 'steam-client') throw new Error(MESSAGES.steamClientInstall);
  const active = db
    .prepare(
      "SELECT 1 AS found FROM servers WHERE install_id = ? AND observed_state IN ('running', 'starting', 'stopping') LIMIT 1",
    )
    .get(id);
  if (active) throw new Error('Stop the servers that use this install first.');
  const state = mode === 'install' ? 'installing' : mode === 'update' ? 'updating' : 'validating';
  setState.run(state, nowIso(), id);
  try {
    const result = await steamcmd.appUpdate({
      installDir: row.path,
      branch: row.branch,
      validate: mode === 'validate' || (mode === 'install' && requireFiles(row.path)),
      signal: ctx.signal,
      progress: ctx.progress,
    });
    const buildId = manifestOf(row.path)?.buildId ?? null;
    setInstalled.run('installed', buildId, nowIso(), id);
    return { buildId, output: result.output };
  } catch (error) {
    // A failed or cancelled update normally leaves the old build intact, and the manifest says so.
    const manifest = manifestOf(row.path);
    if (manifest?.fullyInstalled) setInstalled.run('installed', manifest.buildId, nowIso(), id);
    else setState.run('broken', nowIso(), id);
    throw error;
  }
}

export function createInstallHandlers({ db, steamcmd }) {
  return {
    'steamcmd.setup': async ({ signal, progress }) => {
      if (!steamcmd.isInstalled()) await steamcmd.installSelf({ signal, progress });
      return { installed: true };
    },
    'install.install': (ctx) => runInstall({ db, steamcmd }, ctx, 'install'),
    'install.update': (ctx) => runInstall({ db, steamcmd }, ctx, 'update'),
    'install.validate': (ctx) => runInstall({ db, steamcmd }, ctx, 'validate'),
  };
}
