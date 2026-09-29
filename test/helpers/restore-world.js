// A server with real folders and files under a temp folder, and stand-ins for everything that would start a
// process or talk to a game: the supervisor, the warning channel, the clock, the ready check and the file
// operations that a test may make fail. Nothing here starts a server, SteamCMD or an RCON connection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/index.js';
import { backupServer } from '../../src/scheduler/backup.js';
import { createRestoreHandlers, restoreLayout } from '../../src/backups/restore.js';
import { createSettingsSnapshotHandlers } from '../../src/backups/settings-snapshots.js';
import { defaultOps } from '../../src/backups/swap.js';
import { serverPaths } from '../../src/supervisor/launch.js';

export const T = '2026-01-01T00:00:00.000Z';
export const NOW = Date.parse(T);
const bundled = JSON.parse(fs.readFileSync(new URL('../../src/maps/catalog.json', import.meta.url), 'utf8')).maps;
export const catalog = { get: () => ({ version: 1, maps: bundled }) };

const WORLD_FILES = (map, version) => ({
  [`${map}.ark`]: `world ${map} ${version}`,
  '0001.arkprofile': `${map} profile 0001 ${version}`,
  '0002.arkprofile': `${map} profile 0002 ${version}`,
  '1001.arktribe': `${map} tribe 1001 ${version}`,
  '1002.arktribe': `${map} tribe 1002 ${version}`,
  'nested/rolling.bak': `${map} rolling ${version}`,
});
const CONFIG_FILES = (version) => ({
  'GameUserSettings.ini': `[ServerSettings]\r\nDifficulty=${version}\r\n`,
  'Game.ini': `[/script/shootergame.shootergamemode]\r\nMatingIntervalMultiplier=${version}\r\n`,
});

export function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
// Every file under a folder as { 'relative/path': 'content' }, or null when the folder is not there.
export function readTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const tree = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else tree[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return tree;
}

export function restoreWorld(
  t,
  { running = true, maps = ['TheIsland_WP', 'Ragnarok_WP'], config = true, prefix = 'overseer-restore-' } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'ASA');
  const dataDir = path.join(root, 'data');
  const layout = restoreLayout(installPath);
  for (const map of maps) writeTree(path.join(layout.savedArks, map), WORLD_FILES(map, 'v1'));
  if (config) writeTree(layout.configDir, CONFIG_FILES('v1'));
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (1, 1, ?, 'installed', ?, ?)",
  ).run(installPath, T, T);
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, rcon_port, created_at, updated_at) VALUES (1, 1, 1, 'One', 'TheIsland_WP', 's', 7777, 27020, ?, ?)",
  ).run(T, T);
  db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (1, ?, ?, 'x', 'running')").run(T, T);

  const events = [];
  const plan = {
    start: [],
    stop: [],
    ready: [],
    stopLeavesRunning: false,
    abortOnSleep: false,
    failRcon: false,
    hang: null,
    // Counts of file operations, and the call number (from 1) each one should fail or hang on.
    failRename: null,
    hangRename: null,
    failCopy: null,
    failFinish: false,
    onRename: null,
    onCopy: null,
    controller: new AbortController(),
  };
  const counts = { rename: 0, copy: 0 };
  const ops = {
    ...defaultOps,
    rename: async (from, to) => {
      counts.rename++;
      events.push(['rename', path.basename(from), path.basename(to)]);
      plan.onRename?.(counts.rename, from, to);
      if (plan.hangRename === counts.rename) await new Promise(() => {});
      if (plan.failRename === counts.rename) throw Object.assign(new Error('rename blocked'), { code: 'EIO' });
      return fs.promises.rename(from, to);
    },
    copy: async (from, to) => {
      counts.copy++;
      plan.onCopy?.(counts.copy, from, to);
      if (plan.failCopy === counts.copy) throw Object.assign(new Error('copy blocked'), { code: 'EIO' });
      return defaultOps.copy(from, to);
    },
    rm: async (target) => {
      if (plan.failFinish && /\.old-\d+r?$/.test(target))
        throw Object.assign(new Error('remove blocked'), { code: 'EIO' });
      return defaultOps.rm(target);
    },
  };

  let state = running ? 'running' : 'stopped';
  // The process id the supervisor reports. A test sets `plan.pidOnStart` to say what a start leaves it as.
  let pid = null;
  const supervisor = {
    status: () => ({ observedState: state, pid }),
    stop: async (id) => {
      events.push(['stop', id]);
      if (plan.hang === 'stop') await new Promise(() => {});
      const outcome = plan.stop.shift();
      if (outcome instanceof Error) throw outcome;
      if (!plan.stopLeavesRunning) state = 'stopped';
    },
    start: async (id) => {
      events.push(['start', id]);
      if (plan.hang === 'start') await new Promise(() => {});
      const outcome = plan.start.shift();
      if (outcome instanceof Error) throw outcome;
      if ('pidOnStart' in plan) pid = plan.pidOnStart;
      state = 'running';
    },
  };
  const rcon = async ({ port, command }) => {
    events.push(['rcon', port, command]);
    if (plan.failRcon) throw new Error('connection refused');
  };
  const common = {
    db,
    dataDir,
    supervisor,
    rcon,
    getRconPassword: () => 'pw',
    now: () => NOW,
    ops,
  };
  const handlers = {
    ...createRestoreHandlers({
      ...common,
      catalog,
      sleep: async (ms, signal) => {
        events.push(['sleep', ms / 60000]);
        if (plan.abortOnSleep) plan.controller.abort(new Error('cancelled'));
        if (signal.aborted) throw signal.reason;
      },
      waitReady: async (options) => {
        events.push(['ready', options.isAlive()]);
        const outcome = plan.ready.shift();
        if (typeof outcome === 'function') await outcome();
        if (outcome instanceof Error) throw outcome;
        if (options.signal?.aborted) throw options.signal.reason;
        return { ready: true };
      },
    }),
    ...createSettingsSnapshotHandlers(common),
  };
  const ctx = (params, jobId = 1) => ({
    job: { id: jobId, serverId: 1 },
    params,
    signal: plan.controller.signal,
    progress: (fraction, message) => events.push(['progress', message]),
  });
  const server = () => ({ ...db.prepare('SELECT * FROM servers').get(), install_path: installPath });

  // A real backup of a map and the settings, taken the way the app takes one.
  const backup = async ({ reason = 'manual', map = 'TheIsland_WP', ...rest } = {}) => {
    const made = await backupServer({
      db,
      server: server(),
      dataDir,
      reason,
      rcon,
      getRconPassword: () => 'pw',
      isRunning: async () => false,
      now: () => NOW,
      map,
      ...rest,
    });
    return db.prepare('SELECT * FROM backups WHERE id = ?').get(made.backupId);
  };
  const restore = (params, jobId) => handlers['server.restore'](ctx(params, jobId));
  const world = (map = 'TheIsland_WP') => readTree(path.join(layout.savedArks, map));
  const settings = () => readTree(layout.configDir);
  // Changes every live file, so a restore has something to undo and to prove it replaced.
  const change = (version = 'v2', map = 'TheIsland_WP') => {
    fs.rmSync(path.join(layout.savedArks, map), { recursive: true, force: true });
    writeTree(path.join(layout.savedArks, map), WORLD_FILES(map, version));
    if (config) {
      fs.rmSync(layout.configDir, { recursive: true, force: true });
      writeTree(layout.configDir, CONFIG_FILES(version));
    }
  };
  // Leftovers of the swap that should never outlive a job.
  const artifacts = () => {
    const found = [];
    const scan = (dir) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        if (/\.(old|restore|absent)-\d+r?$/.test(entry.name)) found.push(path.join(dir, entry.name));
        else if (entry.isDirectory()) scan(path.join(dir, entry.name));
      }
    };
    scan(path.dirname(layout.savedArks));
    return found.map((file) => path.relative(installPath, file));
  };
  const audits = (like = 'server.backup.%') =>
    db
      .prepare('SELECT action, actor, detail_json FROM audit_events WHERE action LIKE ? ORDER BY id')
      .all(like)
      .map((row) => ({ action: row.action, actor: row.actor, ...JSON.parse(row.detail_json) }));
  const pending = () =>
    db
      .prepare('SELECT * FROM pending_restores')
      .all()
      .map((row) => ({ ...row }));
  const backups = () =>
    db
      .prepare('SELECT * FROM backups ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  const steps = () => events.filter((event) => ['stop', 'start', 'ready'].includes(event[0])).map((event) => event[0]);
  const messages = () => events.filter((event) => event[0] === 'progress').map((event) => event[1]);
  return {
    db,
    root,
    dataDir,
    installPath,
    layout,
    events,
    plan,
    counts,
    ops,
    handlers,
    ctx,
    restore,
    server,
    backup,
    world,
    settings,
    change,
    artifacts,
    audits,
    pending,
    backups,
    steps,
    messages,
    supervisor,
    setState: (next) => (state = next),
    setPid: (next) => (pid = next),
    state: () => state,
    paths: serverPaths(installPath),
  };
}
