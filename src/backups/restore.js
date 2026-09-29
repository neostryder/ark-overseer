import path from 'node:path';
import { transaction } from '../db/transaction.js';
import { backupServer } from '../scheduler/backup.js';
import { PLAYER_MESSAGES, MESSAGES as SCHEDULE_MESSAGES } from '../scheduler/handlers.js';
import { createTell, runCountdown, defaultSleep } from '../scheduler/countdown.js';
import { serverPaths } from '../supervisor/launch.js';
import { waitForReady, readLogMarker } from '../supervisor/ready.js';
import { readBackup, verifyBackup, selectFiles, WORLD_ROOT, CONFIG_PREFIX } from './read.js';
import { defaultOps, stageUnit, swapUnit, settle } from './swap.js';

export const RESTORE_MESSAGES = {
  noBackup: 'That backup was not found.',
  badScope: 'Choose Everything, World only, Settings only, or Players and tribes.',
  notRestorable: 'This backup cannot be restored. Its folder or its file list is missing.',
  noWorldFiles: 'This backup holds no world files, so there is no world to restore.',
  noSettingsFiles: 'This backup holds no settings files, so there are no settings to restore.',
  noFiles: 'This backup holds no world or settings files, so there is nothing to restore.',
  badMap: "This backup's map name is not one ARK Overseer can restore.",
  noPlayers: 'Choose at least one player or tribe to restore.',
  badPlayers: 'Send the players and tribes as lists of ids.',
  unknownPlayers: 'These are not in the backup: {ids}.',
  stopFailed: 'The server could not be stopped, so nothing was restored.',
  safetyFailed: 'The safety backup failed, so nothing was restored.',
  filesFailed: 'The files could not be replaced, so nothing was changed.',
  filesNotPutBack:
    'The files could not be replaced, and they could not be put back either. ARK Overseer will try again the next time it starts.',
  restartFailed: 'It could not be started again either. Start it from the Overview page.',
  alreadyRunning: 'The server was already running when ARK Overseer went to start it.',
  notRunning: 'The server was not running after ARK Overseer started it.',
  rolledBack:
    'The restored files did not start the server: {reason} The server is back as it was before the restore. The backup from {time} was not changed.',
  rolledBackNoReason:
    'The restored files did not start the server. It is back as it was before the restore. The backup from {time} was not changed.',
  rollbackFailed:
    'The restored files did not start the server, and it did not start after they were put back. Check the server log. The backup from {time} was not changed.',
  rollbackFilesFailed:
    'The restored files did not start the server, and the earlier files could not be put back. ARK Overseer will try again the next time it starts. Check the server log. The backup from {time} was not changed.',
  earlierLeftFiles:
    "An earlier restore on this server left files it couldn't put back, and ARK Overseer couldn't sort them out: {reason} Nothing was changed. Check the world and settings folders, then restart ARK Overseer to try again.",
  unknownStage:
    "An unfinished restore stopped at a point this version doesn't know, so ARK Overseer left its files alone.",
  noStartAfterRollback:
    'The server stays stopped, because these files already failed to start it once. Start it from the Overview page.',
  nothingToSave: 'There was nothing to make a safety backup of.',
  leftovers: 'Some leftover folders could not be removed. ARK Overseer removes them the next time it starts.',
  differentMap:
    'This backup is of {map}, and the server still launches {current}. The restored world is used the next time the server runs {map}.',
  cancelled: 'The job was cancelled.',
  steps: {
    checking: 'Checking the backup against its file list.',
    countdown: 'Warning players in game before the restore.',
    stopping: 'Saving the world and shutting the server down.',
    safety: 'Making a safety backup of what the restore replaces.',
    restoring: 'Copying files from the backup and putting them in place.',
    starting: 'Starting the server.',
    waiting: 'The restored world is loading. A big map can take 10 minutes or more.',
    rollingBack: "The restored files didn't start, so the earlier files are going back.",
    restarting: 'The restore did not happen. Starting the server again.',
    done: 'The backup from {time} is restored.',
    doneStopped: 'The backup from {time} is restored. The server stays stopped until you start it.',
  },
};

export const SCOPES = ['everything', 'world', 'settings', 'players'];
// A map id ends up in a folder name, so it stays to plain characters.
const MAP_ID = /^[A-Za-z0-9_]{1,64}$/;
const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PLAYERS = 5000;
// A server in one of these states may have a live process, so nothing is changed under it.
const ACTIVE = new Set(['running', 'starting', 'unknown']);

// What a stopped restore means at each stage, for the startup reconcile. `first` is what to do with the
// leftovers of the restore itself, `back` with those of the rollback after a server that would not start.
// Up to `swapping` the old files still matter, so everything is put back; from `cleanup` on the swap is
// whole and only the old copies remain.
const STAGES = {
  stopping: { first: 'undo', back: 'undo', outcome: 'rolled_back' },
  safety: { first: 'undo', back: 'undo', outcome: 'rolled_back' },
  staging: { first: 'undo', back: 'undo', outcome: 'rolled_back' },
  swapping: { first: 'undo', back: 'undo', outcome: 'rolled_back' },
  cleanup: { first: 'finish', back: 'undo', outcome: 'completed' },
  starting: { first: 'finish', back: 'undo', outcome: 'completed' },
  // A rollback stage is only reached after the restored files failed to start the server, so the server is
  // not started again from these files whichever way they are settled.
  rollback: { first: 'finish', back: 'undo', outcome: 'completed', start: false },
  rollback_cleanup: { first: 'finish', back: 'finish', outcome: 'rolled_back', start: false },
  rollback_starting: { first: 'finish', back: 'finish', outcome: 'rolled_back', start: false },
};

export class RestoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
const sentence = (text) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};
const joinReason = (message, reason) => (reason ? `${message} ${reason}` : message);
// In this computer's own time zone, which is the one the Backups page shows for the same backup.
export const formatTime = (iso) => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'an earlier time';
  const d = new Date(time);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const auditEvent = (db, stamp, actor, action, serverId, detail) =>
  db
    .prepare(
      'INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(stamp, actor, action, 'server', serverId, JSON.stringify(detail));

// The folders a restore works in, for one install.
export function restoreLayout(installPath) {
  const savedArks = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks');
  const configDir = serverPaths(installPath).configDir;
  return { savedArks, configDir, roots: [savedArks, path.dirname(configDir)] };
}

// Decides whether a restore of this backup, of this scope, may go ahead. The API answers from this before it
// queues the job, and the job asks again when it runs, so both refuse exactly the same requests. It reads the
// backup's file list and never hashes a file (verifyBackup does that, in the job).
export async function checkRestore({ db, dataDir, server, params }) {
  const scope = params.scope;
  if (!SCOPES.includes(scope)) throw new RestoreError(400, 'bad_scope', RESTORE_MESSAGES.badScope);
  const backupId = Number(params.backupId);
  const row = Number.isInteger(backupId)
    ? db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?').get(backupId, server.id)
    : null;
  if (!row) throw new RestoreError(404, 'no_backup', RESTORE_MESSAGES.noBackup);
  let info;
  try {
    info = await readBackup(row, { dataDir });
  } catch (error) {
    throw new RestoreError(409, 'not_restorable', error.message || RESTORE_MESSAGES.notRestorable);
  }
  const wantsWorld = scope === 'world' || scope === 'everything' || scope === 'players';
  if (scope === 'world' && !info.world.length)
    throw new RestoreError(409, 'empty_scope', RESTORE_MESSAGES.noWorldFiles);
  if (scope === 'settings' && !info.settings.length)
    throw new RestoreError(409, 'empty_scope', RESTORE_MESSAGES.noSettingsFiles);
  if (scope === 'everything' && !info.world.length && !info.settings.length)
    throw new RestoreError(409, 'empty_scope', RESTORE_MESSAGES.noFiles);
  if (wantsWorld && info.world.length && !MAP_ID.test(String(info.map)))
    throw new RestoreError(409, 'bad_map', RESTORE_MESSAGES.badMap);
  let profiles = [],
    tribes = [];
  if (scope === 'players') {
    const list = (value) => (value === undefined ? [] : value);
    const given = [list(params.profiles), list(params.tribes)];
    if (
      given.some(
        (ids) =>
          !Array.isArray(ids) ||
          ids.length > MAX_PLAYERS ||
          ids.some((id) => typeof id !== 'string' || !PLAYER_ID.test(id)),
      )
    )
      throw new RestoreError(400, 'bad_players', RESTORE_MESSAGES.badPlayers);
    profiles = [...new Set(given[0])];
    tribes = [...new Set(given[1])];
    if (!profiles.length && !tribes.length) throw new RestoreError(400, 'no_players', RESTORE_MESSAGES.noPlayers);
    const haveProfiles = new Set(info.profiles.map((item) => item.id)),
      haveTribes = new Set(info.tribes.map((item) => item.id));
    const unknown = [...profiles.filter((id) => !haveProfiles.has(id)), ...tribes.filter((id) => !haveTribes.has(id))];
    if (unknown.length)
      throw new RestoreError(
        400,
        'unknown_players',
        fill(RESTORE_MESSAGES.unknownPlayers, { ids: unknown.join(', ') }),
      );
  }
  const worldInScope = wantsWorld && (scope === 'players' || info.world.length > 0);
  const differentMap =
    worldInScope && info.map !== null && String(info.map).toLowerCase() !== String(server.map).toLowerCase();
  return { row, info, scope, profiles, tribes, map: info.map, worldInScope, differentMap };
}

// The things a restore replaces, in the order it replaces them. Each carries where its files come from.
export function restoreUnits(check, server) {
  const { savedArks, configDir } = restoreLayout(server.install_path);
  const { info, scope } = check;
  const selected = selectFiles(info, check);
  const worldPrefix = `${WORLD_ROOT}/${check.map}/`;
  const units = [];
  const withRel = (files, prefix) => files.map((file) => ({ ...file, rel: file.relPath.slice(prefix.length) }));
  if (selected.world.length)
    units.push({
      label: 'world',
      kind: 'folder',
      dir: path.join(savedArks, check.map),
      source: info.folder,
      files: withRel(selected.world, worldPrefix),
    });
  if (selected.settings.length)
    units.push({
      label: 'settings',
      kind: 'folder',
      dir: configDir,
      source: info.folder,
      files: withRel(selected.settings, `${CONFIG_PREFIX}/`),
    });
  if (scope === 'players')
    units.push({
      label: 'players',
      kind: 'files',
      dir: path.join(savedArks, check.map),
      source: info.folder,
      files: withRel(selected.players, worldPrefix),
    });
  return units;
}

// The same targets, filled from the safety backup. A folder the safety backup does not hold is replaced with
// nothing, because it did not exist when the restore began. A players restore puts the whole world folder
// back, which also removes any player file the restore added.
function rollbackUnits(units, check, server, safetyInfo) {
  const { savedArks, configDir } = restoreLayout(server.install_path);
  const prefix = (label) => (label === 'settings' ? `${CONFIG_PREFIX}/` : `${WORLD_ROOT}/${check.map}/`);
  const rolled = [];
  const seen = new Set();
  for (const unit of units) {
    const label = unit.label === 'settings' ? 'settings' : 'world';
    if (seen.has(label)) continue;
    seen.add(label);
    const held = safetyInfo ? (label === 'settings' ? safetyInfo.settings : safetyInfo.world) : [];
    rolled.push({
      label,
      kind: 'folder',
      dir: label === 'settings' ? configDir : path.join(savedArks, check.map),
      source: safetyInfo?.folder,
      files: held.map((file) => ({ ...file, rel: file.relPath.slice(prefix(label).length) })),
    });
  }
  return rolled;
}

// Settles one pending row from what is on disk: before the swap is whole every file is put back as it was, after
// it the old copies are removed. The row is removed and an audit event written. A row whose files cannot be
// settled, or whose stage this version does not know, is kept and reported as `failed`. `wasRunning` says
// whether the server should be started again; it never is after a rollback stage, and nothing here starts it.
export async function settlePendingRow({ db, row, ops = defaultOps, now = () => Date.now(), actor = 'system' }) {
  const server = db
    .prepare('SELECT s.id, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?')
    .get(row.server_id);
  const rule = STAGES[String(row.stage).split(':')[0]];
  let failed = null;
  if (!rule) failed = RESTORE_MESSAGES.unknownStage;
  else if (server) {
    const { roots } = restoreLayout(server.install_path);
    try {
      await settle({ roots, tag: String(row.job_id), mode: rule.first, ops });
      await settle({ roots, tag: `${row.job_id}r`, mode: rule.back, ops });
    } catch (error) {
      failed = String(error?.message ?? error);
    }
  }
  const outcome = failed ? 'failed' : rule.outcome;
  const at = new Date(now()).toISOString();
  transaction(db, () => {
    if (server)
      auditEvent(db, at, actor, 'server.backup.restore_reconciled', row.server_id, {
        backupId: row.backup_id,
        safetyBackupId: row.safety_backup_id,
        scope: row.scope,
        stage: row.stage,
        outcome,
        jobId: row.job_id,
        ...(failed ? { reason: failed } : {}),
        ...(rule?.start === false ? { serverStarted: false, note: RESTORE_MESSAGES.noStartAfterRollback } : {}),
      });
    if (!failed) db.prepare('DELETE FROM pending_restores WHERE server_id = ?').run(row.server_id);
  });
  return {
    serverId: row.server_id,
    wasRunning: rule?.start !== false && Boolean(row.was_running) && Boolean(server) && !failed,
    outcome,
    ...(failed ? { failed } : {}),
  };
}

// At startup: every restore that was cut off by a restart is settled (see settlePendingRow). The caller starts
// the servers reported as `wasRunning` once the supervisor is up, since a start can take minutes.
export async function reconcilePendingRestores({ db, now = () => Date.now(), ops = defaultOps }) {
  const results = [];
  for (const row of db.prepare('SELECT * FROM pending_restores ORDER BY server_id').all())
    results.push(await settlePendingRow({ db, row, ops, now }));
  return results;
}

// At the start of a file job: a row left by an earlier restore that could not put its files back is settled
// first, so the new job never mixes with its leftovers. The server is not started from here. Throws, changing
// nothing, when the leftovers cannot be sorted out.
export async function clearEarlierRestore({ db, serverId, ops, now }) {
  const row = db.prepare('SELECT * FROM pending_restores WHERE server_id = ?').get(serverId);
  if (!row) return;
  const result = await settlePendingRow({ db, row, ops, now, actor: 'job' });
  if (result.failed) throw new Error(fill(RESTORE_MESSAGES.earlierLeftFiles, { reason: sentence(result.failed) }));
}

export function createRestoreHandlers({
  db,
  dataDir,
  supervisor,
  rcon,
  getRconPassword,
  catalog,
  waitReady = waitForReady,
  sleep = defaultSleep,
  now = () => Date.now(),
  readyTimeoutMs,
  readyPollMs,
  ops = defaultOps,
  // Called with the server once a restore has put settings files in place, so the baseline follows them.
  onSettingsWritten = async () => {},
}) {
  const tell = createTell({ rcon, getRconPassword });
  const stamp = () => new Date(now()).toISOString();
  const serverRow = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);
  const stateOf = (id) => supervisor.status(id)?.observedState;
  const nameOf = (mapId) =>
    catalog?.get?.().maps?.find((map) => map.id.toLowerCase() === String(mapId).toLowerCase())?.name ?? mapId;
  const ready = (server, since, marker, signal) =>
    waitReady({
      logPath: serverPaths(server.install_path).logPath,
      since,
      marker,
      isAlive: () => ACTIVE.has(stateOf(server.id)),
      signal,
      sleep,
      now,
      ...(readyTimeoutMs === undefined ? {} : { timeoutMs: readyTimeoutMs }),
      ...(readyPollMs === undefined ? {} : { pollMs: readyPollMs }),
    });

  // The process has to be one this call started, not one that was already there.
  async function startConfirmed(server) {
    const before = supervisor.status(server.id) ?? {};
    if (ACTIVE.has(before.observedState)) throw new Error(RESTORE_MESSAGES.alreadyRunning);
    await supervisor.start(server.id);
    const after = supervisor.status(server.id) ?? {};
    if (before.pid != null && after.pid === before.pid) throw new Error(RESTORE_MESSAGES.alreadyRunning);
    if (!['running', 'starting'].includes(after.observedState)) throw new Error(RESTORE_MESSAGES.notRunning);
  }

  // The job itself. `record` writes the audit event and is how the wrapper below knows one was written.
  const restoreJob = async ({ job, params = {}, signal, progress }, server, record) => {
    const announce = params.announce ?? 'chat';
    const step = (fraction, key, values = {}) => progress(fraction, fill(RESTORE_MESSAGES.steps[key], values));
    const cancelled = () => signal.reason ?? new Error(RESTORE_MESSAGES.cancelled);
    const tag = String(job.id);
    const layout = restoreLayout(server.install_path);

    step(0.02, 'checking');
    await clearEarlierRestore({ db, serverId: server.id, ops, now });
    const check = await checkRestore({ db, dataDir, server, params: { ...params } });
    await verifyBackup(check.row, {
      dataDir,
      scope: check.scope,
      profiles: check.profiles,
      tribes: check.tribes,
      signal,
      info: check.info,
    });
    const when = formatTime(check.row.created_at);
    const units = restoreUnits(check, server);

    // Players are warned only while the server is up. Someone may stop it during the countdown, and then
    // the restore goes on as it would for a stopped server.
    let wasRunning = ACTIVE.has(stateOf(server.id));
    if (stateOf(server.id) === 'running') {
      step(0.05, 'countdown');
      try {
        await runCountdown(
          { tell, sleep },
          [server],
          params.countdownMinutes ?? [5, 1],
          (minutes) => PLAYER_MESSAGES.restore(minutes, check.scope),
          announce,
          signal,
          progress,
        );
        if (signal.aborted) throw cancelled();
      } catch (error) {
        if (signal.aborted) await tell(server, announce, PLAYER_MESSAGES.restoreCancelled).catch(() => {});
        throw error;
      }
      wasRunning = ACTIVE.has(stateOf(server.id));
      if (wasRunning) await tell(server, announce, PLAYER_MESSAGES.restoring).catch(() => {});
    }
    if (signal.aborted) throw cancelled();

    const setStage = (stage) =>
      db.prepare('UPDATE pending_restores SET stage = ? WHERE server_id = ?').run(stage, server.id);
    const dropPending = () => {
      try {
        db.prepare('DELETE FROM pending_restores WHERE server_id = ?').run(server.id);
      } catch {
        /* the row is settled by the next start */
      }
    };
    // From here on a restart of ARK Overseer is settled at its next start (see reconcilePendingRestores).
    db.prepare(
      'INSERT INTO pending_restores (server_id, job_id, backup_id, scope, safety_backup_id, was_running, started_at, stage) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    ).run(server.id, job.id, check.row.id, check.scope, wasRunning ? 1 : 0, stamp(), 'stopping');

    // A server that is not stopped is stopped even when it is not counted as running, so a restart that is
    // waiting to happen cannot bring it back in the middle of the restore.
    if (stateOf(server.id) !== 'stopped') {
      step(0.2, 'stopping');
      try {
        await supervisor.stop(server.id);
      } catch (error) {
        dropPending();
        throw new Error(joinReason(RESTORE_MESSAGES.stopFailed, sentence(error.message)));
      }
    }

    // Until a file is swapped nothing needs undoing, so the server only goes back up as it was.
    const putBack = async (error) => {
      let failed = false;
      if (wasRunning) {
        step(0.45, 'restarting');
        failed = await supervisor.start(server.id).then(
          () => false,
          () => true,
        );
      }
      dropPending();
      record('server.backup.restore', signal.aborted ? 'cancelled' : 'failed', { reason: String(error.message) });
      throw failed ? new Error(`${error.message} ${RESTORE_MESSAGES.restartFailed}`) : error;
    };
    if (signal.aborted) return putBack(cancelled());

    step(0.3, 'safety');
    setStage('safety');
    let safety = null;
    let note = null;
    try {
      safety = await backupServer({
        db,
        server,
        dataDir,
        reason: 'pre_restore',
        rcon,
        getRconPassword,
        isRunning: async () => false,
        now,
        jobId: job.id,
        signal,
        map: check.map ?? server.map,
        include: { world: check.worldInScope, config: units.some((unit) => unit.label === 'settings') },
      });
    } catch (error) {
      if (signal.aborted) return putBack(cancelled());
      if (error.code !== 'EMPTY_BACKUP')
        return putBack(new Error(joinReason(RESTORE_MESSAGES.safetyFailed, sentence(error.message))));
      note = RESTORE_MESSAGES.nothingToSave;
    }
    if (safety)
      db.prepare('UPDATE pending_restores SET safety_backup_id = ? WHERE server_id = ?').run(
        safety.backupId,
        server.id,
      );
    if (signal.aborted) return putBack(cancelled());

    step(0.4, 'restoring');
    setStage('staging');
    try {
      for (const unit of units) await stageUnit(unit, { ops, tag, signal });
      for (const unit of units) {
        // A cancel between folders puts the folders already swapped back; a pair of renames is never cut.
        if (signal.aborted) throw cancelled();
        await swapUnit(unit, { ops, tag, onStage: () => setStage(`swapping:${unit.label}`) });
      }
    } catch (error) {
      try {
        await settle({ roots: layout.roots, tag, mode: 'undo', ops });
      } catch {
        throw new Error(RESTORE_MESSAGES.filesNotPutBack);
      }
      return putBack(
        signal.aborted ? cancelled() : new Error(joinReason(RESTORE_MESSAGES.filesFailed, sentence(error.message))),
      );
    }
    setStage('cleanup');
    let leftovers = false;
    try {
      await settle({ roots: layout.roots, tag, mode: 'finish', ops });
    } catch {
      // The restore is whole. The old copies are removed at the next start. The row keeps saying the server
      // was running until the job has started it (or failed to), so a restart of ARK Overseer in between
      // still brings it back; `finished` then clears that, so a server stopped afterwards stays stopped.
      leftovers = true;
    }
    const finished = () => {
      if (!leftovers) dropPending();
      else db.prepare('UPDATE pending_restores SET was_running = 0 WHERE server_id = ?').run(server.id);
    };
    const result = {
      backupId: check.row.id,
      scope: check.scope,
      map: check.map,
      safetyBackupId: safety?.backupId ?? null,
      started: wasRunning,
      differentMap: check.differentMap,
      ...(note || leftovers ? { notes: [note, leftovers ? RESTORE_MESSAGES.leftovers : null].filter(Boolean) } : {}),
    };
    const settingsWritten = async () => {
      if (units.some((unit) => unit.label === 'settings')) await onSettingsWritten(server, 'restore').catch(() => {});
    };
    const success = async () => {
      finished();
      await settingsWritten();
      record('server.backup.restore', 'restored', {
        safetyBackupId: safety?.backupId ?? null,
        differentMap: check.differentMap,
      });
    };
    const rollBack = async (error) => {
      step(0.8, 'rollingBack');
      await supervisor.stop(server.id).catch(() => {});
      const back = `${tag}r`;
      const values = { time: when, reason: sentence(error?.message) };
      try {
        setStage('rollback');
        let safetyInfo = null;
        if (safety) {
          const safetyRow = db.prepare('SELECT * FROM backups WHERE id = ?').get(safety.backupId);
          safetyInfo = await readBackup(safetyRow, { dataDir });
        }
        const undo = rollbackUnits(units, check, server, safetyInfo);
        for (const unit of undo) await stageUnit(unit, { ops, tag: back });
        for (const unit of undo) await swapUnit(unit, { ops, tag: back });
        setStage('rollback_cleanup');
        await settle({ roots: layout.roots, tag: back, mode: 'finish', ops }).catch(() => {
          leftovers = true;
        });
      } catch {
        await settle({ roots: layout.roots, tag: back, mode: 'undo', ops }).catch(() => {});
        record('server.backup.restore_rolled_back', 'files_not_put_back', { reason: values.reason });
        throw new Error(fill(RESTORE_MESSAGES.rollbackFilesFailed, values));
      }
      record('server.backup.restore_rolled_back', 'rolled_back', {
        safetyBackupId: safety?.backupId ?? null,
        reason: values.reason,
      });
      let restored = false;
      try {
        setStage('rollback_starting');
        const marker = await readLogMarker(serverPaths(server.install_path).logPath);
        const since = now();
        await startConfirmed(server);
        // A cancelled job has no time to wait for a large map; the server is already starting.
        if (!signal.aborted) await ready(server, since, marker, signal);
        restored = true;
      } catch {
        restored = false;
      }
      finished();
      if (signal.aborted) throw error;
      if (!restored) throw new Error(fill(RESTORE_MESSAGES.rollbackFailed, values));
      throw new Error(fill(values.reason ? RESTORE_MESSAGES.rolledBack : RESTORE_MESSAGES.rolledBackNoReason, values));
    };

    if (!wasRunning) {
      await success();
      step(0.95, 'doneStopped', { time: when });
      return result;
    }

    // The server is started on the restored files. If it does not come up, the earlier files go back.
    setStage('starting');
    step(0.6, 'starting');
    try {
      const marker = await readLogMarker(serverPaths(server.install_path).logPath);
      const since = now();
      await startConfirmed(server);
      step(0.7, 'waiting');
      await ready(server, since, marker, signal);
    } catch (error) {
      // A cancel while the world loads stops the waiting. The restore is whole and the server is up on it.
      if (signal.aborted) {
        finished();
        await settingsWritten();
        record('server.backup.restore', 'restored_then_cancelled', { safetyBackupId: safety?.backupId ?? null });
        throw cancelled();
      }
      return rollBack(error);
    }
    await success();
    if (signal.aborted) throw cancelled();
    step(0.95, 'done', { time: when });
    return result;
  };

  return {
    'server.restore': async (context) => {
      const { job, params = {}, signal } = context;
      const server = serverRow(job.serverId);
      if (!server) throw new Error(SCHEDULE_MESSAGES.noServer);
      let recorded = false;
      const record = (action, outcome, extra = {}) => {
        recorded = true;
        try {
          auditEvent(db, stamp(), 'job', action, server.id, {
            backupId: params.backupId ?? null,
            scope: params.scope ?? null,
            jobId: job.id,
            outcome,
            ...extra,
          });
        } catch {
          /* an audit failure does not change what happened to the files */
        }
      };
      try {
        return await restoreJob(context, server, record);
      } catch (error) {
        // Whatever went wrong before the job wrote its own event (a check that failed, a countdown that was
        // cancelled, a server that would not stop) still leaves one.
        if (!recorded)
          record('server.backup.restore', signal.aborted ? 'cancelled' : 'failed', {
            reason: String(error?.message ?? error),
          });
        throw error;
      }
    },
  };
}
