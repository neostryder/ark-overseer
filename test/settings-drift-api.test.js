import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createApp, API_MESSAGES } from '../src/app.js';
import { createDrift, DRIFT_MESSAGES } from '../src/settings/drift.js';
import { serverPaths } from '../src/supervisor/launch.js';
import { defaultOps } from '../src/backups/swap.js';

const GUS = [
  '[SessionSettings]',
  'SessionName=Base',
  '[ServerSettings]',
  'XPMultiplier=1.0',
  'TamingSpeedMultiplier=1.0',
  'ServerAdminPassword=adminpw',
  'MyOddKey=abc',
  '',
].join('\r\n');
const RESOLVE = 'server.settings_resolve';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-drift-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'index.html'), 'app');
  const db = openDatabase(':memory:');
  const calls = [];
  let state = 'stopped';
  const supervisor = {
    status: (id) => ({ id, observedState: state }),
    start: async (id) => (calls.push(['start', id]), { id }),
    stop: async (id) => (calls.push(['stop', id]), { id }),
    restart: async (id) => (calls.push(['restart', id]), { id }),
  };
  const logs = [];
  // While `failBaselines` is set, every baseline folder that is put in place fails to rename.
  const flags = { failBaselines: false };
  const ops = {
    ...defaultOps,
    rename: async (from, to) => {
      if (flags.failBaselines && /baselines/.test(to)) throw Object.assign(new Error('disk full'), { code: 'EIO' });
      return defaultOps.rename(from, to);
    },
  };
  const drift = createDrift({
    db,
    dataDir,
    ops,
    supervisor,
    rcon: async () => {},
    getRconPassword: () => 'pw',
    log: (line) => logs.push(line),
  });
  const noop = async () => ({});
  const jobs = createJobEngine({
    db,
    handlers: {
      ...drift.handlers,
      'install.install': noop,
      'install.update': noop,
      'install.validate': noop,
      'server.backup': noop,
    },
  });
  drift.attach(jobs);
  jobs.start();
  const app = createApp({
    db,
    dataDir,
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
    drift,
    steamcmd: { isInstalled: () => false },
    runner: async () => ({ code: 0 }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => false,
    rankFields: async () => [],
    log: (line) => logs.push(line),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.stop({ abort: true });
    await app.close();
    db.close();
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, route, body) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // Creates a server whose install may already hold settings files.
  let port = 7777;
  const addServer = async (name, files) => {
    const installPath = path.join(root, name);
    const paths = serverPaths(installPath);
    if (files) {
      fs.mkdirSync(paths.configDir, { recursive: true });
      for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(paths.configDir, file), text);
    }
    const install = (await call('POST', '/api/installs', { path: installPath })).body;
    const created = await call('POST', '/api/servers', {
      name,
      map: 'TheIsland_WP',
      sessionName: name,
      installId: install.id,
      gamePort: port,
      queryPort: port + 100,
      rconPort: port + 200,
      maxPlayers: 20,
    });
    port += 2;
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return { id: created.body.id, installId: install.id, paths, installPath };
  };
  const finished = async (id) => {
    const deadline = Date.now() + 5000;
    while (['queued', 'running'].includes(jobs.get(id).state) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return jobs.get(id);
  };
  let tick = 0;
  // A file rewritten from outside, with a change time that has certainly moved.
  const outside = (server, file, text) => {
    const target = path.join(server.paths.configDir, file);
    fs.mkdirSync(server.paths.configDir, { recursive: true });
    fs.writeFileSync(target, text);
    const stamp = new Date(Date.parse('2026-02-01T00:00:00.000Z') + ++tick * 1000);
    fs.utimesSync(target, stamp, stamp);
  };
  const audits = (like) =>
    db
      .prepare('SELECT action, actor, target_id, detail_json FROM audit_events WHERE action LIKE ? ORDER BY id')
      .all(like)
      .map((row) => ({ ...JSON.parse(row.detail_json), action: row.action, actor: row.actor, id: row.target_id }));
  return {
    url,
    cookie,
    db,
    root,
    drift,
    flags,
    jobs,
    calls,
    logs,
    call,
    addServer,
    finished,
    outside,
    audits,
    setState: (next) => (state = next),
    baseline: (id) => db.prepare('SELECT * FROM settings_baselines WHERE server_id = ?').get(id),
    driftRow: (id) => db.prepare('SELECT * FROM settings_drift WHERE server_id = ?').get(id),
    baselineFile: (id, name) =>
      fs.readFileSync(
        path.join(dataDir, 'baselines', `server-${id}`, 'Config', 'WindowsServer', ...name.split('/')),
        'utf8',
      ),
  };
}

const settingsRoute = (id) => `/api/servers/${id}/settings`;
const driftRoute = (id, rest = '') => `/api/servers/${id}/settings/drift${rest}`;

test('a server created over settings files takes them as its baseline, and one with none waits for its first read', async (t) => {
  const f = await fixture(t);
  const withFiles = await f.addServer('Files', { 'GameUserSettings.ini': GUS });
  assert.equal(f.baseline(withFiles.id).source, 'server_created');
  assert.equal(f.baselineFile(withFiles.id, 'GameUserSettings.ini'), GUS);
  const bare = await f.addServer('Bare');
  assert.equal(f.baseline(bare.id), undefined);
  // ASA writes its own files on first start; the first read then takes them.
  f.outside(bare, 'GameUserSettings.ini', GUS);
  assert.equal((await f.call('GET', settingsRoute(bare.id))).status, 200);
  assert.equal(f.baseline(bare.id).source, 'first_read');
  const state = (await f.call('GET', driftRoute(bare.id))).body;
  assert.equal(state.changed, false);
});

test('reading the settings of an older server gives it a baseline and reports nothing as changed', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Old', { 'GameUserSettings.ini': GUS });
  f.db.prepare('DELETE FROM settings_baselines').run();
  assert.equal(f.baseline(server.id), undefined);
  const read = await f.call('GET', settingsRoute(server.id));
  assert.equal(read.status, 200);
  assert.equal(read.body.XPMultiplier, 1);
  assert.equal(f.baseline(server.id).source, 'first_read');
  const state = (await f.call('GET', driftRoute(server.id))).body;
  assert.deepEqual([state.changed, state.differences], [false, []]);
  const list = (await f.call('GET', '/api/servers')).body;
  assert.equal(list[0].settingsChanged, false);
});

test('the drift route reports what changed, never a password, and the fleet list flags it until someone looks', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(
    server,
    'GameUserSettings.ini',
    GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0').replace('adminpw', 'changedpw'),
  );
  const { status, body } = await f.call('GET', driftRoute(server.id));
  assert.equal(status, 200);
  assert.equal(body.changed, true);
  assert.equal(body.seen, false);
  assert.equal(body.afterStop, false);
  assert.equal(body.keepAfterStop, false);
  assert.equal(body.serverRunning, false);
  assert.match(body.liveSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    body.differences.map((x) => [x.key, x.kind, x.baseline, x.live, x.secret]),
    [
      ['ServerAdminPassword', 'changed', null, null, true],
      ['XPMultiplier', 'changed', '1.0', '4.0', false],
    ],
  );
  assert.doesNotMatch(JSON.stringify(body), /adminpw|changedpw/);
  const flagged = (await f.call('GET', '/api/servers')).body;
  assert.equal(flagged[0].settingsChanged, true);
  assert.equal((await f.call('GET', `/api/servers/${server.id}`)).body.settingsChanged, true);
  // Looking marks it seen: the marker goes, and the drift stays until it is dealt with.
  assert.deepEqual((await f.call('POST', driftRoute(server.id, '/seen'), {})).body, { seen: true });
  assert.equal((await f.call('GET', '/api/servers')).body[0].settingsChanged, false);
  const again = (await f.call('GET', driftRoute(server.id))).body;
  assert.equal(again.changed, true);
  assert.equal(again.seen, true);
  assert.equal(again.detectedAt, body.detectedAt);
  assert.equal((await f.call('GET', driftRoute(9999))).status, 404);
  assert.equal((await f.call('POST', driftRoute(9999, '/seen'), {})).status, 404);
  assert.equal(f.audits('server.settings.drift_seen').length, 1);
});

test('saving settings records a new baseline for the keys saved, and a save that fails records nothing', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  const before = f.baseline(server.id).sha256;
  const invalid = await f.call('PUT', settingsRoute(server.id), { XPMultiplier: 1000 });
  assert.equal(invalid.status, 400);
  assert.equal(f.baseline(server.id).sha256, before);
  // Someone edits another key by hand, then a save changes a different one.
  f.outside(server, 'GameUserSettings.ini', GUS.replace('MyOddKey=abc', 'MyOddKey=outside'));
  const saved = await f.call('PUT', settingsRoute(server.id), { XPMultiplier: 2 });
  assert.equal(saved.status, 200);
  assert.equal(f.baseline(server.id).source, 'settings_save');
  assert.match(f.baselineFile(server.id, 'GameUserSettings.ini'), /XPMultiplier=2/);
  const state = (await f.call('GET', driftRoute(server.id))).body;
  assert.deepEqual(
    state.differences.map((x) => x.key),
    ['MyOddKey'],
  );
  // With nothing else different, the drift is gone after the save.
  f.outside(
    server,
    'GameUserSettings.ini',
    fs
      .readFileSync(path.join(server.paths.configDir, 'GameUserSettings.ini'), 'utf8')
      .replace('MyOddKey=outside', 'MyOddKey=abc'),
  );
  assert.equal((await f.call('PUT', settingsRoute(server.id), { TamingSpeedMultiplier: 3 })).status, 200);
  assert.equal((await f.call('GET', driftRoute(server.id))).body.changed, false);
  assert.equal(f.driftRow(server.id), undefined);
});

test('a baseline that cannot be recorded after a save is kept, and the save is recorded at the next read', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  const before = f.baseline(server.id);
  f.flags.failBaselines = true;
  const saved = await f.call('PUT', settingsRoute(server.id), { XPMultiplier: 2 });
  f.flags.failBaselines = false;
  assert.equal(saved.status, 200);
  // The last good baseline stays, with what is still to be recorded beside it.
  assert.equal(f.baseline(server.id).sha256, before.sha256);
  assert.ok(JSON.parse(f.baseline(server.id).pending_json).keys.some((key) => key.key === 'XPMultiplier'));
  assert.match(f.baselineFile(server.id, 'GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.ok(f.logs.some((line) => /Recording the settings baseline for server \d+ failed: disk full/.test(line)));
  // The save is not reported as a change made outside, and the next read records it.
  assert.equal((await f.call('GET', driftRoute(server.id))).body.changed, false);
  assert.equal(f.baseline(server.id).pending_json, null);
  assert.equal(f.baseline(server.id).source, 'settings_save');
  assert.match(f.baselineFile(server.id, 'GameUserSettings.ini'), /XPMultiplier=2/);
});

test('adopt keeps the files and moves the baseline, and answers with the keys it took', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  const state = (await f.call('GET', driftRoute(server.id))).body;
  const resolve = (body) => f.call('POST', driftRoute(server.id, '/resolve'), body);
  const answer = await resolve({ action: 'adopt', liveSha256: state.liveSha256 });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.adopted, true);
  assert.equal(answer.body.changed, false);
  assert.deepEqual(answer.body.keys, [
    { file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'XPMultiplier' },
  ]);
  assert.match(fs.readFileSync(path.join(server.paths.configDir, 'GameUserSettings.ini'), 'utf8'), /XPMultiplier=4.0/);
  assert.equal(f.baseline(server.id).source, 'drift_adopt');
  assert.equal((await f.call('GET', driftRoute(server.id))).body.changed, false);
  assert.equal(f.driftRow(server.id), undefined);
  const [event] = f.audits('server.settings.drift_adopt');
  assert.equal(event.actor, 'user');
  assert.equal(event.action, 'server.settings.drift_adopt');
  assert.deepEqual(event.keys, [{ file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'XPMultiplier' }]);
  assert.doesNotMatch(JSON.stringify(event), /4\.0/);
  // The look is stale now, and nothing differs.
  assert.equal((await resolve({ action: 'adopt', liveSha256: state.liveSha256 })).status, 409);
});

test('revert and merge queue a job that puts values back, and both are audited without values', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  const resolve = (body) => f.call('POST', driftRoute(server.id, '/resolve'), body);
  f.setState('running');
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  let state = (await f.call('GET', driftRoute(server.id))).body;
  assert.equal(state.serverRunning, true);
  const queued = await resolve({ action: 'revert', liveSha256: state.liveSha256 });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.kind, RESOLVE);
  assert.equal(queued.body.serverRunning, true);
  const done = await f.finished(queued.body.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.appliesAtRestart, true);
  assert.match(fs.readFileSync(path.join(server.paths.configDir, 'GameUserSettings.ini'), 'utf8'), /XPMultiplier=1.0/);
  assert.equal((await f.call('GET', driftRoute(server.id))).body.changed, false);
  assert.deepEqual(f.calls, []);

  f.setState('stopped');
  f.outside(
    server,
    'GameUserSettings.ini',
    GUS.replace('XPMultiplier=1.0', 'XPMultiplier=5.0').replace('MyOddKey=abc', 'MyOddKey=zz9plural'),
  );
  state = (await f.call('GET', driftRoute(server.id))).body;
  const choices = [
    { file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'XPMultiplier', choice: 'live' },
    { file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'MyOddKey', choice: 'baseline' },
  ];
  const merged = await resolve({ action: 'merge', choices, liveSha256: state.liveSha256 });
  assert.equal(merged.status, 200);
  assert.equal((await f.finished(merged.body.id)).state, 'succeeded');
  const text = fs.readFileSync(path.join(server.paths.configDir, 'GameUserSettings.ini'), 'utf8');
  assert.match(text, /XPMultiplier=5.0/);
  assert.match(text, /MyOddKey=abc/);
  assert.equal(f.baseline(server.id).source, 'drift_merge');

  const requests = f.audits('server.settings.drift_%').filter((event) => event.actor === 'user');
  assert.deepEqual(
    requests.map((event) => [event.action, event.action === 'server.settings.drift_merge' ? event.keys.length : 1]),
    [
      ['server.settings.drift_revert', 1],
      ['server.settings.drift_merge', 2],
    ],
  );
  const outcomes = f.audits('server.settings.drift_%').filter((event) => event.actor === 'job');
  assert.deepEqual(
    outcomes.map((event) => [event.action, event.outcome]),
    [
      ['server.settings.drift_revert', 'applied'],
      ['server.settings.drift_merge', 'applied'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(f.audits('server.settings.drift_%')), /zz9plural|5\.0|4\.0/);
});

test('a resolve request with a bad action, a stale look or an incomplete merge is refused and queues nothing', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  const state = (await f.call('GET', driftRoute(server.id))).body;
  const resolve = (body) => f.call('POST', driftRoute(server.id, '/resolve'), body);
  const cases = [
    [{ action: 'delete', liveSha256: state.liveSha256 }, 400, 'bad_action', DRIFT_MESSAGES.badAction],
    [{ action: 'revert' }, 400, 'no_look', DRIFT_MESSAGES.noLook],
    [{ action: 'revert', liveSha256: 'f'.repeat(64) }, 409, 'changed', DRIFT_MESSAGES.changedSince],
    [{ action: 'merge', liveSha256: state.liveSha256, choices: [] }, 400, 'missing_choice', null],
    [{ action: 'merge', liveSha256: state.liveSha256, choices: 'live' }, 400, 'bad_choices', DRIFT_MESSAGES.badChoices],
  ];
  for (const [body, status, code, message] of cases) {
    const answer = await resolve(body);
    assert.equal(answer.status, status, code);
    assert.equal(answer.body.code, code);
    if (message) assert.equal(answer.body.error, message);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get(RESOLVE).n, 0);
  assert.equal((await f.call('POST', driftRoute(9999, '/resolve'), { action: 'adopt' })).status, 404);
});

test('a resolve refused while another job runs, and the dashboard refuses to start, stop, restart or save meanwhile', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  const state = (await f.call('GET', driftRoute(server.id))).body;
  const act = (verb) => f.call('POST', `/api/servers/${server.id}/${verb}`, {});
  for (const verb of ['start', 'stop', 'restart']) assert.equal((await act(verb)).status, 200, verb);
  f.calls.length = 0;
  // A put-back that is queued or running holds the same things a restore holds.
  const insert = f.db.prepare(
    "INSERT INTO jobs (created_at, updated_at, kind, server_id, install_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?, ?, ?)",
  );
  for (const jobState of ['queued', 'running']) {
    f.db.prepare('DELETE FROM jobs WHERE kind = ?').run(RESOLVE);
    insert.run(RESOLVE, server.id, server.installId, jobState);
    for (const verb of ['start', 'stop', 'restart']) {
      const answer = await act(verb);
      assert.equal(answer.status, 409, `${verb} while ${jobState}`);
      assert.equal(answer.body.error, API_MESSAGES.jobRunning);
    }
    const save = await f.call('PUT', settingsRoute(server.id), { XPMultiplier: 2 });
    assert.equal(save.status, 409, `save while ${jobState}`);
    for (const action of ['adopt', 'revert']) {
      const answer = await f.call('POST', driftRoute(server.id, '/resolve'), { action, liveSha256: state.liveSha256 });
      assert.equal(answer.status, 409, `${action} while ${jobState}`);
      assert.equal(answer.body.error, API_MESSAGES.jobRunning);
    }
  }
  assert.deepEqual(f.calls, []);
  assert.match(fs.readFileSync(path.join(server.paths.configDir, 'GameUserSettings.ini'), 'utf8'), /XPMultiplier=4.0/);
  // Any other job for the install also keeps a put-back from being queued.
  f.db.prepare('DELETE FROM jobs WHERE kind = ?').run(RESOLVE);
  insert.run('server.backup', server.id, server.installId, 'running');
  const refused = await f.call('POST', driftRoute(server.id, '/resolve'), {
    action: 'revert',
    liveSha256: state.liveSha256,
  });
  assert.equal(refused.status, 409);
  // And it is free again once they have ended.
  f.db.prepare("UPDATE jobs SET state = 'failed'").run();
  assert.equal((await act('stop')).status, 200);
  assert.equal((await f.call('PUT', settingsRoute(server.id), { XPMultiplier: 2 })).status, 200);
});

test('the option to put settings back after a stop is saved on the server, off by default, and audited', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.db.prepare('UPDATE servers SET settings_json = \'{"mods":["928102"]}\' WHERE id = ?').run(server.id);
  assert.equal((await f.call('GET', driftRoute(server.id))).body.keepAfterStop, false);
  const route = driftRoute(server.id, '/keep');
  for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }])
    assert.equal((await f.call('PUT', route, bad)).status, 400);
  assert.deepEqual((await f.call('PUT', route, { enabled: true })).body, { enabled: true });
  assert.equal((await f.call('GET', driftRoute(server.id))).body.keepAfterStop, true);
  // Nothing else in the server's settings is disturbed.
  const stored = JSON.parse(
    f.db.prepare('SELECT settings_json FROM servers WHERE id = ?').get(server.id).settings_json,
  );
  assert.deepEqual(stored, { mods: ['928102'], keepSettingsAfterStop: true });
  const shaped = (await f.call('GET', `/api/servers/${server.id}`)).body;
  assert.deepEqual(shaped.settings_json, { mods: ['928102'], disableBattlEye: false });
  assert.deepEqual((await f.call('PUT', route, { enabled: false })).body, { enabled: false });
  assert.deepEqual(
    JSON.parse(f.db.prepare('SELECT settings_json FROM servers WHERE id = ?').get(server.id).settings_json),
    {
      mods: ['928102'],
    },
  );
  assert.deepEqual(
    f.audits('server.settings.keep_after_stop').map((event) => event.enabled),
    [true, false],
  );
  assert.equal((await f.call('PUT', driftRoute(9999, '/keep'), { enabled: true })).status, 404);
});

test('loading the backups page also looks at whether the settings still match', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  assert.equal(f.driftRow(server.id), undefined);
  assert.equal((await f.call('GET', `/api/servers/${server.id}/backups`)).status, 200);
  const deadline = Date.now() + 3000;
  while (!f.driftRow(server.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.driftRow(server.id));
  assert.equal((await f.call('GET', '/api/servers')).body[0].settingsChanged, true);
});

test('an imported server takes its settings files as the baseline', async (t) => {
  const f = await fixture(t);
  const dashboardDir = path.join(f.root, 'dashboard');
  const installRoot = path.join(f.root, 'legacy-install');
  fs.mkdirSync(path.join(dashboardDir, 'profile-data', 'one'), { recursive: true });
  fs.writeFileSync(
    path.join(dashboardDir, 'profiles.json'),
    JSON.stringify([
      {
        id: 'one',
        name: 'Legacy One',
        map: 'TheIsland',
        serverRoot: installRoot,
        gamePort: 7777,
        queryPort: 27015,
        rconPort: 27020,
      },
    ]),
  );
  const paths = serverPaths(installRoot);
  fs.mkdirSync(paths.exeDir, { recursive: true });
  fs.writeFileSync(paths.exePath, '');
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.gameUserSettingsPath, GUS);
  const preview = await f.call('POST', '/api/import/preview', { dashboardDir });
  const applied = await f.call('POST', '/api/import/apply', { token: preview.body.token, profileId: 'one' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(f.baseline(applied.body.serverId).source, 'import');
  assert.equal(f.baselineFile(applied.body.serverId, 'GameUserSettings.ini'), GUS);
  assert.equal((await f.call('GET', driftRoute(applied.body.serverId))).body.changed, false);
});

test('two resolve requests at once queue one job and refuse the other', async (t) => {
  const f = await fixture(t);
  const server = await f.addServer('Main', { 'GameUserSettings.ini': GUS });
  f.outside(server, 'GameUserSettings.ini', GUS.replace('XPMultiplier=1.0', 'XPMultiplier=4.0'));
  const state = (await f.call('GET', driftRoute(server.id))).body;
  const resolve = () =>
    f.call('POST', driftRoute(server.id, '/resolve'), { action: 'revert', liveSha256: state.liveSha256 });
  const answers = await Promise.all([resolve(), resolve(), resolve()]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409, 409]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get(RESOLVE).n, 1);
  for (const refused of answers.filter((a) => a.status === 409))
    assert.equal(refused.body.error, API_MESSAGES.jobRunning);
});
