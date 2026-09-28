import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/index.js';
import { detectPhase0, previewImport, applyImport, snapshotFiles, MESSAGES } from '../src/import/phase0.js';
import { serverPaths, buildLaunch } from '../src/supervisor/launch.js';
import { createSettingsStore } from '../src/settings/store.js';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const MAP = 'Astraeos_WP';

// A Phase 0 dashboard folder and a server install shaped like a Steam library, built from the real
// Neo Olympus INI files (passwords replaced).
function fixture(t, { profile: overrides = {}, profileSettings, topSettings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  const library = path.join(root, 'SteamLibrary', 'steamapps');
  const install = path.join(library, 'common', 'ARK Survival Ascended Dedicated Server');
  const profile = {
    id: 'neo-olympus',
    name: 'Neo Olympus',
    map: MAP,
    serverRoot: install,
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    rconHost: '127.0.0.1',
    ...overrides,
  };
  fs.mkdirSync(path.join(dashboard, 'profile-data', 'neo-olympus'), { recursive: true });
  fs.writeFileSync(path.join(dashboard, 'profiles.json'), JSON.stringify([profile], null, 2));
  if (profileSettings !== null)
    fs.writeFileSync(
      path.join(dashboard, 'profile-data', 'neo-olympus', 'dashboard-settings.json'),
      JSON.stringify(profileSettings ?? { maxPlayers: 10, mods: [], disableBattlEye: true }),
    );
  if (topSettings) fs.writeFileSync(path.join(dashboard, 'dashboard-settings.json'), JSON.stringify(topSettings));
  const paths = serverPaths(install);
  fs.mkdirSync(paths.exeDir, { recursive: true });
  fs.writeFileSync(paths.exePath, '');
  fs.mkdirSync(paths.configDir, { recursive: true });
  for (const file of ['GameUserSettings.ini', 'Game.ini'])
    fs.copyFileSync(new URL(`./fixtures/neo-olympus/${file}`, import.meta.url), path.join(paths.configDir, file));
  const saveDir = path.join(install, 'ShooterGame', 'Saved', 'SavedArks', MAP);
  fs.mkdirSync(saveDir, { recursive: true });
  for (const file of [
    `${MAP}.ark`,
    'a1.arkprofile',
    'b2.arkprofile',
    'a1.profilebak',
    '1234.arktribe',
    `${MAP}_23.09.2026_04.18.32.ark`,
    `${MAP}_22.09.2026_07.34.37.ark`,
    `${MAP}.ark.before-rollback-2026-09-23`,
  ])
    fs.writeFileSync(path.join(saveDir, file), `contents of ${file}`);
  fs.writeFileSync(
    path.join(library, 'appmanifest_2430930.acf'),
    '"AppState"\n{\n\t"appid"\t\t"2430930"\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"25535041"\n}\n',
  );
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { root, dashboard, install, profile, paths, saveDir, db, snapshots: path.join(root, 'data', 'snapshots') };
}

function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? allFiles(full) : [full];
  });
}
const treeHashes = (...dirs) => new Map(dirs.flatMap(allFiles).map((file) => [file, sha(file)]));
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

function addServer(db, { name = 'Other', game = 7779, query = 27016, rcon = 27021 } = {}) {
  const now = new Date().toISOString();
  let host = db.prepare("SELECT id FROM hosts WHERE name = 'local'").get();
  if (!host)
    host = {
      id: db.prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'local')").run(now, now)
        .lastInsertRowid,
    };
  const install = db
    .prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, ?, ?)')
    .run(now, now, host.id, `C:\\Other\\${name}`).lastInsertRowid;
  db.prepare(
    `INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port, query_port, rcon_port)
     VALUES (?, ?, ?, ?, ?, 'TheIsland', ?, ?, ?, ?)`,
  ).run(now, now, host.id, install, name, name, game, query, rcon);
  return Number(host.id);
}

test('detection reads the profile, ports, session name, settings, build and Steam client source', async (t) => {
  const f = fixture(t, { profileSettings: { maxPlayers: 10, mods: ['928102'], disableBattlEye: true } });
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual(
    {
      profileId: server.profileId,
      name: server.name,
      map: server.map,
      installPath: server.installPath,
      installSource: server.installSource,
      exeExists: server.exeExists,
      buildId: server.buildId,
      ports: [server.gamePort, server.queryPort, server.rconPort],
      sessionName: server.sessionName,
      maxPlayers: server.maxPlayers,
      mods: server.mods,
      disableBattlEye: server.disableBattlEye,
      problems: server.problems,
    },
    {
      profileId: 'neo-olympus',
      name: 'Neo Olympus',
      map: MAP,
      installPath: f.install,
      installSource: 'steam-client',
      exeExists: true,
      buildId: '25535041',
      ports: [7777, 27015, 27020],
      sessionName: 'Neo Olympus',
      maxPlayers: 10,
      mods: ['928102'],
      disableBattlEye: true,
      problems: [],
    },
  );
});

test('the session name comes from the INI, not the profile name', async (t) => {
  const f = fixture(t, { profile: { name: 'Profile Name' } });
  assert.equal((await detectPhase0(f.dashboard)).servers[0].sessionName, 'Neo Olympus');
});

test('an install outside a Steam library is a SteamCMD install', async (t) => {
  const f = fixture(t);
  const moved = path.join(f.root, 'ASA');
  fs.renameSync(f.install, moved);
  fs.writeFileSync(path.join(f.dashboard, 'profiles.json'), JSON.stringify([{ ...f.profile, serverRoot: moved }]));
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.equal(server.installSource, 'steamcmd');
  assert.equal(server.buildId, null);
});

test('the top-level settings file is used only when the per-profile one is missing', async (t) => {
  const top = { maxPlayers: 20, mods: ['1'], disableBattlEye: true };
  const f = fixture(t, { profileSettings: null, topSettings: top });
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual([server.maxPlayers, server.mods, server.disableBattlEye], [20, ['1'], true]);
  // Positive control: with a per-profile file present, nothing is taken from the top-level one.
  const g = fixture(t, { profileSettings: { maxPlayers: 12 }, topSettings: top });
  const [other] = (await detectPhase0(g.dashboard)).servers;
  assert.deepEqual([other.maxPlayers, other.mods, other.disableBattlEye], [12, [], false]);
});

test('the defaults apply when there is no settings file at all', async (t) => {
  const f = fixture(t, { profileSettings: null });
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual([server.maxPlayers, server.mods, server.disableBattlEye], [70, [], false]);
});

test('password flags are set for the real INI and clear when the keys are empty or missing', async (t) => {
  const f = fixture(t);
  const [set] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual([set.hasServerPassword, set.hasAdminPassword], [true, true]);
  const text = fs.readFileSync(f.paths.gameUserSettingsPath, 'latin1');
  fs.writeFileSync(
    f.paths.gameUserSettingsPath,
    text.replace(/^ServerPassword=.*$/m, 'ServerPassword=').replace(/^ServerAdminPassword=.*\r?\n/m, ''),
    'latin1',
  );
  const [clear] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual([clear.hasServerPassword, clear.hasAdminPassword], [false, false]);
});

test('no detection, preview, import result, audit row or snapshot manifest holds a password', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  const preview = previewImport(f.db, detection);
  const result = await applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots });
  const audit = f.db.prepare('SELECT detail_json FROM audit_events').get().detail_json;
  const manifest = fs.readFileSync(path.join(result.snapshotPath, 'snapshot.json'), 'utf8');
  for (const text of [JSON.stringify(detection), JSON.stringify(preview), JSON.stringify(result), audit, manifest])
    assert.doesNotMatch(text, /fixture-password/);
});

test('files hold the config files and exactly the live world, player and tribe files', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.paths.configDir, 'Engine.ini'), '[Core.System]\r\n');
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual(server.files.map((file) => `${file.role} ${file.relPath}`).sort(), [
    'config Config/WindowsServer/Engine.ini',
    'config Config/WindowsServer/Game.ini',
    'config Config/WindowsServer/GameUserSettings.ini',
    `save SavedArks/${MAP}/1234.arktribe`,
    `save SavedArks/${MAP}/${MAP}.ark`,
    `save SavedArks/${MAP}/a1.arkprofile`,
    `save SavedArks/${MAP}/a1.profilebak`,
    `save SavedArks/${MAP}/b2.arkprofile`,
  ]);
  for (const file of server.files) {
    assert.equal(file.sha256, sha(file.path));
    assert.equal(file.size, fs.statSync(file.path).size);
  }
});

test('an invalid profile is reported and nothing is read for it', async (t) => {
  for (const bad of [
    { map: 'Astraeos WP' },
    { gamePort: 65535 },
    { queryPort: 80 },
    { rconPort: '27020' },
    { name: ' ' },
    { id: '..\\..\\x' },
    { serverRoot: 'relative\\path' },
  ]) {
    const f = fixture(t, { profile: bad });
    const [server] = (await detectPhase0(f.dashboard)).servers;
    assert.deepEqual(server.problems, [{ code: 'profile', message: MESSAGES.badProfile }], JSON.stringify(bad));
    assert.deepEqual(server.files, [], JSON.stringify(bad));
  }
});

test('settings the launch line cannot use are reported as a bad profile', async (t) => {
  for (const settings of [{ maxPlayers: 'ten' }, { maxPlayers: 0 }, { mods: ['abc'] }, { mods: '123' }]) {
    const f = fixture(t, { profileSettings: settings });
    const [server] = (await detectPhase0(f.dashboard)).servers;
    assert.deepEqual(
      server.problems.map((p) => p.code),
      ['profile'],
      JSON.stringify(settings),
    );
  }
});

test('a missing exe and a missing GameUserSettings.ini are reported', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.paths.exePath);
  fs.rmSync(f.paths.gameUserSettingsPath);
  const [server] = (await detectPhase0(f.dashboard)).servers;
  assert.deepEqual(server.problems, [
    { code: 'exe', message: MESSAGES.noExe },
    { code: 'config', message: MESSAGES.noConfig },
  ]);
  assert.equal(server.sessionName, 'Neo Olympus');
});

test('a missing profiles.json rejects', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.dashboard, 'profiles.json'));
  await assert.rejects(detectPhase0(f.dashboard), { message: MESSAGES.noProfiles });
});

test('the preview on an empty database is importable with new host and install rows', async (t) => {
  const f = fixture(t);
  const [item] = previewImport(f.db, await detectPhase0(f.dashboard)).servers;
  assert.equal(item.ok, true);
  assert.deepEqual(item.host, { id: null, name: 'local' });
  assert.deepEqual(item.install, {
    id: null,
    path: f.install,
    source: 'steam-client',
    buildId: '25535041',
    state: 'installed',
  });
  assert.deepEqual(item.server, {
    name: 'Neo Olympus',
    map: MAP,
    session_name: 'Neo Olympus',
    game_port: 7777,
    query_port: 27015,
    rcon_port: 27020,
    max_players: 10,
    settings: { mods: [], disableBattlEye: true },
  });
  assert.deepEqual(item.conflicts, []);
  assert.deepEqual(item.warnings, [{ code: 'steamClient', message: MESSAGES.steamClient }]);
});

test('the preview warns about a missing world and missing passwords', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.saveDir, `${MAP}.ark`));
  const text = fs.readFileSync(f.paths.gameUserSettingsPath, 'latin1');
  fs.writeFileSync(f.paths.gameUserSettingsPath, text.replace(/^Server(Admin)?Password=.*\r?\n/gm, ''), 'latin1');
  const [item] = previewImport(f.db, await detectPhase0(f.dashboard)).servers;
  assert.deepEqual(
    item.warnings.map((w) => w.code),
    ['steamClient', 'noAdminPassword', 'noWorld', 'noServerPassword'],
  );
  assert.equal(item.ok, true);
});

test('the preview finds an existing host and install, comparing the path without regard to case', async (t) => {
  const f = fixture(t);
  const hostId = addServer(f.db);
  const now = new Date().toISOString();
  const installId = Number(
    f.db
      .prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, ?, ?)')
      .run(now, now, hostId, f.install.toUpperCase().replaceAll('\\', '/')).lastInsertRowid,
  );
  const [item] = previewImport(f.db, await detectPhase0(f.dashboard)).servers;
  assert.deepEqual([item.host.id, item.install.id], [hostId, installId]);
  assert.equal(item.ok, true);
});

test('the preview reports a port conflict, a taken name and an already imported server', async (t) => {
  const f = fixture(t);
  addServer(f.db, { name: 'Clash', game: 7778, query: 27100, rcon: 27101 });
  const [clash] = previewImport(f.db, await detectPhase0(f.dashboard)).servers;
  assert.deepEqual(clash.conflicts, [{ code: 'port', message: 'UDP 7778 (peer): used by Clash as its game port' }]);
  assert.equal(clash.ok, false);

  const g = fixture(t);
  await applyImport(g.db, await detectPhase0(g.dashboard), 'neo-olympus', { snapshotRoot: g.snapshots });
  const [again] = previewImport(g.db, await detectPhase0(g.dashboard)).servers;
  assert.deepEqual(
    again.conflicts.map((c) => c.code),
    ['port', 'port', 'port', 'port', 'name', 'imported'],
  );
  assert.equal(again.conflicts.at(-2).message, MESSAGES.nameTaken);
  assert.equal(again.conflicts.at(-1).message, MESSAGES.alreadyImported);
});

test('an install that already runs another server is refused by the preview and by the apply', async (t) => {
  const f = fixture(t);
  const hostId = addServer(f.db);
  const now = new Date().toISOString();
  const installId = Number(
    f.db
      .prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, ?, ?)')
      .run(now, now, hostId, f.install).lastInsertRowid,
  );
  f.db
    .prepare(
      `INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port)
       VALUES (?, ?, ?, ?, 'Holder $1', 'TheIsland', 'Holder', 7801)`,
    )
    .run(now, now, hostId, installId);
  const detection = await detectPhase0(f.dashboard);
  const [item] = previewImport(f.db, detection).servers;
  assert.deepEqual(
    item.conflicts.map((c) => c.code),
    ['install'],
  );
  assert.equal(item.conflicts[0].message, 'This install already runs Holder $1. Each server needs its own install.');
  assert.equal(item.ok, false);
  const before = count(f.db, 'servers');
  await assert.rejects(
    applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots }),
    (error) => error.conflicts?.[0].code === 'install',
  );
  assert.equal(count(f.db, 'servers'), before);
});

test('applyImport creates the host, install, stopped server, pre_import backup and audit rows', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  const result = await applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots });
  const host = f.db.prepare('SELECT * FROM hosts WHERE id = ?').get(result.hostId);
  const install = f.db.prepare('SELECT * FROM installs WHERE id = ?').get(result.installId);
  const server = f.db.prepare('SELECT * FROM servers WHERE id = ?').get(result.serverId);
  const backup = f.db.prepare('SELECT * FROM backups WHERE id = ?').get(result.backupId);
  const audit = f.db.prepare('SELECT * FROM audit_events').get();
  assert.deepEqual([host.name, host.kind], ['local', 'local']);
  assert.deepEqual(
    [install.path, install.source, install.build_id, install.state],
    [f.install, 'steam-client', '25535041', 'installed'],
  );
  assert.deepEqual(
    {
      name: server.name,
      map: server.map,
      session: server.session_name,
      ports: [server.game_port, server.query_port, server.rcon_port],
      max: server.max_players,
      desired: server.desired_state,
      observed: server.observed_state,
      settings: JSON.parse(server.settings_json),
    },
    {
      name: 'Neo Olympus',
      map: MAP,
      session: 'Neo Olympus',
      ports: [7777, 27015, 27020],
      max: 10,
      desired: 'stopped',
      observed: 'stopped',
      settings: { mods: [], disableBattlEye: true },
    },
  );
  assert.deepEqual(
    [backup.server_id, backup.reason, backup.path],
    [result.serverId, 'pre_import', result.snapshotPath],
  );
  assert.deepEqual(
    [audit.actor, audit.action, audit.target_kind, audit.target_id],
    ['system', 'server.import', 'server', result.serverId],
  );
  assert.deepEqual(JSON.parse(audit.detail_json), {
    profileId: 'neo-olympus',
    dashboardDir: f.dashboard,
    snapshotPath: result.snapshotPath,
  });
  assert.match(path.basename(result.snapshotPath), /^neo-olympus-\d{8}-\d{6}$/);
});

test('the snapshot holds exactly the listed files, and the backup row describes it', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  const result = await applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots });
  const files = detection.servers[0].files;
  const copies = allFiles(result.snapshotPath).map((file) =>
    path.relative(result.snapshotPath, file).replaceAll('\\', '/'),
  );
  assert.deepEqual(copies.sort(), [...files.map((file) => file.relPath), 'snapshot.json'].sort());
  for (const file of files) assert.equal(sha(path.join(result.snapshotPath, file.relPath)), file.sha256);
  const manifestPath = path.join(result.snapshotPath, 'snapshot.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(
    manifest.files,
    files.map(({ relPath, size, sha256 }) => ({ relPath, size, sha256 })),
  );
  const backup = f.db.prepare('SELECT * FROM backups').get();
  assert.equal(backup.sha256, sha(manifestPath));
  const total = allFiles(result.snapshotPath).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  assert.equal(backup.size_bytes, total);
});

test('the import writes nothing to the Phase 0 folder or the server install', async (t) => {
  const f = fixture(t);
  const before = treeHashes(f.dashboard, path.dirname(path.dirname(f.install)));
  const detection = await detectPhase0(f.dashboard);
  previewImport(f.db, detection);
  await applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots });
  assert.deepEqual(treeHashes(f.dashboard, path.dirname(path.dirname(f.install))), before);
});

test('a settings file changed after detection stops the import before any copy or row', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  fs.appendFileSync(f.paths.gameIniPath, 'Changed=True\r\n');
  await assert.rejects(applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots }), {
    code: 'CHANGED_SINCE_PREVIEW',
    message: MESSAGES.changedSincePreview,
  });
  assert.equal(fs.existsSync(f.snapshots), false);
  assert.deepEqual([count(f.db, 'hosts'), count(f.db, 'servers'), count(f.db, 'backups')], [0, 0, 0]);
});

test('a deleted settings file after detection also stops the import', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  fs.rmSync(f.paths.gameIniPath);
  await assert.rejects(applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots }), {
    code: 'CHANGED_SINCE_PREVIEW',
  });
});

test('a save file changed after detection does not stop the import, and the snapshot has the new copy', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  const world = path.join(f.saveDir, `${MAP}.ark`);
  fs.writeFileSync(world, 'saved again');
  const result = await applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots });
  assert.equal(fs.readFileSync(path.join(result.snapshotPath, 'SavedArks', MAP, `${MAP}.ark`), 'utf8'), 'saved again');
});

test('a conflict that appears after the preview leaves no rows and removes the snapshot', async (t) => {
  const f = fixture(t);
  const detection = await detectPhase0(f.dashboard);
  assert.equal(previewImport(f.db, detection).servers[0].ok, true);
  addServer(f.db, { name: 'Late', game: 7777 });
  const servers = count(f.db, 'servers');
  await assert.rejects(applyImport(f.db, detection, 'neo-olympus', { snapshotRoot: f.snapshots }), (error) => {
    assert.ok(error.conflicts.some((c) => c.message === 'UDP 7777 (game): used by Late as its game port'));
    return true;
  });
  assert.equal(count(f.db, 'servers'), servers);
  assert.equal(count(f.db, 'backups'), 0);
  assert.deepEqual(fs.readdirSync(f.snapshots), []);
});

test('a profile with problems is not imported', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.paths.exePath);
  await assert.rejects(
    applyImport(f.db, await detectPhase0(f.dashboard), 'neo-olympus', { snapshotRoot: f.snapshots }),
    { message: MESSAGES.noExe },
  );
  assert.equal(fs.existsSync(f.snapshots), false);
});

test('snapshotFiles copies a file again when the source changes during the copy', async (t) => {
  const f = fixture(t);
  const source = path.join(f.root, 'world.ark');
  fs.writeFileSync(source, 'version 1');
  let calls = 0;
  // The first copy is followed by a save, so the source no longer matches what was copied.
  const copy = async (from, to) => {
    fs.copyFileSync(from, to);
    const written = { size: fs.statSync(to).size, sha256: sha(to) };
    if (++calls === 1) fs.writeFileSync(from, 'version 2');
    return written;
  };
  const dest = path.join(f.root, 'snap');
  const result = await snapshotFiles([{ relPath: 'SavedArks/world.ark', path: source }], dest, { copy });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'SavedArks', 'world.ark'), 'utf8'), 'version 2');
  assert.equal(result.files[0].sha256, sha(source));
});

test('snapshotFiles gives up after three changed copies and removes the folder', async (t) => {
  const f = fixture(t);
  const source = path.join(f.root, 'world.ark');
  fs.writeFileSync(source, 'v0');
  let calls = 0;
  const copy = async (from, to) => {
    fs.copyFileSync(from, to);
    const written = { size: 2, sha256: sha(to) };
    fs.writeFileSync(from, `v${++calls}`);
    return written;
  };
  const dest = path.join(f.root, 'snap');
  await assert.rejects(
    snapshotFiles([{ relPath: 'world.ark', path: source }], dest, { copy }),
    /world\.ark kept changing/,
  );
  assert.equal(calls, 3);
  assert.equal(fs.existsSync(dest), false);
});

test('snapshotFiles refuses a folder that already exists and leaves it alone', async (t) => {
  const f = fixture(t);
  const dest = path.join(f.root, 'snap');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'keep');
  await assert.rejects(snapshotFiles([], dest), /already exists/);
  assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'keep');
});

test('a settings write after import keeps unknown keys and comments byte for byte', async (t) => {
  const f = fixture(t);
  await applyImport(f.db, await detectPhase0(f.dashboard), 'neo-olympus', { snapshotRoot: f.snapshots });
  const before = fs.readFileSync(f.paths.gameUserSettingsPath, 'latin1').split('\r\n');
  const store = createSettingsStore({
    gameUserSettingsPath: f.paths.gameUserSettingsPath,
    gameIniPath: f.paths.gameIniPath,
  });
  store.writeSettings({ XPMultiplier: 3.5 });
  const after = fs.readFileSync(f.paths.gameUserSettingsPath, 'latin1').split('\r\n');
  const changed = after.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null);
  assert.equal(after.length, before.length);
  assert.equal(changed.length, 1);
  assert.match(after[changed[0]], /^XPMultiplier=3\.5$/);
});

test('buildLaunch for the imported server gives the Phase 0 launch arguments', async (t) => {
  const f = fixture(t);
  const result = await applyImport(f.db, await detectPhase0(f.dashboard), 'neo-olympus', { snapshotRoot: f.snapshots });
  const server = f.db.prepare('SELECT * FROM servers WHERE id = ?').get(result.serverId);
  const install = f.db.prepare('SELECT * FROM installs WHERE id = ?').get(result.installId);
  assert.deepEqual(buildLaunch(server, install).args, [
    `${MAP}?listen?SessionName=Neo Olympus`,
    '-port=7777',
    '-QueryPort=27015',
    '-WinLiveMaxPlayers=10',
    '-log',
    '-NoBattlEye',
  ]);
});

test('the preview tool reports the server and whether each password is set, without the values', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('../tools/import-preview.js', import.meta.url));
  const run = spawnSync(process.execPath, [script, f.dashboard], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Neo Olympus/);
  assert.match(run.stdout, /Server password: yes \| Admin password: yes/);
  assert.match(run.stdout, /steamClient: /);
  assert.doesNotMatch(run.stdout + run.stderr, /fixture-password/);
  // Positive control: a server with a problem makes the tool exit 1.
  fs.rmSync(f.paths.exePath);
  const failing = spawnSync(process.execPath, [script, f.dashboard], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, new RegExp(`exe: ${MESSAGES.noExe}`));
});

test('an existing install recorded with a trailing backslash is the same install', async (t) => {
  const f = fixture(t);
  const hostId = addServer(f.db);
  const now = new Date().toISOString();
  const installId = Number(
    f.db
      .prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, ?, ?)')
      .run(now, now, hostId, `${f.install}\\`).lastInsertRowid,
  );
  const [item] = previewImport(f.db, await detectPhase0(f.dashboard)).servers;
  assert.equal(item.install.id, installId);
});

test('a live world file spelled in another case is still found and snapshotted', async (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.saveDir, `${MAP}.ark`), path.join(f.saveDir, `${MAP.toLowerCase()}.ARK`));
  const detection = await detectPhase0(f.dashboard);
  const [item] = previewImport(f.db, detection).servers;
  assert.ok(item.files.some((file) => file.relPath === `SavedArks/${MAP}/${MAP.toLowerCase()}.ARK`));
  assert.ok(!item.warnings.some((w) => w.code === 'noWorld'));
});
