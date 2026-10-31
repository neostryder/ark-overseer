import { MESSAGES as IMPORT_MESSAGES } from '../import/phase0.js';
import { parsePlayerCount } from '../idle/idle.js';
import { backupServer, pruneBackups } from './backup.js';
import { runInstall } from '../steamcmd/handlers.js';
import { defaultSleep, createTell, runCountdown } from './countdown.js';

// What players read in game. Each countdown mark sends one line.
export const PLAYER_MESSAGES = {
  restart: (n) =>
    `Restart in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server is back a few minutes later.`,
  clusterRestart: (n) =>
    `Restart in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the other servers in this cluster stay up while this one restarts.`,
  clusterRestartNow: 'Saving the world and restarting now. The other servers in this cluster stay up.',
  update: (n) =>
    `Update in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server is back once the update installs.`,
  switchMap: (n, map) =>
    `Map change in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server comes back on ${map}.`,
  restore: (n, scope) =>
    `Restart in ${n} ${n === 1 ? 'minute' : 'minutes'} to restore ${
      {
        settings: 'the server settings from a backup. The world and your progress are kept.',
        players: "some players and tribes from a backup. Everyone else's progress is kept.",
      }[scope] ?? 'a backup. The world goes back to that backup, so anything done since then is lost.'
    }`,
  restarting: 'Saving the world and restarting now.',
  updating: 'Saving the world and stopping for the update now.',
  move: (n) =>
    `Server maintenance in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server is back once its files are moved, which can take a while.`,
  switching: 'Saving the world and changing the map now.',
  restoring: 'Shutting down to restore a backup now.',
  cancelled: 'The restart is off. Keep playing.',
  switchCancelled: 'The map change is off. Keep playing.',
  restoreCancelled: 'The restore is off. Keep playing.',
};
export const MESSAGES = {
  noServer: 'The server was not found.',
  noInstall: 'The install was not found.',
  updateHeld: 'Players are online, so this update waits for the next scheduled run.',
};
// Skipped runs stay bounded so a busy server still gets the build. A schedule may set maxHold from 0 up to this.
export const UPDATE_HELD = 'players online';
export const DEFAULT_UPDATE_HOLD = 3;
export const MAX_UPDATE_HOLD = 48;
const RUNNING = 'running';

export function createScheduleHandlers({
  db,
  dataDir,
  steamcmd,
  supervisor,
  rcon,
  getRconPassword,
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  const serverSql =
    'SELECT s.*, i.path AS install_path, i.source AS install_source FROM servers s JOIN installs i ON i.id = s.install_id';
  const serverRow = (id) => db.prepare(`${serverSql} WHERE s.id = ?`).get(id);
  const isRunning = (id) => supervisor.status(id)?.observedState === RUNNING;
  const tell = createTell({ rcon, getRconPassword });
  const holdLimit = (value) =>
    Number.isInteger(value) && value >= 0 && value <= MAX_UPDATE_HOLD ? value : DEFAULT_UPDATE_HOLD;

  // Consecutive holds are counted from finished jobs, because the schedule starts a new job each run.
  function deferralsSoFar(job) {
    const id = Number.isInteger(job.id) ? job.id : null;
    const rows = db
      .prepare(
        `SELECT result_json FROM jobs
         WHERE kind = 'install.auto_update' AND install_id = ? AND state = 'succeeded' AND (? IS NULL OR id != ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(job.installId, id, id, MAX_UPDATE_HOLD);
    let count = 0;
    for (const row of rows) {
      let result;
      try {
        result = JSON.parse(row.result_json);
      } catch {
        break;
      }
      if (result?.held !== UPDATE_HELD) break;
      count += 1;
    }
    return count;
  }

  // The scheduler has already moved next_run_at to the following run by the time this job starts.
  function nextQuietWindow(installId) {
    return (
      db
        .prepare(
          `SELECT MIN(s.next_run_at) AS at FROM schedules s
           JOIN servers sv ON sv.id = s.server_id
           WHERE s.kind = 'auto_update' AND s.enabled = 1 AND sv.install_id = ? AND s.next_run_at > ?`,
        )
        .get(installId, new Date(now()).toISOString())?.at ?? null
    );
  }

  // A missing or unreadable count is unknown, which does not count as someone being online.
  async function someoneOnline(servers, signal) {
    for (const server of servers) {
      if (signal?.aborted) throw signal.reason;
      let text;
      try {
        text = await rcon({
          host: '127.0.0.1',
          port: server.rcon_port,
          password: await getRconPassword(server),
          command: 'ListPlayers',
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        continue;
      }
      if (parsePlayerCount(text) > 0) return true;
    }
    return false;
  }

  async function checkInstall(id, signal) {
    const install = db.prepare('SELECT * FROM installs WHERE id = ?').get(id);
    if (!install) throw new Error(MESSAGES.noInstall);
    if (install.source === 'steam-client') throw new Error(IMPORT_MESSAGES.steamClientInstall);
    const latest = await steamcmd.latestBuildId({ branch: install.branch, signal });
    const checked = new Date(now()).toISOString();
    db.prepare('UPDATE installs SET latest_build_id = ?, update_checked_at = ?, updated_at = ? WHERE id = ?').run(
      latest == null ? null : String(latest),
      checked,
      checked,
      id,
    );
    // Builds are compared as text, since the manifest and Steam's answer may not agree on the type.
    const current = install.build_id == null ? null : String(install.build_id);
    return {
      current,
      latest: latest == null ? null : String(latest),
      updateAvailable: latest != null && String(latest) !== current,
    };
  }

  const countdown = (servers, marks, message, announce, signal, progress) =>
    runCountdown({ tell, sleep }, servers, marks, message, announce, signal, progress);

  return {
    'server.restart': async ({ job, params = {}, signal, progress }) => {
      const server = serverRow(job.serverId);
      if (!server) throw new Error(MESSAGES.noServer);
      if (!isRunning(server.id)) return { skipped: 'not running' };
      const announce = params.announce ?? 'chat';
      try {
        await countdown(
          [server],
          params.countdownMinutes ?? [10, 5, 1],
          PLAYER_MESSAGES.restart,
          announce,
          signal,
          progress,
        );
      } catch (error) {
        if (signal.aborted) await tell(server, announce, PLAYER_MESSAGES.cancelled).catch(() => {});
        throw error;
      }
      // Someone may have stopped the server during the countdown; a restart would start it again.
      if (!isRunning(server.id)) return { skipped: 'stopped during the countdown' };
      await tell(server, announce, PLAYER_MESSAGES.restarting).catch(() => {});
      await supervisor.restart(server.id);
      return { restarted: true };
    },

    'server.backup': async ({ job, params = {}, signal }) => {
      const server = serverRow(job.serverId);
      if (!server) throw new Error(MESSAGES.noServer);
      const result = await backupServer({
        db,
        server,
        dataDir,
        reason: params.reason ?? 'manual',
        rcon,
        getRconPassword,
        isRunning: async (id) => isRunning(id),
        now,
        jobId: job.id,
        signal,
      });
      pruneBackups({ db, serverId: server.id, keep: params.keep ?? 10, dataDir });
      return result;
    },

    'install.check_update': ({ job, signal }) => checkInstall(job.installId, signal),

    'install.auto_update': async (ctx) => {
      const { job, params = {}, signal, progress } = ctx;
      const countdownSignal = ctx.countdownSignal ?? signal;
      const check = await checkInstall(job.installId, signal);
      if (!check.updateAvailable) return { updated: false, ...check };
      const servers = db.prepare(`${serverSql} WHERE s.install_id = ? ORDER BY s.id`).all(job.installId);
      const running = servers.filter((server) => isRunning(server.id));
      if (params.reason === 'scheduled' && running.length && deferralsSoFar(job) < holdLimit(params.maxHold)) {
        const retryAt = nextQuietWindow(job.installId);
        if (retryAt && (await someoneOnline(running, signal))) {
          progress(null, MESSAGES.updateHeld);
          return { updated: false, held: UPDATE_HELD, retryAt };
        }
      }
      const announce = params.announce ?? 'chat';
      // Only servers this job stopped are started again afterwards, whatever else goes wrong.
      const stopped = [];
      let failure = null;
      try {
        if (running.length) {
          await countdown(
            running,
            params.countdownMinutes ?? [15, 5, 1],
            PLAYER_MESSAGES.update,
            announce,
            countdownSignal,
            progress,
          );
          await Promise.all(running.map((server) => tell(server, announce, PLAYER_MESSAGES.updating).catch(() => {})));
        }
        for (const server of running) {
          await supervisor.stop(server.id);
          stopped.push(server);
        }
        // No update without a backup of every server on the install first.
        for (const server of servers)
          await backupServer({
            db,
            server,
            dataDir,
            reason: 'pre_update',
            rcon,
            getRconPassword,
            isRunning: async () => false,
            now,
            jobId: job.id,
            signal,
          });
        await runInstall({ db, steamcmd }, ctx, 'update');
      } catch (error) {
        failure = error;
        if (countdownSignal.aborted && !stopped.length)
          await Promise.all(running.map((server) => tell(server, announce, PLAYER_MESSAGES.cancelled).catch(() => {})));
      }
      for (const server of stopped) {
        try {
          await supervisor.start(server.id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
      return { updated: true, from: check.current, to: check.latest, restarted: stopped.map((server) => server.id) };
    },
  };
}
