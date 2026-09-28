import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './db/index.js';
import { createProcessRunner } from './steamcmd/runner.js';
import { createWindowsPlatform } from './supervisor/platform.js';
import { createSteamCmd } from './steamcmd/steamcmd.js';
import { createInstallHandlers } from './steamcmd/handlers.js';
import { createJobEngine } from './jobs/engine.js';
import { createSupervisor } from './supervisor/supervisor.js';
import { serverPaths } from './supervisor/launch.js';
import { readIniLines, getIniKey, SERVER_SETTINGS } from './settings/ini.js';
import { listListeners as readListeners } from './network/listeners.js';
import { parseFirewallRules } from './network/firewall.js';
import { rankFields } from './settings/semantic-search.js';
import { SETTINGS_FIELDS } from './settings/fields.js';
import { createApp } from './app.js';

export async function start() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(process.env.OVERSEER_DATA || path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, 'overseer.db'));
  const runner = createProcessRunner(),
    platform = createWindowsPlatform();
  const steamcmd = createSteamCmd({ root: path.join(dataDir, 'steamcmd'), runner });
  const jobs = createJobEngine({ db, handlers: createInstallHandlers({ db, steamcmd }) });
  const supervisor = createSupervisor({
    db,
    platform,
    getRconPassword: (server) => {
      const ini = serverPaths(server.install_path).gameUserSettingsPath;
      return getIniKey(readIniLines(ini), SERVER_SETTINGS, 'ServerAdminPassword') || '';
    },
  });
  const listListeners = () => readListeners({ runner });
  // Windows' own tools by full path, never whatever a PATH entry happens to put first.
  const system32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const firewallRules = async () => {
    let output = '';
    const netsh = path.win32.join(system32, 'netsh.exe');
    const result = await runner(netsh, ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'verbose'], {
      onLine: (line) => {
        output += `${line}\n`;
      },
    });
    if (result.code !== 0) throw new Error('Could not read Windows Firewall rules');
    return parseFirewallRules(output);
  };
  // "net session" succeeds only for an administrator.
  const isElevated = async () => (await runner(path.win32.join(system32, 'net.exe'), ['session'])).code === 0;
  // Extra names the server may be reached by, such as a relay's domain, as a comma-separated list.
  const allowedHosts = (process.env.OVERSEER_ALLOWED_HOSTS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const app = createApp({
    db,
    dataDir,
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
    steamcmd,
    runner,
    platform,
    listListeners,
    firewallRules,
    isElevated,
    allowedHosts,
    rankFields: (query, fields) => rankFields(query, fields || SETTINGS_FIELDS),
  });
  jobs.start();
  await supervisor.recover();
  supervisor.startPolling();
  const port = Number(process.env.OVERSEER_PORT || 3310),
    host = process.env.OVERSEER_HOST || '0.0.0.0';
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await jobs.stop({ abort: true });
    await supervisor.stopPolling();
    await app.close();
    db.close();
  };
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  return { ...app, db, jobs, supervisor, shutdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
