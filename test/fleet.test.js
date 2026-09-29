import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createDrift } from '../src/settings/drift.js';
import { baselineDir } from '../src/settings/baseline.js';
import { serverPaths } from '../src/supervisor/launch.js';
import { createTransferHandlers } from '../src/fleet/transfer.js';
import { createFleetHandlers } from '../src/fleet/handlers.js';
import {
  checkClone,
  checkCopyPathLength,
  checkDestination,
  checkFleet,
  checkFolder,
  folderSize,
  MESSAGES,
} from '../src/fleet/core.js';
import {
  cleanClone,
  reconcileInterruptedClones,
  reconcilePendingMoves,
  recordClonePath,
} from '../src/fleet/recovery.js';
import { copyHashed } from '../src/import/phase0.js';
import { createApp } from '../src/app.js';
import { createJobEngine } from '../src/jobs/engine.js';

const at = () => new Date().toISOString();
function fixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-fleet-'));
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO hosts (id, created_at, updated_at, name) VALUES (1, ?, ?, 'local')").run(at(), at());
  const servers = [];
  for (let id = 1; id <= count; id++) {
    const folder = path.join(root, `source-${id}`);
    const paths = serverPaths(folder);
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(path.join(folder, 'ShooterGame', 'Saved', 'SavedArks', 'TheIsland_WP'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'server.bin'), `build ${id}`);
    fs.writeFileSync(
      paths.gameUserSettingsPath,
      `[SessionSettings]\nSessionName=Source ${id}\n[ServerSettings]\nServerAdminPassword=secret\nServerPassword=join\n`,
    );
    fs.writeFileSync(paths.gameIniPath, '[/Script/ShooterGame.ShooterGameMode]\nHarvestAmountMultiplier=2\n');
    fs.writeFileSync(
      path.join(folder, 'ShooterGame', 'Saved', 'SavedArks', 'TheIsland_WP', 'TheIsland_WP.ark'),
      `world ${id}`,
    );
    db.prepare(
      "INSERT INTO installs (id, created_at, updated_at, host_id, path, state, source) VALUES (?, ?, ?, 1, ?, 'installed', 'steamcmd')",
    ).run(id, at(), at(), folder);
    db.prepare(
      'INSERT INTO servers (id, created_at, updated_at, host_id, install_id, name, map, session_name, game_port, query_port, rcon_port, max_players, settings_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 70, ?)',
    ).run(
      id,
      at(),
      at(),
      id,
      `Server ${id}`,
      'TheIsland_WP',
      `Source ${id}`,
      7775 + id * 2,
      27014 + id,
      27019 + id,
      JSON.stringify({ mods: ['123'], disableBattlEye: true }),
    );
    servers.push({ id, install_id: id, install_path: folder });
  }
  return { root, db, servers, target: (name) => path.join(root, name) };
}
function transfer(f, overrides = {}) {
  const calls = [];
  let state = 'stopped';
  const supervisor = {
    status: () => ({ observedState: state }),
    stop: async (id) => {
      calls.push(['stop', id]);
      state = 'stopped';
    },
    start: async (id) => {
      calls.push(['start', id]);
      state = 'running';
    },
  };
  const steamcmd = {
    appUpdate: async (value) => {
      calls.push(['validate', value]);
      return { output: 'ok' };
    },
    readManifest: () => ({ fullyInstalled: true, buildId: '42' }),
  };
  const drift = createDrift({
    db: f.db,
    dataDir: path.join(f.root, 'data'),
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  const handlers = createTransferHandlers({
    db: f.db,
    dataDir: path.join(f.root, 'data'),
    supervisor,
    steamcmd,
    drift,
    rcon: async (value) => {
      calls.push(['rcon', value.command]);
    },
    getRconPassword: () => 'secret',
    listListeners: async () => [],
    ready: async () => {
      calls.push(['ready']);
    },
    marker: async () => null,
    ...overrides,
  });
  return {
    handlers,
    calls,
    supervisor,
    drift,
    setState: (value) => {
      state = value;
    },
  };
}
function reserve(f, target, id = 20) {
  f.db
    .prepare(
      "INSERT INTO installs (id, created_at, updated_at, host_id, path, state, source) VALUES (?, ?, ?, 1, ?, 'missing', 'steamcmd')",
    )
    .run(id, at(), at(), target);
  return id;
}
const ctx = (serverId, installId, params, signal = new AbortController().signal) => ({
  job: { id: 99, serverId, installId },
  params,
  signal,
  progress: () => {},
});

test('clone copies settings and files, skips saves, allocates ports and writes a drift baseline', async (t) => {
  const f = fixture(t);
  const target = f.target('clone');
  const id = reserve(f, target);
  const w = transfer(f);
  const result = await w.handlers['server.clone'](
    ctx(1, id, { name: 'Server copy', sessionName: 'Session copy', path: target }),
  );
  assert.equal(result.installId, id);
  assert.equal(fs.existsSync(path.join(target, 'server.bin')), true);
  assert.equal(fs.existsSync(path.join(target, 'ShooterGame', 'Saved', 'SavedArks')), false);
  const clone = f.db.prepare('SELECT * FROM servers WHERE id = ?').get(result.serverId);
  assert.notEqual(clone.game_port, 7777);
  assert.notEqual(clone.query_port, 27015);
  assert.notEqual(clone.rcon_port, 27020);
  assert.equal(clone.cluster_id, null);
  assert.deepEqual(JSON.parse(clone.settings_json), { mods: ['123'], disableBattlEye: true });
  const ini = fs.readFileSync(serverPaths(target).gameUserSettingsPath, 'utf8');
  assert.match(ini, /SessionName=Session copy/);
  assert.match(ini, /ServerAdminPassword=secret/);
  assert.match(ini, /ServerPassword=join/);
  assert.match(ini, new RegExp(`RCONPort=${clone.rcon_port}`));
  assert.equal(fs.readFileSync(serverPaths(target).gameIniPath, 'utf8').includes('HarvestAmountMultiplier=2'), true);
  assert.ok(f.db.prepare('SELECT 1 FROM settings_baselines WHERE server_id = ?').get(clone.id));
  assert.equal(f.db.prepare('SELECT 1 FROM settings_drift WHERE server_id = ?').get(clone.id), undefined);
  assert.equal(w.calls.filter((item) => item[0] === 'validate').length, 1);
  assert.equal(w.calls.find((item) => item[0] === 'validate')[1].installDir, target);
});

test('clone and size skip a junction outside the source install', async (t) => {
  const f = fixture(t);
  const outside = f.target('outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.bin'), 'outside content');
  fs.symlinkSync(outside, path.join(f.servers[0].install_path, 'linked'), 'junction');
  const size = await folderSize(f.servers[0].install_path);
  assert.ok(size > 0);
  assert.ok(size < 1000);
  const target = f.target('without-link');
  const id = reserve(f, target);
  await transfer(f).handlers['server.clone'](ctx(1, id, { name: 'No link', sessionName: 'No link', path: target }));
  assert.equal(fs.existsSync(path.join(target, 'linked')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'private.bin'), 'utf8'), 'outside content');
});

test('clone ports avoid every existing server and jobs redact legacy password params', async (t) => {
  const f = fixture(t, 3);
  const target = f.target('many-ports');
  const id = reserve(f, target, 20);
  const result = await transfer(f).handlers['server.clone'](
    ctx(1, id, { name: 'Fourth', sessionName: 'Fourth', path: target }),
  );
  const all = f.db.prepare('SELECT game_port, query_port, rcon_port FROM servers ORDER BY id').all();
  const clone = all.at(-1);
  for (const other of all.slice(0, -1)) {
    assert.notEqual(clone.game_port, other.game_port);
    assert.notEqual(clone.query_port, other.query_port);
    assert.notEqual(clone.rcon_port, other.rcon_port);
  }
  assert.equal(result.serverId > 3, true);
  const jobs = createJobEngine({ db: f.db, handlers: { legacy: async () => {} } });
  const legacy = jobs.enqueue('legacy', { adminPassword: 'secret', joinPassword: 'secret', name: 'safe' });
  assert.deepEqual(jobs.get(legacy.id).params, { name: 'safe' });
});

test('a stopped server moves without countdown, stop or start', async (t) => {
  const f = fixture(t);
  const w = transfer(f);
  const target = f.target('stopped-move');
  await w.handlers['server.move'](ctx(1, 1, { path: target, countdownMinutes: [1] }));
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, target);
  assert.equal(
    w.calls.some(([name]) => ['rcon', 'stop', 'start'].includes(name)),
    false,
  );
});

test('pending moves restore the desired state at every stage without deleting copied files', async (t) => {
  for (const [index, stage] of ['prepared', 'stopped', 'copied', 'path_updated', 'rebaselined', 'started'].entries()) {
    const f = fixture(t);
    const target = f.target(`move-${index}`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'copy.bin'), 'keep');
    if (index >= 3) f.db.prepare('UPDATE installs SET path = ? WHERE id = 1').run(target);
    f.db.prepare('UPDATE servers SET desired_state = ? WHERE id = 1').run('stopped');
    f.db
      .prepare('INSERT INTO pending_moves VALUES (?, 1, ?, ?, 1, ?)')
      .run(100 + index, f.servers[0].install_path, target, stage);
    const recovered = reconcilePendingMoves({ db: f.db });
    assert.equal(recovered[0].pathUpdated, index >= 3);
    assert.equal(f.db.prepare('SELECT desired_state FROM servers WHERE id = 1').get().desired_state, 'running');
    assert.equal(f.db.prepare('SELECT 1 FROM pending_moves').get(), undefined);
    assert.equal(fs.readFileSync(path.join(target, 'copy.bin'), 'utf8'), 'keep');
  }
  const f = fixture(t);
  const target = f.target('stopped-pending');
  f.db
    .prepare('INSERT INTO pending_moves VALUES (200, 1, ?, ?, 0, ?)')
    .run(f.servers[0].install_path, target, 'stopped');
  assert.equal(reconcilePendingMoves({ db: f.db })[0].wasRunning, false);
  assert.equal(f.db.prepare('SELECT desired_state FROM servers WHERE id = 1').get().desired_state, 'stopped');
});

test('interrupted clone cleanup removes only recorded paths in a pre-existing folder', async (t) => {
  const f = fixture(t);
  const target = f.target('existing-empty-at-start');
  fs.mkdirSync(target);
  const id = reserve(f, target);
  f.db
    .prepare(
      "INSERT INTO jobs (id, created_at, updated_at, kind, server_id, install_id, state, params_json) VALUES (99, ?, ?, 'server.clone', 1, ?, 'running', ?)",
    )
    .run(at(), at(), id, JSON.stringify({ path: target }));
  f.db.prepare('INSERT INTO pending_clones (job_id, install_id, target_path) VALUES (99, ?, ?)').run(id, target);
  const copied = path.join(target, 'copied.bin');
  fs.writeFileSync(copied, 'job');
  recordClonePath(f.db, 99, target, copied, 'file');
  const unrelated = path.join(target, 'unrelated.bin');
  fs.writeFileSync(unrelated, 'user');
  await reconcileInterruptedClones({ db: f.db, dataDir: f.target('data') });
  assert.equal(fs.existsSync(copied), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user');
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(id), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM pending_clones WHERE job_id = 99').get(), undefined);
});

test('interrupted clone cleanup removes its server, baseline and folder', async (t) => {
  const f = fixture(t);
  const target = f.target('created-clone');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'copied.bin'), 'job');
  const id = reserve(f, target);
  f.db
    .prepare(
      "INSERT INTO jobs (id, created_at, updated_at, kind, server_id, install_id, state, params_json) VALUES (98, ?, ?, 'server.clone', 1, ?, 'running', ?)",
    )
    .run(at(), at(), id, JSON.stringify({ path: target }));
  f.db
    .prepare(
      "INSERT INTO servers (id, created_at, updated_at, host_id, install_id, name, map, session_name, game_port) VALUES (10, ?, ?, 1, ?, 'Orphan', 'TheIsland_WP', 'Orphan', 8888)",
    )
    .run(at(), at(), id);
  const dataDir = f.target('data');
  const baseline = baselineDir(dataDir, 10);
  fs.mkdirSync(baseline, { recursive: true });
  fs.writeFileSync(path.join(baseline, 'baseline.bin'), 'job');
  f.db
    .prepare(
      'INSERT INTO pending_clones (job_id, install_id, target_path, created_root, server_id) VALUES (98, ?, ?, 1, 10)',
    )
    .run(id, target);
  await reconcileInterruptedClones({ db: f.db, dataDir });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(baseline), false);
  assert.equal(f.db.prepare('SELECT 1 FROM servers WHERE id = 10').get(), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(id), undefined);
});

test('clone can include saves and override passwords', async (t) => {
  const f = fixture(t);
  f.db.prepare("UPDATE installs SET source = 'steam-client' WHERE id = 1").run();
  const target = f.target('clone-world');
  const w = transfer(f);
  await w.handlers['server.clone'](
    ctx(1, reserve(f, target), {
      name: 'World copy',
      sessionName: 'World copy',
      path: target,
      copyWorld: true,
      adminPassword: 'newadmin',
      joinPassword: 'newjoin',
    }),
  );
  assert.equal(
    fs.readFileSync(path.join(target, 'ShooterGame', 'Saved', 'SavedArks', 'TheIsland_WP', 'TheIsland_WP.ark'), 'utf8'),
    'world 1',
  );
  const ini = fs.readFileSync(serverPaths(target).gameUserSettingsPath, 'utf8');
  assert.match(ini, /ServerAdminPassword=newadmin/);
  assert.match(ini, /ServerPassword=newjoin/);
  assert.equal(f.db.prepare('SELECT source FROM installs WHERE id = 20').get().source, 'steamcmd');
});

test('destination refuses nonempty and already registered folders and low space', async (t) => {
  const f = fixture(t);
  const occupied = f.target('occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(checkDestination(f.db, occupied, f.servers[0].install_path), /empty folder/);
  await assert.rejects(
    checkDestination(f.db, f.servers[0].install_path, f.servers[0].install_path),
    /already an install/,
  );
  await assert.rejects(
    checkDestination(f.db, path.join(f.servers[0].install_path, 'nested'), f.servers[0].install_path),
    /full folder path/,
  );
  const fake = { ...fsp, statfs: async () => ({ bavail: 0, bsize: 1 }) };
  await assert.rejects(
    checkDestination(f.db, f.target('small'), f.servers[0].install_path, fake),
    /needs [0-9.]+ GB free on that drive/,
  );
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
});

test('destination requires the source size plus ten percent', async (t) => {
  const f = fixture(t);
  const source = f.servers[0].install_path;
  const target = f.target('space-margin');
  const size = await folderSize(source);
  const required = Math.ceil(size * 1.1);
  const fake = (free) => ({ ...fsp, statfs: async () => ({ bavail: free, bsize: 1 }) });
  await assert.rejects(checkDestination(f.db, target, source, fake(required - 1)), /needs/);
  assert.equal((await checkDestination(f.db, target, source, fake(required))).requiredBytes, required);
});

test('failed and cancelled clones remove their own folder and rows', async (t) => {
  const f = fixture(t);
  const failed = f.target('failed');
  const w = transfer(f, {
    steamcmd: {
      appUpdate: async () => {
        throw new Error('validate failed');
      },
      readManifest: () => null,
    },
  });
  await assert.rejects(
    w.handlers['server.clone'](
      ctx(1, reserve(f, failed), { name: 'Failed copy', sessionName: 'Failed copy', path: failed }),
    ),
    /validate failed/,
  );
  assert.equal(fs.existsSync(failed), false);
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = 20').get(), undefined);
  const cancelled = f.target('cancelled');
  const abort = new AbortController();
  const v = transfer(f, {
    copy: async (source, target) => {
      const result = await copyHashed(source, target);
      abort.abort(new Error('cancelled'));
      return result;
    },
  });
  await assert.rejects(
    v.handlers['server.clone'](
      ctx(
        1,
        reserve(f, cancelled, 21),
        { name: 'Cancelled copy', sessionName: 'Cancelled copy', path: cancelled },
        abort.signal,
      ),
    ),
    /cancelled/,
  );
  assert.equal(fs.existsSync(cancelled), false);
  assert.equal(f.db.prepare('SELECT 1 FROM servers WHERE id = 1').get() != null, true);
});

test('a queued clone whose name becomes taken releases its reserved install', async (t) => {
  const f = fixture(t);
  const target = f.target('late-conflict');
  const installId = reserve(f, target);
  await assert.rejects(
    transfer(f).handlers['server.clone'](ctx(1, installId, { name: 'Server 1', sessionName: 'Copy', path: target })),
    /already exists/,
  );
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(installId), undefined);
  assert.equal(fs.existsSync(target), false);
});

test('clone and move handlers repeat route validation before touching files', async (t) => {
  const f = fixture(t);
  const target = f.target('invalid-job');
  const id = reserve(f, target);
  const handlers = transfer(f).handlers;
  await assert.rejects(handlers['server.clone'](ctx(1, id, { name: 'Server 1', sessionName: 'Copy', path: target })), {
    status: 409,
  });
  await assert.rejects(handlers['server.move'](ctx(1, 1, { path: 'relative' })), { status: 400 });
  assert.equal(fs.existsSync(target), false);
  assert.equal(f.db.prepare('SELECT 1 FROM pending_moves').get(), undefined);
});

test('clone rechecks free space and preserves an existing empty target folder on failure', async (t) => {
  const f = fixture(t);
  const target = f.target('empty-target');
  fs.mkdirSync(target);
  const installId = reserve(f, target);
  const w = transfer(f, { fsOps: { ...fsp, statfs: async () => ({ bavail: 0, bsize: 1 }) } });
  await assert.rejects(
    w.handlers['server.clone'](ctx(1, installId, { name: 'Small copy', sessionName: 'Small copy', path: target })),
    /needs [0-9.]+ GB free on that drive/,
  );
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(installId), undefined);
});

test('clone removes a folder it created when the space check fails before copying', async (t) => {
  const f = fixture(t);
  const target = f.target('new-low-space');
  const id = reserve(f, target);
  const w = transfer(f, { fsOps: { ...fsp, statfs: async () => ({ bavail: 0, bsize: 1 }) } });
  await assert.rejects(
    w.handlers['server.clone'](ctx(1, id, { name: 'Low space', sessionName: 'Low space', path: target })),
    /needs/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(id), undefined);
});

test('failed clone in a pre-existing empty folder keeps unrelated files added during the copy', async (t) => {
  const f = fixture(t);
  const target = f.target('pre-existing');
  fs.mkdirSync(target);
  const id = reserve(f, target);
  const w = transfer(f, {
    copy: async (from, to) => {
      await copyHashed(from, to);
      fs.writeFileSync(path.join(target, 'unrelated.bin'), 'keep');
      throw new Error('copy failed');
    },
  });
  await assert.rejects(
    w.handlers['server.clone'](ctx(1, id, { name: 'Failed', sessionName: 'Failed', path: target })),
    /copy failed/,
  );
  assert.equal(fs.readFileSync(path.join(target, 'unrelated.bin'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(target, 'server.bin')), false);
});

test('a running source is saved before clone copying starts', async (t) => {
  const f = fixture(t);
  const target = f.target('running-copy');
  const save = path.join(
    f.servers[0].install_path,
    'ShooterGame',
    'Saved',
    'SavedArks',
    'TheIsland_WP',
    'TheIsland_WP.ark',
  );
  const events = [];
  const w = transfer(f, {
    rcon: async ({ command }) => {
      events.push(command);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(save, future, future);
    },
    copy: async (from, to) => {
      events.push('copy');
      return copyHashed(from, to);
    },
  });
  w.setState('running');
  await w.handlers['server.clone'](
    ctx(1, reserve(f, target), { name: 'Running copy', sessionName: 'Running copy', path: target }),
  );
  assert.equal(events[0], 'SaveWorld');
  assert.ok(events.includes('copy'));
});

test('move saves, stops, verifies, keeps the old folder and restarts with cluster membership', async (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      "INSERT INTO clusters (id, created_at, updated_at, name, cluster_key, shared_dir) VALUES (1, ?, ?, 'Group', '1234567890ABCDEF', ?)",
    )
    .run(at(), at(), f.target('shared'));
  f.db.prepare('UPDATE servers SET cluster_id = 1 WHERE id = 1').run();
  f.db
    .prepare(
      "INSERT INTO schedules (server_id, kind, cron, created_at, updated_at) VALUES (1, 'restart', '0 5 * * *', ?, ?)",
    )
    .run(at(), at());
  f.db
    .prepare("INSERT INTO backups (server_id, created_at, reason, path) VALUES (1, ?, 'manual', ?)")
    .run(at(), f.target('backup'));
  f.db
    .prepare("INSERT INTO settings_snapshots (server_id, created_at, name, path) VALUES (1, ?, 'Saved settings', ?)")
    .run(at(), f.target('snapshot'));
  const target = f.target('moved');
  const save = path.join(
    f.servers[0].install_path,
    'ShooterGame',
    'Saved',
    'SavedArks',
    'TheIsland_WP',
    'TheIsland_WP.ark',
  );
  const events = [];
  let writes = 0;
  const w = transfer(f, {
    rcon: async ({ command }) => {
      events.push(command);
      const future = new Date(Date.now() + 5000 + ++writes * 1000);
      fs.utimesSync(save, future, future);
    },
    sleep: async () => {},
    ready: async () => events.push('ready'),
  });
  w.setState('running');
  const result = await w.handlers['server.move'](ctx(1, 1, { path: target, countdownMinutes: [1] }));
  assert.ok(result.verified >= 3);
  assert.equal(events.includes('SaveWorld'), true);
  assert.deepEqual(
    w.calls.filter((item) => ['stop', 'start'].includes(item[0])),
    [
      ['stop', 1],
      ['start', 1],
    ],
  );
  assert.equal(events.at(-1), 'ready');
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, target);
  const movedServer = f.db
    .prepare('SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = 1')
    .get();
  assert.equal((await w.drift.checkDrift(movedServer, { force: true })).changed, false);
  await w.drift.beforeStart(1);
  assert.equal(f.db.prepare('SELECT 1 FROM settings_drift WHERE server_id = 1').get(), undefined);
  assert.equal(f.db.prepare('SELECT cluster_id FROM servers WHERE id = 1').get().cluster_id, 1);
  for (const table of ['schedules', 'backups', 'settings_snapshots'])
    assert.equal(f.db.prepare(`SELECT server_id FROM ${table} WHERE server_id = 1`).get().server_id, 1);
  assert.equal(fs.existsSync(f.servers[0].install_path), true);
  assert.match(result.message, /Network page/);
  assert.match(result.message, /You can delete it/);
});

test('move detects a changed saved file before switching the install path', async (t) => {
  const f = fixture(t);
  const target = f.target('bad-hash');
  const w = transfer(f, {
    copy: async (from, to) => {
      const result = await copyHashed(from, to);
      if (from.endsWith('.ark')) fs.writeFileSync(to, 'changed after copy');
      return result;
    },
  });
  await assert.rejects(w.handlers['server.move'](ctx(1, 1, { path: target })), /copied folder was kept/);
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, f.servers[0].install_path);
  assert.equal(fs.existsSync(target), true);
});

test('move rejects a changed settings file before switching the install path', async (t) => {
  const f = fixture(t);
  const w = transfer(f, {
    copy: async (from, to) => {
      const result = await copyHashed(from, to);
      if (from.endsWith('Game.ini')) fs.writeFileSync(to, 'changed after copy');
      return result;
    },
  });
  await assert.rejects(
    w.handlers['server.move'](ctx(1, 1, { path: f.target('settings-hash') })),
    /copied folder was kept/,
  );
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, f.servers[0].install_path);
});

test('a long copy path is refused before a running server is stopped', async (t) => {
  const f = fixture(t);
  const longName = 'a'.repeat(80);
  const nested = path.join(f.servers[0].install_path, longName);
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'b'.repeat(70)), 'x');
  const w = transfer(f);
  w.setState('running');
  await assert.rejects(
    w.handlers['server.move'](ctx(1, 1, { path: f.target('t'.repeat(100)) })),
    /folder path is too long/,
  );
  assert.equal(
    w.calls.some(([name]) => name === 'stop'),
    false,
  );
});

test('clone path limit ignores world files when the world is not copied', async (t) => {
  const f = fixture(t);
  const source = f.servers[0].install_path;
  const saveFolder = path.join(source, 'ShooterGame', 'Saved', 'SavedArks', 'a'.repeat(70));
  fs.mkdirSync(saveFolder);
  fs.writeFileSync(path.join(saveFolder, 'b'.repeat(60)), 'world');
  const target = f.target('t'.repeat(100));
  await checkCopyPathLength(source, target, fsp, { copyWorld: false });
  await assert.rejects(checkCopyPathLength(source, target, fsp, { copyWorld: true }), /folder path is too long/);
});

test('move failure before path update restarts the old server and keeps the copy', async (t) => {
  const f = fixture(t);
  const target = f.target('move-failed');
  const save = path.join(
    f.servers[0].install_path,
    'ShooterGame',
    'Saved',
    'SavedArks',
    'TheIsland_WP',
    'TheIsland_WP.ark',
  );
  let writes = 0;
  const w = transfer(f, {
    rcon: async () => {
      const future = new Date(Date.now() + 5000 + ++writes * 1000);
      fs.utimesSync(save, future, future);
    },
    sleep: async () => {},
    copy: async (from, to) => {
      if (from.endsWith('Game.ini')) throw new Error('copy broke');
      return copyHashed(from, to);
    },
  });
  w.setState('running');
  await assert.rejects(w.handlers['server.move'](ctx(1, 1, { path: target, countdownMinutes: [1] })), /copy broke/);
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, f.servers[0].install_path);
  assert.deepEqual(
    w.calls.filter((item) => ['stop', 'start'].includes(item[0])),
    [
      ['stop', 1],
      ['start', 1],
    ],
  );
  assert.equal(fs.existsSync(target), true);
});

test('a failed start after move names both folders and leaves the new path in use', async (t) => {
  const f = fixture(t);
  const target = f.target('move-new');
  const save = path.join(
    f.servers[0].install_path,
    'ShooterGame',
    'Saved',
    'SavedArks',
    'TheIsland_WP',
    'TheIsland_WP.ark',
  );
  let writes = 0;
  const w = transfer(f, {
    rcon: async () => {
      const future = new Date(Date.now() + 5000 + ++writes * 1000);
      fs.utimesSync(save, future, future);
    },
    sleep: async () => {},
  });
  w.setState('running');
  w.supervisor.start = async () => {
    throw new Error('did not start');
  };
  await assert.rejects(
    w.handlers['server.move'](ctx(1, 1, { path: target, countdownMinutes: [1] })),
    (cause) => cause.message.includes(target) && cause.message.includes(f.servers[0].install_path),
  );
  assert.equal(f.db.prepare('SELECT path FROM installs WHERE id = 1').get().path, target);
});

test('fleet actions run in selection order, skip inapplicable servers and stop at a failure', async (t) => {
  const f = fixture(t, 3);
  const events = [];
  const states = new Map([
    [1, 'stopped'],
    [2, 'running'],
    [3, 'stopped'],
  ]);
  const supervisor = {
    status: (id) => ({ observedState: states.get(id) }),
    start: async (id) => {
      events.push(['start', id]);
      states.set(id, 'running');
    },
    stop: async (id) => {
      events.push(['stop', id]);
      states.set(id, 'stopped');
    },
    restart: async (id) => {
      events.push(['restart', id]);
    },
  };
  const handlers = createFleetHandlers({
    db: f.db,
    dataDir: f.root,
    steamcmd: {},
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    marker: async () => null,
    ready: async ({ isAlive }) => {
      assert.equal(isAlive(), true);
      events.push(['ready']);
    },
  });
  const job = { id: 2 };
  const result = await handlers['fleet.action']({
    job,
    params: { action: 'start', serverIds: [3, 2, 1] },
    signal: new AbortController().signal,
    progress: () => {},
  });
  assert.deepEqual(result, { action: 'start', completed: [3, 1], skipped: [2] });
  assert.deepEqual(events, [['start', 3], ['ready'], ['start', 1], ['ready']]);
  supervisor.stop = async (id) => {
    events.push(['stop', id]);
    if (id === 2) throw new Error('broke');
  };
  await assert.rejects(
    handlers['fleet.action']({
      job,
      params: { action: 'stop', serverIds: [3, 2, 1] },
      signal: new AbortController().signal,
      progress: () => {},
    }),
    /Server 2 did not finish/,
  );
  assert.equal(
    events.some((item) => item[0] === 'stop' && item[1] === 1),
    false,
  );
});

test('fleet cancellation between and during members leaves later servers untouched', async (t) => {
  const f = fixture(t, 2);
  for (const during of [false, true]) {
    const abort = new AbortController();
    const events = [];
    const supervisor = {
      status: () => ({ observedState: 'stopped' }),
      start: async (id) => {
        events.push(id);
        if (!during) abort.abort(new Error('cancelled'));
      },
    };
    const handlers = createFleetHandlers({
      db: f.db,
      dataDir: f.root,
      steamcmd: {},
      supervisor,
      rcon: async () => {},
      getRconPassword: () => '',
      marker: async () => null,
      ready: async () => {
        if (during) abort.abort(new Error('cancelled'));
      },
    });
    await assert.rejects(
      handlers['fleet.action']({
        job: { id: 1 },
        params: { action: 'start', serverIds: [1, 2] },
        signal: abort.signal,
        progress: () => {},
      }),
      /cancelled/,
    );
    assert.deepEqual(events, [1]);
  }
});

test('fleet restart counts down, restarts and waits for readiness, skipping stopped servers', async (t) => {
  const f = fixture(t, 2);
  const events = [];
  const handlers = createFleetHandlers({
    db: f.db,
    dataDir: f.root,
    steamcmd: {},
    supervisor: {
      status: (id) => ({ observedState: id === 1 ? 'running' : 'stopped' }),
      restart: async (id) => events.push(['restart', id]),
    },
    rcon: async ({ command }) => events.push(['rcon', command]),
    getRconPassword: () => 'secret',
    sleep: async (ms) => events.push(['sleep', ms]),
    marker: async () => null,
    ready: async () => events.push(['ready']),
  });
  const result = await handlers['fleet.action']({
    job: { id: 1 },
    params: { action: 'restart', serverIds: [1, 2], countdownMinutes: [1] },
    signal: new AbortController().signal,
    progress: () => {},
  });
  assert.deepEqual(result.completed, [1]);
  assert.deepEqual(result.skipped, [2]);
  assert.ok(events.find(([kind, value]) => kind === 'rcon' && value.includes('Restart in 1 minute')));
  assert.deepEqual(
    events.filter(([kind]) => ['restart', 'ready'].includes(kind)),
    [['restart', 1], ['ready']],
  );
});

test('cancelling a fleet restart countdown tells players it is off', async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  const commands = [];
  const handlers = createFleetHandlers({
    db: f.db,
    dataDir: f.root,
    steamcmd: {},
    supervisor: { status: () => ({ observedState: 'running' }), restart: async () => assert.fail('must not restart') },
    rcon: async ({ command }) => commands.push(command),
    getRconPassword: () => 'secret',
    sleep: async () => {
      abort.abort(new Error('cancelled'));
      throw abort.signal.reason;
    },
  });
  await assert.rejects(
    handlers['fleet.action']({
      job: { id: 1 },
      params: { action: 'restart', serverIds: [1], countdownMinutes: [1] },
      signal: abort.signal,
      progress: () => {},
    }),
    /cancelled/,
  );
  assert.ok(commands.some((command) => command.includes('The restart is off')));
});

test('cancelling a fleet update countdown tells players it is off before stopping', async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  const commands = [];
  const handlers = createFleetHandlers({
    db: f.db,
    dataDir: f.root,
    steamcmd: { latestBuildId: async () => '99' },
    supervisor: {
      status: () => ({ observedState: 'running' }),
      stop: async () => assert.fail('must not stop'),
    },
    rcon: async ({ command }) => commands.push(command),
    getRconPassword: () => 'secret',
    sleep: async () => {
      abort.abort(new Error('cancelled'));
      throw abort.signal.reason;
    },
  });
  await assert.rejects(
    handlers['fleet.action']({
      job: { id: 1 },
      params: { action: 'update', serverIds: [1], countdownMinutes: [1] },
      signal: abort.signal,
      progress: () => {},
    }),
    /cancelled/,
  );
  assert.ok(commands.some((command) => command.includes('The restart is off')));
});

test('fleet update skips Steam library installs and waits for readiness before the next server', async (t) => {
  const f = fixture(t, 3);
  f.db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind) VALUES (9, ?, ?, 'fleet.action')").run(at(), at());
  f.db.prepare("UPDATE installs SET source = 'steam-client' WHERE id = 2").run();
  const events = [];
  const states = new Map([
    [1, 'running'],
    [2, 'running'],
    [3, 'running'],
  ]);
  const supervisor = {
    status: (id) => ({ observedState: states.get(id) }),
    stop: async (id) => {
      events.push(['stop', id]);
      states.set(id, 'stopped');
    },
    start: async (id) => {
      events.push(['start', id]);
      states.set(id, 'running');
    },
  };
  const steamcmd = {
    latestBuildId: async () => '99',
    appUpdate: async ({ installDir }) => {
      events.push(['update', installDir]);
      return { output: 'ok' };
    },
    readManifest: () => ({ fullyInstalled: true, buildId: '99' }),
  };
  const handlers = createFleetHandlers({
    db: f.db,
    dataDir: f.root,
    steamcmd,
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    sleep: async () => {},
    marker: async () => null,
    ready: async () => {
      events.push(['ready']);
    },
  });
  const result = await handlers['fleet.action']({
    job: { id: 9 },
    params: { action: 'update', serverIds: [1, 2, 3], countdownMinutes: [1] },
    signal: new AbortController().signal,
    progress: () => {},
  });
  assert.deepEqual(result.skipped, [2]);
  assert.deepEqual(result.completed, [1, 3]);
  assert.deepEqual(events.filter((item) => item[0] === 'ready').length, 2);
  assert.ok(
    events.findIndex((item) => item[0] === 'ready') < events.findIndex((item) => item[0] === 'stop' && item[1] === 3),
  );
  assert.equal(events.filter((item) => item[0] === 'update').length, 2);
});

test('route and job action validation agree', (t) => {
  const f = fixture(t);
  for (const value of [
    { action: 'erase', serverIds: [1] },
    { action: 'start', serverIds: [1, 1] },
    { action: 'restart', serverIds: [1], options: { countdownMinutes: [1, 5] } },
  ])
    assert.throws(() => checkFleet(value, f.db), { status: 400 });
  assert.deepEqual(checkFleet({ action: 'stop', serverIds: [1] }, f.db).serverIds, [1]);
});

test('fleet routes protect, audit, check free space and enforce job conflicts', async (t) => {
  const f = fixture(t, 2);
  const publicDir = path.join(f.root, 'public');
  fs.mkdirSync(publicDir);
  const kinds = ['server.clone', 'server.move', 'fleet.action'];
  let heldClone = null;
  const jobs = createJobEngine({
    db: f.db,
    handlers: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        async ({ job, signal }) => {
          if (kind === 'server.clone' && heldClone?.id === job.id) {
            heldClone.started();
            await heldClone.wait;
            if (signal.aborted) throw signal.reason;
          }
          return {};
        },
      ]),
    ),
  });
  const app = createApp({
    db: f.db,
    dataDir: path.join(f.root, 'data'),
    publicDir,
    jobs,
    supervisor: { status: () => ({ observedState: 'stopped' }) },
    steamcmd: { isInstalled: () => false },
    runner: async () => ({ code: 0 }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => false,
    rankFields: async () => [],
    log: () => {},
  });
  fs.mkdirSync(path.join(f.root, 'data'));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.stop({ abort: true });
    await app.close();
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const post = (route, value) =>
    fetch(`${url}${route}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const badClone = { path: f.target('invalid-clone'), name: 'Server 1', sessionName: 'Copy' };
  assert.throws(() => checkClone(badClone, f.db), { status: 409 });
  assert.equal((await post('/api/servers/1/clone', badClone)).status, 409);
  assert.throws(() => checkFolder('relative'), { status: 400 });
  assert.equal((await post('/api/servers/1/move', { path: 'relative' })).status, 400);
  const badFleet = { action: 'restart', serverIds: [1], options: { countdownMinutes: [1, 5] } };
  assert.throws(() => checkFleet(badFleet, f.db), { status: 400 });
  assert.equal((await post('/api/fleet/actions', badFleet)).status, 400);
  const target = f.target('api-clone');
  assert.equal((await fetch(`${url}/api/host/free-space?path=${encodeURIComponent(target)}&serverId=1`)).status, 401);
  const space = await (
    await fetch(`${url}/api/host/free-space?path=${encodeURIComponent(target)}&serverId=1`, {
      headers: { Cookie: cookie },
    })
  ).json();
  assert.ok(space.freeBytes >= space.requiredBytes);
  assert.ok(space.sourceBytes > 0);
  const getSpace = (folder) =>
    fetch(`${url}/api/host/free-space?path=${encodeURIComponent(folder)}`, { headers: { Cookie: cookie } });
  for (const invalid of [
    'relative',
    'C:\\folder\\..\\else',
    '\\\\server\\share',
    '\\\\?\\C:\\folder',
    'C:\\Steam\\steamapps\\common\\ASA',
    'Z:\\missing-drive',
  ])
    assert.equal((await getSpace(invalid)).status, 400, invalid);
  assert.equal((await getSpace(f.target('new', 'child'))).status, 200);
  const browseRoot = f.target('browse');
  fs.mkdirSync(path.join(browseRoot, 'Servers'), { recursive: true });
  fs.writeFileSync(path.join(browseRoot, 'notes.txt'), 'not a folder');
  const listFolders = (folder) =>
    fetch(`${url}/api/host/folders?path=${encodeURIComponent(folder)}`, { headers: { Cookie: cookie } });
  const listing = await (await listFolders(browseRoot)).json();
  assert.deepEqual(
    listing.folders.map((entry) => entry.name),
    ['Servers'],
  );
  assert.equal((await listFolders(path.join(browseRoot, 'missing'))).status, 400);
  assert.equal((await listFolders('\\\\server\\share')).status, 400);
  const body = {
    path: target,
    name: 'API copy',
    sessionName: 'API copy',
    adminPassword: 'private-admin',
    joinPassword: 'private-join',
  };
  const first = await post('/api/servers/1/clone', body);
  assert.equal(first.status, 200);
  const queued = await first.json();
  assert.equal(
    f.db.prepare('SELECT params_json FROM jobs WHERE id = ?').get(queued.id).params_json.includes('private-'),
    false,
  );
  assert.equal(JSON.stringify(queued).includes('private-'), false);
  const listed = await (await fetch(`${url}/api/jobs`, { headers: { Cookie: cookie } })).json();
  assert.equal(JSON.stringify(listed).includes('private-'), false);
  assert.equal((await post('/api/servers/2/clone', { ...body, name: 'Other copy' })).status, 409);
  assert.deepEqual(queued.targets.servers, [1]);
  assert.ok(queued.targets.installs.includes(queued.installId));
  assert.equal(
    (await post('/api/servers/1/clone', { ...body, path: f.target('another'), name: 'Another' })).status,
    409,
  );
  assert.equal((await post('/api/servers/1/move', { path: f.target('moved') })).status, 409);
  assert.equal((await post('/api/fleet/actions', { action: 'start', serverIds: [1] })).status, 409);
  const audit = f.db
    .prepare("SELECT action, target_kind, detail_json FROM audit_events WHERE action = 'server.clone'")
    .get();
  assert.equal(audit.target_kind, 'server');
  assert.equal(JSON.parse(audit.detail_json).path, target);
  assert.equal(JSON.parse(audit.detail_json).name, body.name);
  assert.equal(JSON.stringify(audit).includes('private-'), false);
  assert.equal((await post(`/api/jobs/${queued.id}/cancel`, {})).status, 200);
  assert.equal(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(queued.installId), undefined);
  const move = await post('/api/servers/1/move', { path: f.target('moved') });
  assert.equal(move.status, 200);
  assert.equal((await post('/api/servers/2/move', { path: f.target('moved') })).status, 409);
  const moveAudit = f.db
    .prepare("SELECT target_kind, target_id, detail_json FROM audit_events WHERE action = 'server.move'")
    .get();
  assert.equal(moveAudit.target_kind, 'server');
  assert.equal(moveAudit.target_id, 1);
  assert.equal(JSON.parse(moveAudit.detail_json).path, f.target('moved'));
  assert.equal((await post(`/api/jobs/${(await move.json()).id}/cancel`, {})).status, 200);
  const fleet = await post('/api/fleet/actions', { action: 'start', serverIds: [1] });
  assert.equal(fleet.status, 200);
  const fleetAudit = f.db
    .prepare("SELECT target_kind, detail_json FROM audit_events WHERE action = 'fleet.action'")
    .get();
  assert.equal(fleetAudit.target_kind, 'fleet');
  assert.deepEqual(JSON.parse(fleetAudit.detail_json).serverIds, [1]);
  assert.equal((await post(`/api/jobs/${(await fleet.json()).id}/cancel`, {})).status, 200);
  f.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, state, targets_json) VALUES (?, ?, 'server.clone', 'queued', ?)",
    )
    .run(at(), at(), JSON.stringify({ servers: [], installs: [1] }));
  assert.equal((await post('/api/servers/1/start', {})).status, 409);
  const oldPath = f.servers[0].install_path;
  const newPath = f.target('completed-move');
  f.db.prepare('UPDATE installs SET path = ? WHERE id = 1').run(newPath);
  f.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state, result_json) VALUES (?, ?, 'server.move', 1, 'succeeded', ?)",
    )
    .run(
      at(),
      at(),
      JSON.stringify({
        source: oldPath,
        target: newPath,
        message: MESSAGES.oldFolder.replace('{source}', oldPath).replace('{target}', newPath),
      }),
    );
  const detail = await (await fetch(`${url}/api/servers/1`, { headers: { Cookie: cookie } })).json();
  assert.equal(detail.lastMove.source, oldPath);
  assert.match(detail.lastMove.message, /You can delete it/);
  const racing = await (
    await post('/api/servers/2/clone', {
      path: f.target('racing-clone'),
      name: 'Racing clone',
      sessionName: 'Racing clone',
    })
  ).json();
  let notifyStarted;
  let release;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  heldClone = { id: racing.id, started: notifyStarted, wait };
  jobs.start();
  await started;
  assert.equal(jobs.get(racing.id).state, 'running');
  assert.equal((await post(`/api/jobs/${racing.id}/cancel`, {})).status, 200);
  assert.ok(f.db.prepare('SELECT 1 FROM installs WHERE id = ?').get(racing.installId));
  release();
  await jobs.stop();
});

test('new components keep visible labels in the shared strings file', () => {
  for (const name of ['components/ao-servers.js', 'components/ao-server-overview.js', 'lib/install-folder.js']) {
    const source = fs.readFileSync(new URL(`../public/js/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /textContent\s*=\s*['"`][A-Za-z]/);
    assert.doesNotMatch(source, /(?:placeholder|title|value)\s*=\s*['"`][A-Za-z]/);
    assert.doesNotMatch(source, /setAttribute\(['"]aria-label['"],\s*['"`][A-Za-z]/);
    assert.doesNotMatch(source, /new Option\(['"`][A-Za-z]/);
    assert.doesNotMatch(source, /\bel\(['"][a-z]+['"],\s*['"`][A-Za-z]/);
    assert.doesNotMatch(source, /createTextNode\(['"`][A-Za-z]/);
    assert.doesNotMatch(source, /\.ask\(['"`][A-Za-z]/);
  }
});
