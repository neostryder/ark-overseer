import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createApp, API_MESSAGES } from '../src/app.js';
import { createAuth, AUTH_MESSAGES } from '../src/auth/auth.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  const jobKinds = ['install.install', 'install.update', 'install.validate', 'steamcmd.setup'];
  const jobs = createJobEngine({
    db,
    handlers: Object.fromEntries(jobKinds.map((kind) => [kind, async () => ({ ok: true })])),
  });
  const calls = [];
  const supervisor = {
    status: (id) => ({ id, observedState: 'stopped' }),
    start: async (id) => (calls.push(['start', id]), { id }),
    stop: async (id) => (calls.push(['stop', id]), { id }),
    restart: async (id) => (calls.push(['restart', id]), { id }),
  };
  let activeRules = [];
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor,
    steamcmd: { isInstalled: () => false, exePath: 'fake' },
    runner: async (...args) => {
      calls.push(['runner', ...args]);
      return { code: 0 };
    },
    platform: {},
    listListeners: async () => [{ protocol: 'tcp', port: 28000, pid: 123, state: 'LISTENING' }],
    firewallRules: async () => activeRules,
    isElevated: async () => true,
    rankFields: async (q, fields) => [{ key: q, count: fields.length }],
    log: () => {},
  });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'login.html'), 'login');
  fs.writeFileSync(path.join(root, 'public', 'index.html'), 'app');
  fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'js', 'login.js'), 'export {};');
  fs.writeFileSync(path.join(root, 'public', 'icons', 'sprite.svg'), '<svg/>');
  await fs.promises.mkdir(path.join(root, 'data'), { recursive: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.stop({ abort: true });
    await app.close();
    db.close();
  });
  return {
    root,
    db,
    jobs,
    calls,
    app,
    setFirewallRules: (rules) => {
      activeRules = rules;
    },
    url: `http://127.0.0.1:${app.server.address().port}`,
  };
}
const json = (value, cookie) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(value),
});
async function setup(url) {
  const response = await fetch(`${url}/api/auth/setup`, json({ password: 'correct horse battery' }));
  return { response, cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('first-time setup works only on loopback and later setup is refused', async (t) => {
  const { url, db } = await fixture(t);
  const { response } = await setup(url);
  assert.equal(response.status, 200);
  assert.ok(db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get().password_hash);
  const again = await fetch(`${url}/api/auth/setup`, json({ password: 'another password' }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'A password is already set. Sign in with it.');
});

test('sign in, cookie flags, lockout, sign out, protected API and page access work', async (t) => {
  const { url } = await fixture(t);
  await setup(url);
  const short = await fetch(`${url}/api/auth/login`, json({ password: 'correct horse battery', remember: false }));
  assert.equal(short.status, 200);
  assert.doesNotMatch(short.headers.get('set-cookie'), /Max-Age=/);
  assert.match(short.headers.get('set-cookie'), /HttpOnly/);
  assert.match(short.headers.get('set-cookie'), /SameSite=Strict/);
  const remembered = await fetch(`${url}/api/auth/login`, json({ password: 'correct horse battery', remember: true }));
  assert.match(remembered.headers.get('set-cookie'), /Max-Age=7776000/);
  const cookie = remembered.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 5; i++) await fetch(`${url}/api/auth/login`, json({ password: 'wrong password' }));
  assert.equal((await fetch(`${url}/api/auth/login`, json({ password: 'correct horse battery' }))).status, 429);
  assert.equal((await fetch(`${url}/api/host`)).status, 401);
  assert.equal((await fetch(url, { redirect: 'manual' })).headers.get('location'), '/login.html');
  assert.equal(await (await fetch(`${url}/login.html`)).text(), 'login');
  // The sign-in page needs its scripts and icons before there is a session; the app page does not get them.
  const script = await fetch(`${url}/js/login.js`, { redirect: 'manual' });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${url}/icons/sprite.svg`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${url}/index.html`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${url}/js/missing.js`, { redirect: 'manual' })).status, 404);
  const cross = await fetch(`${url}/api/installs`, {
    ...json({ path: 'C:\\ARK' }, cookie),
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.test' },
  });
  assert.equal(cross.status, 403);
  const host = await fetch(`${url}/api/host`, { headers: { Cookie: cookie } });
  assert.equal(host.status, 200);
  assert.equal((await host.json()).elevated, true);
  const out = await fetch(`${url}/api/auth/logout`, json({}, cookie));
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('install validation, job queueing, server port conflicts and supervisor actions work', async (t) => {
  const { url, jobs, calls, db } = await fixture(t);
  const { cookie } = await setup(url);
  const headers = { Cookie: cookie };
  const post = (route, body) => fetch(`${url}${route}`, json(body, cookie));
  assert.equal((await post('/api/installs', { path: 'relative' })).status, 400);
  assert.equal((await post('/api/installs', { path: 'C:\\Steam\\steamapps\\common\\ASA' })).status, 400);
  const install = await post('/api/installs', { path: 'C:\\ARK\\Server' });
  const added = await install.json();
  assert.equal(install.status, 200);
  assert.equal(jobs.get(added.jobId).kind, 'install.install');
  const serverInput = {
    name: 'Main',
    map: 'TheIsland',
    sessionName: 'Main Session',
    installId: added.id,
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    maxPlayers: 70,
  };
  const created = await post('/api/servers', serverInput);
  assert.equal(created.status, 200);
  const server = await created.json();
  assert.equal((await post('/api/servers', { ...serverInput, name: 'Clash' })).status, 409);
  assert.equal((await post('/api/servers', { ...serverInput, name: 'BadMap', map: 'bad map' })).status, 400);
  assert.equal((await post('/api/servers', { ...serverInput, name: 'BadPlayers', maxPlayers: 1001 })).status, 400);
  db.prepare('UPDATE servers SET pid = 123 WHERE id = ?').run(server.id);
  const portUpdate = await fetch(`${url}/api/servers/${server.id}/ports`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gamePort: 7781, queryPort: 27030, rconPort: 28000 }),
  });
  assert.equal(portUpdate.status, 200);
  for (const verb of ['start', 'stop', 'restart'])
    assert.equal((await post(`/api/servers/${server.id}/${verb}`, {})).status, 200);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['start', 'stop', 'restart'],
  );
  assert.equal((await fetch(`${url}/api/servers/${server.id}`, { headers })).status, 200);
});

test('firewall previews require the current token and audit rows never include passwords', async (t) => {
  const { url, db, calls, setFirewallRules } = await fixture(t);
  const { cookie } = await setup(url);
  const post = (route, body) => fetch(`${url}${route}`, json(body, cookie));
  const install = await (await post('/api/installs', { path: 'C:\\ARK\\Server' })).json();
  const server = await (
    await post('/api/servers', {
      name: 'One',
      map: 'TheIsland',
      sessionName: 'One',
      installId: install.id,
      gamePort: 7777,
      queryPort: 27015,
      rconPort: 27020,
      maxPlayers: 70,
    })
  ).json();
  const preview = await (
    await fetch(`${url}/api/servers/${server.id}/firewall`, { headers: { Cookie: cookie } })
  ).json();
  assert.ok(preview.token);
  assert.equal((await post(`/api/servers/${server.id}/firewall/apply`, { token: 'old' })).status, 409);
  assert.equal(calls.length, 0);
  const apply = await post(`/api/servers/${server.id}/firewall/apply`, { token: preview.token });
  assert.equal(apply.status, 200);
  assert.equal(calls[0][0], 'runner');
  const alreadyCovered = preview.rules.map(({ coveredBy: _coveredBy, ...rule }) => ({
    ...rule,
    enabled: true,
    direction: 'in',
    profiles: ['Any'],
    remoteIp: 'Any',
    action: 'allow',
  }));
  setFirewallRules(alreadyCovered);
  const coveredPreview = await (
    await fetch(`${url}/api/servers/${server.id}/firewall`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(coveredPreview.script, null);
  const noOp = await post(`/api/servers/${server.id}/firewall/apply`, { token: null });
  assert.deepEqual(await noOp.json(), { applied: false });
  assert.equal(calls.length, 1);
  const audits = db.prepare('SELECT action, detail_json FROM audit_events').all();
  assert.ok(audits.some((row) => row.action === 'server.create'));
  assert.ok(audits.some((row) => row.action === 'server.firewall.apply'));
  assert.doesNotMatch(JSON.stringify(audits), /correct horse battery/);
});

test('reset-password utility clears the stored password so setup works again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-reset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(path.join(root, 'overseer.db'));
  db.prepare(
    "INSERT INTO users (created_at, updated_at, username, password_hash, session_secret) VALUES (?, ?, 'admin', 'old', ?)",
  ).run(new Date().toISOString(), new Date().toISOString(), Buffer.alloc(32, 1));
  db.prepare(
    "INSERT INTO user_passkeys (created_at, user_id, credential_id, public_key, rp_id) VALUES (?, 1, 'cred', x'00', 'localhost')",
  ).run(new Date().toISOString());
  db.close();
  const result = spawnSync(process.execPath, [path.resolve('tools/reset-password.js'), root], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The password and passkeys are cleared/);
  const reopened = openDatabase(path.join(root, 'overseer.db'));
  try {
    assert.equal(
      reopened.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get().password_hash,
      null,
    );
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM user_passkeys').get().n, 0);
    assert.notDeepEqual(reopened.prepare('SELECT session_secret FROM users').get().session_secret, Buffer.alloc(32, 1));
    const auth = createAuth({ db: reopened });
    const res = { setHeader() {} };
    await auth.routes.setup({
      req: { headers: { host: 'localhost:3310' }, socket: { remoteAddress: '127.0.0.1' } },
      res,
      body: { password: 'replacement password' },
    });
    assert.ok(reopened.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get().password_hash);
  } finally {
    reopened.close();
  }
});
import { serverPaths } from '../src/supervisor/launch.js';

test('settings read, write, validation and job event snapshot work through the HTTP API', async (t) => {
  const { url, jobs, root } = await fixture(t);
  const { cookie } = await setup(url);
  const post = (route, body) => fetch(`${url}${route}`, json(body, cookie));
  const installPath = path.win32.join(root, 'settings-install');
  const install = await (await post('/api/installs', { path: installPath })).json();
  const server = await (
    await post('/api/servers', {
      name: 'Settings',
      map: 'TheIsland',
      sessionName: 'Before',
      installId: install.id,
      gamePort: 7777,
      queryPort: 27015,
      rconPort: 27020,
      maxPlayers: 70,
    })
  ).json();
  const paths = serverPaths(installPath);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(
    paths.gameUserSettingsPath,
    '[SessionSettings]\r\nSessionName=Before\r\n[ServerSettings]\r\nXPMultiplier=1.0\r\n',
  );
  const get = (route) => fetch(`${url}${route}`, { headers: { Cookie: cookie } });
  const read = await (await get(`/api/servers/${server.id}/settings`)).json();
  assert.equal(read.sessionName, 'Before');
  const write = await fetch(`${url}/api/servers/${server.id}/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionName: 'After', XPMultiplier: 2 }),
  });
  assert.equal(write.status, 200);
  assert.match(fs.readFileSync(paths.gameUserSettingsPath, 'utf8'), /SessionName=After/);
  const invalid = await fetch(`${url}/api/servers/${server.id}/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ XPMultiplier: 1000 }),
  });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).errors.length);
  assert.deepEqual(await (await get('/api/settings/search?q=rate')).json(), [
    { key: 'rate', count: (await (await get('/api/settings/fields')).json()).length },
  ]);
  assert.ok(jobs.get(1));
  const response = await get('/api/jobs/events');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  await reader.cancel();
  assert.ok(fs.existsSync(path.join(root, 'data')));
});

test('Phase 0 import preview and apply use expiring HTTP tokens and detect changed settings', async (t) => {
  const { url, root } = await fixture(t);
  const { cookie } = await setup(url);
  const dashboardDir = path.join(root, 'dashboard'),
    installRoot = path.win32.join(root, 'legacy-install');
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
  fs.writeFileSync(paths.gameUserSettingsPath, '[SessionSettings]\r\nSessionName=Legacy\r\n');
  const post = (route, body) => fetch(`${url}${route}`, json(body, cookie));
  const preview = await post('/api/import/preview', { dashboardDir });
  assert.equal(preview.status, 200);
  const token = (await preview.json()).token;
  const imported = await post('/api/import/apply', { token, profileId: 'one' });
  assert.equal(imported.status, 200);
  const secondPreview = await post('/api/import/preview', { dashboardDir });
  const secondToken = (await secondPreview.json()).token;
  fs.appendFileSync(paths.gameUserSettingsPath, '[ServerSettings]\r\nXPMultiplier=2\r\n');
  const apply = await post('/api/import/apply', { token: secondToken, profileId: 'one' });
  assert.equal(apply.status, 409);
  assert.equal((await apply.json()).code, 'CHANGED_SINCE_PREVIEW');
  const expired = await post('/api/import/apply', { token: 'missing', profileId: 'one' });
  assert.equal(expired.status, 410);
});

// Raw requests, so the Host header can be set to what a DNS-rebinding page would send.
function rawRequest(url, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('a request addressed to an unknown host name is refused before anything else', async (t) => {
  const { url, db } = await fixture(t);
  const body = JSON.stringify({ password: 'correct horse battery' });
  const rebound = await rawRequest(url, {
    method: 'POST',
    path: '/api/auth/setup',
    headers: { Host: 'evil.test:3310', Origin: 'http://evil.test:3310', 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(rebound.status, 421);
  assert.equal(JSON.parse(rebound.text).error, AUTH_MESSAGES.unknownHost);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  // Positive control: the same request addressed to localhost sets the password.
  const local = await rawRequest(url, {
    method: 'POST',
    path: '/api/auth/setup',
    headers: { Host: 'localhost:3310', 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(local.status, 200);
});

test('a server name that is taken, empty or too long, and a bad session name, are refused', async (t) => {
  const { url } = await fixture(t);
  const { cookie } = await setup(url);
  const post = (route, body) => fetch(`${url}${route}`, json(body, cookie));
  const install = await (await post('/api/installs', { path: 'C:\\Games\\ARK' })).json();
  const base = {
    name: 'Main',
    map: 'TheIsland',
    sessionName: 'Main',
    installId: install.id,
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    maxPlayers: 70,
  };
  assert.equal((await post('/api/servers', base)).status, 200);
  const taken = await post('/api/servers', {
    ...base,
    name: 'main',
    gamePort: 7779,
    queryPort: 27016,
    rconPort: 27021,
  });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, API_MESSAGES.nameTaken);
  for (const [change, message] of [
    [{ name: '' }, API_MESSAGES.badName],
    [{ name: 'x'.repeat(65) }, API_MESSAGES.badName],
    [{ sessionName: 'a?b' }, API_MESSAGES.badSessionName],
    [{ sessionName: 'a"b' }, API_MESSAGES.badSessionName],
    [{ sessionName: 'a\nb' }, API_MESSAGES.badSessionName],
    [{ map: 42 }, API_MESSAGES.badMap],
  ]) {
    const response = await post('/api/servers', { ...base, name: 'Other', gamePort: 7779, ...change });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.equal((await response.json()).error, message);
  }
});

test('an install path already added, in any letter case, is refused', async (t) => {
  const { url } = await fixture(t);
  const { cookie } = await setup(url);
  const post = (body) => fetch(`${url}/api/installs`, json(body, cookie));
  assert.equal((await post({ path: 'C:\\Games\\ARK' })).status, 200);
  const again = await post({ path: 'c:\\games\\ark\\' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, API_MESSAGES.installExists);
});

test('an import preview of a relative folder is refused', async (t) => {
  const { url } = await fixture(t);
  const { cookie } = await setup(url);
  const response = await fetch(`${url}/api/import/preview`, json({ dashboardDir: 'dashboard' }, cookie));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, API_MESSAGES.relativePath);
});

test('an unknown API path is a JSON 404 and a failing handler is a JSON 500 without its message', async (t) => {
  const logged = [];
  const { url, cookie } = await fixtureWith(t, {
    isElevated: async () => {
      throw new Error('net session broke password=hunter2');
    },
    log: (line) => logged.push(line),
  });
  const missing = await fetch(`${url}/api/nothing`, { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, API_MESSAGES.notFound);
  const broken = await fetch(`${url}/api/host`, { headers: { Cookie: cookie } });
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: API_MESSAGES.serverError });
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /hunter2/);
});

test('a signed-in page request is served from the public folder, and a signed-out one is not', async (t) => {
  const { url, cookie } = await fixtureWith(t);
  assert.equal(await (await fetch(url, { headers: { Cookie: cookie } })).text(), 'app');
  const out = await fetch(`${url}/index.html`, { redirect: 'manual' });
  assert.equal(out.status, 302);
});

test('a PUT with a text body is refused as not JSON', async (t) => {
  const { url, cookie } = await fixtureWith(t);
  const response = await fetch(`${url}/api/servers/1/ports`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
});

// A fixture that is already signed in, with a few collaborators replaced.
async function fixtureWith(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(':memory:');
  // The engine is never started, so queued jobs stay queued and nothing runs.
  const kinds = ['install.install', 'install.update', 'install.validate', 'steamcmd.setup'];
  const jobs = createJobEngine({ db, handlers: Object.fromEntries(kinds.map((kind) => [kind, async () => ({})])) });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'index.html'), 'app');
  const app = createApp({
    db,
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    jobs,
    supervisor: { status: () => ({}) },
    steamcmd: { isInstalled: () => false },
    runner: async () => ({ code: 0 }),
    platform: {},
    listListeners: async () => [],
    firewallRules: async () => [],
    isElevated: async () => false,
    rankFields: async () => [],
    log: () => {},
    ...overrides,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await jobs.stop({ abort: true });
    await app.close();
    db.close();
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const { cookie } = await setup(url);
  return { url, cookie, db };
}

test('a request line that is not a URL is a 400 and the server keeps answering', async (t) => {
  const { url } = await fixtureWith(t);
  assert.equal((await rawRequest(url, { path: '//', headers: { Host: 'localhost:3310' } })).status, 400);
  assert.equal((await fetch(`${url}/api/auth/state`)).status, 200);
});

test('a cookie with a broken escape is ignored rather than failing the request', async (t) => {
  const { url, cookie } = await fixtureWith(t);
  const broken = await fetch(`${url}/api/auth/state`, { headers: { Cookie: 'overseer_session=%' } });
  assert.equal(broken.status, 200);
  assert.equal((await broken.json()).signedIn, false);
  // Positive control: the real cookie next to a broken one still signs in.
  const both = await fetch(`${url}/api/auth/state`, { headers: { Cookie: `junk=%E0; ${cookie}` } });
  assert.equal((await both.json()).signedIn, true);
});

test('the owner can list and remove passkeys, and only while signed in', async (t) => {
  const { url, cookie, db } = await fixtureWith(t);
  db.prepare(
    "INSERT INTO user_passkeys (created_at, user_id, credential_id, public_key, rp_id, label) VALUES (?, 1, 'cred', x'00', 'localhost', 'Laptop')",
  ).run(new Date().toISOString());
  assert.equal((await fetch(`${url}/api/auth/passkeys`)).status, 401);
  const list = await (await fetch(`${url}/api/auth/passkeys`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(
    list.map((k) => [k.rp_id, k.label]),
    [['localhost', 'Laptop']],
  );
  assert.equal(list[0].public_key, undefined);
  assert.equal((await fetch(`${url}/api/auth/passkey/remove`, json({ id: list[0].id }))).status, 401);
  const removed = await fetch(`${url}/api/auth/passkey/remove`, json({ id: list[0].id }, cookie));
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM user_passkeys').get().n, 0);
});

test('the read routes and the job routes answer for a signed-in owner', async (t) => {
  const { url, cookie, db } = await fixtureWith(t, {
    listListeners: async () => [{ protocol: 'udp', port: 7777, pid: 5, state: null }],
  });
  const get = async (route) => {
    const response = await fetch(`${url}${route}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const post = (route, body = {}) => fetch(`${url}${route}`, json(body, cookie));
  assert.deepEqual(await get('/api/auth/state'), { signedIn: true, needsSetup: false, passkeysAvailable: false });
  const install = await (await post('/api/installs', { path: 'C:\\Games\\ARK' })).json();
  assert.deepEqual(
    (await get('/api/installs')).map((row) => [row.path, row.state, row.source]),
    [['C:\\Games\\ARK', 'missing', 'steamcmd']],
  );
  assert.deepEqual(await get('/api/servers'), []);
  // The listener on 7777 holds that game port, so the suggestion moves on.
  assert.deepEqual(await get('/api/ports/suggest'), { gamePort: 7779, queryPort: 27015, rconPort: 27020 });
  assert.equal((await post(`/api/installs/${install.id}/update`)).status, 200);
  assert.equal((await post(`/api/installs/${install.id}/validate`)).status, 200);
  assert.equal((await post('/api/installs/999/update')).status, 404);
  assert.equal((await post('/api/steamcmd/setup')).status, 200);
  const kinds = (await get('/api/jobs')).map((job) => job.kind).sort();
  assert.deepEqual(kinds, ['install.install', 'install.update', 'install.validate', 'steamcmd.setup']);
  const queued = (await get('/api/jobs?state=queued'))[0];
  assert.equal((await post(`/api/jobs/${queued.id}/cancel`)).status, 200);
  assert.equal((await post('/api/jobs/999/cancel')).status, 404);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action = 'job.cancel'").get());
});

test('the firewall apply runs the previewed script with elevation taken from the check', async (t) => {
  const calls = [];
  const { url, cookie } = await fixtureWith(t, {
    isElevated: async () => false,
    pwshPath: 'C:\\Tools\\pwsh.exe',
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0 };
    },
  });
  const post = (route, body = {}) => fetch(`${url}${route}`, json(body, cookie));
  const install = await (await post('/api/installs', { path: 'C:\\Games\\ARK' })).json();
  const server = await (
    await post('/api/servers', {
      name: 'One',
      map: 'TheIsland',
      sessionName: 'One',
      installId: install.id,
      gamePort: 7777,
      queryPort: 27015,
      rconPort: 27020,
      maxPlayers: 70,
    })
  ).json();
  const preview = await (
    await fetch(`${url}/api/servers/${server.id}/firewall`, { headers: { Cookie: cookie } })
  ).json();
  const result = await (await post(`/api/servers/${server.id}/firewall/apply`, { token: preview.token })).json();
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  // Not elevated, so the one call is pwsh running elevate.ps1, and apply.cmd next to it is the preview's script.
  assert.equal(calls[0].command, 'C:\\Tools\\pwsh.exe');
  const scriptPath = path.join(calls[0].options.cwd, 'apply.cmd');
  assert.equal(fs.readFileSync(scriptPath, 'utf8'), preview.script);
});
