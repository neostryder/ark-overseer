import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './db/index.js';
import { createProcessRunner } from './steamcmd/runner.js';
import { createWindowsPlatform } from './supervisor/platform.js';
import { createSteamCmd } from './steamcmd/steamcmd.js';
import { createInstallHandlers } from './steamcmd/handlers.js';
import { createScheduleHandlers } from './scheduler/handlers.js';
import { createScheduler } from './scheduler/scheduler.js';
import { createJobEngine } from './jobs/engine.js';
import { createSupervisor } from './supervisor/supervisor.js';
import { serverPaths } from './supervisor/launch.js';
import { rconCommand } from './supervisor/rcon.js';
import { saveAllWorlds } from './supervisor/save-all.js';
import { readIniLines, getIniKey, SERVER_SETTINGS } from './settings/ini.js';
import { listListeners as readListeners } from './network/listeners.js';
import { readFirewallRules } from './network/firewall.js';
import { rankFields } from './settings/semantic-search.js';
import { SETTINGS_FIELDS } from './settings/fields.js';
import { createApp } from './app.js';
import { createGamingMode } from './gaming/gaming-mode.js';
import { createCatalog, scheduleCatalogRefresh } from './maps/catalog.js';
import { createArtResolver } from './maps/art.js';
import { createSwitchHandlers, reconcilePendingSwitches } from './maps/switch.js';
import { createRestoreHandlers, reconcilePendingRestores } from './backups/restore.js';
import { createSettingsSnapshotHandlers } from './backups/settings-snapshots.js';
import { createDrift } from './settings/drift.js';
import { readUpdateInfo } from './updater.js';

// shawl waits 60 s after Ctrl-C before it kills the process. World saves get 25 s and running jobs
// 20 s, which leaves time to close everything else.
const SAVE_ALL_MS = 25000;
// The pending restores whose scope put settings files in place.
const SETTINGS_SCOPES = new Set(['everything', 'settings', 'settings_snapshot', 'settings_resolve']);
const JOB_STOP_MS = 20000;

export async function start() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(process.env.OVERSEER_DATA || path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, 'overseer.db'));
  const runner = createProcessRunner(),
    pwshPath = process.env.OVERSEER_PWSH || 'pwsh',
    platform = createWindowsPlatform({ pwshPath });
  const steamcmd = createSteamCmd({ root: path.join(dataDir, 'steamcmd'), runner });
  // The supervisor asks the drift service, created below, to put ARK Overseer's settings back before a start.
  const supervisor = createSupervisor({
    db,
    platform,
    getRconPassword: (server) => {
      const ini = serverPaths(server.install_path).gameUserSettingsPath;
      return getIniKey(readIniLines(ini), SERVER_SETTINGS, 'ServerAdminPassword') || '';
    },
    beforeStart: (id) => drift.beforeStart(id),
  });
  const gaming = createGamingMode({
    db,
    platform,
    supervisor,
    cpuCount: os.availableParallelism(),
    log: console.error,
  });
  const getRconPassword = (server) => {
    const ini = serverPaths(server.install_path).gameUserSettingsPath;
    return getIniKey(readIniLines(ini), SERVER_SETTINGS, 'ServerAdminPassword') || '';
  };
  const drift = createDrift({
    db,
    dataDir,
    supervisor,
    rcon: rconCommand,
    getRconPassword,
    log: console.error,
  });
  supervisor.subscribe((event) => drift.onStateChange(event));
  const settingsWritten = (server, source) => drift.recordBaseline(server, source);
  const catalog = createCatalog({ dataDir, log: console.error });
  const handlers = {
    ...createInstallHandlers({ db, steamcmd }),
    ...createScheduleHandlers({ db, dataDir, steamcmd, supervisor, rcon: rconCommand, getRconPassword }),
    ...createSwitchHandlers({ db, dataDir, supervisor, rcon: rconCommand, getRconPassword, catalog }),
    ...createRestoreHandlers({
      db,
      dataDir,
      supervisor,
      rcon: rconCommand,
      getRconPassword,
      catalog,
      onSettingsWritten: settingsWritten,
    }),
    ...createSettingsSnapshotHandlers({
      db,
      dataDir,
      supervisor,
      rcon: rconCommand,
      getRconPassword,
      onSettingsWritten: settingsWritten,
    }),
    ...drift.handlers,
  };
  const jobs = createJobEngine({ db, handlers });
  drift.attach(jobs);
  const scheduler = createScheduler({ db, jobs });
  const listListeners = () => readListeners({ runner });
  // Windows' own tools by full path, never whatever a PATH entry happens to put first.
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const firewallRules = () => readFirewallRules({ pwshPath });
  // "net session" succeeds only for an administrator.
  const isElevated = async () => (await runner(path.win32.join(system32, 'net.exe'), ['session'])).code === 0;
  // Extra names the server may be reached by, such as a relay's domain, as a comma-separated list.
  const allowedHosts = (process.env.OVERSEER_ALLOWED_HOSTS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const startedAt = new Date().toISOString();
  const serviceMode = process.env.OVERSEER_SERVICE === '1';
  const logsDir = path.resolve(process.env.OVERSEER_LOGS || path.join(dataDir, '..', 'logs'));
  const app = createApp({
    updateInfo: () => readUpdateInfo({ root, dataDir, logsDir, startedAt, serviceMode }),
    db,
    dataDir,
    catalog,
    artResolver: createArtResolver({ dataDir, log: console.error }),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
    gaming,
    scheduler,
    drift,
    rcon: rconCommand,
    getRconPassword,
    steamcmd,
    runner,
    platform,
    listListeners,
    firewallRules,
    isElevated,
    pwshPath,
    serviceMode,
    allowedHosts,
    rankFields: (query, fields) => rankFields(query, fields || SETTINGS_FIELDS),
  });
  const port = Number(process.env.OVERSEER_PORT || 3310),
    host = process.env.OVERSEER_HOST || '0.0.0.0';
  try {
    // A map switch cut off by the last shutdown is undone first, so a server that was running comes back
    // on the map it had before, and one still running on the new map is restarted onto the old one.
    const undone = reconcilePendingSwitches({ db }).filter((entry) => entry.changed && entry.wasRunning);
    // A restore cut off by the last shutdown is settled the same way: the files are put back, or the old copies
    // are removed if the swap was whole. A server that was running is started again once the supervisor is up.
    const pendingScopes = new Map(
      db
        .prepare('SELECT server_id, scope FROM pending_restores')
        .all()
        .map((row) => [row.server_id, row.scope]),
    );
    const settled = await reconcilePendingRestores({ db });
    for (const item of settled.filter((entry) => entry.failed))
      console.error(`Settling the interrupted restore for server ${item.serverId} failed: ${item.failed}`);
    // A restore or a put-back that finished swapping settings files before it was cut off leaves the baseline behind
    // the files, so it is taken again from them.
    for (const item of settled.filter(
      (entry) => entry.outcome === 'completed' && SETTINGS_SCOPES.has(pendingScopes.get(entry.serverId)),
    )) {
      const row = db
        .prepare(
          'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
        )
        .get(item.serverId);
      if (row) await drift.recordBaseline(row, 'restore_settled').catch((error) => console.error(error.message));
    }
    const pidsBefore = new Map(undone.map((entry) => [entry.serverId, supervisor.status(entry.serverId)?.pid ?? null]));
    jobs.start();
    scheduler.start();
    await supervisor.recover();
    // A process that recover() adopted, rather than started, is still running the new map. The restart
    // runs in the background, since a stop can take minutes and the dashboard should answer meanwhile.
    for (const item of undone) {
      const status = supervisor.status(item.serverId);
      if (status?.observedState === 'running' && status.pid != null && status.pid === pidsBefore.get(item.serverId))
        void supervisor
          .restart(item.serverId)
          .catch((error) =>
            console.error(
              `Restarting server ${item.serverId} after an interrupted map change failed: ${error.message}`,
            ),
          );
    }
    for (const item of settled.filter((entry) => entry.wasRunning))
      void supervisor
        .start(item.serverId)
        .catch((error) =>
          console.error(`Starting server ${item.serverId} after an interrupted restore failed: ${error.message}`),
        );
    supervisor.startPolling();
    await gaming.start();
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, host, resolve);
    });
  } catch (error) {
    await jobs.stop({ abort: true, timeoutMs: JOB_STOP_MS });
    scheduler.stop();
    await supervisor.stopPolling();
    await gaming.stop();
    if (app.server.listening) await app.close();
    db.close();
    throw error;
  }
  // A newer map list is fetched now and then daily; without OVERSEER_CATALOG_URL this does nothing.
  const stopCatalogRefresh = scheduleCatalogRefresh(catalog);
  // Every server's settings files are compared with ARK Overseer's last write now and then every ten minutes.
  const stopDriftWatch = drift.start();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopCatalogRefresh();
    stopDriftWatch();
    await gaming.stop();
    await saveAllWorlds({ db, supervisor, rcon: rconCommand, getRconPassword, timeoutMs: SAVE_ALL_MS }).catch((error) =>
      console.error(`World saves before shutdown failed: ${error.message}`),
    );
    await jobs.stop({ abort: true, timeoutMs: JOB_STOP_MS });
    scheduler.stop();
    await supervisor.stopPolling();
    await app.close();
    db.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'])
    process.once(signal, () =>
      shutdown().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      ),
    );
  return { ...app, db, jobs, supervisor, scheduler, shutdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
