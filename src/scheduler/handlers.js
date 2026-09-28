import { MESSAGES as IMPORT_MESSAGES } from '../import/phase0.js';
import { backupServer, pruneBackups } from './backup.js';
import { runInstall } from '../steamcmd/handlers.js';

// What players read in game. Each countdown mark sends one line.
export const PLAYER_MESSAGES = {
  restart: (n) =>
    `Restart in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server is back a few minutes later.`,
  update: (n) =>
    `Update in ${n} ${n === 1 ? 'minute' : 'minutes'}. The world is saved first, and the server is back once the update installs.`,
  restarting: 'Saving the world and restarting now.',
  updating: 'Saving the world and stopping for the update now.',
  cancelled: 'The restart is off. Keep playing.',
};
export const MESSAGES = {
  noServer: 'The server was not found.',
  noInstall: 'The install was not found.',
};
const RUNNING = 'running';

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

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
  const tell = async (server, announce, message) =>
    rcon({
      host: '127.0.0.1',
      port: server.rcon_port,
      password: await getRconPassword(server),
      command: `${announce === 'broadcast' ? 'Broadcast' : 'ServerChat'} ${message}`,
    });

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

  // Warns every listed server at each mark, waits out the gaps, then waits the last mark's minutes.
  // A failed warning is noted in the job message and the countdown goes on.
  async function countdown(servers, marks, message, announce, signal, progress) {
    for (let index = 0; index < marks.length; index++) {
      if (signal.aborted) throw signal.reason;
      const minutes = marks[index];
      await Promise.all(
        servers.map((server) =>
          tell(server, announce, message(minutes)).catch((error) =>
            progress(null, `${server.name} did not get the in-game warning: ${error.message}`),
          ),
        ),
      );
      const next = marks[index + 1] ?? 0;
      await sleep((minutes - next) * 60000, signal);
    }
  }

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
      const check = await checkInstall(job.installId, signal);
      if (!check.updateAvailable) return { updated: false, ...check };
      const servers = db.prepare(`${serverSql} WHERE s.install_id = ? ORDER BY s.id`).all(job.installId);
      const running = servers.filter((server) => isRunning(server.id));
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
            signal,
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
        if (signal.aborted && !stopped.length)
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
