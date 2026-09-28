import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createGamingMode } from '../src/gaming/gaming-mode.js';

function fixture(t, cpuCount = 16) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (name,created_at,updated_at) VALUES ('local','x','x')").run();
  // One install per server, as the API requires.
  for (const path of ['x', 'y', 'z'])
    db.prepare('INSERT INTO installs (host_id,path,created_at,updated_at) VALUES (1,?,?,?)').run(path, 'x', 'x');
  const states = new Map([
    [1, { pid: 10, observedState: 'running' }],
    [2, { pid: 20, observedState: 'running' }],
  ]);
  const processes = [];
  const calls = [];
  let listingError = null,
    failPid = null;
  const timers = new Map();
  let timerId = 0;
  const clock = {
    now: () => 0,
    setTimer: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const platform = {
    listAllProcesses: async () => {
      if (listingError) throw listingError;
      return processes;
    },
    setProcessPolicy: async (pid, policy) => {
      calls.push([pid, policy]);
      if (pid === failPid) throw Error('Access is denied');
    },
  };
  const supervisor = { status: (id) => states.get(id) || {} };
  db.prepare(
    "INSERT INTO servers (id,host_id,install_id,name,map,session_name,game_port,created_at,updated_at) VALUES (1,1,1,'One','m','s',7777,'x','x'),(2,1,2,'Two','m','s',7778,'x','x')",
  ).run();
  const engine = createGamingMode({ db, platform, supervisor, clock, cpuCount, log: () => {} });
  return {
    db,
    engine,
    processes,
    calls,
    states,
    timers,
    clock,
    platform,
    setError: (v) => (listingError = v),
    setFail: (v) => (failPid = v),
  };
}
test('off does nothing; gaming applies masks once and restores after two empty polls', async (t) => {
  const f = fixture(t);
  await f.engine.refresh();
  assert.deepEqual(f.calls, []);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 30, parentPid: 29, name: 'Game.exe' });
  await f.engine.refresh();
  assert.deepEqual(
    f.calls.map(([pid, p]) => [pid, p.priority, p.affinityMask]),
    [
      [10, 'BelowNormal', '65280'],
      [20, 'BelowNormal', '65280'],
    ],
  );
  await f.engine.refresh();
  assert.equal(f.calls.length, 2);
  f.processes.length = 0;
  await f.engine.refresh();
  assert.equal(f.engine.status().state, 'gaming');
  await f.engine.refresh();
  assert.equal(f.engine.status().state, 'normal');
  assert.equal(f.calls.at(-1)[1].priority, 'Normal');
});
test('refresh failure preserves policies and turning off or stop restores changed servers', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 30, parentPid: 29, name: 'Game.exe' });
  await f.engine.refresh();
  f.setError(new Error('listing failed'));
  const n = f.calls.length;
  await f.engine.refresh();
  assert.equal(f.calls.length, n);
  f.setError(null);
  f.db.prepare('UPDATE hosts SET gaming_mode=0').run();
  await f.engine.refresh();
  assert.equal(f.calls.at(-1)[1].priority, 'Normal');
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 31, parentPid: 29, name: 'Game.exe' });
  await f.engine.refresh();
  await f.engine.stop();
  assert.equal(f.calls.at(-1)[1].priority, 'Normal');
  assert.equal(f.timers.size, 0);
});

test('custom core count, late servers, isolated access errors and gone pids', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1, gaming_game_cores=4').run();
  f.setFail(10);
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 30, parentPid: 29, name: 'Game.exe' });
  await f.engine.refresh();
  assert.equal(f.calls[0][1].affinityMask, '65520');
  assert.equal(f.engine.status().servers.find((s) => s.id === 1).error, 'Access is denied');
  assert.equal(
    f.calls.some(([pid]) => pid === 20),
    true,
  );
  f.states.set(3, { pid: 30, observedState: 'running' });
  f.db
    .prepare(
      "INSERT INTO servers (id,host_id,install_id,name,map,session_name,game_port,created_at,updated_at) VALUES (3,1,3,'Three','m','s',7779,'x','x')",
    )
    .run();
  await f.engine.refresh();
  assert.equal(f.calls.filter(([pid]) => pid === 30).length, 1);
  f.states.delete(1);
  await f.engine.refresh();
  assert.equal(
    f.engine.status().servers.some((s) => s.id === 1),
    false,
  );
});

test('the default clock works, so the engine starts without one being passed', async (t) => {
  const f = fixture(t);
  const engine = createGamingMode({
    db: f.db,
    platform: f.platform,
    supervisor: { status: () => ({}) },
    pollMs: 60000,
  });
  await engine.start();
  await engine.stop();
});

test('with no game running, servers it never throttled are left alone', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  await f.engine.refresh();
  await f.engine.refresh();
  assert.deepEqual(f.calls, []);
  assert.equal(f.engine.status().state, 'normal');
});

test('polls never overlap, and stop waits for a running poll before restoring', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 30, parentPid: 29, name: 'Game.exe' });
  let inFlight = 0,
    most = 0,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  f.platform.setProcessPolicy = async (pid, policy) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await gate;
    f.calls.push([pid, policy]);
    inFlight--;
  };
  const first = f.engine.refresh();
  const second = f.engine.refresh();
  const stopping = f.engine.stop();
  release();
  await Promise.all([first, second, stopping]);
  assert.ok(most <= 2, `at most one poll's servers at a time, saw ${most}`);
  // The last call for each server is the restore, after the gaming policy.
  for (const pid of [10, 20]) assert.equal(f.calls.filter(([p]) => p === pid).at(-1)[1].priority, 'Normal');
});

test('a server throttled under older settings is still put back when the game ends', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push({ pid: 29, parentPid: 0, name: 'steam.exe' }, { pid: 30, parentPid: 29, name: 'Game.exe' });
  await f.engine.refresh();
  f.db.prepare('UPDATE hosts SET gaming_game_cores=4').run();
  f.processes.splice(0);
  await f.engine.refresh();
  await f.engine.refresh();
  for (const pid of [10, 20]) assert.equal(f.calls.filter(([p]) => p === pid).at(-1)[1].priority, 'Normal');
  assert.deepEqual(
    f.engine.status().servers.map((s) => s.policy),
    ['normal', 'normal'],
  );
});

const GAME = [
  { pid: 29, parentPid: 0, name: 'steam.exe' },
  { pid: 30, parentPid: 29, name: 'Game.exe' },
];
const lastPriority = (calls, pid) => calls.filter(([p]) => p === pid).at(-1)?.[1].priority;

test('servers throttled before a restart are put back by the next engine', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push(...GAME);
  await f.engine.refresh();
  assert.equal(JSON.parse(f.db.prepare('SELECT gaming_applied_json AS j FROM hosts').get().j).length, 2);
  // ARK Overseer dies without a clean stop, and comes back after the game has closed.
  f.processes.splice(0);
  const calls = [];
  const next = createGamingMode({
    db: f.db,
    platform: { ...f.platform, setProcessPolicy: async (pid, policy) => calls.push([pid, policy]) },
    supervisor: { status: (id) => f.states.get(id) || {} },
    clock: f.clock,
    cpuCount: 16,
  });
  await next.start();
  assert.equal(lastPriority(calls, 10), 'Normal');
  assert.equal(lastPriority(calls, 20), 'Normal');
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT gaming_applied_json AS j FROM hosts').get().j), []);
  await next.stop();
});

test('a server that is briefly unknown is still put back once it is running again', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push(...GAME);
  await f.engine.refresh();
  f.states.set(1, { pid: 10, observedState: 'unknown' });
  f.processes.splice(0);
  await f.engine.refresh();
  await f.engine.refresh();
  assert.equal(lastPriority(f.calls, 10), 'BelowNormal');
  f.states.set(1, { pid: 10, observedState: 'running' });
  await f.engine.refresh();
  assert.equal(lastPriority(f.calls, 10), 'Normal');
});

test('a restarted server that reuses a pid is throttled again', async (t) => {
  const f = fixture(t);
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.states.set(1, { pid: 10, observedState: 'running', startedAt: 'first' });
  f.processes.push(...GAME);
  await f.engine.refresh();
  const before = f.calls.filter(([pid]) => pid === 10).length;
  f.states.set(1, { pid: 10, observedState: 'running', startedAt: 'second' });
  await f.engine.refresh();
  assert.equal(f.calls.filter(([pid]) => pid === 10).length, before + 1);
});

test('a failure is logged once per server and policy', async (t) => {
  const f = fixture(t);
  const logged = [];
  const engine = createGamingMode({
    db: f.db,
    platform: {
      ...f.platform,
      setProcessPolicy: async (pid) => {
        if (pid === 20) throw new Error('Access is denied');
      },
    },
    supervisor: { status: (id) => f.states.get(id) || {} },
    clock: f.clock,
    cpuCount: 16,
    log: (line) => logged.push(line),
  });
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  f.processes.push(...GAME);
  await engine.refresh();
  await engine.refresh();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Two .*Access is denied/);
  assert.equal(engine.status().servers.find((s) => s.id === 2).error, 'Access is denied');
});

test('masks and priority for 1, 2 and 64 processors', async (t) => {
  for (const [count, cores, expected] of [
    [1, null, '1'],
    [2, null, '2'],
    [64, null, String(((1n << 32n) - 1n) << 32n)],
    [64, 63, String(1n << 63n)],
  ]) {
    const f = fixture(t, count);
    f.db.prepare('UPDATE hosts SET gaming_mode=1, gaming_game_cores=?').run(cores);
    f.processes.push(...GAME);
    await f.engine.refresh();
    assert.deepEqual(f.calls[0][1], { priority: 'BelowNormal', affinityMask: expected }, `${count} processors`);
  }
});

test('a failed listing is logged, changes nothing and does not move the last check time', async (t) => {
  const f = fixture(t);
  const logged = [];
  const engine = createGamingMode({
    db: f.db,
    platform: {
      listAllProcesses: async () => {
        throw new Error('pwsh broke');
      },
      setProcessPolicy: f.platform.setProcessPolicy,
    },
    supervisor: { status: (id) => f.states.get(id) || {} },
    clock: f.clock,
    cpuCount: 16,
    log: (line) => logged.push(line),
  });
  f.db.prepare('UPDATE hosts SET gaming_mode=1').run();
  const status = await engine.refresh();
  assert.equal(status.checkedAt, null);
  assert.deepEqual(f.calls, []);
  assert.match(logged[0], /could not list processes: pwsh broke/);
});
