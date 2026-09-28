import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createSupervisor } from '../src/supervisor/supervisor.js';

function setup(t, overrides = {}) {
  const db = openDatabase(':memory:');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, ?)').run(stamp, stamp, 'host');
  db.prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, 1, ?)').run(
    stamp,
    stamp,
    'C:\\ARK',
  );
  for (let i = 1; i <= 2; i += 1)
    db.prepare(
      'INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port, rcon_port) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)',
    ).run(stamp, stamp, `server${i}`, 'TheIsland', `Server ${i}`, 7776 + i, 27020 + i);
  const live = new Map();
  const spawns = [];
  const kills = [];
  const rcons = [];
  let attempts = 0;
  let listCalls = 0;
  let time = 0;
  const clock = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      for (const [pid, proc] of live) if (proc.diesAt !== undefined && time >= proc.diesAt) live.delete(pid);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const platform = {
    spawnServer: async (launch) => {
      const pid = ++attempts;
      spawns.push({ pid, launch });
      const behavior = overrides.spawn?.(pid, launch) ?? {};
      if (behavior.alive !== false)
        live.set(pid, {
          pid,
          exePath: launch.exePath,
          commandLine: launch.args.join(' '),
          startedAt: `2026-01-01T00:00:0${pid}.000Z`,
          ...behavior,
        });
      return { pid };
    },
    processInfo: async (pid) => {
      if (overrides.processError) throw new Error('lookup failed');
      return live.get(pid) ?? null;
    },
    listServerProcesses: async () => {
      listCalls += 1;
      if (overrides.listError) throw new Error('listing failed');
      return [...live.values()];
    },
    killPid: async (pid) => {
      kills.push(pid);
      live.delete(pid);
    },
  };
  const supervisor = createSupervisor({
    db,
    platform,
    clock,
    rcon: async (args) => {
      rcons.push(args.command);
      if (overrides.rconError) throw new Error('no rcon');
      if (args.command === 'DoExit' && overrides.exitOnRcon) live.clear();
      return '';
    },
    getRconPassword: () => 'secret',
    options: {
      surviveMs: 2000,
      startupAttempts: 2,
      retryDelayMs: 1000,
      stopTimeoutMs: 3000,
      adoptionMissMs: 2000,
      restartBackoffMs: [1000, 2000],
      crashLoopLimit: 2,
      crashLoopWindowMs: 10000,
    },
  });
  t.after(() => db.close());
  return {
    db,
    supervisor,
    live,
    spawns,
    kills,
    rcons,
    platform,
    clock,
    get time() {
      return time;
    },
    get listCalls() {
      return listCalls;
    },
  };
}

test('start records a surviving process and its start time', async (t) => {
  const ctx = setup(t);
  const result = await ctx.supervisor.start(1);
  assert.equal(result.observedState, 'running');
  assert.equal(result.pid, 1);
  assert.ok(result.startedAt);
});

test('start retries when its process exits during the survive window', async (t) => {
  const ctx = setup(t, { spawn: (pid) => (pid === 1 ? { diesAt: 500 } : {}) });
  assert.equal((await ctx.supervisor.start(1)).pid, 2);
  assert.equal(ctx.spawns.length, 2);
});

test('start reports the attempt count and clears pid after repeated failures', async (t) => {
  const ctx = setup(t, { spawn: () => ({ diesAt: 1 }) });
  await assert.rejects(ctx.supervisor.start(1), /2 attempt/);
  assert.equal(ctx.supervisor.status(1).pid, null);
  assert.equal(ctx.supervisor.status(1).observedState, 'crashed');
});

test('start on a running server does not spawn twice', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  await ctx.supervisor.start(1);
  assert.equal(ctx.spawns.length, 1);
});

test('stop sends save then exit and resolves after graceful exit', async (t) => {
  const ctx = setup(t, { exitOnRcon: true });
  await ctx.supervisor.start(1);
  const result = await ctx.supervisor.stop(1);
  assert.deepEqual(ctx.rcons, ['SaveWorld', 'DoExit']);
  assert.equal(result.graceful, true);
  assert.equal(ctx.kills.length, 0);
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('stop force kills after its timeout when graceful shutdown does not exit', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  const result = await ctx.supervisor.stop(1);
  assert.equal(result.forced, true);
  assert.equal(ctx.kills.length, 1);
});

test('stop does not kill a reused pid with a different start time', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  const row = ctx.db.prepare('SELECT pid FROM servers WHERE id=1').get();
  ctx.live.set(row.pid, { ...ctx.live.get(row.pid), startedAt: '2030-01-01T00:00:00.000Z' });
  const result = await ctx.supervisor.stop(1);
  assert.equal(result.forced, false);
  assert.equal(ctx.kills.length, 0);
});

test('RCON failure during stop still waits and forces the owned process', async (t) => {
  const ctx = setup(t, { rconError: true });
  await ctx.supervisor.start(1);
  const result = await ctx.supervisor.stop(1);
  assert.equal(result.forced, true);
});

test('poll adopts exactly one matching process and rejects ambiguous adoption', async (t) => {
  const ctx = setup(t);
  const launch = (await import('../src/supervisor/launch.js')).buildLaunch(
    ctx.db.prepare('SELECT * FROM servers WHERE id=1').get(),
    { path: 'C:\\ARK' },
  );
  ctx.live.set(20, {
    pid: 20,
    exePath: launch.exePath,
    commandLine: '-port=7777',
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).pid, 20);
  const other = setup(t);
  other.live.set(20, { pid: 20, exePath: launch.exePath, commandLine: '-port=7777' });
  other.live.set(21, { pid: 21, exePath: launch.exePath, commandLine: '-port=7777' });
  await other.supervisor.poll(1);
  assert.equal(other.supervisor.status(1).pid, null);
});

test('adoption miss skips process listing until the miss window expires', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.poll(1);
  await ctx.supervisor.poll(1);
  assert.equal(ctx.listCalls, 1);
  await ctx.clock.sleep(2001);
  await ctx.supervisor.poll(1);
  assert.equal(ctx.listCalls, 2);
});

test('process listing failure marks unknown without killing or clearing state', async (t) => {
  const ctx = setup(t, { listError: true });
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'unknown');
  assert.equal(ctx.kills.length, 0);
});

test('poll moves a vanished stopped process to stopped', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  ctx.db.prepare("UPDATE servers SET desired_state='stopped' WHERE id=1").run();
  ctx.live.clear();
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('recover adopts or starts desired running servers', async (t) => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE servers SET desired_state='running' WHERE id=2").run();
  await ctx.supervisor.start(1);
  await ctx.supervisor.recover();
  assert.equal(ctx.supervisor.status(1).observedState, 'running');
  assert.equal(ctx.supervisor.status(2).observedState, 'running');
});

test('restart stops and starts within one serialized action', async (t) => {
  const ctx = setup(t, { exitOnRcon: true });
  await ctx.supervisor.start(1);
  const before = ctx.spawns.length;
  await ctx.supervisor.restart(1);
  assert.equal(ctx.spawns.length, before + 1);
  assert.equal(ctx.supervisor.status(1).observedState, 'running');
});

test('state events include transitions and throwing listeners are ignored', async (t) => {
  const ctx = setup(t);
  const events = [];
  ctx.supervisor.subscribe((event) => events.push(event));
  ctx.supervisor.subscribe(() => {
    throw new Error('listener');
  });
  await ctx.supervisor.start(1);
  assert.ok(events.some((event) => event.from === 'stopped' && event.to === 'starting' && event.reason));
});

test('a crash of a running server is restarted after the first backoff delay', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  ctx.live.clear();
  const crashedAt = ctx.time;
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'crashed');
  await waitFor(() => ctx.spawns.length === 2);
  assert.ok(ctx.time - crashedAt >= 1000);
  await waitFor(() => ctx.supervisor.status(1).observedState === 'running');
});

test('crash-loop protection trips on automatic restarts, and a manual start clears it', async (t) => {
  const overrides = {};
  const ctx = setup(t, overrides);
  // A window long enough that the fake clock's jumps never age a crash out of it.
  const supervisor = createSupervisor({
    db: ctx.db,
    platform: ctx.platform,
    clock: ctx.clock,
    options: { surviveMs: 2000, restartBackoffMs: [1000, 2000], crashLoopLimit: 2, crashLoopWindowMs: 600000 },
  });
  // Every process survives startup, then dies 5 seconds later.
  overrides.spawn = () => ({ diesAt: ctx.time + 5000 });
  await supervisor.start(1);
  for (let round = 0; round < 10 && !supervisor.status(1).crashLoop; round++) {
    await ctx.clock.sleep(5000);
    await supervisor.poll(1);
    await waitFor(() => supervisor.status(1).crashLoop || supervisor.status(1).observedState === 'running');
  }
  const status = supervisor.status(1);
  assert.equal(status.crashLoop, true);
  assert.equal(status.observedState, 'crashed');
  // One manual start plus crashLoopLimit (2) automatic restarts, then no more.
  assert.equal(ctx.spawns.length, 3);
  overrides.spawn = undefined;
  await supervisor.start(1);
  assert.equal(supervisor.status(1).crashLoop, false);
  assert.equal(supervisor.status(1).observedState, 'running');
});

test('a stop issued during a start runs after the start finishes, while other servers proceed', async (t) => {
  const ctx = setup(t);
  const order = [];
  ctx.supervisor.subscribe((event) => order.push(`${event.serverId}:${event.to}`));
  const starting = ctx.supervisor.start(1);
  const stopping = ctx.supervisor.stop(1);
  const other = await ctx.supervisor.start(2);
  await starting;
  await stopping;
  assert.equal(other.observedState, 'running');
  assert.ok(order.indexOf('1:running') < order.indexOf('1:stopping'));
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('stopPolling cancels a pending automatic restart', async (t) => {
  const ctx = setup(t);
  const slowClock = { now: ctx.clock.now, sleep: (ms, signal) => realSleep(ms > 1000 ? 30 : 0, signal) };
  const supervisor = createSupervisor({
    db: ctx.db,
    platform: ctx.platform,
    clock: slowClock,
    options: { surviveMs: 0, restartBackoffMs: [5000] },
  });
  await supervisor.start(1);
  ctx.live.clear();
  await supervisor.poll(1);
  assert.equal(supervisor.status(1).observedState, 'crashed');
  await supervisor.stopPolling();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ctx.spawns.length, 1);
});

test('a spawn that fails ends crashed instead of stuck starting', async (t) => {
  const ctx = setup(t);
  ctx.platform.spawnServer = async () => {
    throw new Error('ArkAscendedServer.exe not found');
  };
  await assert.rejects(ctx.supervisor.start(1), /could not launch the server: ArkAscendedServer.exe not found/);
  assert.equal(ctx.supervisor.status(1).observedState, 'crashed');
});

test('lookups failing during startup end unknown with the pid kept, and a later poll settles it', async (t) => {
  const overrides = {};
  const ctx = setup(t, overrides);
  const spawn = ctx.platform.spawnServer;
  ctx.platform.spawnServer = async (launch) => {
    const result = await spawn(launch);
    overrides.processError = true;
    return result;
  };
  await assert.rejects(ctx.supervisor.start(1), /could not confirm the server started/);
  assert.equal(ctx.supervisor.status(1).observedState, 'unknown');
  assert.equal(ctx.supervisor.status(1).pid, 1);
  overrides.processError = false;
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'running');
});

test('a poll that finds nothing new changes nothing and emits nothing', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  const before = ctx.supervisor.status(1).changedAt;
  const events = [];
  ctx.supervisor.subscribe((event) => events.push(event));
  await ctx.clock.sleep(5000);
  await ctx.supervisor.poll(1);
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).changedAt, before);
  assert.deepEqual(events, []);
});

test('a poll keeps a failed start as crashed rather than relabelling it stopped', async (t) => {
  const ctx = setup(t, { spawn: () => ({ diesAt: 1 }) });
  await assert.rejects(ctx.supervisor.start(1));
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'crashed');
});

test('a crash during a lookup outage is still restarted once lookups recover', async (t) => {
  const overrides = {};
  const ctx = setup(t, overrides);
  await ctx.supervisor.start(1);
  overrides.processError = true;
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'unknown');
  ctx.live.clear();
  overrides.processError = false;
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'crashed');
  await waitFor(() => ctx.spawns.length === 2);
});

test('stop with no recorded pid adopts a live owned process and stops it', async (t) => {
  const ctx = setup(t);
  ctx.live.set(50, {
    pid: 50,
    exePath: 'C:\\ARK\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe',
    commandLine: 'TheIsland?listen -port=7777 -log',
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  const result = await ctx.supervisor.stop(1);
  assert.deepEqual(ctx.rcons, ['SaveWorld', 'DoExit']);
  assert.equal(result.forced, true);
  assert.deepEqual(ctx.kills, [50]);
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('a slow SaveWorld still sends DoExit, and a socket closed by DoExit counts as graceful', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  const sent = [];
  const rcon = async ({ command, timeoutMs }) => {
    sent.push({ command, timeoutMs });
    if (command === 'SaveWorld') throw new Error('RCON timeout after 120000ms');
    ctx.live.clear();
    throw new Error('RCON socket closed early');
  };
  const supervisor = createSupervisor({
    db: ctx.db,
    platform: ctx.platform,
    clock: ctx.clock,
    rcon,
    getRconPassword: () => 'secret',
  });
  const result = await supervisor.stop(1);
  assert.deepEqual(
    sent.map((entry) => entry.command),
    ['SaveWorld', 'DoExit'],
  );
  assert.equal(sent[0].timeoutMs, 120000);
  assert.equal(result.graceful, true);
  assert.equal(result.forced, false);
});

test('a kill that fails because the process just exited still ends stopped', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  ctx.platform.killPid = async (pid) => {
    ctx.live.delete(pid);
    throw new Error('process not found');
  };
  const result = await ctx.supervisor.stop(1);
  assert.equal(result.forced, true);
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('an automatic restart that fails schedules another one', async (t) => {
  const overrides = {};
  const ctx = setup(t, overrides);
  await ctx.supervisor.start(1);
  overrides.spawn = () => ({ diesAt: 1 });
  ctx.live.clear();
  await ctx.supervisor.poll(1);
  // The first restart (2 attempts) fails; a second one is scheduled and fails too.
  await waitFor(() => ctx.spawns.length >= 5);
});

test('one empty lookup for a running server is checked again before it counts as a crash', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  const lookup = ctx.platform.processInfo;
  let calls = 0;
  ctx.platform.processInfo = async (pid) => {
    calls += 1;
    return calls === 1 ? null : lookup(pid);
  };
  await ctx.supervisor.poll(1);
  assert.equal(ctx.supervisor.status(1).observedState, 'running');
  assert.equal(ctx.spawns.length, 1);
});

test('recover does not start a server whose process lookup failed', async (t) => {
  const overrides = {};
  const ctx = setup(t, overrides);
  ctx.db.prepare("UPDATE servers SET desired_state = 'running' WHERE id = 1").run();
  overrides.listError = true;
  await ctx.supervisor.recover();
  assert.equal(ctx.supervisor.status(1).observedState, 'unknown');
  assert.equal(ctx.spawns.length, 0);
});

test('stop will not force-kill a process whose start time was never recorded', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  ctx.db.prepare('UPDATE servers SET pid_started_at = NULL WHERE id = 1').run();
  ctx.live.get(1).startedAt = null;
  await assert.rejects(ctx.supervisor.stop(1), /cannot be force-stopped safely/);
  assert.deepEqual(ctx.kills, []);
  assert.equal(ctx.supervisor.status(1).observedState, 'unknown');
});

function realSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    });
  });
}

async function waitFor(predicate, tries = 500) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('a server does not start while its install is being updated', async (t) => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE installs SET state = 'updating' WHERE id = 1").run();
  await assert.rejects(ctx.supervisor.start(1), /cannot start while its install is updating/);
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.supervisor.status(1).observedState, 'stopped');
});

test('an automatic restart waits for an install update without counting it as a crash', async (t) => {
  const ctx = setup(t);
  await ctx.supervisor.start(1);
  ctx.db.prepare("UPDATE installs SET state = 'updating' WHERE id = 1").run();
  ctx.live.clear();
  await ctx.supervisor.poll(1);
  await ctx.clock.sleep(20000);
  assert.equal(ctx.spawns.length, 1);
  assert.equal(ctx.supervisor.status(1).crashLoop, false);
  ctx.db.prepare("UPDATE installs SET state = 'installed' WHERE id = 1").run();
  await waitFor(() => ctx.spawns.length === 2);
});
