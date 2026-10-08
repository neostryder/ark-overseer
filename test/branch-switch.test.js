import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { checkSwitch, clusterBranchProblem, createBranchHandlers, MESSAGES, savedMaps } from '../src/builds/branch.js';
import { listInstallBuilds } from '../src/builds/history.js';
import { MESSAGES as IMPORT_MESSAGES } from '../src/import/phase0.js';

const T = '2026-01-01T00:00:00.000Z';

function setup(t, { mods = ['111', '222'], failInstall = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'install');
  const saves = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks');
  for (const map of ['TheIsland_WP', 'Ragnarok_WP']) {
    fs.mkdirSync(path.join(saves, map), { recursive: true });
    fs.writeFileSync(path.join(saves, map, `${map}.ark`), map);
  }
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, build_id, created_at, updated_at) VALUES (1, 1, ?, 'installed', '100', ?, ?)",
  ).run(installPath, T, T);
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, settings_json, created_at, updated_at) VALUES (1, 1, 1, 'One', 'TheIsland_WP', 's', 7777, ?, ?, ?)",
  ).run(JSON.stringify({ mods, other: 1 }), T, T);
  db.prepare(
    "INSERT INTO steam_builds (branch, build_id, manifest_id, first_seen_at, changed_at, checked_at) VALUES ('public_test_realm', '200', 'm200', ?, ?, ?)",
  ).run(T, T, T);
  const manifest = { buildId: '200', fullyInstalled: true };
  const calls = [];
  const steamcmd = {
    appUpdate: async (args) => {
      calls.push(args);
      if (failInstall) throw new Error('disk full');
      return { output: 'ok' };
    },
    readManifest: () => manifest,
  };
  const handlers = createBranchHandlers({
    db,
    dataDir: path.join(root, 'data'),
    steamcmd,
    rcon: async () => {},
    getRconPassword: () => '',
  });
  const ctx = (params) => ({
    job: { id: null, installId: 1 },
    params,
    signal: new AbortController().signal,
    progress() {},
  });
  const run = (params) => handlers['install.switch_branch'](ctx(params));
  const install = () => db.prepare('SELECT * FROM installs WHERE id = 1').get();
  const settings = () => JSON.parse(db.prepare('SELECT settings_json FROM servers WHERE id = 1').get().settings_json);
  return { db, run, calls, install, settings, installPath, manifest };
}

test('a switch to the test branch backs up every map, installs it, and suspends mods', async (t) => {
  const f = setup(t);
  const result = await f.run({ branch: 'public_test_realm', acknowledged: true });
  assert.equal(result.branch, 'public_test_realm');
  assert.equal(result.from, 'public');
  assert.equal(f.install().branch, 'public_test_realm');
  assert.equal(f.calls[0].branch, 'public_test_realm');
  assert.equal(f.calls[0].validate, true);
  const backups = f.db.prepare('SELECT reason, map FROM backups ORDER BY id').all();
  assert.deepEqual(backups.map((row) => [row.reason, row.map]).sort(), [
    ['pre_update', 'Ragnarok_WP'],
    ['pre_update', 'TheIsland_WP'],
  ]);
  assert.deepEqual(f.settings(), { other: 1, suspendedMods: ['111', '222'] });
  const [latest] = listInstallBuilds(f.db, 1);
  assert.deepEqual(
    [latest.branch, latest.build_id, latest.manifest_id, latest.reason],
    ['public_test_realm', '200', 'm200', 'branch_switch'],
  );
});

test('keepMods leaves the mod list alone on a test branch', async (t) => {
  const f = setup(t);
  await f.run({ branch: 'public_test_realm', acknowledged: true, keepMods: true });
  assert.deepEqual(f.settings(), { mods: ['111', '222'], other: 1 });
});

test('going back to the live game restores the suspended mods', async (t) => {
  const f = setup(t);
  await f.run({ branch: 'public_test_realm', acknowledged: true });
  f.db.prepare("UPDATE steam_builds SET branch = branch WHERE branch = 'public_test_realm'").run();
  await f.run({ branch: 'public' });
  assert.equal(f.install().branch, 'public');
  assert.deepEqual(f.settings(), { other: 1, mods: ['111', '222'] });
});

test('a failed install puts the old branch back and keeps the mods', async (t) => {
  const f = setup(t, { failInstall: true });
  await assert.rejects(
    f.run({ branch: 'public_test_realm', acknowledged: true }),
    /did not finish.*stays on the live game|stays on/,
  );
  assert.equal(f.install().branch, 'public');
  assert.deepEqual(f.settings(), { mods: ['111', '222'], other: 1 });
  // The backups were already taken and stay.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 2);
});

test('a switch is refused before anything changes when it should not happen', (t) => {
  const f = setup(t);
  const refuse = (params, message) =>
    assert.throws(
      () => checkSwitch(f.db, 1, params),
      (error) => error.message === message,
    );
  refuse({ branch: 'public_test_realm' }, MESSAGES.needsAck);
  refuse({ branch: 'public', acknowledged: true }, MESSAGES.sameBranch);
  refuse({ branch: 'no spaces allowed' }, MESSAGES.badBranch);
  refuse({}, MESSAGES.badBranch);
  refuse({ branch: 'unlisted', acknowledged: true }, MESSAGES.unknownBranch);
  f.db.prepare("UPDATE servers SET observed_state = 'running'").run();
  refuse({ branch: 'public_test_realm', acknowledged: true }, MESSAGES.running);
  f.db.prepare("UPDATE servers SET observed_state = 'stopped'").run();
  f.db.prepare("UPDATE installs SET source = 'steam-client'").run();
  refuse({ branch: 'public_test_realm', acknowledged: true }, IMPORT_MESSAGES.steamClientInstall);
  assert.throws(() => checkSwitch(f.db, 9, { branch: 'public' }), { status: 404 });
});

test('a server in a cluster cannot move to the test branch without the override', async (t) => {
  const f = setup(t);
  f.db
    .prepare("INSERT INTO clusters (id, name, cluster_key, created_at, updated_at) VALUES (1, 'c', 'k', ?, ?)")
    .run(T, T);
  f.db.prepare('UPDATE servers SET cluster_id = 1').run();
  const params = { branch: 'public_test_realm', acknowledged: true };
  assert.throws(
    () => checkSwitch(f.db, 1, params),
    (error) => error.message === MESSAGES.inCluster,
  );
  await f.run({ ...params, allowCluster: true });
  assert.equal(f.install().branch, 'public_test_realm');
  // With every cluster member on this install, going back to live leaves the cluster all live.
  assert.equal(checkSwitch(f.db, 1, { branch: 'public' }).branch, 'public');
  // A member on another install that stays on test would make the cluster mixed.
  f.db
    .prepare(
      "INSERT INTO installs (id, host_id, path, state, branch, created_at, updated_at) VALUES (2, 1, 'x', 'installed', 'public_test_realm', ?, ?)",
    )
    .run(T, T);
  f.db
    .prepare(
      "INSERT INTO servers (id, host_id, install_id, cluster_id, name, map, session_name, game_port, created_at, updated_at) VALUES (2, 1, 2, 1, 'Two', 'Ragnarok_WP', 's', 7778, ?, ?)",
    )
    .run(T, T);
  assert.throws(
    () => checkSwitch(f.db, 1, { branch: 'public' }),
    (error) => error.message === MESSAGES.clusterMix,
  );
});

test('a cluster cannot mix live and test servers', (t) => {
  const f = setup(t);
  f.db
    .prepare("INSERT INTO clusters (id, name, cluster_key, created_at, updated_at) VALUES (1, 'c', 'k', ?, ?)")
    .run(T, T);
  f.db.prepare('UPDATE servers SET cluster_id = 1').run();
  assert.equal(clusterBranchProblem(f.db, 1, 'public'), null);
  assert.equal(clusterBranchProblem(f.db, 1, 'public_test_realm'), MESSAGES.clusterMix);
  // Leaving out the install that holds the only member leaves nothing to clash with.
  assert.equal(clusterBranchProblem(f.db, 1, 'public_test_realm', 1), null);
  assert.equal(clusterBranchProblem(f.db, 99, 'public_test_realm'), null);
});

test('savedMaps lists the folders under SavedArks and nothing for a missing install', (t) => {
  const f = setup(t);
  assert.deepEqual(savedMaps(f.installPath).sort(), ['Ragnarok_WP', 'TheIsland_WP']);
  assert.deepEqual(savedMaps(path.join(f.installPath, 'nope')), []);
});
