import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { backupServer, pruneBackups, MESSAGES } from '../src/scheduler/backup.js';

const T = '2026-01-01T00:00:00.000Z';

function setup(t, { config = true, world = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'ASA');
  const saved = path.join(installPath, 'ShooterGame', 'Saved');
  if (world) {
    fs.mkdirSync(path.join(saved, 'SavedArks', 'TheIsland_WP', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(saved, 'SavedArks', 'TheIsland_WP', 'TheIsland_WP.ark'), 'world');
    fs.writeFileSync(path.join(saved, 'SavedArks', 'TheIsland_WP', 'nested', 'player.arkprofile'), 'player');
  }
  if (config) {
    fs.mkdirSync(path.join(saved, 'Config', 'WindowsServer'), { recursive: true });
    fs.writeFileSync(path.join(saved, 'Config', 'WindowsServer', 'Game.ini'), '[x]');
  }
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare('INSERT INTO installs (id, host_id, path, created_at, updated_at) VALUES (1, 1, ?, ?, ?)').run(
    installPath,
    T,
    T,
  );
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, rcon_port, created_at, updated_at) VALUES (1, 1, 1, 'One', 'TheIsland_WP', 's', 7777, 27020, ?, ?)",
  ).run(T, T);
  const server = { id: 1, map: 'TheIsland_WP', rcon_port: 27020, install_path: installPath };
  const commands = [];
  let clock = Date.parse(T);
  const run = (overrides = {}) =>
    backupServer({
      db,
      server,
      dataDir: path.join(root, 'data'),
      reason: 'manual',
      rcon: async ({ command }) => commands.push(command),
      getRconPassword: () => 'pw',
      isRunning: async () => false,
      now: () => clock,
      ...overrides,
    });
  return { db, root, run, commands, dataDir: path.join(root, 'data'), tick: (ms) => (clock += ms) };
}

test('a backup copies the world and the settings, hashed, and records a row', async (t) => {
  const { db, run, commands } = setup(t);
  const result = await run();
  assert.deepEqual(result.files.map((f) => f.relPath).sort(), [
    'Config/WindowsServer/Game.ini',
    'SavedArks/TheIsland_WP/TheIsland_WP.ark',
    'SavedArks/TheIsland_WP/nested/player.arkprofile',
  ]);
  assert.ok(result.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(
    fs.readFileSync(path.join(result.path, 'SavedArks', 'TheIsland_WP', 'TheIsland_WP.ark'), 'utf8'),
    'world',
  );
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(commands, []);
  const row = db.prepare('SELECT reason, path, size_bytes FROM backups').get();
  assert.equal(row.reason, 'manual');
  assert.equal(row.path, result.path);
  assert.equal(row.size_bytes, result.sizeBytes);
});

test('a missing settings folder is noted and the world is still backed up', async (t) => {
  const { run } = setup(t, { config: false });
  const result = await run();
  assert.deepEqual(result.skipped, [MESSAGES.missingConfig]);
  assert.equal(result.files.length, 2);
});

test('a backup with no files fails and records nothing', async (t) => {
  const { db, run } = setup(t, { config: false, world: false });
  await assert.rejects(run(), new RegExp(MESSAGES.emptyBackup));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0);
});

test('SaveWorld is sent only when the server is running, and a failed save is noted', async (t) => {
  const { run, commands } = setup(t);
  await run({ isRunning: async () => true });
  assert.deepEqual(commands, ['SaveWorld']);
  const failed = await run({
    isRunning: async () => true,
    rcon: async () => {
      throw new Error('refused');
    },
  });
  assert.deepEqual(failed.skipped, [MESSAGES.saveFailed]);
});

test('two backups in the same millisecond get separate folders', async (t) => {
  const { run } = setup(t);
  const first = await run();
  const second = await run();
  assert.notEqual(first.path, second.path);
  assert.ok(second.path.endsWith('-2'));
});

test('pruning keeps the newest scheduled and manual backups and never touches update backups', async (t) => {
  const { db, run, tick, dataDir } = setup(t);
  const made = [];
  for (const reason of ['pre_update', 'scheduled', 'manual', 'scheduled', 'pre_update', 'manual']) {
    made.push({ reason, ...(await run({ reason })) });
    tick(1000);
  }
  pruneBackups({ db, serverId: 1, keep: 2, dataDir });
  const left = db.prepare('SELECT reason, path FROM backups ORDER BY id').all();
  assert.deepEqual(
    left.map((r) => r.reason),
    ['pre_update', 'scheduled', 'pre_update', 'manual'],
  );
  for (const item of made)
    assert.equal(
      fs.existsSync(item.path),
      left.some((r) => r.path === item.path),
    );
});

test('pruning never deletes a folder outside the backup folder', async (t) => {
  const { db, root, dataDir } = setup(t);
  const outside = path.join(root, 'precious');
  fs.mkdirSync(outside);
  const insert = db.prepare(
    "INSERT INTO backups (created_at, server_id, reason, path, size_bytes, sha256) VALUES (?, 1, 'manual', ?, 1, 'x')",
  );
  insert.run('2026-01-01T00:00:00.000Z', outside);
  insert.run('2026-01-02T00:00:00.000Z', path.join(dataDir, 'backups'));
  insert.run('2026-01-03T00:00:00.000Z', path.join(dataDir, 'backups', 'server-1', 'newest'));
  pruneBackups({ db, serverId: 1, keep: 1, dataDir });
  assert.ok(fs.existsSync(outside));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 3);
});

test('a cancelled backup stops between files and leaves no folder or row behind', async (t) => {
  const { db, run, dataDir } = setup(t);
  await assert.rejects(run({ signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0);
  const serverDir = path.join(dataDir, 'backups', 'server-1');
  assert.deepEqual(fs.existsSync(serverDir) ? fs.readdirSync(serverDir) : [], []);
});
