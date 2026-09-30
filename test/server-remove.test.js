import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createDrift } from '../src/settings/drift.js';
import { serverPaths } from '../src/supervisor/launch.js';
import { createRemovalHandlers } from '../src/fleet/removal.js';
import { MESSAGES } from '../src/fleet/core.js';
import { createApp } from '../src/app.js';
import { createJobEngine } from '../src/jobs/engine.js';

const at = () => new Date().toISOString();
function fixture(t, count = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-remove-')));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO hosts (id, created_at, updated_at, name) VALUES (1, ?, ?, 'local')").run(at(), at());
  for (let id = 1; id <= count; id++) {
    const folder = path.join(root, `server-${id}`);
    const paths = serverPaths(folder);
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(path.join(folder, 'server.bin'), `build ${id}`);
    fs.writeFileSync(paths.gameUserSettingsPath, '[ServerSettings]\nServerAdminPassword=secret\n');
    fs.mkdirSync(path.join(folder, 'ShooterGame', 'Saved', 'SavedArks'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'ShooterGame', 'Saved', 'SavedArks', 'world.ark'), `world ${id}`);
    db.prepare(
      "INSERT INTO installs (id, created_at, updated_at, host_id, path, state, source) VALUES (?, ?, ?, 1, ?, 'installed', 'steamcmd')",
    ).run(id, at(), at(), folder);
    db.prepare(
      "INSERT INTO servers (id, created_at, updated_at, host_id, install_id, name, map, session_name, game_port, query_port, rcon_port) VALUES (?, ?, ?, 1, ?, ?, 'TheIsland_WP', ?, ?, ?, ?)",
    ).run(id, at(), at(), id, `Server ${id}`, `Session ${id}`, 7775 + id * 2, 27014 + id, 27019 + id);
    db.prepare(
      "INSERT INTO schedules (created_at, updated_at, server_id, kind, cron) VALUES (?, ?, ?, 'backup', '0 * * * *')",
    ).run(at(), at(), id);
    const backupDir = path.join(dataDir, 'backups', `server-${id}`, 'one');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'world.ark'), 'backup');
    db.prepare("INSERT INTO backups (created_at, server_id, reason, path) VALUES (?, ?, 'manual', ?)").run(
      at(),
      id,
      path.join(`server-${id}`, 'one'),
    );
    const snapshots = path.join(dataDir, 'settings-snapshots', `server-${id}`, 'one');
    fs.mkdirSync(snapshots, { recursive: true });
    fs.writeFileSync(path.join(snapshots, 'GameUserSettings.ini'), 'x');
  }
  return { root, dataDir, db, folder: (id) => path.join(root, `server-${id}`) };
}
function handlers(f, { state = 'stopped', forgotten = [] } = {}) {
  const supervisor = { status: () => ({ observedState: state }), forget: (id) => forgotten.push(id) };
  const drift = createDrift({
    db: f.db,
    dataDir: f.dataDir,
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  return createRemovalHandlers({ db: f.db, dataDir: f.dataDir, supervisor, drift, cwd: path.join(f.root, 'app') });
}
const run = (h, serverId, params, signal = new AbortController().signal) =>
  h['server.remove']({ job: { id: 99, serverId }, params, signal, progress: () => {} });
const count = (f, sql, ...args) => f.db.prepare(sql).get(...args).n;

test('removing a server and keeping its files leaves the folder and its backups', async (t) => {
  const f = fixture(t);
  const forgotten = [];
  const result = await run(handlers(f, { forgotten }), 1, { deleteFiles: false });
  assert.equal(result.deleteFiles, false);
  assert.equal(result.message, MESSAGES.removedKept.replace('{folder}', f.folder(1)));
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) n FROM installs WHERE id = 1'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) n FROM schedules WHERE server_id = 1'), 0);
  assert.ok(fs.existsSync(path.join(f.folder(1), 'ShooterGame', 'Saved', 'SavedArks', 'world.ark')));
  assert.ok(fs.existsSync(path.join(f.dataDir, 'backups', 'server-1', 'one', 'world.ark')));
  assert.equal(fs.existsSync(path.join(f.dataDir, 'settings-snapshots', 'server-1')), false);
  assert.deepEqual(forgotten, [1]);
  // The other server is untouched.
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 2'), 1);
  assert.equal(count(f, 'SELECT COUNT(*) n FROM schedules WHERE server_id = 2'), 1);
  assert.ok(fs.existsSync(f.folder(2)));
});

test('removing a server with its files deletes the folder, the backups and the snapshots', async (t) => {
  const f = fixture(t);
  const result = await run(handlers(f), 1, { deleteFiles: true });
  assert.equal(result.message, MESSAGES.removedDeleted);
  assert.equal(fs.existsSync(f.folder(1)), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'backups', 'server-1')), false);
  assert.equal(count(f, 'SELECT COUNT(*) n FROM backups WHERE server_id = 1'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) n FROM backups'), 1);
  assert.ok(fs.existsSync(f.folder(2)));
  assert.ok(fs.existsSync(path.join(f.dataDir, 'backups', 'server-2', 'one', 'world.ark')));
});

test('a folder that is already gone is not an error', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.folder(1), { recursive: true, force: true });
  await run(handlers(f), 1, { deleteFiles: true });
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 0);
});

test('a running server is not removed', async (t) => {
  const f = fixture(t);
  for (const state of ['running', 'starting', 'stopping', 'unknown'])
    await assert.rejects(run(handlers(f, { state }), 1, { deleteFiles: true }), { message: MESSAGES.removeRunning });
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 1);
  assert.ok(fs.existsSync(f.folder(1)));
});

test('a Steam library install is never deleted', async (t) => {
  const f = fixture(t);
  f.db.prepare("UPDATE installs SET source = 'steam-client' WHERE id = 1").run();
  await assert.rejects(run(handlers(f), 1, { deleteFiles: true }), { message: MESSAGES.removeSteam });
  assert.ok(fs.existsSync(f.folder(1)));
  await run(handlers(f), 1, { deleteFiles: false });
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 0);
  assert.ok(fs.existsSync(f.folder(1)));
});

test('a folder that holds another install, ARK Overseer data or the working folder is refused', async (t) => {
  const f = fixture(t);
  const nested = path.join(f.folder(1), 'nested');
  fs.mkdirSync(nested);
  f.db.prepare('UPDATE installs SET path = ? WHERE id = 2').run(nested);
  await assert.rejects(run(handlers(f), 1, { deleteFiles: true }), { message: MESSAGES.removeUnsafe });
  await assert.rejects(run(handlers(f), 2, { deleteFiles: true }), { message: MESSAGES.removeUnsafe });
  f.db.prepare('UPDATE installs SET path = ? WHERE id = 2').run(f.folder(2));
  f.db.prepare('UPDATE installs SET path = ? WHERE id = 1').run(f.root);
  await assert.rejects(run(handlers(f), 1, { deleteFiles: true }), { message: MESSAGES.removeUnsafe });
  assert.ok(fs.existsSync(f.dataDir));
  assert.ok(fs.existsSync(f.folder(1)));
});

test('a folder that is a link is refused', async (t) => {
  const f = fixture(t);
  const real = path.join(f.root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'keep.txt'), 'keep');
  fs.rmSync(f.folder(1), { recursive: true, force: true });
  try {
    fs.symlinkSync(real, f.folder(1), 'junction');
  } catch {
    return t.skip('links cannot be created here');
  }
  await assert.rejects(run(handlers(f), 1, { deleteFiles: true }), { message: MESSAGES.removeLink });
  assert.ok(fs.existsSync(path.join(real, 'keep.txt')));
});

test('a cancelled removal leaves the server listed', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const h = handlers(f);
  controller.abort(new Error('cancelled'));
  await assert.rejects(run(h, 1, { deleteFiles: true }, controller.signal), { message: 'cancelled' });
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 1);
});

test('a file that cannot be deleted fails the job and keeps the server', async (t) => {
  const f = fixture(t);
  const failing = {
    ...fs.promises,
    rm: async (target, ...rest) => {
      if (String(target).endsWith('server.bin')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.promises.rm(target, ...rest);
    },
  };
  const supervisor = { status: () => ({ observedState: 'stopped' }) };
  const drift = createDrift({
    db: f.db,
    dataDir: f.dataDir,
    supervisor,
    rcon: async () => {},
    getRconPassword: () => '',
    log: () => {},
  });
  const h = createRemovalHandlers({
    db: f.db,
    dataDir: f.dataDir,
    supervisor,
    drift,
    fsOps: failing,
    cwd: f.root + '-app',
  });
  await assert.rejects(run(h, 1, { deleteFiles: true }), {
    message: MESSAGES.removeFailed.replace('{folder}', f.folder(1)),
  });
  assert.equal(count(f, 'SELECT COUNT(*) n FROM servers WHERE id = 1'), 1);
});

test('the remove route validates, audits and queues one job at a time', async (t) => {
  const f = fixture(t);
  const publicDir = path.join(f.root, 'public');
  fs.mkdirSync(publicDir);
  let state = 'stopped';
  const jobs = createJobEngine({ db: f.db, handlers: { 'server.remove': async () => ({}) } });
  const app = createApp({
    db: f.db,
    dataDir: f.dataDir,
    publicDir,
    jobs,
    supervisor: { status: () => ({ observedState: state }) },
    steamcmd: { isInstalled: () => false },
    runner: async () => ({ code: 0 }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => false,
    rankFields: async () => [],
    log: () => {},
  });
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
  const del = (id, body, headers = { Cookie: cookie }) =>
    fetch(`${url}/api/servers/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await del(1, {}, {})).status, 401);
  assert.equal((await del(99, {})).status, 404);
  assert.equal((await del(1, { deleteFiles: 'yes' })).status, 400);
  state = 'running';
  const running = await del(1, {});
  assert.equal(running.status, 409);
  assert.equal((await running.json()).error, MESSAGES.removeRunning);
  state = 'stopped';
  f.db.prepare("UPDATE installs SET source = 'steam-client' WHERE id = 2").run();
  const steam = await del(2, { deleteFiles: true });
  assert.equal(steam.status, 409);
  assert.equal((await steam.json()).error, MESSAGES.removeSteam);
  const queued = await del(1, { deleteFiles: true });
  assert.equal(queued.status, 200);
  const job = await queued.json();
  assert.equal(job.kind, 'server.remove');
  assert.equal(job.jobId, job.id);
  assert.deepEqual(job.params, { deleteFiles: true });
  // A second request while the first is queued or running is refused.
  assert.equal((await del(1, {})).status, 409);
  const audit = f.db.prepare("SELECT * FROM audit_events WHERE action = 'server.remove'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].target_id, 1);
  assert.deepEqual(JSON.parse(audit[0].detail_json), { deleteFiles: true });
});
