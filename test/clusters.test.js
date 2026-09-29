import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { createApp } from '../src/app.js';
import { buildLaunch, buildWindowsCommandLine, serverPaths } from '../src/supervisor/launch.js';
import { serverSpawnArgs } from '../src/supervisor/platform.js';
import { createClusterHandlers } from '../src/clusters/handlers.js';
import {
  checkActionOptions,
  checkOverrides,
  checkSharedSettings,
  clusterKey,
  activeJobFor,
  prepareFolder,
  settingsForMember,
  validateFolder,
} from '../src/clusters/core.js';
import { createDrift } from '../src/settings/drift.js';
import { clusterEditChoice, clusterFieldState } from '../public/js/lib/clusters.js';
import { createSettingInput, readSettingInput } from '../public/js/lib/settings-controls.js';

const T = '2026-01-01T00:00:00.000Z';
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-clusters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function rows(db, root, count = 3) {
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'local', ?, ?)").run(T, T);
  db.prepare(
    'INSERT INTO clusters (id, created_at, updated_at, name, cluster_key, shared_dir, settings_json) VALUES (1, ?, ?, ?, ?, ?, ?)',
  ).run(
    T,
    T,
    'Worlds',
    '1234567890abcdef',
    path.join(root, 'shared'),
    JSON.stringify({ noTributeDownloads: true, TamingSpeedMultiplier: 2, MaxPlayers: 50 }),
  );
  for (let id = 1; id <= count; id++) {
    const install = path.join(root, `install-${id}`);
    db.prepare(
      "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (?, 1, ?, 'installed', ?, ?)",
    ).run(id, install, T, T);
    db.prepare(
      "INSERT INTO servers (id, host_id, install_id, cluster_id, name, map, session_name, game_port, rcon_port, created_at, updated_at) VALUES (?, 1, ?, 1, ?, 'TheIsland_WP', ?, ?, ?, ?, ?)",
    ).run(id, id, `Server ${id}`, `Server ${id}`, 7775 + id * 2, 27020 + id, T, T);
    const config = serverPaths(install).configDir;
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, 'GameUserSettings.ini'),
      '[ServerSettings]\r\nTamingSpeedMultiplier=1\r\nnoTributeDownloads=False\r\n',
    );
  }
}

test('migration 10 preserves populated servers and schedules and adds cluster fields and targets', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.slice(0, 9)) {
      db.exec(migration.up);
      migration.after?.(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, T);
    }
    db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'local', ?, ?)").run(T, T);
    db.prepare("INSERT INTO installs (id, host_id, path, created_at, updated_at) VALUES (1, 1, 'C:/ark', ?, ?)").run(
      T,
      T,
    );
    db.prepare(
      "INSERT INTO clusters (id, created_at, updated_at, name, cluster_key, shared_dir) VALUES (1, ?, ?, 'Worlds', '1234567890abcdef', NULL)",
    ).run(T, T);
    db.prepare(
      "INSERT INTO servers (id, host_id, install_id, cluster_id, name, map, session_name, game_port, created_at, updated_at) VALUES (1, 1, 1, 1, 'One', 'TheIsland_WP', 'One', 7777, ?, ?)",
    ).run(T, T);
    db.prepare(
      "INSERT INTO schedules (id, server_id, kind, cron, created_at, updated_at) VALUES (1, 1, 'restart', '0 5 * * *', ?, ?)",
    ).run(T, T);
    assert.deepEqual(migrate(db, { dataDir: 'C:\\Test Data' }), [10]);
    assert.equal(db.prepare('SELECT cluster_id, cluster_overrides_json FROM servers').get().cluster_id, 1);
    assert.equal(db.prepare('SELECT settings_json, notes FROM clusters').get().settings_json, '{}');
    assert.equal(
      db.prepare('SELECT shared_dir FROM clusters').get().shared_dir,
      'C:\\Test Data\\clusters\\1234567890abcdef',
    );
    assert.equal(db.prepare('SELECT kind, cron FROM schedules WHERE id = 1').get().kind, 'restart');
    db.prepare(
      "INSERT INTO schedules (cluster_id, kind, cron, created_at, updated_at) VALUES (1, 'cluster_restart', '0 6 * * *', ?, ?)",
    ).run(T, T);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schedules').get().n, 2);
    assert.deepEqual(migrate(db), []);
  } finally {
    db.close();
  }
});

test('launch passes one immutable cluster ID and quotes a folder with spaces', () => {
  const server = {
    map: 'TheIsland_WP',
    session_name: 'One',
    game_port: 7777,
    query_port: null,
    max_players: 70,
    settings_json: '{}',
    cluster_key: '1234567890abcdef',
    shared_dir: 'C:\\ASA Cluster\\Ark Data',
  };
  const args = buildLaunch(server, { path: 'C:\\ASA' }).args;
  assert.deepEqual(args.slice(-2), ['-clusterid=1234567890abcdef', '-ClusterDirOverride="C:\\ASA Cluster\\Ark Data"']);
  assert.equal(
    buildLaunch({ ...server, cluster_key: null, shared_dir: null }, { path: 'C:\\ASA' }).args.some((arg) =>
      arg.includes('cluster'),
    ),
    false,
  );
  assert.match(clusterKey(), /^[a-z0-9]{16}$/);
  const named = buildLaunch(
    { ...server, session_name: 'My Server', settings_json: '{"mods":[12,34]}' },
    { path: 'C:\\ASA' },
  );
  assert.equal(
    buildWindowsCommandLine(named.args),
    '"TheIsland_WP?listen?SessionName=My Server" -port=7777 -WinLiveMaxPlayers=70 -log -mods=12,34 -clusterid=1234567890abcdef -ClusterDirOverride="C:\\ASA Cluster\\Ark Data"',
  );
  assert.equal(
    buildWindowsCommandLine(
      buildLaunch({ ...server, session_name: 'My Server', cluster_key: null, shared_dir: null }, { path: 'C:\\ASA' })
        .args,
    ),
    '"TheIsland_WP?listen?SessionName=My Server" -port=7777 -WinLiveMaxPlayers=70 -log',
  );
  const [file, spawnArgs, options] = serverSpawnArgs({
    exePath: 'C:\\ARK Servers\\ArkAscendedServer.exe',
    cwd: 'C:\\ARK Servers',
    args: named.args,
  });
  assert.equal(file, 'C:\\ARK Servers\\ArkAscendedServer.exe');
  assert.deepEqual(spawnArgs, [buildWindowsCommandLine(named.args)]);
  assert.equal(options.argv0, '"C:\\ARK Servers\\ArkAscendedServer.exe"');
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.windowsHide, true);
});

test('cluster folders refuse UNC and mapped drives, grant Network Service, and probe writes', async (t) => {
  const root = temp(t);
  await assert.rejects(prepareFolder('\\\\host\\share', { custom: true }), /local drive/);
  for (const bad of ['\\\\?\\UNC\\host\\share\\x', '\\\\?\\C:\\x', 'relative', 'C:\\a\\..\\..\\x', 'C:\\'])
    assert.throws(() => validateFolder(bad), /local drive/);
  assert.equal(await validateFolder('C:\\ARK\\Folder\\'), 'C:\\ARK\\Folder');
  assert.equal(
    await prepareFolder('\\\\host\\share\\clusters\\key', {
      fsOps: { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} },
    }),
    '\\\\host\\share\\clusters\\key',
  );
  await assert.rejects(prepareFolder(root, { custom: true, isMappedDrive: () => true }), /local drive/);
  const calls = [];
  assert.equal(
    await prepareFolder(root, {
      custom: true,
      runner: async (...args) => {
        calls.push(args);
        return { code: 0 };
      },
    }),
    path.win32.normalize(root),
  );
  assert.match(calls[0][1].join(' '), /S-1-5-20/);
  assert.equal(fs.readdirSync(root).length, 0);
  await assert.rejects(prepareFolder(root, { custom: true, runner: async () => ({ code: 1 }) }), /Network Service/);
  await assert.rejects(
    prepareFolder(root, {
      fsOps: {
        mkdir: async () => {},
        writeFile: async () => {
          throw new Error('denied');
        },
        unlink: async () => {},
      },
    }),
    /Network Service/,
  );
  await assert.rejects(
    prepareFolder(root, {
      fsOps: {
        mkdir: async () => {},
        writeFile: async () => {},
        unlink: async () => {
          throw new Error('locked');
        },
      },
    }),
    /could not remove its test file/,
  );
});

test('shared settings use catalog validation, skip overrides, and update drift baselines', async (t) => {
  const root = temp(t),
    db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, root, 2);
  db.prepare('UPDATE servers SET cluster_overrides_json = ? WHERE id = 2').run('["noTributeDownloads"]');
  assert.throws(() => checkSharedSettings({ ServerAdminPassword: 'secret' }), /catalog/);
  assert.throws(() => checkSharedSettings({ TamingSpeedMultiplier: -1 }), /at least/);
  assert.throws(() => checkOverrides(['bad'], db.prepare('SELECT * FROM clusters').get()), /Overrides/);
  const supervisor = { status: () => ({ observedState: 'stopped' }) };
  const drift = createDrift({
    db,
    dataDir: path.join(root, 'data'),
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  const cluster = db.prepare('SELECT * FROM clusters').get();
  const members = db
    .prepare('SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id ORDER BY s.id')
    .all();
  for (const member of members) await drift.recordBaseline(member, 'test');
  assert.deepEqual(settingsForMember(cluster, members[1]), { TamingSpeedMultiplier: 2, MaxPlayers: 50 });
  const handlers = createClusterHandlers({ db, supervisor, drift, rcon: async () => {}, getRconPassword: () => '' });
  for (const member of members)
    await handlers['server.cluster_apply']({
      job: { serverId: member.id },
      params: { clusterId: 1 },
      signal: new AbortController().signal,
    });
  const one = fs.readFileSync(serverPaths(members[0].install_path).gameUserSettingsPath, 'utf8');
  const two = fs.readFileSync(serverPaths(members[1].install_path).gameUserSettingsPath, 'utf8');
  assert.match(one, /noTributeDownloads=True/);
  assert.match(two, /noTributeDownloads=False/);
  assert.match(two, /TamingSpeedMultiplier=2/);
  assert.equal(db.prepare('SELECT max_players FROM servers WHERE id = 2').get().max_players, 50);
  assert.equal((await drift.checkDrift(members[0])).changed, false);
  assert.equal((await drift.checkDrift(members[1])).changed, false);
  db.prepare("UPDATE servers SET cluster_overrides_json = '[]' WHERE id = 2").run();
  await handlers['server.cluster_apply']({
    job: { serverId: 2 },
    params: { clusterId: 1, keys: ['noTributeDownloads'] },
    signal: new AbortController().signal,
  });
  assert.match(
    fs.readFileSync(serverPaths(members[1].install_path).gameUserSettingsPath, 'utf8'),
    /noTributeDownloads=True/,
  );
  assert.equal((await drift.checkDrift(members[1])).changed, false);
});

test('Settings page helper marks inherited fields and asks only for inherited edits', () => {
  const cluster = { settings: { noTributeDownloads: true, TamingSpeedMultiplier: 2 } };
  assert.equal(clusterFieldState('noTributeDownloads', cluster), 'inherited');
  assert.equal(clusterFieldState('noTributeDownloads', cluster, ['noTributeDownloads']), 'override');
  assert.equal(clusterFieldState('ServerPassword', cluster), 'local');
  assert.equal(clusterEditChoice([{ key: 'noTributeDownloads' }], cluster), true);
  assert.equal(clusterEditChoice([{ key: 'noTributeDownloads' }], cluster, ['noTributeDownloads']), false);
});

test('cluster and server editors share field control values', () => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try {
    const number = { key: 'MaxPlayers', type: 'int', default: 70, min: 1, max: 100 };
    const { input, display } = createSettingInput(number, null, 'players');
    assert.equal(display.isDefault, true);
    assert.equal(input.value, '70');
    input.value = '60';
    assert.equal(readSettingInput(number, input), 60);
    const toggle = { key: 'noTributeDownloads', type: 'bool', default: false };
    const control = createSettingInput(toggle, true, 'transfers').input;
    assert.equal(control.checked, true);
    assert.equal(readSettingInput(toggle, control), true);
  } finally {
    globalThis.document = original;
  }
});

function rolling(t, runningIds = [1, 2, 3]) {
  const root = temp(t),
    db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, root);
  const states = new Map([1, 2, 3].map((id) => [id, runningIds.includes(id) ? 'running' : 'stopped']));
  const events = [];
  const abort = new AbortController();
  const supervisor = {
    status: (id) => ({ observedState: states.get(id) }),
    stop: async (id) => {
      events.push(['stop', id]);
      states.set(id, 'stopped');
      if (rolling.abortOnStop) abort.abort(new Error('cancel'));
    },
    start: async (id) => {
      events.push(['start', id]);
      states.set(id, 'running');
    },
  };
  const handlers = createClusterHandlers({
    db,
    supervisor,
    drift: {},
    rcon: async ({ port }) => events.push(['rcon', port]),
    getRconPassword: () => '',
    sleep: async () => {},
    marker: async () => null,
    ready: async ({ isAlive }) => {
      events.push(['ready']);
      if (!isAlive() || rolling.failReady) throw new Error('not ready');
      if (rolling.abortOnReady) abort.abort(new Error('cancel'));
    },
  });
  return {
    db,
    events,
    abort,
    handlers,
    ctx: { params: { clusterId: 1, countdownMinutes: [1] }, signal: abort.signal, progress: () => {} },
  };
}

test('rolling restart skips stopped members and waits for each running member in order', async (t) => {
  const w = rolling(t, [1, 3]);
  const result = await w.handlers['cluster.restart'](w.ctx);
  assert.deepEqual(result.restarted, [1, 3]);
  assert.deepEqual(
    w.events.filter(([action]) => action !== 'rcon'),
    [['stop', 1], ['start', 1], ['ready'], ['stop', 3], ['start', 3], ['ready']],
  );
});
test('cluster start and stop act on members one at a time', async (t) => {
  const start = rolling(t, [2]);
  assert.deepEqual((await start.handlers['cluster.start']({ ...start.ctx, params: { clusterId: 1 } })).started, [1, 3]);
  assert.deepEqual(start.events, [
    ['start', 1],
    ['start', 3],
  ]);
  const stop = rolling(t, [1, 3]);
  assert.deepEqual((await stop.handlers['cluster.stop']({ ...stop.ctx, params: { clusterId: 1 } })).stopped, [1, 3]);
  assert.deepEqual(stop.events, [
    ['stop', 1],
    ['stop', 3],
  ]);
});
test('rolling restart stops after a member fails to become ready', async (t) => {
  const w = rolling(t);
  rolling.failReady = true;
  try {
    await assert.rejects(w.handlers['cluster.restart'](w.ctx), /Server 1 did not come back/);
    assert.deepEqual(
      w.events.filter(([action]) => action === 'stop').map((x) => x[1]),
      [1],
    );
  } finally {
    rolling.failReady = false;
  }
});
test('cancellation between and during members leaves later members untouched', async (t) => {
  const w = rolling(t);
  rolling.abortOnReady = true;
  try {
    await assert.rejects(w.handlers['cluster.restart'](w.ctx), /cancel/);
    assert.deepEqual(
      w.events.filter(([action]) => action === 'start').map((x) => x[1]),
      [1],
    );
  } finally {
    rolling.abortOnReady = false;
  }
  const v = rolling(t);
  rolling.abortOnStop = true;
  try {
    await assert.rejects(v.handlers['cluster.restart'](v.ctx), /cancel/);
    assert.deepEqual(
      v.events.filter(([action]) => action === 'start').map((x) => x[1]),
      [1],
    );
  } finally {
    rolling.abortOnStop = false;
  }
});

test('scheduled cluster restart queues a job that targets every member', (t) => {
  const root = temp(t),
    db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, root, 2);
  db.prepare(
    "INSERT INTO schedules (cluster_id, kind, cron, next_run_at, created_at, updated_at) VALUES (1, 'cluster_restart', '* * * * *', ?, ?, ?)",
  ).run(T, T, T);
  const sent = [];
  const jobs = {
    enqueue: (kind, params, targets) => {
      sent.push({ kind, params, targets });
      const id = Number(
        db.prepare("INSERT INTO jobs (kind, state, created_at, updated_at) VALUES (?, 'queued', ?, ?)").run(kind, T, T)
          .lastInsertRowid,
      );
      return { id };
    },
  };
  const scheduler = createScheduler({ db, jobs, now: () => Date.parse(T), setTimer: () => 1, clearTimer: () => {} });
  scheduler.start();
  assert.equal(sent[0].kind, 'cluster.restart');
  assert.equal(sent[0].params.clusterId, 1);
  assert.deepEqual(sent[0].targets.targets.servers, [1, 2]);
  assert.deepEqual(sent[0].targets.targets.installs, [1, 2]);
  scheduler.stop();
});

test('action options have the same validation before enqueue and inside jobs', async (t) => {
  const w = rolling(t);
  assert.throws(() => checkActionOptions({ countdownMinutes: [1, 10] }), /action options/);
  for (const action of ['restart', 'start', 'stop'])
    await assert.rejects(
      w.handlers[`cluster.${action}`]({ ...w.ctx, params: { clusterId: 1, countdownMinutes: [1, 10] } }),
      /action options/,
    );
});

test('rolling jobs skip members that leave and include starting members', async (t) => {
  const w = rolling(t, [1]);
  w.db.prepare('UPDATE servers SET cluster_id = NULL WHERE id = 2').run();
  const result = await w.handlers['cluster.start']({ ...w.ctx, params: { clusterId: 1 } });
  assert.deepEqual(result.started, [3]);
  const v = rolling(t);
  const status = v.db.prepare('UPDATE servers SET cluster_id = NULL WHERE id = 2');
  // The first member leaves the second while the job awaits its readiness.
  const ready = createClusterHandlers({
    db: v.db,
    supervisor: {
      status: (id) => ({ observedState: id === 2 ? 'starting' : 'running' }),
      stop: async (id) => {
        v.events.push(['stop', id]);
      },
      start: async (id) => {
        v.events.push(['start', id]);
      },
    },
    drift: {},
    rcon: async () => {},
    getRconPassword: () => '',
    sleep: async () => {},
    marker: async () => null,
    ready: async () => {
      status.run();
    },
  });
  assert.deepEqual((await ready['cluster.restart'](v.ctx)).restarted, [1, 3]);
  assert.deepEqual(
    v.events.filter(([action]) => action === 'stop').map(([, id]) => id),
    [1, 3],
  );
  const starting = rolling(t);
  const include = createClusterHandlers({
    db: starting.db,
    supervisor: {
      status: (id) => ({ observedState: id === 2 ? 'starting' : 'stopped' }),
      stop: async (id) => starting.events.push(['stop', id]),
    },
    drift: {},
    rcon: async () => {},
    getRconPassword: () => '',
  });
  assert.deepEqual((await include['cluster.stop']({ ...starting.ctx, params: { clusterId: 1 } })).stopped, [2]);
});

test('cancel during readiness reaches the wait signal and ends cancelled', async (t) => {
  const w = rolling(t);
  const handlers = createClusterHandlers({
    db: w.db,
    supervisor: {
      status: () => ({ observedState: 'running' }),
      stop: async (id) => w.events.push(['stop', id]),
      start: async (id) => w.events.push(['start', id]),
    },
    drift: {},
    rcon: async () => {},
    getRconPassword: () => '',
    sleep: async () => {},
    marker: async () => null,
    ready: async ({ signal }) => {
      assert.equal(signal, w.abort.signal);
      w.abort.abort(new Error('cancelled'));
      throw signal.reason;
    },
  });
  await assert.rejects(handlers['cluster.restart'](w.ctx), /cancelled/);
  assert.deepEqual(
    w.events.filter(([action]) => action === 'start').map(([, id]) => id),
    [1],
  );
});

test('active jobs include install targets', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, temp(t), 1);
  db.prepare("INSERT INTO jobs (created_at, updated_at, kind, targets_json) VALUES (?, ?, 'cluster.restart', ?)").run(
    T,
    T,
    JSON.stringify({ servers: [], installs: [1] }),
  );
  assert.equal(activeJobFor(db, [{ id: 1, install_id: 1 }]), true);
});

test('job engine locks every server and install targeted by a cluster job', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const root = temp(t);
  rows(db, root, 2);
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const jobs = createJobEngine({
    db,
    concurrency: 2,
    progressWriteMs: 0,
    handlers: {
      'cluster.restart': async () => {
        events.push('cluster');
        await gate;
      },
      'server.backup': async () => {
        events.push('backup');
      },
    },
  });
  t.after(() => jobs.stop({ abort: true }));
  jobs.start();
  jobs.enqueue('cluster.restart', { clusterId: 1 }, { targets: { servers: [1, 2], installs: [1, 2] } });
  jobs.enqueue('server.backup', {}, { serverId: 2, installId: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['cluster']);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['cluster', 'backup']);
});

test('cluster API protects and audits member changes, preserves settings on leave, and enforces 409 locks', async (t) => {
  const root = temp(t),
    db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, root);
  db.prepare('UPDATE servers SET cluster_id = NULL WHERE id IN (2, 3)').run();
  const handlers = Object.fromEntries(
    ['server.cluster_apply', 'cluster.restart', 'cluster.start', 'cluster.stop'].map((kind) => [
      kind,
      async () => ({ ok: true }),
    ]),
  );
  const jobs = createJobEngine({ db, handlers });
  t.after(() => jobs.stop({ abort: true }));
  const calls = [];
  const supervisor = {
    status: (id) => ({ observedState: id === 2 ? 'running' : 'stopped' }),
    start: async (id) => {
      calls.push(['start', id]);
    },
    stop: async (id) => {
      calls.push(['stop', id]);
    },
    restart: async (id) => {
      calls.push(['restart', id]);
    },
  };
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
    steamcmd: { isInstalled: () => false, exePath: 'fake' },
    runner: async () => ({ code: 0, stdout: '3' }),
    clusterExec: async () => ({ stdout: '3' }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => true,
    rankFields: async () => [],
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  assert.equal((await fetch(`${base}/api/clusters`)).status, 401);
  assert.equal((await call('GET', '/api/clusters')).status, 200);
  assert.equal((await call('POST', '/api/clusters/1/members', { serverId: 2 })).status, 200);
  const server = await (await call('GET', '/api/servers/2')).json();
  assert.equal(server.cluster_name, 'Worlds');
  assert.equal(server.cluster_id, 1);
  assert.equal((await call('POST', '/api/clusters/1/members', { serverId: 2 })).status, 409);
  assert.equal((await call('DELETE', '/api/clusters/1')).status, 409);
  assert.equal((await call('DELETE', '/api/clusters/1/members/2')).status, 409);
  const pending = db.prepare("SELECT id FROM jobs WHERE kind = 'server.cluster_apply' AND state = 'queued'").get();
  jobs.cancel(pending.id);
  const folderResult = await (
    await call('PATCH', '/api/clusters/1', { shared_dir: path.join(root, 'cluster folder') })
  ).json();
  assert.equal(folderResult.appliesAtNextStart, true);
  assert.equal(folderResult.cluster_key, '1234567890abcdef');
  assert.equal((await call('PUT', '/api/servers/2/settings', { noTributeDownloads: false })).status, 400);
  assert.equal(
    (await call('PUT', '/api/servers/2/settings', { noTributeDownloads: false, MaxPlayers: 60, clusterChoice: 'keep' }))
      .status,
    200,
  );
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT cluster_overrides_json FROM servers WHERE id = 2').get().cluster_overrides_json),
    ['noTributeDownloads', 'MaxPlayers'],
  );
  assert.equal(db.prepare('SELECT max_players FROM servers WHERE id = 2').get().max_players, 60);
  assert.equal((await call('PUT', '/api/servers/2/cluster-overrides', { overrides: [] })).status, 200);
  for (const queued of db.prepare("SELECT id FROM jobs WHERE kind = 'server.cluster_apply' AND state = 'queued'").all())
    jobs.cancel(queued.id);
  const oldValue = fs.readFileSync(serverPaths(server.install.path).gameUserSettingsPath, 'utf8');
  const left = await (await call('DELETE', '/api/clusters/1/members/2')).json();
  assert.equal(left.appliesAtNextStart, true);
  assert.equal(db.prepare('SELECT cluster_id FROM servers WHERE id = 2').get().cluster_id, null);
  assert.equal(fs.readFileSync(serverPaths(server.install.path).gameUserSettingsPath, 'utf8'), oldValue);
  assert.equal((await call('PUT', '/api/clusters/1/settings', { ServerAdminPassword: 'x' })).status, 400);
  assert.equal(
    (await call('PUT', '/api/servers/1/settings', { TamingSpeedMultiplier: 3, clusterChoice: 'cluster' })).status,
    200,
  );
  assert.equal(
    JSON.parse(db.prepare('SELECT settings_json FROM clusters WHERE id = 1').get().settings_json).TamingSpeedMultiplier,
    3,
  );
  for (const queued of db.prepare("SELECT id FROM jobs WHERE kind = 'server.cluster_apply' AND state = 'queued'").all())
    jobs.cancel(queued.id);
  assert.equal((await call('POST', '/api/clusters/1/restart', { countdownMinutes: [1, 10] })).status, 400);
  assert.equal((await call('PUT', '/api/clusters/1/schedules/restart', { cron: 'bad' })).status, 400);
  assert.equal(
    (await call('PUT', '/api/clusters/1/schedules/restart', { cron: '0 5 * * *', options: { countdownMinutes: [1] } }))
      .status,
    200,
  );
  assert.equal((await (await call('GET', '/api/clusters/1/schedules')).json())[0].kind, 'cluster_restart');
  const job = await (await call('POST', '/api/clusters/1/restart', { countdownMinutes: [1] })).json();
  assert.equal(job.kind, 'cluster.restart');
  assert.deepEqual(job.targets.servers, [1]);
  assert.equal((await call('POST', '/api/servers/1/start', {})).status, 409);
  assert.equal((await call('DELETE', '/api/clusters/1/members/1')).status, 409);
  jobs.cancel(job.id);
  assert.equal((await call('DELETE', '/api/clusters/1/members/1')).status, 200);
  assert.equal((await call('DELETE', '/api/clusters/1')).status, 200);
  const audits = db
    .prepare("SELECT action FROM audit_events WHERE action LIKE 'cluster.%' ORDER BY id")
    .all()
    .map((row) => row.action);
  assert.ok(audits.includes('cluster.member.add'));
  assert.ok(audits.includes('cluster.member.remove'));
  assert.ok(audits.includes('cluster.restart'));
  assert.ok(audits.includes('cluster.delete'));
  assert.ok(audits.includes('cluster.update'));
  assert.ok(audits.includes('cluster.settings'));
  assert.ok(audits.includes('cluster.overrides'));
  assert.ok(audits.includes('cluster.schedule.save'));
  assert.deepEqual(calls, []);
});

async function clusterApi(t, exec = async () => ({ stdout: '3' })) {
  const root = temp(t);
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  rows(db, root);
  const jobs = createJobEngine({
    db,
    handlers: Object.fromEntries(
      ['server.cluster_apply', 'cluster.restart', 'cluster.start', 'cluster.stop'].map((kind) => [
        kind,
        async () => ({}),
      ]),
    ),
  });
  t.after(() => jobs.stop({ abort: true }));
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor: { status: () => ({ observedState: 'stopped' }), start: async () => {}, stop: async () => {} },
    steamcmd: { isInstalled: () => false, exePath: 'fake' },
    runner: async () => ({ code: 0 }),
    clusterExec: exec,
    pwshPath: 'C:\\Tools\\pwsh.exe',
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => true,
    rankFields: async () => [],
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const call = (method, url, body = {}) =>
    fetch(`${base}${url}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  return { root, db, jobs, call };
}

test('cluster API checks mapped drives through configured pwsh and refuses failed checks', async (t) => {
  const calls = [];
  let answer = '4';
  const api = await clusterApi(t, async (...args) => {
    calls.push(args);
    if (answer === 'fail') throw new Error('pwsh failed');
    return { stdout: answer };
  });
  assert.equal(
    (await api.call('POST', '/api/clusters', { name: 'Mapped', shared_dir: path.join(api.root, 'mapped') })).status,
    400,
  );
  assert.equal(calls[0][0], 'C:\\Tools\\pwsh.exe');
  assert.equal(calls[0][2].windowsHide, true);
  answer = 'fail';
  assert.equal(
    (await api.call('POST', '/api/clusters', { name: 'Failed', shared_dir: path.join(api.root, 'failed') })).status,
    400,
  );
  answer = '3';
  assert.equal(
    (await api.call('POST', '/api/clusters', { name: 'Local', shared_dir: path.join(api.root, 'local') })).status,
    200,
  );
});

test('cluster API protects folder identity, name, key, and action options', async (t) => {
  const { db, root, call } = await clusterApi(t);
  const created = await (await call('POST', '/api/clusters', { name: 'Second' })).json();
  assert.equal(created.shared_dir, path.win32.join(root, 'data', 'clusters', created.cluster_key));
  assert.equal((await call('POST', '/api/clusters', { name: 'Second' })).status, 409);
  assert.equal((await call('POST', '/api/clusters', { name: 'Third', shared_dir: created.shared_dir })).status, 409);
  assert.equal(
    (await call('POST', '/api/clusters', { name: 'Third', shared_dir: `${created.shared_dir.toUpperCase()}\\` }))
      .status,
    409,
  );
  assert.equal((await call('PATCH', '/api/clusters/1', { shared_dir: created.shared_dir })).status, 409);
  assert.equal((await call('PATCH', '/api/clusters/1', { cluster_key: 'newkey' })).status, 400);
  assert.equal(db.prepare('SELECT cluster_key FROM clusters WHERE id = 1').get().cluster_key, '1234567890abcdef');
  for (const action of ['start', 'stop'])
    assert.equal((await call('POST', `/api/clusters/1/${action}`, { countdownMinutes: [1, 10] })).status, 400);
  const audit = db
    .prepare("SELECT action FROM audit_events WHERE action LIKE 'cluster.%' ORDER BY id")
    .all()
    .map((row) => row.action);
  assert.ok(audit.includes('cluster.create'));
});

test('cluster settings reject identity fields and roll back with failed enqueue', async (t) => {
  const { db, jobs, call } = await clusterApi(t);
  for (const key of [
    'SessionName',
    'Port',
    'QueryPort',
    'RCONPort',
    'ServerPassword',
    'ServerAdminPassword',
    'ActiveMapMod',
  ])
    assert.equal(
      (await call('PUT', '/api/clusters/1/settings', { [key]: key.includes('Port') ? 7777 : 'x' })).status,
      400,
    );
  assert.equal((await call('PUT', '/api/clusters/1/settings', ['bad'])).status, 415);
  const before = db.prepare('SELECT settings_json FROM clusters WHERE id = 1').get().settings_json;
  let enqueues = 0;
  jobs.enqueue = () => {
    if (++enqueues === 2) throw new Error('enqueue failed');
    return { id: 1 };
  };
  assert.equal((await call('PUT', '/api/clusters/1/settings', { TamingSpeedMultiplier: 4 })).status, 500);
  assert.equal(db.prepare('SELECT settings_json FROM clusters WHERE id = 1').get().settings_json, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'server.cluster_apply'").get().n, 0);
});

test('Settings page cluster change rolls back the cluster row when enqueue fails', async (t) => {
  const { db, jobs, call } = await clusterApi(t);
  const before = db.prepare('SELECT settings_json FROM clusters WHERE id = 1').get().settings_json;
  let count = 0;
  jobs.enqueue = () => {
    if (++count === 2) throw new Error('enqueue failed');
    return { id: 1 };
  };
  assert.equal(
    (await call('PUT', '/api/servers/1/settings', { TamingSpeedMultiplier: 5, clusterChoice: 'cluster' })).status,
    500,
  );
  assert.equal(db.prepare('SELECT settings_json FROM clusters WHERE id = 1').get().settings_json, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'cluster.settings'").get().n, 0);
});

test('removing an override queues and writes the cluster value', async (t) => {
  const { db, root, call } = await clusterApi(t);
  assert.equal(
    (await call('PUT', '/api/servers/1/settings', { noTributeDownloads: false, clusterChoice: 'keep' })).status,
    200,
  );
  const response = await call('PUT', '/api/servers/1/cluster-overrides', { overrides: [] });
  assert.equal(response.status, 200);
  const queued = (await response.json()).jobs;
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT params_json FROM jobs WHERE id = ?').get(queued[0].id).params_json).keys,
    ['noTributeDownloads'],
  );
  const supervisor = { status: () => ({ observedState: 'stopped' }) };
  const drift = createDrift({
    db,
    dataDir: path.join(root, 'data'),
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  const handlers = createClusterHandlers({ db, supervisor, drift, rcon: async () => {}, getRconPassword: () => '' });
  await handlers['server.cluster_apply']({
    job: { serverId: 1 },
    params: { clusterId: 1, keys: ['noTributeDownloads'] },
    signal: new AbortController().signal,
  });
  assert.match(
    fs.readFileSync(serverPaths(path.join(root, 'install-1')).gameUserSettingsPath, 'utf8'),
    /noTributeDownloads=True/,
  );
});

test('cluster routes record their audit actions', async (t) => {
  const { db, jobs, call } = await clusterApi(t);
  const created = await (await call('POST', '/api/clusters', { name: 'Empty' })).json();
  assert.equal((await call('PATCH', `/api/clusters/${created.id}`, { notes: 'note' })).status, 200);
  assert.equal((await call('PUT', '/api/clusters/1/settings', { TamingSpeedMultiplier: 3 })).status, 200);
  for (const row of db.prepare("SELECT id FROM jobs WHERE state = 'queued'").all()) jobs.cancel(row.id);
  assert.equal(
    (await call('PUT', '/api/servers/1/cluster-overrides', { overrides: ['TamingSpeedMultiplier'] })).status,
    200,
  );
  assert.equal((await call('PUT', '/api/clusters/1/schedules/restart', { cron: '0 5 * * *' })).status, 200);
  assert.equal((await call('DELETE', '/api/clusters/1/schedules/restart')).status, 200);
  for (const action of ['start', 'stop', 'restart']) {
    const response = await call('POST', `/api/clusters/1/${action}`);
    assert.equal(response.status, 200);
    jobs.cancel((await response.json()).id);
  }
  assert.equal((await call('DELETE', `/api/clusters/${created.id}`)).status, 200);
  const actions = new Set(
    db
      .prepare("SELECT action FROM audit_events WHERE action LIKE 'cluster.%'")
      .all()
      .map((row) => row.action),
  );
  for (const action of [
    'cluster.create',
    'cluster.update',
    'cluster.settings',
    'cluster.overrides',
    'cluster.schedule.save',
    'cluster.schedule.delete',
    'cluster.start',
    'cluster.stop',
    'cluster.restart',
    'cluster.delete',
  ])
    assert.ok(actions.has(action), action);
});

test('a running cluster job holds members and install targets', async (t) => {
  const { db, call } = await clusterApi(t);
  db.prepare(
    "INSERT INTO jobs (created_at, updated_at, kind, state, targets_json) VALUES (?, ?, 'cluster.restart', 'running', ?)",
  ).run(T, T, JSON.stringify({ servers: [], installs: [1] }));
  assert.equal((await call('DELETE', '/api/clusters/1/members/1')).status, 409);
});

test('a cluster without a folder cannot accept a member', async (t) => {
  const { db, call } = await clusterApi(t);
  db.prepare('UPDATE clusters SET shared_dir = NULL WHERE id = 1').run();
  db.prepare('UPDATE servers SET cluster_id = NULL WHERE id = 3').run();
  assert.equal((await call('POST', '/api/clusters/1/members', { serverId: 3 })).status, 400);
  assert.equal(db.prepare('SELECT cluster_id FROM servers WHERE id = 3').get().cluster_id, null);
});

test('the Clusters page keeps its cluster id off the element id, so the list page never loads a cluster', () => {
  // HTMLElement.id reflects the id attribute, so storing null there reads back as the string "null".
  const source = fs.readFileSync(new URL('../public/js/components/ao-clusters.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /this\.id\b/);
  assert.match(source, /this\.clusterId = Number\(this\.getAttribute\('cluster-id'\)\) \|\| null/);
});
