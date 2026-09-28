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
import { readUpdateInfo } from './updater.js';

// shawl waits 60 s after Ctrl-C before it kills the process. World saves get 25 s and running jobs
// 20 s, which leaves time to close everything else.
const SAVE_ALL_MS = 25000;
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
  const supervisor = createSupervisor({
    db,
    platform,
    getRconPassword: (server) => {
      const ini = serverPaths(server.install_path).gameUserSettingsPath;
      return getIniKey(readIniLines(ini), SERVER_SETTINGS, 'ServerAdminPassword') || '';
    },
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
  const handlers = {
    ...createInstallHandlers({ db, steamcmd }),
    ...createScheduleHandlers({ db, dataDir, steamcmd, supervisor, rcon: rconCommand, getRconPassword }),
  };
  const jobs = createJobEngine({ db, handlers });
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
  const catalog = createCatalog({ dataDir, log: console.error });
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
    jobs.start();
    scheduler.start();
    await supervisor.recover();
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
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopCatalogRefresh();
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
