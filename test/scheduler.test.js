import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createScheduler, CATCH_UP_MS } from '../src/scheduler/scheduler.js';

const T = '2026-01-01T00:00:00.000Z';

function setup(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare("INSERT INTO installs (id, host_id, path, created_at, updated_at) VALUES (3, 1, 'C:/ark', ?, ?)").run(
    T,
    T,
  );
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, created_at, updated_at) VALUES (5, 1, 3, 's', 'TheIsland_WP', 's', 7777, ?, ?)",
  ).run(T, T);
  const addSchedule = ({
    kind = 'backup',
    cron = '* * * * *',
    enabled = 1,
    options = '{"keep":4}',
    next = T,
    lastJob = null,
  } = {}) =>
    Number(
      db
        .prepare(
          'INSERT INTO schedules (server_id, kind, cron, enabled, options_json, next_run_at, last_job_id, created_at, updated_at) VALUES (5, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(kind, cron, enabled, options, next, lastJob, T, T).lastInsertRowid,
    );
  const state = { clock: Date.parse(T), enqueued: [], delays: [], nextJob: 8 };
  const jobs = {
    enqueue: (...values) => {
      const id = state.nextJob++;
      db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (?, ?, ?, ?, 'queued')").run(
        id,
        T,
        T,
        values[0],
      );
      state.enqueued.push(values);
      return { id };
    },
  };
  const scheduler = createScheduler({
    db,
    jobs,
    now: () => state.clock,
    setTimer: (fn, ms) => {
      state.callback = fn;
      state.delays.push(ms);
      return 1;
    },
    clearTimer: () => {},
  });
  t.after(() => scheduler.stop());
  const audits = () =>
    db
      .prepare('SELECT action, detail_json FROM audit_events ORDER BY id')
      .all()
      .map((row) => ({ action: row.action, ...JSON.parse(row.detail_json) }));
  const schedule = (id) => ({ ...db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) });
  return { db, state, scheduler, addSchedule, audits, schedule };
}

test('a due backup is queued with its options, marked scheduled, and the next run is set', (t) => {
  const { state, scheduler, addSchedule, schedule, audits } = setup(t);
  const id = addSchedule();
  scheduler.start();
  assert.deepEqual(state.enqueued, [['server.backup', { keep: 4, reason: 'scheduled' }, { serverId: 5 }]]);
  const row = schedule(id);
  assert.equal(row.last_job_id, 8);
  assert.equal(row.last_run_at, T);
  assert.equal(row.next_run_at, '2026-01-01T00:01:00.000Z');
  assert.equal(audits()[0].action, 'schedule.run');
  assert.ok(state.delays.at(-1) <= 60000);
});

test('update schedules target the install, not the server', (t) => {
  const { state, scheduler, addSchedule } = setup(t);
  addSchedule({ kind: 'update_check', options: '{}' });
  addSchedule({ kind: 'auto_update', options: '{"keep":3}' });
  scheduler.start();
  assert.deepEqual(state.enqueued, [
    ['install.check_update', {}, { installId: 3 }],
    ['install.auto_update', { keep: 3 }, { installId: 3 }],
  ]);
});

test('a run missed by less than the catch-up window still runs, a later one is skipped', (t) => {
  const { state, scheduler, addSchedule, audits, schedule } = setup(t);
  const late = addSchedule({ next: new Date(state.clock - CATCH_UP_MS + 1000).toISOString() });
  const tooLate = addSchedule({
    kind: 'restart',
    options: '{}',
    next: new Date(state.clock - CATCH_UP_MS).toISOString(),
  });
  scheduler.start();
  assert.equal(state.enqueued.length, 1);
  assert.equal(schedule(late).last_job_id, 8);
  const skipped = audits().find((a) => a.action === 'schedule.skipped');
  assert.equal(skipped.reason, 'too late');
  assert.equal(schedule(tooLate).last_run_at, null);
  assert.equal(schedule(tooLate).next_run_at, '2026-01-01T00:01:00.000Z');
});

test('a schedule whose last job is still running is skipped rather than stacked', (t) => {
  const { db, state, scheduler, addSchedule, audits } = setup(t);
  db.prepare(
    "INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (2, ?, ?, 'server.backup', 'running')",
  ).run(T, T);
  addSchedule({ lastJob: 2 });
  scheduler.start();
  assert.equal(state.enqueued.length, 0);
  assert.equal(audits()[0].reason, 'last job still running');
});

test('a disabled schedule never runs', (t) => {
  const { state, scheduler, addSchedule } = setup(t);
  addSchedule({ enabled: 0 });
  scheduler.start();
  assert.equal(state.enqueued.length, 0);
  assert.equal(state.delays.at(-1), 60000);
});

test('a row that fails is parked and the others still run', (t) => {
  const { state, scheduler, addSchedule, audits, schedule } = setup(t);
  const bad = addSchedule({ cron: 'not a cron' });
  addSchedule({ kind: 'restart', options: '{}' });
  scheduler.start();
  assert.deepEqual(
    state.enqueued.map((e) => e[0]),
    ['server.restart'],
  );
  assert.equal(schedule(bad).next_run_at, null);
  assert.ok(audits().some((a) => a.action === 'schedule.failed'));
});

test('the timer waits for the next run and never spins', (t) => {
  const { state, scheduler, addSchedule } = setup(t);
  addSchedule({ cron: '0 5 * * *', next: '2026-01-01T00:00:30.000Z' });
  scheduler.start();
  assert.equal(state.enqueued.length, 0);
  assert.equal(state.delays.at(-1), 30000);
  state.clock += 30000;
  state.callback();
  assert.equal(state.enqueued.length, 1);
  // The next run is hours away, so the timer checks back at most once a minute and never with 0.
  assert.equal(state.delays.at(-1), 60000);
  state.clock += 60000;
  state.callback();
  assert.equal(state.enqueued.length, 1);
});
