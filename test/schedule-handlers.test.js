import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createScheduleHandlers, PLAYER_MESSAGES } from '../src/scheduler/handlers.js';

const T = '2026-01-01T00:00:00.000Z';

// One install with two servers on it, backed by real folders so backups have files to copy.
function world(t, { source = 'steamcmd', build = '100', running = [1] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-handlers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'ASA');
  for (const map of ['TheIsland_WP', 'Ragnarok_WP']) {
    const saves = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks', map);
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(saves, `${map}.ark`), `world ${map}`);
  }
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, source, build_id, created_at, updated_at) VALUES (1, 1, ?, 'installed', ?, ?, ?, ?)",
  ).run(installPath, source, build, T, T);
  const addServer = db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, rcon_port, created_at, updated_at) VALUES (?, 1, 1, ?, ?, 's', ?, ?, ?, ?)",
  );
  addServer.run(1, 'One', 'TheIsland_WP', 7777, 27020, T, T);
  addServer.run(2, 'Two', 'Ragnarok_WP', 7779, 27021, T, T);
  db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (1, ?, ?, 'x', 'running')").run(T, T);
  const events = [];
  const states = new Map([1, 2].map((id) => [id, running.includes(id) ? 'running' : 'stopped']));
  const supervisor = {
    status: (id) => ({ observedState: states.get(id) }),
    restart: async (id) => events.push(['restart', id]),
    stop: async (id) => {
      events.push(['stop', id]);
      states.set(id, 'stopped');
    },
    start: async (id) => {
      events.push(['start', id]);
      states.set(id, 'running');
    },
  };
  const rcon = async ({ port, command }) => {
    events.push(['rcon', port, command]);
    if (world.failRcon) throw new Error('connection refused');
  };
  const steamcmd = {
    latestBuildId: async () => world.latest ?? '101',
    appUpdate: async () => {
      events.push(['update']);
      if (world.failUpdate) throw new Error('SteamCMD failed');
      return { output: '' };
    },
    readManifest: () => ({ buildId: world.failUpdate ? '100' : '101', fullyInstalled: true }),
  };
  const handlers = createScheduleHandlers({
    db,
    dataDir: path.join(root, 'data'),
    steamcmd,
    supervisor,
    rcon,
    getRconPassword: () => 'pw',
    sleep: async (ms, signal) => {
      events.push(['sleep', ms / 60000]);
      if (world.abortOnSleep) world.controller.abort(new Error('cancelled'));
      if (signal.aborted) throw signal.reason;
    },
    now: () => Date.parse(T),
  });
  world.controller = new AbortController();
  const ctx = (params = {}, target = { serverId: 1 }) => ({
    job: { id: 1, ...target },
    params,
    signal: world.controller.signal,
    progress: (fraction, message) => events.push(['progress', message]),
  });
  return { db, events, handlers, ctx, states, root };
}
test.afterEach(() => {
  for (const key of ['failRcon', 'failUpdate', 'latest', 'abortOnSleep']) delete world[key];
});

test('a scheduled restart warns at each mark, waits the gaps, then restarts', async (t) => {
  const { handlers, ctx, events } = world(t);
  const result = await handlers['server.restart'](ctx({ countdownMinutes: [10, 5, 1] }));
  assert.deepEqual(result, { restarted: true });
  assert.deepEqual(events, [
    ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.restart(10)}`],
    ['sleep', 5],
    ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.restart(5)}`],
    ['sleep', 4],
    ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.restart(1)}`],
    ['sleep', 1],
    ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.restarting}`],
    ['restart', 1],
  ]);
  assert.match(PLAYER_MESSAGES.restart(1), /^Restart in 1 minute. /);
});

test('broadcast is used when asked for', async (t) => {
  const { handlers, ctx, events } = world(t);
  await handlers['server.restart'](ctx({ countdownMinutes: [1], announce: 'broadcast' }));
  assert.ok(events.filter((e) => e[0] === 'rcon').every((e) => e[2].startsWith('Broadcast ')));
});

test('a stopped server is not restarted, before or during the countdown', async (t) => {
  const stopped = world(t, { running: [] });
  assert.deepEqual(await stopped.handlers['server.restart'](stopped.ctx()), { skipped: 'not running' });
  assert.deepEqual(stopped.events, []);
  const midway = world(t);
  const sleepFirst = midway.handlers['server.restart'];
  midway.states.set(1, 'running');
  // Someone stops the server while the countdown runs.
  const original = midway.events.push.bind(midway.events);
  midway.events.push = (entry) => {
    if (entry[0] === 'sleep') midway.states.set(1, 'stopped');
    return original(entry);
  };
  const result = await sleepFirst(midway.ctx({ countdownMinutes: [5] }));
  assert.deepEqual(result, { skipped: 'stopped during the countdown' });
  assert.ok(!midway.events.some((e) => e[0] === 'restart'));
});

test('a cancelled restart tells players and does not restart', async (t) => {
  const { handlers, ctx, events } = world(t);
  world.abortOnSleep = true;
  await assert.rejects(handlers['server.restart'](ctx({ countdownMinutes: [10, 5] })), /cancelled/);
  assert.deepEqual(events.at(-1), ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.cancelled}`]);
  assert.ok(!events.some((e) => e[0] === 'restart'));
});

test('a failed warning is noted and the countdown goes on', async (t) => {
  const { handlers, ctx, events } = world(t);
  world.failRcon = true;
  assert.deepEqual(await handlers['server.restart'](ctx({ countdownMinutes: [2, 1] })), { restarted: true });
  assert.equal(events.filter((e) => e[0] === 'progress').length, 2);
  assert.match(events.find((e) => e[0] === 'progress')[1], /One did not get the in-game warning/);
  assert.deepEqual(events.at(-1), ['restart', 1]);
});

test('check_update stores the builds and compares them as text', async (t) => {
  const { handlers, ctx, db } = world(t);
  world.latest = 101;
  assert.deepEqual(await handlers['install.check_update'](ctx({}, { installId: 1 })), {
    current: '100',
    latest: '101',
    updateAvailable: true,
  });
  const row = db.prepare('SELECT latest_build_id, update_checked_at FROM installs').get();
  assert.deepEqual({ ...row }, { latest_build_id: '101', update_checked_at: T });
  world.latest = 100;
  assert.equal((await handlers['install.check_update'](ctx({}, { installId: 1 }))).updateAvailable, false);
});

test('auto_update with no new build changes nothing', async (t) => {
  const { handlers, ctx, events, db } = world(t);
  world.latest = '100';
  assert.equal((await handlers['install.auto_update'](ctx({}, { installId: 1 }))).updated, false);
  assert.deepEqual(events, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backups').get().n, 0);
});

test('auto_update warns, stops, backs up every server, updates, and starts only what was running', async (t) => {
  const { handlers, ctx, events, db } = world(t, { running: [1] });
  const result = await handlers['install.auto_update'](ctx({ countdownMinutes: [2, 1] }, { installId: 1 }));
  assert.deepEqual(result, { updated: true, from: '100', to: '101', restarted: [1] });
  const steps = events.filter((e) => e[0] !== 'progress').map((e) => (e[0] === 'rcon' ? `rcon ${e[1]}` : e[0]));
  assert.deepEqual(steps, ['rcon 27020', 'sleep', 'rcon 27020', 'sleep', 'rcon 27020', 'stop', 'update', 'start']);
  // Server 2 was stopped already: no warning, no stop, no start, but it is still backed up.
  assert.deepEqual(
    db
      .prepare('SELECT server_id, reason FROM backups ORDER BY server_id')
      .all()
      .map((r) => ({ ...r })),
    [
      { server_id: 1, reason: 'pre_update' },
      { server_id: 2, reason: 'pre_update' },
    ],
  );
  assert.equal(db.prepare('SELECT build_id FROM installs').get().build_id, '101');
});

test('auto_update with nothing running skips the countdown', async (t) => {
  const { handlers, ctx, events } = world(t, { running: [] });
  await handlers['install.auto_update'](ctx({}, { installId: 1 }));
  assert.deepEqual(
    events.map((e) => e[0]),
    ['update'],
  );
});

test('a failed update still starts the servers it stopped, on the old build, and fails the job', async (t) => {
  const { handlers, ctx, events, db } = world(t, { running: [1, 2] });
  world.failUpdate = true;
  await assert.rejects(
    handlers['install.auto_update'](ctx({ countdownMinutes: [1] }, { installId: 1 })),
    /SteamCMD failed/,
  );
  assert.deepEqual(
    events.filter((e) => e[0] === 'start').map((e) => e[1]),
    [1, 2],
  );
  assert.deepEqual(
    { ...db.prepare('SELECT state, build_id FROM installs').get() },
    { state: 'installed', build_id: '100' },
  );
});

test('a cancelled update countdown starts nothing it never stopped', async (t) => {
  const { handlers, ctx, events } = world(t, { running: [1] });
  world.abortOnSleep = true;
  await assert.rejects(handlers['install.auto_update'](ctx({ countdownMinutes: [5] }, { installId: 1 })), /cancelled/);
  assert.ok(!events.some((e) => e[0] === 'stop' || e[0] === 'start' || e[0] === 'update'));
  assert.deepEqual(events.at(-1), ['rcon', 27020, `ServerChat ${PLAYER_MESSAGES.cancelled}`]);
});

test('Steam library installs are refused for checks and updates', async (t) => {
  const { handlers, ctx, events } = world(t, { source: 'steam-client' });
  await assert.rejects(handlers['install.check_update'](ctx({}, { installId: 1 })), /Steam/);
  await assert.rejects(handlers['install.auto_update'](ctx({}, { installId: 1 })), /Steam/);
  assert.deepEqual(events, []);
});

test('a backup job for a missing server fails with a message', async (t) => {
  const { handlers, ctx } = world(t);
  await assert.rejects(handlers['server.backup'](ctx({}, { serverId: 99 })), /server was not found/);
});
