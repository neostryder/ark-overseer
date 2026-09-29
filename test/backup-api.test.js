import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createApp, API_MESSAGES } from '../src/app.js';
import { API_MESSAGES as BACKUP_MESSAGES } from '../src/backups/api.js';
import { checkRestore, RestoreError } from '../src/backups/restore.js';
import { backupServer } from '../src/scheduler/backup.js';
import { restoreLayout } from '../src/backups/restore.js';
import { writeTree } from './helpers/restore-world.js';

const json = (value, cookie, method = 'POST', extra = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
  body: JSON.stringify(value),
});

// A signed-in app with a queue that never runs, a stand-in supervisor, and one server whose install has a
// world, player files and settings on disk.
async function fixture(t, { state = 'stopped' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-backup-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  const kinds = ['install.install', 'server.backup', 'server.switch_map', 'server.restore', 'server.settings_restore'];
  const jobs = createJobEngine({ db, handlers: Object.fromEntries(kinds.map((kind) => [kind, async () => ({})])) });
  const calls = [];
  const supervisor = {
    status: () => ({ observedState: state }),
    start: async (id) => (calls.push(['start', id]), { id }),
    stop: async (id) => (calls.push(['stop', id]), { id }),
    restart: async (id) => (calls.push(['restart', id]), { id }),
  };
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'index.html'), 'app');
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
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
    db.close();
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const signIn = await fetch(`${url}/api/auth/setup`, json({ password: 'correct horse battery' }));
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  const installPath = path.join(root, 'ASA');
  const install = await (await fetch(`${url}/api/installs`, json({ path: installPath }, cookie))).json();
  const created = await fetch(
    `${url}/api/servers`,
    json(
      {
        name: 'Main',
        map: 'TheIsland_WP',
        sessionName: 'Main',
        installId: install.id,
        gamePort: 7777,
        queryPort: 27777,
        rconPort: 27782,
        maxPlayers: 70,
      },
      cookie,
    ),
  );
  assert.equal(created.status, 200);
  const server = await created.json();
  const layout = restoreLayout(installPath);
  for (const map of ['TheIsland_WP', 'Ragnarok_WP'])
    writeTree(path.join(layout.savedArks, map), {
      [`${map}.ark`]: `world ${map}`,
      '0001.arkprofile': 'profile one',
      '1001.arktribe': 'tribe one',
    });
  writeTree(layout.configDir, {
    'GameUserSettings.ini': '[ServerSettings]\r\nDifficulty=1\r\n',
    'Game.ini': '[x]\r\nk=1\r\n',
  });
  db.prepare("UPDATE jobs SET state = 'succeeded'").run();
  const dataDir = path.join(root, 'data');
  const backup = async ({ reason = 'manual', map = 'TheIsland_WP', ...rest } = {}) => {
    const made = await backupServer({
      db,
      server: { id: server.id, map: server.map, rcon_port: 27782, install_path: installPath },
      dataDir,
      reason,
      rcon: async () => {},
      getRconPassword: () => 'pw',
      isRunning: async () => false,
      map,
      ...rest,
    });
    return db.prepare('SELECT * FROM backups WHERE id = ?').get(made.backupId);
  };
  const request = (route, options = {}) => fetch(`${url}${route}`, { headers: { Cookie: cookie }, ...options });
  const send = (method, route, body, extra) => fetch(`${url}${route}`, json(body ?? {}, cookie, method, extra));
  const jobRows = (kind) =>
    db
      .prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY id')
      .all(kind)
      .map((row) => ({ ...row }));
  const audits = (like) =>
    db
      .prepare('SELECT action, target_kind, target_id, detail_json FROM audit_events WHERE action LIKE ? ORDER BY id')
      .all(like)
      .map((row) => ({ ...row, detail: JSON.parse(row.detail_json) }));
  return { root, dataDir, url, cookie, db, server, installPath, layout, calls, backup, request, send, jobRows, audits };
}

test('the backup list has the map, note, file count and whether each backup can be restored', async (t) => {
  const f = await fixture(t);
  const manual = await f.backup();
  const before = await f.backup({ reason: 'pre_switch', map: 'Ragnarok_WP' });
  f.db.prepare("UPDATE backups SET note = 'before the raid' WHERE id = ?").run(manual.id);
  // A backup from before maps were recorded gets its map from the manifest, and the row remembers it.
  f.db.prepare('UPDATE backups SET map = NULL WHERE id = ?').run(before.id);
  // A backup outside the backup folder (an import snapshot) lists its files but is not restorable.
  const outside = path.join(f.dataDir, 'snapshots', 'imported');
  fs.cpSync(manual.path, outside, { recursive: true });
  f.db
    .prepare("INSERT INTO backups (created_at, server_id, reason, path) VALUES (?, ?, 'pre_import', ?)")
    .run('2026-01-01T00:00:00.000Z', f.server.id, outside);
  const gone = await f.backup({ reason: 'scheduled' });
  fs.rmSync(gone.path, { recursive: true });

  assert.equal((await f.request(`/api/servers/${f.server.id}/backups`, { headers: {} })).status, 401);
  assert.equal((await f.request('/api/servers/999/backups')).status, 404);
  const list = await (await f.request(`/api/servers/${f.server.id}/backups`)).json();
  const byId = new Map(list.map((row) => [row.id, row]));
  assert.equal(list.length, 4);
  assert.deepEqual(
    [byId.get(manual.id).map, byId.get(manual.id).note, byId.get(manual.id).fileCount, byId.get(manual.id).restorable],
    ['TheIsland_WP', 'before the raid', 5, true],
  );
  assert.equal(byId.get(manual.id).files, 5);
  assert.equal(byId.get(manual.id).problem, null);
  assert.equal(byId.get(before.id).map, 'Ragnarok_WP');
  assert.equal(f.db.prepare('SELECT map FROM backups WHERE id = ?').get(before.id).map, 'Ragnarok_WP');
  assert.equal(byId.get(before.id).note, null);
  const imported = list.find((row) => row.reason === 'pre_import');
  assert.deepEqual([imported.restorable, imported.fileCount, imported.map], [false, 5, null]);
  assert.match(imported.problem, /not inside the backup folder/);
  assert.deepEqual([byId.get(gone.id).restorable, byId.get(gone.id).fileCount], [false, 0]);
  // Newest first: the import row is dated earlier than the rest.
  assert.deepEqual(
    list.map((row) => row.reason),
    ['scheduled', 'pre_switch', 'manual', 'pre_import'],
  );
});

test('one backup lists its players and tribes without hashing anything', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const answer = await (await f.request(`/api/servers/${f.server.id}/backups/${row.id}`)).json();
  assert.equal(answer.map, 'TheIsland_WP');
  assert.deepEqual([answer.fileCount, answer.worldFiles, answer.settingsFiles], [5, 3, 2]);
  assert.deepEqual(
    answer.profiles.map((item) => [item.id, item.size]),
    [['0001', 'profile one'.length]],
  );
  assert.deepEqual(
    answer.tribes.map((item) => item.id),
    ['1001'],
  );
  assert.match(answer.profiles[0].modifiedAt, /^\d{4}-/);
  // Not hashing means a changed file still lists.
  fs.writeFileSync(path.join(row.path, 'SavedArks', 'TheIsland_WP', '0001.arkprofile'), 'x');
  assert.equal((await f.request(`/api/servers/${f.server.id}/backups/${row.id}`)).status, 200);
  assert.equal((await f.request(`/api/servers/${f.server.id}/backups/999`)).status, 404);
  assert.equal((await f.request(`/api/servers/${f.server.id}/backups/nope`)).status, 404);
  // A backup that cannot be read says so.
  fs.rmSync(path.join(row.path, 'snapshot.json'));
  const broken = await f.request(`/api/servers/${f.server.id}/backups/${row.id}`);
  assert.equal(broken.status, 409);
  assert.equal((await broken.json()).code, 'not_restorable');
});

test('every route checks that the backup or snapshot belongs to the server in the path', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const snapshot = await (
    await f.send('POST', `/api/servers/${f.server.id}/settings-snapshots`, { name: 'Base' })
  ).json();
  // A second server with no backups.
  f.db
    .prepare(
      "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (9, 1, 'C:/other', 'installed', 'x', 'x')",
    )
    .run();
  f.db
    .prepare(
      "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, created_at, updated_at) VALUES (2, 1, 9, 'Other', 'TheIsland_WP', 's', 7801, 'x', 'x')",
    )
    .run();
  const base = '/api/servers/2';
  for (const [method, route, body] of [
    ['GET', `${base}/backups/${row.id}`],
    ['POST', `${base}/backups/${row.id}/restore`, { scope: 'world' }],
    ['PATCH', `${base}/backups/${row.id}`, { note: 'x' }],
    ['DELETE', `${base}/backups/${row.id}`],
    ['GET', `${base}/settings-snapshots/${snapshot.id}/diff`],
    ['POST', `${base}/settings-snapshots/${snapshot.id}/restore`],
    ['PATCH', `${base}/settings-snapshots/${snapshot.id}`, { name: 'Stolen' }],
    ['DELETE', `${base}/settings-snapshots/${snapshot.id}`],
  ]) {
    const response = method === 'GET' ? await f.request(route) : await f.send(method, route, body);
    assert.equal(response.status, 404, `${method} ${route}`);
  }
  // Nothing changed for the owner.
  assert.ok(f.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(row.id));
  assert.equal(f.db.prepare('SELECT name FROM settings_snapshots WHERE id = ?').get(snapshot.id).name, 'Base');
  assert.equal(f.jobRows('server.restore').length, 0);
  assert.equal(f.jobRows('server.settings_restore').length, 0);
});

test('a restore request is checked, audited and queued as a job that holds the server and its install', async (t) => {
  const f = await fixture(t, { state: 'running' });
  const row = await f.backup();
  const post = (body, id = row.id, headers = f.cookie) =>
    fetch(`${f.url}/api/servers/${f.server.id}/backups/${id}/restore`, json(body, headers));
  assert.equal((await post({ scope: 'world' }, row.id, null)).status, 401);
  assert.equal((await post({ scope: 'world' }, 999)).status, 404);
  const queued = await post({ scope: 'everything' });
  assert.equal(queued.status, 200);
  const job = await queued.json();
  assert.equal(job.kind, 'server.restore');
  assert.equal(job.state, 'queued');
  assert.equal(job.differentMap, false);
  assert.equal(job.map, 'TheIsland_WP');
  const stored = f.jobRows('server.restore')[0];
  assert.deepEqual(
    [stored.id, stored.server_id, stored.install_id, JSON.parse(stored.params_json)],
    [job.id, f.server.id, f.server.install_id, { backupId: row.id, scope: 'everything' }],
  );
  const [audit] = f.audits('backup.restore');
  assert.deepEqual(
    [audit.target_kind, audit.target_id, audit.detail],
    ['server', f.server.id, { backupId: row.id, scope: 'everything' }],
  );
  // The restore changes nothing itself.
  assert.equal(
    fs.readFileSync(path.join(f.layout.savedArks, 'TheIsland_WP', '0001.arkprofile'), 'utf8'),
    'profile one',
  );
  // Another request is refused while it is queued or running.
  const again = await post({ scope: 'world' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, API_MESSAGES.jobRunning);
  assert.equal(f.jobRows('server.restore').length, 1);
});

test('a restore of players carries the ids, and the marks and style come from the restart schedule', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  await f.send('PUT', `/api/servers/${f.server.id}/schedules/restart`, {
    cron: '0 5 * * *',
    options: { countdownMinutes: [15, 3], announce: 'broadcast' },
  });
  const answer = await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, {
    scope: 'players',
    profiles: ['0001', '0001'],
    tribes: ['1001'],
    countdownMinutes: [99],
    server_id: 5,
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(f.jobRows('server.restore')[0].params_json), {
    backupId: row.id,
    scope: 'players',
    profiles: ['0001'],
    tribes: ['1001'],
    countdownMinutes: [15, 3],
    announce: 'broadcast',
  });
  // A scope other than players carries no ids.
  f.db.prepare("UPDATE jobs SET state = 'succeeded'").run();
  await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, { scope: 'world', profiles: ['0001'] });
  assert.deepEqual(Object.keys(JSON.parse(f.jobRows('server.restore')[1].params_json)).sort(), [
    'announce',
    'backupId',
    'countdownMinutes',
    'scope',
  ]);
});

test('a restore of another map says the server keeps its own map', async (t) => {
  const f = await fixture(t);
  const row = await f.backup({ map: 'Ragnarok_WP' });
  const answer = await (
    await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, { scope: 'world' })
  ).json();
  assert.equal(answer.differentMap, true);
  assert.equal(answer.map, 'Ragnarok_WP');
  assert.equal(f.db.prepare('SELECT map FROM servers').get().map, 'TheIsland_WP');
});

test('the request is refused for exactly the reasons the job refuses it', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const settingsOnly = await f.backup({ include: { world: false } });
  const server = { ...f.db.prepare('SELECT * FROM servers').get(), install_path: f.installPath };
  const cases = [
    [row.id, {}],
    [row.id, { scope: 'sideways' }],
    [999, { scope: 'world' }],
    [row.id, { scope: 'players' }],
    [row.id, { scope: 'players', profiles: 'all' }],
    [row.id, { scope: 'players', profiles: ['../x'] }],
    [row.id, { scope: 'players', profiles: ['0007'] }],
    [row.id, { scope: 'players', profiles: ['1001'] }],
    [row.id, { scope: 'players', tribes: ['0001'] }],
    [settingsOnly.id, { scope: 'world' }],
  ];
  for (const [backupId, body] of cases) {
    let expected;
    await checkRestore({ db: f.db, dataDir: f.dataDir, server, params: { ...body, backupId } }).catch((error) => {
      expected = error;
    });
    assert.ok(expected instanceof RestoreError, JSON.stringify(body));
    const response = await f.send('POST', `/api/servers/${f.server.id}/backups/${backupId}/restore`, body);
    assert.equal(response.status, expected.status, JSON.stringify(body));
    const answer = await response.json();
    assert.equal(answer.error, expected.message);
    assert.equal(answer.code, expected.code);
  }
  assert.equal(f.jobRows('server.restore').length, 0);
  // A good request with the same function passes both.
  await checkRestore({
    db: f.db,
    dataDir: f.dataDir,
    server,
    params: { backupId: row.id, scope: 'players', tribes: ['1001'] },
  });
  assert.equal(
    (
      await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, {
        scope: 'players',
        tribes: ['1001'],
      })
    ).status,
    200,
  );
});

test('a backup outside the backup folder cannot be restored', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const outside = path.join(f.root, 'elsewhere');
  fs.cpSync(row.path, outside, { recursive: true });
  f.db.prepare('UPDATE backups SET path = ? WHERE id = ?').run(outside, row.id);
  const response = await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, { scope: 'world' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not inside the backup folder/);
});

test('the dashboard Start, Stop and Restart are refused while a restore is queued or running for that server', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const act = (verb) => f.send('POST', `/api/servers/${f.server.id}/${verb}`, {});
  for (const verb of ['start', 'stop', 'restart']) assert.equal((await act(verb)).status, 200, verb);
  assert.equal(f.calls.length, 3);
  f.calls.length = 0;
  const queued = await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, { scope: 'world' });
  assert.equal(queued.status, 200);
  for (const state of ['queued', 'running']) {
    f.db.prepare("UPDATE jobs SET state = ? WHERE kind = 'server.restore'").run(state);
    for (const verb of ['start', 'stop', 'restart']) {
      const response = await act(verb);
      assert.equal(response.status, 409, `${verb} while ${state}`);
      assert.equal((await response.json()).error, API_MESSAGES.jobRunning);
    }
  }
  assert.deepEqual(f.calls, []);
  // A settings restore holds them too, and both are free once the job has ended.
  f.db.prepare("UPDATE jobs SET state = 'failed' WHERE kind = 'server.restore'").run();
  assert.equal((await act('stop')).status, 200);
  f.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('x', 'x', 'server.settings_restore', ?, 'running')",
    )
    .run(f.server.id);
  assert.equal((await act('start')).status, 409);
});

test('a note is set, cleared and limited to 200 characters', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const patch = (body, headers) => f.send('PATCH', `/api/servers/${f.server.id}/backups/${row.id}`, body, headers);
  assert.equal(
    (await fetch(`${f.url}/api/servers/${f.server.id}/backups/${row.id}`, json({ note: 'x' }, null, 'PATCH'))).status,
    401,
  );
  assert.deepEqual(await (await patch({ note: '  Before the raid  ' })).json(), {
    id: row.id,
    note: 'Before the raid',
  });
  assert.equal(f.db.prepare('SELECT note FROM backups WHERE id = ?').get(row.id).note, 'Before the raid');
  assert.equal((await patch({ note: 'x'.repeat(200) })).status, 200);
  for (const bad of ['x'.repeat(201), 'two\nlines', 5, ['a']]) {
    const response = await patch({ note: bad });
    assert.equal(response.status, 400, String(bad));
    assert.equal((await response.json()).error, BACKUP_MESSAGES.badNote);
  }
  assert.deepEqual(await (await patch({ note: '' })).json(), { id: row.id, note: null });
  assert.deepEqual(await (await patch({})).json(), { id: row.id, note: null });
  assert.equal(f.db.prepare('SELECT note FROM backups WHERE id = ?').get(row.id).note, null);
  assert.equal(f.audits('backup.note').length, 4);
});

test('a PATCH from another site is refused like any other change', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  const route = `/api/servers/${f.server.id}/backups/${row.id}`;
  const foreign = await f.send('PATCH', route, { note: 'hijacked' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await f.send('PATCH', route, { note: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.db.prepare('SELECT note FROM backups WHERE id = ?').get(row.id).note, null);
  assert.equal((await f.send('PATCH', route, { note: 'ok' }, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  // A PATCH needs a JSON body like the other verbs do.
  const noBody = await fetch(`${f.url}${route}`, { method: 'PATCH', headers: { Cookie: f.cookie } });
  assert.equal(noBody.status, 415);
});

test('only manual and scheduled backups can be deleted, and their folders go with them', async (t) => {
  const f = await fixture(t);
  const del = (id) => f.send('DELETE', `/api/servers/${f.server.id}/backups/${id}`);
  const keepers = [];
  for (const reason of ['pre_update', 'pre_restore', 'pre_switch', 'pre_rollback'])
    keepers.push(await f.backup({ reason }));
  f.db
    .prepare("INSERT INTO backups (created_at, server_id, reason, path) VALUES ('x', ?, 'pre_import', 'C:/import')")
    .run(f.server.id);
  keepers.push(f.db.prepare("SELECT * FROM backups WHERE reason = 'pre_import'").get());
  for (const row of keepers) {
    const response = await del(row.id);
    assert.equal(response.status, 409, row.reason);
    assert.equal((await response.json()).error, BACKUP_MESSAGES.keepSafety);
    assert.ok(f.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(row.id), row.reason);
  }
  for (const row of keepers.slice(0, 4)) assert.ok(fs.existsSync(row.path), row.reason);
  for (const reason of ['manual', 'scheduled']) {
    const row = await f.backup({ reason });
    assert.deepEqual(await (await del(row.id)).json(), { deleted: true });
    assert.equal(f.db.prepare('SELECT 1 FROM backups WHERE id = ?').get(row.id), undefined);
    assert.ok(!fs.existsSync(row.path), reason);
  }
  assert.equal((await del(9999)).status, 404);
  assert.equal(f.audits('backup.delete').length, 2);
  // A row that points outside the backup folder loses its row and nothing else.
  const outside = path.join(f.root, 'precious');
  writeTree(outside, { 'keep.txt': 'keep' });
  f.db
    .prepare("INSERT INTO backups (created_at, server_id, reason, path) VALUES ('x', ?, 'manual', ?)")
    .run(f.server.id, outside);
  const odd = f.db.prepare('SELECT id FROM backups WHERE path = ?').get(outside);
  assert.equal((await del(odd.id)).status, 200);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(f.dataDir, 'backups')));
});

test('a backup cannot be deleted while a restore is queued or running for the server', async (t) => {
  const f = await fixture(t);
  const row = await f.backup();
  await f.send('POST', `/api/servers/${f.server.id}/backups/${row.id}/restore`, { scope: 'world' });
  const response = await f.send('DELETE', `/api/servers/${f.server.id}/backups/${row.id}`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, API_MESSAGES.jobRunning);
  assert.ok(fs.existsSync(row.path));
  f.db.prepare("UPDATE jobs SET state = 'succeeded'").run();
  assert.equal((await f.send('DELETE', `/api/servers/${f.server.id}/backups/${row.id}`)).status, 200);
});

// ---- settings snapshots ----

test('settings snapshots are saved, listed, compared, renamed and deleted', async (t) => {
  const f = await fixture(t);
  const root = `/api/servers/${f.server.id}/settings-snapshots`;
  assert.equal((await fetch(`${f.url}${root}`)).status, 401);
  assert.deepEqual(await (await f.request(root)).json(), []);
  const saved = await f.send('POST', root, { name: ' Base ' });
  assert.equal(saved.status, 200);
  const snapshot = await saved.json();
  assert.equal(snapshot.name, 'Base');
  assert.equal(snapshot.files, 2);
  assert.deepEqual(f.audits('settings.snapshot.save')[0].detail, { name: ' Base ' });
  // Bad and duplicate names.
  for (const name of ['', 'x'.repeat(65), 'a\nb', 7]) {
    const response = await f.send('POST', root, { name });
    assert.equal(response.status, 400, String(name));
    assert.equal((await response.json()).code, 'bad_name');
  }
  const dupe = await f.send('POST', root, { name: 'BASE' });
  assert.equal(dupe.status, 409);
  assert.equal((await dupe.json()).code, 'name_taken');
  const list = await (await f.request(root)).json();
  assert.deepEqual(
    list.map((row) => [row.id, row.name, row.files, row.usable]),
    [[snapshot.id, 'Base', 2, true]],
  );
  // The comparison.
  assert.deepEqual(await (await f.request(`${root}/${snapshot.id}/diff`)).json(), { files: [], same: 2 });
  fs.writeFileSync(path.join(f.layout.configDir, 'GameUserSettings.ini'), '[ServerSettings]\r\nDifficulty=5\r\n');
  const diff = await (await f.request(`${root}/${snapshot.id}/diff`)).json();
  assert.deepEqual(diff.files[0].sections[0].changed, [{ key: 'Difficulty', old: '1', current: '5' }]);
  assert.equal((await f.request(`${root}/999/diff`)).status, 404);
  // Renaming and deleting.
  assert.deepEqual(await (await f.send('PATCH', `${root}/${snapshot.id}`, { name: 'Renamed' })).json(), {
    id: snapshot.id,
    name: 'Renamed',
  });
  assert.equal((await f.send('PATCH', `${root}/${snapshot.id}`, { name: '' })).status, 400);
  const other = await (await f.send('POST', root, { name: 'Other' })).json();
  assert.equal((await f.send('PATCH', `${root}/${other.id}`, { name: 'renamed' })).status, 409);
  const folder = f.db.prepare('SELECT path FROM settings_snapshots WHERE id = ?').get(snapshot.id).path;
  assert.deepEqual(await (await f.send('DELETE', `${root}/${snapshot.id}`)).json(), { deleted: true });
  assert.ok(!fs.existsSync(folder));
  assert.equal((await f.send('DELETE', `${root}/${snapshot.id}`)).status, 404);
  assert.deepEqual(
    f.audits('settings.snapshot.%').map((audit) => audit.action),
    ['settings.snapshot.save', 'settings.snapshot.rename', 'settings.snapshot.save', 'settings.snapshot.delete'],
  );
});

test('a snapshot restore is queued without stopping anything, and says when it applies', async (t) => {
  for (const [state, applies] of [
    ['running', true],
    ['stopped', false],
  ]) {
    const f = await fixture(t, { state });
    const root = `/api/servers/${f.server.id}/settings-snapshots`;
    const snapshot = await (await f.send('POST', root, { name: 'Base' })).json();
    const queued = await f.send('POST', `${root}/${snapshot.id}/restore`, {});
    assert.equal(queued.status, 200);
    const job = await queued.json();
    assert.equal(job.kind, 'server.settings_restore');
    assert.equal(job.appliesAtRestart, applies, state);
    const stored = f.jobRows('server.settings_restore')[0];
    assert.deepEqual(
      [stored.server_id, stored.install_id, JSON.parse(stored.params_json)],
      [f.server.id, f.server.install_id, { snapshotId: snapshot.id }],
    );
    assert.deepEqual(f.calls, []);
    // One at a time, and it cannot be deleted from under the job.
    assert.equal((await f.send('POST', `${root}/${snapshot.id}/restore`, {})).status, 409);
    assert.equal((await f.send('DELETE', `${root}/${snapshot.id}`)).status, 409);
    assert.equal((await f.send('POST', `${root}/999/restore`, {})).status, 404);
  }
});

test('a snapshot whose files are gone cannot be restored', async (t) => {
  const f = await fixture(t);
  const root = `/api/servers/${f.server.id}/settings-snapshots`;
  const snapshot = await (await f.send('POST', root, { name: 'Base' })).json();
  const row = f.db.prepare('SELECT path FROM settings_snapshots WHERE id = ?').get(snapshot.id);
  fs.rmSync(path.join(row.path, 'snapshot.json'));
  const response = await f.send('POST', `${root}/${snapshot.id}/restore`, {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'not_usable');
  const list = await (await f.request(root)).json();
  assert.deepEqual([list[0].usable, list[0].files], [false, 0]);
  assert.equal(f.jobRows('server.settings_restore').length, 0);
});

// ---- review fixes ----

test('saving server settings is refused while a restore, settings restore or map switch holds the server', async (t) => {
  const f = await fixture(t);
  const body = { sessionName: 'Renamed' };
  const put = () => f.send('PUT', `/api/servers/${f.server.id}/settings`, body);
  for (const kind of ['server.restore', 'server.settings_restore', 'server.switch_map']) {
    f.db
      .prepare("INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('x', 'x', ?, ?, 'running')")
      .run(kind, f.server.id);
    const response = await put();
    assert.equal(response.status, 409, kind);
    assert.equal((await response.json()).error, API_MESSAGES.jobRunning, kind);
    f.db.prepare("UPDATE jobs SET state = 'succeeded'").run();
    assert.notEqual((await put()).status, 409, `${kind} after it ended`);
  }
});

test('a snapshot stored outside the snapshot folder is not deleted, and its row stays', async (t) => {
  const f = await fixture(t);
  const root = `/api/servers/${f.server.id}/settings-snapshots`;
  const snapshot = await (await f.send('POST', root, { name: 'Base' })).json();
  const row = f.db.prepare('SELECT path FROM settings_snapshots WHERE id = ?').get(snapshot.id);
  const outside = path.join(f.root, 'elsewhere');
  fs.cpSync(row.path, outside, { recursive: true });
  f.db.prepare('UPDATE settings_snapshots SET path = ? WHERE id = ?').run(outside, snapshot.id);
  const response = await f.send('DELETE', `${root}/${snapshot.id}`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'outside');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM settings_snapshots').get().n, 1);
  assert.ok(fs.existsSync(outside));
});

test('the file count of a backup is only read from a manifest inside the snapshot or backup folders', async (t) => {
  const f = await fixture(t);
  const manual = await f.backup();
  const elsewhere = path.join(f.root, 'elsewhere');
  fs.cpSync(manual.path, elsewhere, { recursive: true });
  // Rows whose stored path climbs out of the snapshot folder, or is absolute and outside it.
  const insert = f.db.prepare(
    "INSERT INTO backups (created_at, server_id, reason, path) VALUES ('2026-01-01T00:00:00.000Z', ?, 'pre_import', ?)",
  );
  fs.cpSync(manual.path, path.join(f.root, 'elsewhere2'), { recursive: true });
  insert.run(f.server.id, elsewhere);
  insert.run(f.server.id, path.join(f.dataDir, 'snapshots', '..', '..', 'elsewhere2'));
  const list = await (await f.request(`/api/servers/${f.server.id}/backups`)).json();
  const imports = list.filter((row) => row.reason === 'pre_import');
  assert.equal(imports.length, 2);
  assert.deepEqual(
    imports.map((row) => row.fileCount),
    [0, 0],
  );
  assert.equal(list.find((row) => row.id === manual.id).fileCount, 5);
});
