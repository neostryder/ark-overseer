import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { reconcilePendingRestores, RESTORE_MESSAGES } from '../src/backups/restore.js';
import { defaultOps, settle } from '../src/backups/swap.js';
import { restoreWorld, writeTree, readTree, NOW } from './helpers/restore-world.js';

const worldPath = (w, map = 'TheIsland_WP') => path.join(w.layout.savedArks, map);
const safetyRows = (w) => w.backups().filter((row) => row.reason === 'pre_restore');

async function withBackup(t, options) {
  const w = restoreWorld(t, options);
  const row = await w.backup();
  const v1 = { world: w.world(), settings: w.settings() };
  w.change('v2');
  const v2 = { world: w.world(), settings: w.settings() };
  // A second job row, so a second restore can name itself as the job of its backups.
  w.db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (2, 'x', 'x', 'x', 'running')").run();
  return { w, row, v1, v2 };
}
function cutOff(w, { stage, jobId = 1, wasRunning = 1 } = {}) {
  w.db
    .prepare(
      'INSERT INTO pending_restores (server_id, job_id, backup_id, scope, safety_backup_id, was_running, started_at, stage) VALUES (1, ?, 1, ?, NULL, ?, ?, ?)',
    )
    .run(jobId, 'everything', wasRunning, '2026-01-01T00:00:00.000Z', stage);
}

// ---- a row left by an earlier restore ----

// The first rename works and every later one fails, so the world is left renamed aside and cannot be put back.
function breakDisk(w) {
  const original = w.ops.rename;
  let calls = 0;
  w.ops.rename = async (from, to) => {
    if (++calls > 1) throw Object.assign(new Error('still blocked'), { code: 'EIO' });
    return original(from, to);
  };
  return () => (w.ops.rename = original);
}

test('a second restore settles the row an earlier one left, and never starts the server for it', async (t) => {
  const { w, row, v1, v2 } = await withBackup(t);
  const repair = breakDisk(w);
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), { message: RESTORE_MESSAGES.filesNotPutBack });
  assert.equal(w.pending().length, 1);
  assert.equal(w.world(), null);
  assert.ok(fs.existsSync(`${worldPath(w)}.old-1`));
  repair();
  // The server is stopped by the first job, and stays that way: the second job does not start it for the row.
  const result = await w.restore({ backupId: row.id, scope: 'world' }, 2);
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.steps(), ['stop']);
  // The safety backup was taken after the earlier files were put back, so it holds them.
  assert.deepEqual(readTree(path.join(safetyRows(w)[0].path, 'SavedArks', 'TheIsland_WP')), v2.world);
  assert.equal(result.started, false);
  const reconciled = w.audits('server.backup.restore_reconciled');
  assert.deepEqual(
    [reconciled.length, reconciled[0].actor, reconciled[0].outcome, reconciled[0].jobId],
    [1, 'job', 'rolled_back', 1],
  );
});

test('a second restore that cannot settle the earlier row fails with that message and changes nothing', async (t) => {
  const { w, row } = await withBackup(t);
  breakDisk(w);
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), { message: RESTORE_MESSAGES.filesNotPutBack });
  const stopped = w.steps().length;
  const backupsBefore = w.backups().length;
  await assert.rejects(w.restore({ backupId: row.id, scope: 'settings' }, 2), {
    message:
      "An earlier restore on this server left files it couldn't put back, and ARK Overseer couldn't sort them out: Still blocked. Nothing was changed. Check the world and settings folders, then restart ARK Overseer to try again.",
  });
  assert.equal(w.pending().length, 1);
  assert.equal(w.pending()[0].job_id, 1);
  assert.ok(fs.existsSync(`${worldPath(w)}.old-1`));
  assert.equal(w.steps().length, stopped);
  assert.equal(w.backups().length, backupsBefore);
  assert.deepEqual(
    w.audits('server.backup.%').map((audit) => [audit.action, audit.outcome, audit.jobId]),
    [
      ['server.backup.restore', 'failed', 1],
      ['server.backup.restore_reconciled', 'failed', 1],
      ['server.backup.restore', 'failed', 2],
    ],
  );
});

test('a restore with no row behind it goes ahead as before', async (t) => {
  const { w, row, v1 } = await withBackup(t);
  await w.restore({ backupId: row.id, scope: 'world' });
  await w.restore({ backupId: row.id, scope: 'world' }, 2);
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.audits('server.backup.restore_reconciled'), []);
});

// ---- file checks ----

test('only a missing path counts as absent; any other error is thrown', async (t) => {
  const w = restoreWorld(t);
  const file = path.join(w.root, 'there.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(await defaultOps.exists(file), true);
  assert.equal(await defaultOps.exists(path.join(w.root, 'missing.txt')), false);
  assert.equal(await defaultOps.exists(path.join(file, 'below-a-file')), false);
  for (const [code, expected] of [
    ['ENOENT', false],
    ['ENOTDIR', false],
  ]) {
    mock.method(fsp, 'lstat', async () => {
      throw Object.assign(new Error(code), { code });
    });
    assert.equal(await defaultOps.exists(file), expected, code);
    mock.restoreAll();
  }
  mock.method(fsp, 'lstat', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(defaultOps.exists(file), { code: 'EACCES' });
  // In an undo, a target that cannot be inspected is left alone rather than treated as missing.
  fs.mkdirSync(`${worldPath(w)}.old-5`, { recursive: true });
  const before = w.world();
  await assert.rejects(settle({ roots: w.layout.roots, tag: '5', mode: 'undo', ops: defaultOps }), { code: 'EACCES' });
  mock.restoreAll();
  assert.deepEqual(w.world(), before);
  assert.ok(fs.existsSync(`${worldPath(w)}.old-5`));
});

// ---- the startup reconcile ----

test('reconcile: a stage this version does not know keeps the row, reports it, and touches nothing', async (t) => {
  const w = restoreWorld(t);
  fs.renameSync(worldPath(w), `${worldPath(w)}.old-1`);
  cutOff(w, { stage: 'weird' });
  const settled = await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.deepEqual(settled, [
    {
      serverId: 1,
      wasRunning: false,
      outcome: 'failed',
      failed:
        "An unfinished restore stopped at a point this version doesn't know, so ARK Overseer left its files alone.",
    },
  ]);
  assert.equal(w.pending().length, 1);
  assert.ok(fs.existsSync(`${worldPath(w)}.old-1`));
  assert.equal(w.world(), null);
  assert.deepEqual(
    w.audits().map((audit) => [audit.action, audit.outcome, audit.stage]),
    [['server.backup.restore_reconciled', 'failed', 'weird']],
  );
  // The next job for the server is refused for the same reason.
  await assert.rejects(
    w.restore({ backupId: 1, scope: 'world' }),
    /left files it couldn't put back.*stopped at a point/,
  );
});

test('reconcile: after any rollback stage the server is not started, and the audit event says so', async (t) => {
  for (const stage of ['rollback', 'rollback_cleanup', 'rollback_starting']) {
    const w = restoreWorld(t);
    fs.renameSync(worldPath(w), `${worldPath(w)}.old-1r`);
    writeTree(worldPath(w), { 'TheIsland_WP.ark': 'x' });
    cutOff(w, { stage, wasRunning: 1 });
    const [result] = await reconcilePendingRestores({ db: w.db, now: () => NOW });
    assert.equal(result.wasRunning, false, stage);
    const [audit] = w.audits();
    assert.equal(audit.serverStarted, false, stage);
    assert.equal(audit.note, RESTORE_MESSAGES.noStartAfterRollback, stage);
    assert.deepEqual(w.pending(), []);
  }
  // Other stages say nothing about it, and still start a server that was running.
  const w = restoreWorld(t);
  cutOff(w, { stage: 'starting' });
  const [result] = await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.equal(result.wasRunning, true);
  assert.equal('serverStarted' in w.audits()[0], false);
});

test('reconcile: a cut-off rollback of the settings folder is undone or finished beside WindowsServer', async (t) => {
  const config = (w) => w.layout.configDir;
  const restored = { 'GameUserSettings.ini': 'restored' };
  const earlier = { 'GameUserSettings.ini': 'earlier' };
  // rollback: the first swap is whole (its old copy is `.old-1`), the rollback swap stopped between its renames.
  const cut = restoreWorld(t);
  fs.rmSync(config(cut), { recursive: true });
  writeTree(`${config(cut)}.old-1`, earlier);
  writeTree(`${config(cut)}.old-1r`, restored);
  writeTree(`${config(cut)}.restore-1r`, earlier);
  cutOff(cut, { stage: 'rollback' });
  await reconcilePendingRestores({ db: cut.db, now: () => NOW });
  assert.deepEqual(cut.settings(), restored);
  assert.deepEqual(cut.artifacts(), []);
  // rollback_cleanup: the rollback is whole, so its old copy goes and the earlier files stay.
  const whole = restoreWorld(t);
  fs.rmSync(config(whole), { recursive: true });
  writeTree(config(whole), earlier);
  writeTree(`${config(whole)}.old-1r`, restored);
  cutOff(whole, { stage: 'rollback_cleanup' });
  await reconcilePendingRestores({ db: whole.db, now: () => NOW });
  assert.deepEqual(whole.settings(), earlier);
  assert.deepEqual(whole.artifacts(), []);
  // A file-level rollback beside a nested file is settled too.
  const nested = restoreWorld(t);
  writeTree(path.join(config(nested), 'Sub'), { 'Extra.ini': 'live' });
  fs.renameSync(path.join(config(nested), 'Sub', 'Extra.ini'), path.join(config(nested), 'Sub', 'Extra.ini.old-1r'));
  fs.writeFileSync(path.join(config(nested), 'Sub', 'Extra.ini.restore-1r'), 'staged');
  cutOff(nested, { stage: 'rollback' });
  await reconcilePendingRestores({ db: nested.db, now: () => NOW });
  assert.equal(readTree(path.join(config(nested), 'Sub'))['Extra.ini'], 'live');
  assert.deepEqual(nested.artifacts(), []);
});

// ---- was_running while the server starts ----

test('leftover old copies keep the row saying the server was running until the start has finished', async (t) => {
  const { w, row } = await withBackup(t);
  w.plan.failFinish = true;
  let during = null;
  w.plan.ready.push(() => {
    during = { ...w.pending()[0] };
  });
  await w.restore({ backupId: row.id, scope: 'world' });
  assert.deepEqual([during.was_running, during.stage], [1, 'starting']);
  // A restart of ARK Overseer in that window would have started the server; now the job is over, it would not.
  assert.deepEqual(
    w.pending().map((pending) => pending.was_running),
    [0],
  );
  w.plan.failFinish = false;
  const [settled] = await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW });
  assert.deepEqual([settled.wasRunning, settled.outcome], [false, 'completed']);
  assert.deepEqual(w.artifacts(), []);
});

test('the same holds for the leftovers of a rollback', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.failFinish = true;
  let during = null;
  w.plan.ready.push(new Error('slow'), () => {
    during = { ...w.pending()[0] };
  });
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /did not start the server/);
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual([during.was_running, during.stage], [1, 'rollback_starting']);
  assert.deepEqual(
    w.pending().map((pending) => [pending.was_running, pending.stage]),
    [[0, 'rollback_starting']],
  );
  w.plan.failFinish = false;
  const [settled] = await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW });
  assert.equal(settled.wasRunning, false);
  assert.deepEqual(w.artifacts(), []);
});

// ---- audit events ----

test('a server that will not stop, and a request that fails its check, both leave an audit event', async (t) => {
  const { w, row } = await withBackup(t);
  w.plan.stop.push(new Error('would not exit'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /could not be stopped/);
  await assert.rejects(w.restore({ backupId: row.id, scope: 'nonsense' }), /Choose Everything/);
  await assert.rejects(w.restore({ backupId: 999, scope: 'world' }), /not found/);
  assert.deepEqual(
    w.audits().map((audit) => [audit.action, audit.outcome, audit.scope, audit.backupId]),
    [
      ['server.backup.restore', 'failed', 'world', row.id],
      ['server.backup.restore', 'failed', 'nonsense', row.id],
      ['server.backup.restore', 'failed', 'world', 999],
    ],
  );
  assert.match(w.audits()[0].reason, /Would not exit/);
  // Cancelled before anything was touched.
  const late = await withBackup(t);
  late.w.plan.controller.abort(new Error('cancelled'));
  await assert.rejects(late.w.restore({ backupId: late.row.id, scope: 'world' }), /cancelled/);
  assert.equal(late.w.audits()[0].outcome, 'cancelled');
  // Each job writes one event, not two.
  const cancelled = await withBackup(t);
  cancelled.w.plan.onCopy = (count) => {
    if (count === 2) cancelled.w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(cancelled.w.restore({ backupId: cancelled.row.id, scope: 'world' }), /cancelled/);
  assert.deepEqual(
    cancelled.w.audits().map((audit) => audit.outcome),
    ['cancelled'],
  );
});

// ---- the map a safety backup records ----

test('a safety backup records the map only when it holds a world', async (t) => {
  const settings = await withBackup(t);
  await settings.w.restore({ backupId: settings.row.id, scope: 'settings' });
  assert.equal(safetyRows(settings.w)[0].map, null);
  const world = await withBackup(t);
  await world.w.restore({ backupId: world.row.id, scope: 'world' });
  assert.equal(safetyRows(world.w)[0].map, 'TheIsland_WP');
  const both = await withBackup(t);
  await both.w.restore({ backupId: both.row.id, scope: 'everything' });
  assert.equal(safetyRows(both.w)[0].map, 'TheIsland_WP');
  // A rollback of a settings restore still reads the safety backup, which has no world and no map.
  const rolled = await withBackup(t);
  rolled.w.plan.ready.push(new Error('bad ini'));
  await assert.rejects(rolled.w.restore({ backupId: rolled.row.id, scope: 'settings' }), /did not start/);
  assert.deepEqual(rolled.w.settings(), rolled.v2.settings);
});

// ---- starting the server ----

test('a start is trusted only when it leaves a process that is not the one seen before', async (t) => {
  // A new process id after the start: fine.
  const fresh = await withBackup(t);
  fresh.w.setPid(100);
  fresh.w.plan.pidOnStart = 200;
  await fresh.w.restore({ backupId: fresh.row.id, scope: 'world' });
  assert.deepEqual(fresh.w.steps(), ['stop', 'start', 'ready']);
  // The same id as before the start means nothing new was started.
  const same = await withBackup(t);
  same.w.setPid(100);
  await assert.rejects(same.w.restore({ backupId: same.row.id, scope: 'world' }), /Check the server log\./);
  assert.deepEqual(same.w.steps(), ['stop', 'start', 'stop', 'start']);
  assert.deepEqual(same.w.world(), same.v2.world);
  // No id before the start cannot be the same as after.
  const none = await withBackup(t);
  none.w.plan.pidOnStart = 300;
  await none.w.restore({ backupId: none.row.id, scope: 'world' });
  assert.deepEqual(none.w.steps(), ['stop', 'start', 'ready']);
});
