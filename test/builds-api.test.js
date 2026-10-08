import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createApp, API_MESSAGES } from '../src/app.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createBuildWatch } from '../src/builds/watch.js';
import { MESSAGES as BRANCH_MESSAGES } from '../src/builds/branch.js';
import { recordInstallBuild } from '../src/builds/history.js';

const T = '2026-01-01T00:00:00.000Z';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF_-0123456789';
const post = (value, cookie, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(value),
});

async function fixture(t, { withWatch = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-builds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  const queued = [];
  const jobs = createJobEngine({
    db,
    handlers: {
      'install.switch_branch': async ({ params }) => {
        queued.push(params);
        return { ok: true };
      },
    },
  });
  const buildWatch = withWatch
    ? createBuildWatch({
        db,
        steamcmd: {
          isInstalled: () => true,
          branchInfo: async () => ({ public: { buildId: '100', timeUpdated: null, manifestId: 'm100' } }),
        },
      })
    : null;
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor: { status: () => ({ observedState: 'stopped' }) },
    steamcmd: { isInstalled: () => true, exePath: 'fake' },
    buildWatch,
    runner: async () => ({ code: 0 }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => ({ rules: [] }),
    isElevated: async () => true,
    rankFields: async () => [],
    log: () => {},
  });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'login.html'), 'login');
  await fs.promises.mkdir(path.join(root, 'data'), { recursive: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.stop({ abort: true });
    await app.close();
    db.close();
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery' }),
  });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, build_id, created_at, updated_at) VALUES (1, 1, 'C:/ark', 'installed', '100', ?, ?)",
  ).run(T, T);
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, created_at, updated_at) VALUES (1, 1, 1, 'One', 'TheIsland_WP', 's', 7777, ?, ?)",
  ).run(T, T);
  db.prepare(
    "INSERT INTO steam_builds (branch, build_id, manifest_id, first_seen_at, changed_at, checked_at) VALUES ('public_test_realm', '200', 'm200', ?, ?, ?)",
  ).run(T, T, T);
  const get = async (route) => {
    const response = await fetch(`${url}${route}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.json() };
  };
  const send = async (route, value, method = 'POST') => {
    const response = await fetch(`${url}${route}`, post(value, cookie, method));
    return { status: response.status, body: await response.json() };
  };
  return { db, get, send, queued, jobs, url };
}

test('the build routes need a signed-in user', async (t) => {
  const { url } = await fixture(t);
  for (const route of ['/api/builds', '/api/installs/1/builds'])
    assert.equal((await fetch(`${url}${route}`)).status, 401);
  assert.equal((await fetch(`${url}/api/builds/check`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/api/installs/1/branch`, { method: 'POST' })).status, 401);
});

test('GET /api/builds lists the branches and only says whether a webhook is set', async (t) => {
  const f = await fixture(t);
  const before = await f.get('/api/builds');
  assert.deepEqual(before.body.webhook, { configured: false });
  assert.deepEqual(
    before.body.branches.map((row) => row.branch),
    ['public_test_realm'],
  );
  assert.equal((await f.send('/api/builds/webhook', { url: HOOK }, 'PUT')).status, 200);
  const after = await f.get('/api/builds');
  assert.deepEqual(after.body.webhook, { configured: true });
  assert.equal(JSON.stringify(after.body).includes('abcdefghijklmnop'), false);
  assert.equal((await f.send('/api/builds/webhook', { url: 'https://example.com/x' }, 'PUT')).status, 400);
  assert.deepEqual((await f.send('/api/builds/webhook', { url: '' }, 'PUT')).body, { configured: false });
});

test('POST /api/builds/check looks at Steam now and returns the branches', async (t) => {
  const f = await fixture(t);
  const result = await f.send('/api/builds/check', {});
  assert.equal(result.status, 200);
  assert.equal(result.body.checked, true);
  assert.deepEqual(
    result.body.branches.map((row) => row.branch),
    ['public', 'public_test_realm'],
  );
});

test('without a build watch the check and webhook routes say so, and the list is empty', async (t) => {
  const f = await fixture(t, { withWatch: false });
  assert.deepEqual((await f.get('/api/builds')).body, { branches: [], webhook: { configured: false } });
  const check = await f.send('/api/builds/check', {});
  assert.equal(check.status, 503);
  assert.equal(check.body.error, API_MESSAGES.noBuildWatch);
  assert.equal((await f.send('/api/builds/webhook', { url: '' }, 'PUT')).status, 503);
});

test('GET /api/installs/:id/builds lists what the install received, newest first', async (t) => {
  const f = await fixture(t);
  recordInstallBuild(f.db, 1, { branch: 'public', buildId: '100', reason: 'install', now: () => 1 });
  recordInstallBuild(f.db, 1, { branch: 'public_test_realm', buildId: '200', reason: 'branch_switch', now: () => 2 });
  const { body } = await f.get('/api/installs/1/builds');
  assert.deepEqual(
    body.map((row) => [row.branch, row.build_id, row.manifest_id, row.reason]),
    [
      ['public_test_realm', '200', 'm200', 'branch_switch'],
      ['public', '100', null, 'install'],
    ],
  );
  assert.equal((await f.get('/api/installs/9/builds')).status, 404);
});

test('POST /api/installs/:id/branch checks first, then queues the switch', async (t) => {
  const f = await fixture(t);
  const refused = await f.send('/api/installs/1/branch', { branch: 'public_test_realm' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, BRANCH_MESSAGES.needsAck);
  assert.equal((await f.send('/api/installs/1/branch', { branch: 'bad branch', acknowledged: true })).status, 400);
  assert.equal((await f.send('/api/installs/9/branch', { branch: 'public' })).status, 404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  const ok = await f.send('/api/installs/1/branch', { branch: 'public_test_realm', acknowledged: true });
  assert.equal(ok.status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'install.switch_branch'").get().n, 1);
  const audit = f.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'install.switch_branch'").get();
  assert.deepEqual(JSON.parse(audit.detail_json), { branch: 'public_test_realm' });
  // The two overrides are on the record when they were used.
  f.db.prepare('DELETE FROM jobs').run();
  await f.send('/api/installs/1/branch', { branch: 'public_test_realm', acknowledged: true, keepMods: true });
  const rows = f.db
    .prepare("SELECT detail_json FROM audit_events WHERE action = 'install.switch_branch' ORDER BY id")
    .all();
  assert.deepEqual(JSON.parse(rows.at(-1).detail_json), { branch: 'public_test_realm', keepMods: true });
});

test('adding a server to a cluster refuses a mix of live and test installs', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO clusters (id, name, cluster_key, shared_dir, created_at, updated_at) VALUES (1, 'c', 'k', 'C:/shared', ?, ?)",
    )
    .run(T, T);
  f.db
    .prepare(
      "INSERT INTO installs (id, host_id, path, state, branch, created_at, updated_at) VALUES (2, 1, 'C:/ptr', 'installed', 'public_test_realm', ?, ?)",
    )
    .run(T, T);
  f.db
    .prepare(
      "INSERT INTO servers (id, host_id, install_id, cluster_id, name, map, session_name, game_port, created_at, updated_at) VALUES (2, 1, 2, 1, 'Two', 'Ragnarok_WP', 's', 7779, ?, ?)",
    )
    .run(T, T);
  const mixed = await f.send('/api/clusters/1/members', { serverId: 1 });
  assert.equal(mixed.status, 409);
  assert.equal(mixed.body.error, BRANCH_MESSAGES.clusterMix);
});
