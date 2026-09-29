import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DRIFT_MESSAGES,
  DriftError,
  isCovered,
  isSecretKey,
  planResolve,
  putKey,
  settingKeys,
} from '../src/settings/drift.js';
import { createSupervisor } from '../src/supervisor/supervisor.js';
import { reconcilePendingRestores } from '../src/backups/restore.js';
import { serverPaths } from '../src/supervisor/launch.js';
import { driftWorld, GUS, GAME } from './helpers/drift-world.js';
import { readTree, NOW } from './helpers/restore-world.js';

const brief = (state) => state.differences.map((x) => [x.file, x.section, x.key, x.kind, x.baseline, x.live]);
const RESOLVE = 'server.settings_resolve';
const target = { serverId: 1, installId: 1 };
const lines = (text) => text.split('\r\n');

// The changes ASA or a person might make: one changed, one removed, one added, and a comment of their own.
function tamper(d) {
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  d.edit('GameUserSettings.ini', 'TamingSpeedMultiplier=1.0\r\n', '');
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=abc\r\n; edited by hand\r\nNewKey=zz9plural');
}

// ---- detection ----

test('changed, added and removed keys are reported with both values, and comments and blank lines are not', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const clean = await d.check();
  assert.deepEqual(
    { changed: clean.changed, differences: clean.differences, seen: clean.seen, afterStop: clean.afterStop },
    { changed: false, differences: [], seen: false, afterStop: false },
  );
  // Comments, blank lines and trailing blank lines are not settings.
  d.write('GameUserSettings.ini', `${GUS}; a new comment\r\n\r\n\r\n`.replace('; a comment', '; another comment'));
  assert.equal((await d.check()).changed, false);
  assert.equal(d.driftRow(), undefined);
  tamper(d);
  const state = await d.check();
  assert.equal(state.changed, true);
  assert.deepEqual(brief(state), [
    ['GameUserSettings.ini', 'ServerSettings', 'XPMultiplier', 'changed', '1.0', '2.0'],
    ['GameUserSettings.ini', 'ServerSettings', 'NewKey', 'added', null, 'zz9plural'],
    ['GameUserSettings.ini', 'ServerSettings', 'TamingSpeedMultiplier', 'removed', '1.0', null],
  ]);
  assert.equal(state.seen, false);
  assert.equal(state.afterStop, false);
  assert.equal(state.detectedAt, new Date(NOW).toISOString());
  assert.match(state.liveSha256, /^[0-9a-f]{64}$/);
  assert.ok(d.driftRow());
});

test('a key repeated on several lines is compared as a whole', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('Game.ini', 'PreventBreedingForClassNames=B_C\r\n', '');
  const state = await d.check();
  assert.deepEqual(brief(state), [
    ['Game.ini', '/script/shootergame.shootergamemode', 'PreventBreedingForClassNames', 'changed', 'A_C\nB_C', 'A_C'],
  ]);
});

test('a whole file added or removed is one difference', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.write('Extra.ini', '[a]\r\nb=1\r\n');
  fs.rmSync(d.live('Game.ini'));
  const state = await d.check();
  assert.deepEqual(brief(state), [
    ['Extra.ini', '', '', 'file_added', null, null],
    ['Game.ini', '', '', 'file_removed', null, null],
  ]);
  const other = driftWorld(t, { files: { 'GameUserSettings.ini': GUS, 'Notes.txt': 'one' } });
  await other.baseline();
  other.write('Notes.txt', 'two');
  assert.deepEqual(brief(await other.check()), [['Notes.txt', '', '', 'file_changed', null, null]]);
});

test('password values are never returned, whether the field is a password field or its name looks like one', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'ServerPassword=secret1', 'ServerPassword=newsecret');
  d.edit('GameUserSettings.ini', 'ServerAdminPassword=adminpw\r\n', '');
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=abc\r\nMyPasswordThing=hunter42');
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  const secrets = state.differences.filter((x) => x.secret).map((x) => [x.key, x.kind, x.baseline, x.live]);
  assert.deepEqual(secrets, [
    ['ServerPassword', 'changed', null, null],
    ['MyPasswordThing', 'added', null, null],
    ['ServerAdminPassword', 'removed', null, null],
  ]);
  assert.doesNotMatch(JSON.stringify(state), /secret1|newsecret|adminpw|hunter42/);
  // An ordinary key still shows its values.
  assert.deepEqual(
    state.differences.find((x) => x.key === 'XPMultiplier'),
    {
      file: 'GameUserSettings.ini',
      section: 'ServerSettings',
      key: 'XPMultiplier',
      kind: 'changed',
      baseline: '1.0',
      live: '2.0',
      secret: false,
    },
  );
  assert.equal(isSecretKey('ServerPassword'), true);
  assert.equal(isSecretKey(' spectatorpassword '), true);
  assert.equal(isSecretKey('SomethingPassword2'), true);
  assert.equal(isSecretKey('XPMultiplier'), false);
});

test('the cheap check hashes nothing when no file moved, and hashes again when one did', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  await d.check();
  const first = d.hashed.length;
  assert.equal(first, 2);
  await d.check();
  await d.check();
  assert.equal(d.hashed.length, first);
  // A change with a new size and time is hashed and found.
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.5');
  assert.equal((await d.check()).changed, true);
  assert.equal(d.hashed.length, first + 2);
  await d.check();
  assert.equal(d.hashed.length, first + 2);
  // A file saved again with the same text has a new time, so it is hashed once more and still matches.
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.5', 'XPMultiplier=1.0');
  assert.equal((await d.check()).changed, false);
  assert.equal(d.hashed.length, first + 4);
  // A new baseline is a different comparison even though no file moved.
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=3.0');
  await d.check();
  await d.baseline();
  const before = d.hashed.length;
  assert.equal((await d.check()).changed, false);
  assert.equal(d.hashed.length, before + 2);
});

test('a force check ignores the cheap skip', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  await d.check();
  const before = d.hashed.length;
  await d.check({ force: true });
  assert.equal(d.hashed.length, before + 2);
});

test('the same drift found again keeps its time and whether anyone has looked; a new change starts over', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const first = await d.check({ afterStop: true });
  assert.equal(first.detectedAt, new Date(NOW).toISOString());
  assert.equal(first.afterStop, true);
  assert.equal(first.seen, false);
  d.drift.markSeen(1);
  d.clock.now = NOW + 60_000;
  const again = await d.check({ force: true });
  assert.equal(again.detectedAt, first.detectedAt);
  assert.equal(again.seen, true);
  // Found again by an ordinary check, it is still the one found after the stop.
  assert.equal(again.afterStop, true);
  assert.equal(d.w.db.prepare('SELECT count(*) AS n FROM settings_drift').get().n, 1);
  d.clock.now = NOW + 120_000;
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.0', 'XPMultiplier=4.0');
  const next = await d.check();
  assert.equal(next.detectedAt, new Date(NOW + 120_000).toISOString());
  assert.equal(next.seen, false);
  assert.equal(next.afterStop, false);
  // The files matching again removes the row.
  d.edit('GameUserSettings.ini', 'XPMultiplier=4.0', 'XPMultiplier=1.0');
  assert.equal((await d.check()).changed, false);
  assert.equal(d.driftRow(), undefined);
});

test('a check never writes the settings files', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const before = d.w.settings();
  const times = fs.readdirSync(d.w.layout.configDir).map((name) => fs.statSync(d.live(name)).mtimeMs);
  await d.check();
  await d.check({ force: true, afterStop: true });
  assert.deepEqual(d.w.settings(), before);
  assert.deepEqual(
    fs.readdirSync(d.w.layout.configDir).map((name) => fs.statSync(d.live(name)).mtimeMs),
    times,
  );
  assert.deepEqual(d.w.artifacts(), []);
});

test('while another file job owns the files nothing is compared or recorded', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  d.w.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'server.restore', 1, 'running')",
    )
    .run();
  const state = await d.check();
  assert.deepEqual({ busy: state.busy, changed: state.changed }, { busy: true, changed: false });
  assert.equal(d.driftRow(), undefined);
  d.w.db.prepare("UPDATE jobs SET state = 'succeeded' WHERE kind = 'server.restore'").run();
  assert.equal((await d.check()).changed, true);
});

test('checkAll looks at every server and reports a failure in the log without stopping', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  await d.drift.checkAll();
  assert.ok(d.driftRow());
  assert.deepEqual(d.logs, []);
  // A check that throws is logged and does not reach the caller.
  d.w.db.exec('DROP TABLE settings_drift');
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.0', 'XPMultiplier=3.0');
  await d.drift.checkAll();
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /^Checking the settings of server 1 failed: /);
});

test('the periodic check runs at start and every ten minutes until it is stopped', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const stop = d.drift.start();
  assert.equal(d.timers.intervals.length, 1);
  assert.equal(d.timers.intervals[0].ms, 10 * 60 * 1000);
  await d.drift.idle();
  assert.ok(d.driftRow());
  d.w.db.prepare('DELETE FROM settings_drift').run();
  d.timers.intervals[0].fn();
  await d.drift.idle();
  assert.ok(d.driftRow());
  stop();
  assert.equal(d.timers.intervals[0].cleared, true);
});

// ---- choosing what to do ----

test('adopt keeps the files as they are and changes only the baseline', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const state = await d.check();
  const files = d.w.settings();
  const result = await d.drift.adopt(d.server(), state.liveSha256);
  assert.equal(result.adopted, true);
  assert.deepEqual(
    result.keys.map((k) => k.key),
    ['XPMultiplier', 'NewKey', 'TamingSpeedMultiplier'],
  );
  assert.deepEqual(d.w.settings(), files);
  assert.equal(d.driftRow(), undefined);
  assert.equal(d.baselineRow().source, 'drift_adopt');
  assert.equal(d.baselineFile('GameUserSettings.ini'), files['GameUserSettings.ini']);
  assert.equal((await d.check()).changed, false);
  assert.deepEqual(d.w.backups(), []);
});

test('adopt refuses a look that is out of date, no look at all, and nothing to adopt', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.0', 'XPMultiplier=3.0');
  await assert.rejects(d.drift.adopt(d.server(), state.liveSha256), {
    status: 409,
    code: 'changed',
    message: DRIFT_MESSAGES.changedSince,
  });
  await assert.rejects(d.drift.adopt(d.server(), undefined), { status: 400, code: 'no_look' });
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=1.0/);
  await d.baseline();
  const clean = await d.check();
  await assert.rejects(d.drift.adopt(d.server(), clean.liveSha256), { status: 409, code: 'nothing' });
});

test('revert puts ARK Overseer values back and keeps comments, unknown keys and order in the live file', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  d.edit('Game.ini', 'PreventBreedingForClassNames=B_C\r\n', '');
  d.edit('Game.ini', 'MatingIntervalMultiplier=1', 'MatingIntervalMultiplier=2');
  d.write('Extra.ini', '[a]\r\nb=zz9plural\r\n');
  const state = await d.check();
  const tampered = d.w.settings();
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.action, 'revert');
  assert.equal(done.result.changed, 6);
  assert.equal(done.result.appliesAtRestart, false);

  const user = d.read('GameUserSettings.ini');
  const got = lines(user);
  assert.ok(got.includes('XPMultiplier=1.0') && got.includes('TamingSpeedMultiplier=1.0'));
  assert.ok(!user.includes('NewKey'));
  // The comment, the key ARK Overseer does not know and the order of the keys already there are kept.
  assert.ok(got.includes('; edited by hand') && got.includes('; a comment') && got.includes('MyOddKey=abc'));
  const at = (line) => got.indexOf(line);
  assert.ok(at('XPMultiplier=1.0') < at('ServerPassword=secret1') && at('ServerPassword=secret1') < at('MyOddKey=abc'));
  assert.ok(at('MyOddKey=abc') < at('; edited by hand'));
  // The file keeps its line endings.
  assert.doesNotMatch(user.replaceAll('\r\n', ''), /\n/);
  const game = lines(d.read('Game.ini'));
  assert.deepEqual(
    game.filter((line) => line.startsWith('PreventBreedingForClassNames=')),
    ['PreventBreedingForClassNames=A_C', 'PreventBreedingForClassNames=B_C'],
  );
  assert.ok(game.includes('MatingIntervalMultiplier=1'));
  assert.equal(fs.existsSync(d.live('Extra.ini')), false);

  // The result is the baseline, and the drift is gone.
  assert.equal((await d.check()).changed, false);
  assert.equal(d.driftRow(), undefined);
  assert.equal(d.baselineRow().source, 'drift_revert');
  for (const name of ['GameUserSettings.ini', 'Game.ini']) assert.equal(d.baselineFile(name), d.read(name));
  assert.equal(
    fs.existsSync(path.join(d.w.dataDir, 'baselines', 'server-1', 'Config', 'WindowsServer', 'Extra.ini')),
    false,
  );
  assert.deepEqual(d.w.artifacts(), []);
  assert.deepEqual(d.w.pending(), []);
  assert.deepEqual(fs.readdirSync(path.join(d.w.dataDir, 'settings-staging')), []);

  // A safety backup of the settings folder as it was, and no world in it.
  const backups = d.w.backups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].reason, 'pre_restore');
  assert.equal(backups[0].job_id, job.id);
  assert.deepEqual(readTree(path.join(backups[0].path, 'Config', 'WindowsServer')), tampered);
  assert.equal(fs.existsSync(path.join(backups[0].path, 'SavedArks')), false);

  // One audit event, naming the keys and holding no values.
  const [event] = d.settingsAudits('server.settings.drift_revert');
  assert.equal(event.outcome, 'applied');
  assert.equal(event.actor, 'job');
  assert.equal(event.safetyBackupId, backups[0].id);
  assert.equal(event.keys.length, 6);
  assert.deepEqual(event.keys[0], { file: 'Extra.ini', section: '', key: '' });
  assert.doesNotMatch(JSON.stringify(d.settingsAudits()), /zz9plural|2\.0|secret1/);
});

test('revert of a running server says the values apply after its next restart', async (t) => {
  const d = driftWorld(t, { running: true });
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.appliesAtRestart, true);
  assert.equal(done.message, DRIFT_MESSAGES.steps.doneRunning);
  // The server was not stopped or started.
  assert.deepEqual(d.w.steps(), []);
  assert.equal(d.w.state(), 'running');
});

test('merge takes each setting from the side chosen for it, ignoring a choice for one that no longer differs', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  d.edit('GameUserSettings.ini', 'SessionName=Base', 'SessionName=Mine');
  const state = await d.check();
  const pick = (key, choice) => ({ file: 'GameUserSettings.ini', section: 'ServerSettings', key, choice });
  const choices = [
    pick('XPMultiplier', 'live'),
    pick('TamingSpeedMultiplier', 'baseline'),
    pick('NewKey', 'baseline'),
    { file: 'GameUserSettings.ini', section: 'SessionSettings', key: 'SessionName', choice: 'live' },
    { file: 'Game.ini', section: 'nothing', key: 'here', choice: 'baseline' },
  ];
  const job = d.jobs.enqueue(RESOLVE, { action: 'merge', choices, liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  const got = lines(d.read('GameUserSettings.ini'));
  assert.ok(got.includes('XPMultiplier=2.0'));
  assert.ok(got.includes('TamingSpeedMultiplier=1.0'));
  assert.ok(!got.some((line) => line.startsWith('NewKey')));
  assert.ok(got.includes('SessionName=Mine'));
  // The values kept from the live file are now the baseline's, and so are the ones put back.
  assert.equal((await d.check()).changed, false);
  assert.equal(d.baselineRow().source, 'drift_merge');
  assert.equal(d.baselineFile('GameUserSettings.ini'), d.read('GameUserSettings.ini'));
  const [event] = d.settingsAudits('server.settings.drift_merge');
  assert.deepEqual(
    event.keys.map((k) => k.key),
    ['NewKey', 'TamingSpeedMultiplier'],
  );
});

test('a merge where every setting keeps the live value changes no file and takes them as the baseline', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  const before = d.w.settings();
  const choices = [{ file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'XPMultiplier', choice: 'live' }];
  const job = d.jobs.enqueue(RESOLVE, { action: 'merge', choices, liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.deepEqual(d.w.settings(), before);
  assert.deepEqual(d.w.backups(), []);
  assert.equal((await d.check()).changed, false);
});

test('planResolve refuses a merge with a missing or malformed choice, and the same requests the job refuses', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const state = await d.check();
  const request = (choices, extra = {}) => ({ action: 'merge', choices, liveSha256: state.liveSha256, ...extra });
  const all = state.differences.map((x) => ({ file: x.file, section: x.section, key: x.key, choice: 'live' }));
  await assert.rejects(d.drift.planFor(d.server(), request(all.slice(1))), {
    status: 400,
    code: 'missing_choice',
    message: 'Choose a value for every setting that differs. 1 still need a choice.',
  });
  await assert.rejects(d.drift.planFor(d.server(), request([])), { code: 'missing_choice' });
  for (const bad of [undefined, 'live', [null], [{ ...all[0], choice: 'both' }], [{ ...all[0], key: 5 }]])
    await assert.rejects(d.drift.planFor(d.server(), request(bad)), { status: 400, code: 'bad_choices' });
  await assert.rejects(d.drift.planFor(d.server(), request(all, { action: 'delete' })), { code: 'bad_action' });
  await assert.rejects(d.drift.planFor(d.server(), request(all, { liveSha256: 'abc' })), {
    status: 409,
    code: 'changed',
  });
  const plan = await d.drift.planFor(d.server(), request(all));
  assert.equal(plan.entries.length, 3);
  // The pure function is what both use.
  assert.throws(
    () => planResolve({ ...state, changed: false }, { action: 'revert', liveSha256: state.liveSha256 }),
    (error) => error instanceof DriftError && error.code === 'nothing',
  );
  // The job itself refuses a merge without a choice for every key, changing nothing.
  const job = d.jobs.enqueue(RESOLVE, request(all.slice(1)), target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /still need a choice/);
  assert.deepEqual(d.w.backups(), []);
});

test('the job refuses when the files changed since the request, and changes nothing', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=changed after the request');
  const before = d.w.settings();
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.error, DRIFT_MESSAGES.changedSince);
  assert.deepEqual(d.w.settings(), before);
  assert.deepEqual(d.w.backups(), []);
  assert.deepEqual(d.w.artifacts(), []);
  assert.deepEqual(d.w.pending(), []);
  assert.equal(d.baselineRow().source, 'test');
  const [event] = d.settingsAudits('server.settings.drift_revert');
  assert.equal(event.outcome, 'failed');
});

test('a swap that fails puts the files back, keeps the baseline and leaves nothing behind', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  d.write('Extra.ini', '[a]\r\nb=1\r\n');
  const state = await d.check();
  const before = d.w.settings();
  const baseline = d.baselineRow().sha256;
  // One file to remove and one to swap: fail on the swapped file's second rename.
  d.w.plan.failRename = d.w.counts.rename + 3;
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /^The settings files could not be replaced, so nothing was changed\./);
  assert.deepEqual(d.w.settings(), before);
  assert.deepEqual(d.w.artifacts(), []);
  assert.deepEqual(d.w.pending(), []);
  assert.equal(d.baselineRow().sha256, baseline);
  assert.ok(d.driftRow());
});

test('a safety backup that fails stops the put-back before any file changes', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  const before = d.w.settings();
  const stampText = new Date(NOW).toISOString().replace(/[-:]/g, '').replace('.', '-');
  const base = path.join(d.w.dataDir, 'backups', 'server-1', `${stampText}-pre_restore`);
  fs.mkdirSync(base, { recursive: true });
  for (let n = 2; n <= 10; n++) fs.mkdirSync(`${base}-${n}`);
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'failed');
  assert.ok(done.error.startsWith(DRIFT_MESSAGES.safetyFailed));
  assert.deepEqual(d.w.settings(), before);
  assert.deepEqual(d.w.pending(), []);
});

test('a put-back cut off after the swap is finished at the next start and its result stays', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const state = await d.check();
  // The old copies cannot be removed, so the row stays at its cleanup stage.
  d.w.plan.failFinish = true;
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(d.w.pending()[0].stage, 'cleanup');
  assert.equal(d.w.pending()[0].scope, 'settings_resolve');
  d.w.plan.failFinish = false;
  const settled = await reconcilePendingRestores({ db: d.w.db, ops: d.w.ops, now: () => NOW });
  assert.equal(settled[0].outcome, 'completed');
  assert.deepEqual(d.w.artifacts(), []);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
});

test('a put-back cut off at its first rename is undone at the next start', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  tamper(d);
  const state = await d.check();
  d.w.plan.hangRename = d.w.counts.rename + 1;
  const stuck = d.drift.resolveNow({
    server: d.server(),
    params: { action: 'revert', liveSha256: state.liveSha256 },
    jobId: 1,
  });
  stuck.catch(() => {});
  while (d.w.counts.rename < d.w.plan.hangRename) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(d.w.pending().length, 1);
  // ARK Overseer stopped here: the job that hung is gone, and the next start settles what it left.
  d.w.plan.hangRename = null;
  const settled = await reconcilePendingRestores({ db: d.w.db, ops: d.w.ops, now: () => NOW });
  assert.equal(settled[0].outcome, 'rolled_back');
  assert.deepEqual(d.w.pending(), []);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=2.0/);
  assert.deepEqual(d.w.artifacts(), []);
});

// ---- keeping ARK Overseer's settings after a stop ----

const stopped = { serverId: 1, from: 'stopping', to: 'stopped' };

test('a stop with the option on puts back the settings ARK Overseer has a control for, and leaves the rest as drift', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  const baseline = d.baselineRow().sha256;
  // What ASA writes back while it shuts down: a known setting and a key ARK Overseer has no control for.
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=def');
  d.edit('GameUserSettings.ini', 'SessionName=Base', 'SessionName=Renamed');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  const queued = d.w.db.prepare('SELECT * FROM jobs WHERE kind = ?').all(RESOLVE);
  assert.equal(queued.length, 1);
  assert.deepEqual(
    { ...JSON.parse(queued[0].params_json), liveSha256: 'x' },
    { action: 'revert', auto: true, liveSha256: 'x' },
  );
  const done = await d.finished(queued[0].id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.partial, true);
  const got = lines(d.read('GameUserSettings.ini'));
  assert.ok(got.includes('XPMultiplier=1.0'));
  assert.ok(got.includes('SessionName=Base'));
  assert.ok(got.includes('MyOddKey=def'));
  // The baseline stays, so the key that was not put back is still reported.
  assert.equal(d.baselineRow().sha256, baseline);
  const state = await d.check();
  assert.deepEqual(brief(state), [['GameUserSettings.ini', 'ServerSettings', 'MyOddKey', 'changed', 'abc', 'def']]);
  assert.equal(state.afterStop, true);
  assert.equal(state.seen, false);
  assert.equal(d.settingsAudits('server.settings.drift_revert')[0].partial, true);
});

test('with the option off a stop only records the drift', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  assert.equal(d.w.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get(RESOLVE).n, 0);
  assert.equal(d.driftRow().after_stop, 1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=7.0/);
  // Other changes of state do not look at the files.
  d.edit('GameUserSettings.ini', 'XPMultiplier=7.0', 'XPMultiplier=8.0');
  d.drift.onStateChange({ serverId: 1, from: 'stopped', to: 'starting' });
  d.drift.onStateChange({ serverId: 1, from: 'running', to: 'crashed' });
  await d.drift.idle();
  assert.match(d.driftRow().live_sha256, /^[0-9a-f]{64}$/);
  assert.equal((await d.check({ force: true })).afterStop, false);
});

test('a change found by the ordinary check before the stop is marked as after the stop, and put back', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  await d.check();
  assert.equal(d.driftRow().after_stop, 0);
  const sha = d.driftRow().live_sha256;
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  // The files are the same as the earlier look found, and the row now says they were found after a stop.
  assert.equal(d.driftRow().after_stop, 1);
  assert.equal(d.driftRow().live_sha256, sha);
  assert.equal(d.w.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get(RESOLVE).n, 1);
  await d.drift.beforeStart(1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
});

test('a start waits for the put-back, once, and does nothing when there is nothing to put back', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.drift.attach(null);
  // Nothing changed: the hook returns without a backup or a check of its own.
  await d.drift.beforeStart(1);
  assert.deepEqual(d.w.backups(), []);
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  // The hook does not wait for idle: it waits for the check that the stop started, then reverts.
  await d.drift.beforeStart(1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.equal(d.w.backups().length, 1);
  assert.equal(d.baselineRow().source, 'drift_revert');
  await d.drift.beforeStart(1);
  assert.equal(d.w.backups().length, 1);
  assert.equal(d.settingsAudits('server.settings.drift_revert')[0].actor, 'system');
});

test('a start does not put anything back with the option off, or while a file job owns the files', async (t) => {
  const off = driftWorld(t);
  await off.baseline();
  off.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  off.drift.onStateChange(stopped);
  await off.drift.idle();
  await off.drift.beforeStart(1);
  assert.match(off.read('GameUserSettings.ini'), /XPMultiplier=7.0/);

  const busy = driftWorld(t, { keep: true });
  await busy.baseline();
  busy.drift.attach(null);
  busy.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  busy.drift.onStateChange(stopped);
  await busy.drift.idle();
  busy.w.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'server.restore', 1, 'running')",
    )
    .run();
  await busy.drift.beforeStart(1);
  assert.match(busy.read('GameUserSettings.ini'), /XPMultiplier=7.0/);
  assert.deepEqual(busy.w.backups(), []);
});

test('a start that finds the put-back failing goes ahead and logs it', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.drift.attach(null);
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  d.w.plan.failRename = d.w.counts.rename + 1;
  await d.drift.beforeStart(1);
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /Putting the settings back before starting server 1 failed/);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=7.0/);
});

test('a restart brings the server back on the put-back settings, not the ones ASA wrote as it shut down', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  const live = new Map();
  let pid = 0,
    time = 0;
  const exePath = serverPaths(d.w.installPath).exePath;
  const seenAtSpawn = [];
  const platform = {
    spawnServer: async (launch) => {
      pid += 1;
      seenAtSpawn.push(d.read('GameUserSettings.ini'));
      live.set(pid, { pid, exePath, commandLine: launch.args.join(' '), startedAt: `2026-01-01T00:00:0${pid}.000Z` });
      return { pid };
    },
    processInfo: async (p) => live.get(p) ?? null,
    listServerProcesses: async () => [...live.values()],
    killPid: async (p) => live.delete(p),
  };
  const supervisor = createSupervisor({
    db: d.w.db,
    platform,
    clock: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        await new Promise((resolve) => setImmediate(resolve));
      },
    },
    // ASA writes its own values as it exits.
    rcon: async ({ command }) => {
      if (command === 'DoExit') {
        d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
        live.clear();
      }
      return '';
    },
    getRconPassword: () => 'pw',
    options: { surviveMs: 2000, stopTimeoutMs: 3000, startupAttempts: 1 },
    beforeStart: (id) => d.drift.beforeStart(id),
  });
  supervisor.subscribe((event) => d.drift.onStateChange(event));
  await supervisor.start(1);
  await supervisor.restart(1);
  assert.equal(supervisor.status(1).observedState, 'running');
  // The second launch saw the put-back value.
  assert.equal(seenAtSpawn.length, 2);
  assert.match(seenAtSpawn[1], /XPMultiplier=1.0/);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  // Whichever of the queued job and the start did the work, it was done once.
  await d.drift.idle();
  for (const job of d.w.db.prepare('SELECT id FROM jobs WHERE kind = ?').all(RESOLVE)) await d.finished(job.id);
  assert.equal(d.w.backups().filter((b) => b.reason === 'pre_restore').length, 1);
  assert.equal((await d.check({ force: true })).changed, false);
});

// ---- the writers ----

test('a restore that touched settings takes the restored files as the baseline, and a failed one does not', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const backup = await d.w.backup();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=5.0');
  const before = d.baselineRow().sha256;
  d.w.plan.failCopy = d.w.counts.copy + 1;
  await assert.rejects(d.w.restore({ backupId: backup.id, scope: 'settings' }, 1));
  assert.equal(d.baselineRow().sha256, before);
  d.w.plan.failCopy = null;
  await d.w.restore({ backupId: backup.id, scope: 'settings' }, 1);
  assert.equal(d.baselineRow().source, 'restore');
  assert.notEqual(d.baselineRow().sha256, before);
  assert.equal(d.baselineFile('GameUserSettings.ini'), GUS);
  assert.equal((await d.check({ force: true })).changed, false);
});

test('a restore of only the world leaves the baseline alone', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const backup = await d.w.backup();
  const before = d.baselineRow().sha256;
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=5.0');
  await d.w.restore({ backupId: backup.id, scope: 'world' }, 1);
  assert.equal(d.baselineRow().sha256, before);
  assert.equal((await d.check({ force: true })).changed, true);
});

test('restoring a settings snapshot takes the restored files as the baseline', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const { saveSnapshot } = await import('../src/backups/settings-snapshots.js');
  const saved = await saveSnapshot({
    db: d.w.db,
    dataDir: d.w.dataDir,
    server: d.server(),
    name: 'Base',
    now: () => NOW,
  });
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=5.0');
  const before = d.baselineRow().sha256;
  d.w.plan.failRename = d.w.counts.rename + 1;
  await assert.rejects(d.w.handlers['server.settings_restore'](d.w.ctx({ snapshotId: saved.id })));
  assert.equal(d.baselineRow().sha256, before);
  d.w.plan.failRename = null;
  await d.w.handlers['server.settings_restore'](d.w.ctx({ snapshotId: saved.id }));
  assert.equal(d.baselineRow().source, 'settings_restore');
  assert.equal(d.baselineFile('GameUserSettings.ini'), GUS);
});

test('after a settings save only the saved keys join the baseline, so other outside changes are still reported', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  // The save itself: ARK Overseer changes one key. A person had changed another before that.
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=outside');
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  await d.drift.recordAfterSave(d.server(), settingKeys({ XPMultiplier: 2 }));
  assert.equal(d.baselineRow().source, 'settings_save');
  const state = await d.check();
  assert.deepEqual(brief(state), [['GameUserSettings.ini', 'ServerSettings', 'MyOddKey', 'changed', 'abc', 'outside']]);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=2.0/);
  // With nothing else different the whole baseline is taken again.
  d.edit('GameUserSettings.ini', 'MyOddKey=outside', 'MyOddKey=abc');
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.0', 'XPMultiplier=3.0');
  await d.drift.recordAfterSave(d.server(), settingKeys({ XPMultiplier: 3 }));
  assert.equal((await d.check()).changed, false);
  assert.equal(d.driftRow(), undefined);
});

test('a save that added a key or a whole section takes it into the baseline', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=outside');
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0\r\n', 'XPMultiplier=1.0\r\nHarvestAmountMultiplier=2\r\n');
  d.write('Game.ini', `${d.read('Game.ini')}[Ragnarok]\r\nAllowMultipleAttachments=True\r\n`);
  await d.drift.recordAfterSave(d.server(), [
    ...settingKeys({ HarvestAmountMultiplier: 2 }),
    { file: 'Game.ini', section: 'Ragnarok', key: 'AllowMultipleAttachments' },
  ]);
  const state = await d.check();
  assert.deepEqual(
    state.differences.map((x) => x.key),
    ['MyOddKey'],
  );
  assert.match(d.baselineFile('GameUserSettings.ini'), /HarvestAmountMultiplier=2/);
  assert.match(d.baselineFile('Game.ini'), /\[Ragnarok\]/);
});

// ---- small pieces ----

test('isCovered says which keys ARK Overseer has a control for', () => {
  const key = (file, section, name) => ({ file, section, key: name });
  assert.equal(isCovered(key('GameUserSettings.ini', 'ServerSettings', 'XPMultiplier')), true);
  assert.equal(isCovered(key('gameusersettings.INI', 'serversettings', 'xpmultiplier')), true);
  assert.equal(isCovered(key('GameUserSettings.ini', 'SessionSettings', 'SessionName')), true);
  assert.equal(isCovered(key('Game.ini', '/script/shootergame.shootergamemode', 'MatingIntervalMultiplier')), true);
  assert.equal(isCovered(key('GameUserSettings.ini', 'ServerSettings', 'MyOddKey')), false);
  // The right key in the wrong file or section is another setting.
  assert.equal(isCovered(key('Game.ini', 'ServerSettings', 'XPMultiplier')), false);
  assert.equal(isCovered(key('GameUserSettings.ini', 'Other', 'XPMultiplier')), false);
  assert.equal(isCovered(key('Extra.ini', 'ServerSettings', 'XPMultiplier')), false);
  assert.equal(isCovered({ file: 'GameUserSettings.ini', section: '', key: '' }), false);
});

test('settingKeys names the file, section and key each saved setting lands in', () => {
  assert.deepEqual(
    settingKeys({ sessionName: 'x', XPMultiplier: 2, MatingIntervalMultiplier: 1, Unknown: 1, Port: 7777 }),
    [
      { file: 'GameUserSettings.ini', section: 'SessionSettings', key: 'SessionName' },
      { file: 'GameUserSettings.ini', section: 'serversettings', key: 'XPMultiplier' },
      { file: 'Game.ini', section: '/script/shootergame.shootergamemode', key: 'MatingIntervalMultiplier' },
    ],
  );
  assert.deepEqual(settingKeys({ sessionName: '  ' }), []);
});

test('putKey sets, removes and repeats keys in the named section, and above the first section', () => {
  const file = ['pre=1', '[A]', 'x=1', 'x=2', 'y=3', '[B]', 'z=4'];
  const copy = () => [...file];
  let lines = copy();
  putKey(lines, 'A', 'x', ['9']);
  assert.deepEqual(lines, ['pre=1', '[A]', 'x=9', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, 'A', 'x', ['7', '8', '9']);
  assert.deepEqual(lines, ['pre=1', '[A]', 'x=7', 'x=8', 'x=9', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, 'A', 'x', []);
  assert.deepEqual(lines, ['pre=1', '[A]', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, 'C', 'n', ['1', '2']);
  assert.deepEqual(lines, [...file, '', '[C]', 'n=1', 'n=2']);
  lines = copy();
  putKey(lines, 'B', 'w', ['1', '2']);
  assert.deepEqual(lines, ['pre=1', '[A]', 'x=1', 'x=2', 'y=3', '[B]', 'w=1', 'w=2', 'z=4']);
  lines = copy();
  putKey(lines, '', 'pre', ['5']);
  assert.deepEqual(lines, ['pre=5', '[A]', 'x=1', 'x=2', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, '', 'top', ['1']);
  assert.deepEqual(lines, ['top=1', 'pre=1', '[A]', 'x=1', 'x=2', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, '', 'pre', []);
  assert.deepEqual(lines, ['[A]', 'x=1', 'x=2', 'y=3', '[B]', 'z=4']);
  lines = copy();
  putKey(lines, 'a', 'Y', ['4']);
  assert.deepEqual(lines, ['pre=1', '[A]', 'x=1', 'x=2', 'Y=4', '[B]', 'z=4']);
});

// ---- review fixes: the save under the lock, pending records, repeated keys, the start hook, sweeps ----

const XP = { file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'XPMultiplier' };
const TAMING = { file: 'GameUserSettings.ini', section: 'ServerSettings', key: 'TamingSpeedMultiplier' };
const BREED = { file: 'Game.ini', section: '/script/shootergame.shootergamemode', key: 'PreventBreedingForClassNames' };
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};
const resolveJobs = (d) => d.w.db.prepare('SELECT count(*) AS n FROM jobs WHERE kind = ?').get(RESOLVE).n;

test('a stop that is checked while a save is being written waits for the save and its record, and does not revert it', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  const held = gate();
  const saving = d.drift.saveSettings(
    d.server(),
    async () => {
      d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=3.0');
      await held.promise;
      return 'written';
    },
    [XP],
  );
  // The stop arrives between the write and its record: the check queues behind the whole save.
  await new Promise((resolve) => setImmediate(resolve));
  d.drift.onStateChange(stopped);
  await new Promise((resolve) => setImmediate(resolve));
  held.open();
  assert.equal(await saving, 'written');
  await d.drift.idle();
  assert.equal(d.driftRow(), undefined);
  assert.equal(resolveJobs(d), 0);
  await d.drift.beforeStart(1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=3.0/);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=3.0/);
  assert.equal(d.baselineRow().source, 'settings_save');
});

test('what ASA writes as it shuts down is not taken into the baseline by the save that came before', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  await d.drift.saveSettings(
    d.server(),
    async () => d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=3.0'),
    [XP],
  );
  d.edit('GameUserSettings.ini', 'TamingSpeedMultiplier=1.0', 'TamingSpeedMultiplier=9.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  for (const job of d.w.db.prepare('SELECT id FROM jobs WHERE kind = ?').all(RESOLVE)) await d.finished(job.id);
  // Only ASA's own value is put back; the saved one stays.
  const user = d.read('GameUserSettings.ini');
  assert.match(user, /XPMultiplier=3.0/);
  assert.match(user, /TamingSpeedMultiplier=1.0/);
});

test('a save that is refused records nothing, and the refusal reaches the caller', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const before = d.baselineRow();
  await assert.rejects(
    d.drift.saveSettings(
      d.server(),
      async () => {
        throw new Error('refused');
      },
      [XP],
    ),
    /refused/,
  );
  assert.deepEqual({ ...d.baselineRow() }, { ...before });
});

test('a record that fails keeps the last good baseline, and an outside edit made meanwhile is still reported', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const before = d.baselineRow();
  d.w.plan.failRename = d.w.counts.rename + 1;
  const written = await d.drift.saveSettings(
    d.server(),
    async () => {
      d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=3.0');
      return 42;
    },
    [XP],
  );
  assert.equal(written, 42);
  assert.equal(d.baselineRow().sha256, before.sha256);
  assert.deepEqual(JSON.parse(d.baselineRow().pending_json).keys, [XP]);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.ok(d.logs.some((line) => /Recording the settings baseline for server 1 failed: rename blocked/.test(line)));

  // A person changes another key, and the retry fails again: the save is still not reported, the edit is.
  d.edit('GameUserSettings.ini', 'TamingSpeedMultiplier=1.0', 'TamingSpeedMultiplier=5.0');
  d.w.plan.failRename = d.w.counts.rename + 1;
  const during = await d.check();
  assert.deepEqual(
    during.differences.map((x) => x.key),
    ['TamingSpeedMultiplier'],
  );
  assert.ok(d.baselineRow().pending_json);

  // The next check lands the record first, then reports only what is left.
  const after = await d.check();
  assert.deepEqual(
    after.differences.map((x) => x.key),
    ['TamingSpeedMultiplier'],
  );
  assert.equal(d.baselineRow().pending_json, null);
  assert.equal(d.baselineRow().source, 'settings_save');
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=3.0/);
  assert.match(d.baselineFile('GameUserSettings.ini'), /TamingSpeedMultiplier=1.0/);
});

test('a failed record after a restore is retried the same way, and never drops the baseline', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const backup = await d.w.backup();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=5.0');
  await d.drift.recordBaseline(d.server(), 'test');
  d.edit('GameUserSettings.ini', 'XPMultiplier=5.0', 'XPMultiplier=6.0');
  const before = d.baselineRow().sha256;
  // The restore handler's own record goes through recordBaseline, which now reports a failure by a log line.
  // Only the rename that would put the new baseline in place fails, not the restore itself.
  d.w.plan.onRename = (count, from, to) => {
    if (/baselines/.test(to)) throw Object.assign(new Error('rename blocked'), { code: 'EIO' });
  };
  await d.w.restore({ backupId: backup.id, scope: 'settings' }, 1);
  d.w.plan.onRename = null;
  assert.equal(d.baselineRow().sha256, before);
  assert.ok(d.baselineRow().pending_json);
  assert.equal(d.read('GameUserSettings.ini'), GUS);
  // Another key changed by hand is still reported; the restored one is not.
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=outside');
  const state = await d.check();
  assert.deepEqual(
    state.differences.map((x) => x.key),
    ['MyOddKey'],
  );
  assert.equal(d.baselineRow().pending_json, null);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.equal(d.baselineRow().source, 'restore');
});

// Repeated keys: every line of a key in a section is the key's value.

test('a save that changes a repeated key records all its lines, in order, without doubling them', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit(
    'Game.ini',
    'PreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=B_C\r\nPreventBreedingForClassNames=C_C',
  );
  d.edit('GameUserSettings.ini', 'MyOddKey=abc', 'MyOddKey=outside');
  await d.drift.recordAfterSave(d.server(), [BREED]);
  assert.equal(d.baselineFile('Game.ini'), d.read('Game.ini'));
  const kept = lines(d.baselineFile('Game.ini')).filter((line) => line.startsWith('PreventBreedingForClassNames='));
  assert.deepEqual(kept, [
    'PreventBreedingForClassNames=A_C',
    'PreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=C_C',
  ]);
  // The unrelated outside edit is not taken in.
  assert.deepEqual(
    (await d.check()).differences.map((x) => x.key),
    ['MyOddKey'],
  );
  // The same key with fewer lines, and then with its lines reordered in place.
  d.edit('Game.ini', 'PreventBreedingForClassNames=C_C\r\n', '');
  d.edit(
    'Game.ini',
    'PreventBreedingForClassNames=A_C\r\nPreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=B_C\r\nPreventBreedingForClassNames=A_C',
  );
  await d.drift.recordAfterSave(d.server(), [BREED]);
  assert.equal(d.baselineFile('Game.ini'), d.read('Game.ini'));
  assert.deepEqual(
    lines(d.baselineFile('Game.ini')).filter((line) => line.startsWith('PreventBreedingForClassNames=')),
    ['PreventBreedingForClassNames=B_C', 'PreventBreedingForClassNames=A_C'],
  );
});

test('a revert of a repeated key puts back every line, in the baseline order, in place', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  // The first line changed, a third one appeared, and other keys sit between them.
  d.edit('Game.ini', 'PreventBreedingForClassNames=A_C', 'PreventBreedingForClassNames=Z_C');
  d.edit(
    'Game.ini',
    'PreventBreedingForClassNames=B_C',
    'MatingIntervalMultiplier=1\r\nPreventBreedingForClassNames=B_C\r\nPreventBreedingForClassNames=Q_C',
  );
  d.edit(
    'Game.ini',
    'MatingIntervalMultiplier=1\r\nPreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=B_C',
  );
  const state = await d.check();
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.equal(d.read('Game.ini'), GAME);
  assert.equal((await d.check({ force: true })).changed, false);
  // A key with the same lines in another order goes back the same way, and a removed second copy returns.
  d.edit(
    'Game.ini',
    'PreventBreedingForClassNames=A_C\r\nPreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=B_C',
  );
  const second = await d.check();
  const again = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: second.liveSha256 }, target);
  assert.equal((await d.finished(again.id)).state, 'succeeded');
  assert.equal(d.read('Game.ini'), GAME);
});

test('choosing per key keeps the current lines of a repeated key whole and puts back the baseline lines of another', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit(
    'Game.ini',
    'PreventBreedingForClassNames=B_C',
    'PreventBreedingForClassNames=B_C\r\nPreventBreedingForClassNames=C_C',
  );
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  const choices = state.differences.map((x) => ({
    file: x.file,
    section: x.section,
    key: x.key,
    choice: x.key === 'XPMultiplier' ? 'baseline' : 'live',
  }));
  const job = d.jobs.enqueue(RESOLVE, { action: 'merge', liveSha256: state.liveSha256, choices }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.deepEqual(
    lines(d.read('Game.ini')).filter((line) => line.startsWith('PreventBreedingForClassNames=')),
    ['PreventBreedingForClassNames=A_C', 'PreventBreedingForClassNames=B_C', 'PreventBreedingForClassNames=C_C'],
  );
  // The kept key joined the baseline once, and nothing is left to report.
  assert.equal((await d.check({ force: true })).changed, false);
  assert.equal(d.baselineFile('Game.ini'), d.read('Game.ini'));
});

// The stop, the start and the queued put-back

test('a check after a stop marks an unchanged drift as found after the stop', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  await d.check();
  const first = d.driftRow();
  assert.equal(first.after_stop, 0);
  assert.equal((await d.check({ afterStop: true })).afterStop, true);
  const row = d.driftRow();
  assert.equal(row.after_stop, 1);
  assert.equal(row.live_sha256, first.live_sha256);
  assert.equal(row.detected_at, first.detected_at);
  // A later ordinary look does not take the mark away.
  assert.equal((await d.check()).afterStop, true);
});

test('a queued put-back job does not make a start wait for itself, and the start runs the revert', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.drift.attach(null);
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  d.w.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, 1, 'queued')",
    )
    .run(RESOLVE);
  await d.drift.beforeStart(1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.equal(d.w.backups().length, 1);
  assert.deepEqual(d.logs, []);
});

test('a start from any path waits for the revert: the supervisor hook and the queued job put back once', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  // A scheduled restart or a supervisor restart reaches the hook the same way a dashboard start does.
  await Promise.all([d.drift.beforeStart(1), d.drift.beforeStart(1)]);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  await d.drift.idle();
  for (const job of d.w.db.prepare('SELECT id FROM jobs WHERE kind = ?').all(RESOLVE)) await d.finished(job.id);
  assert.equal(d.w.backups().filter((b) => b.reason === 'pre_restore').length, 1);
});

test('a start only puts settings back when the server is stopped or has crashed', async (t) => {
  const d = driftWorld(t, { keep: true });
  await d.baseline();
  d.drift.attach(null);
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  const status = d.w.supervisor.status;
  for (const observedState of ['unknown', 'running', 'starting', 'stopping']) {
    d.w.supervisor.status = () => ({ observedState });
    await d.drift.beforeStart(1);
    assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=7.0/, observedState);
    assert.deepEqual(d.w.backups(), [], observedState);
  }
  d.w.supervisor.status = () => ({ observedState: 'crashed' });
  await d.drift.beforeStart(1);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  d.w.supervisor.status = status;
});

test('a start does not wait longer than the limit for the put-back: it goes ahead, logs the delay and changes nothing', async (t) => {
  const d = driftWorld(t, { keep: true, hookLimitMs: 30 });
  await d.baseline();
  d.drift.attach(null);
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  d.drift.onStateChange(stopped);
  await d.drift.idle();
  // The put-back is held while it reads the files, longer than the limit.
  const held = gate();
  d.hooks.onHash = () => held.promise;
  const started = Date.now();
  await d.drift.beforeStart(1);
  assert.ok(Date.now() - started < 2000);
  assert.equal(
    d.logs.filter((line) =>
      /^Server 1 started on the values ASA wrote at shutdown, because putting ARK Overseer.s settings back was still running after 0 seconds/.test(
        line,
      ),
    ).length,
    1,
  );
  d.hooks.onHash = null;
  held.open();
  await d.drift.idle();
  // The cancelled put-back wrote nothing.
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=7.0/);
  assert.deepEqual(d.w.backups(), []);
});

test('the put-back re-reads the files right before the swap and stops if they moved after it was planned', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  const state = await d.check();
  let moved = false;
  // The first full read after the job starts is the one that builds the plan; the next one is the re-read.
  d.hooks.onHash = async () => {
    if (moved) return;
    moved = true;
  };
  let reads = 0;
  d.hooks.onHash = async () => {
    reads += 1;
    if (reads === 2) d.edit('GameUserSettings.ini', 'XPMultiplier=7.0', 'XPMultiplier=8.0');
  };
  const before = d.w.counts.rename;
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  d.hooks.onHash = null;
  assert.equal(done.state, 'failed');
  assert.equal(done.error, DRIFT_MESSAGES.changedSince);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=8.0/);
  assert.equal(d.w.counts.rename, before);
  assert.deepEqual(
    d.w.backups().filter((b) => b.reason === 'pre_restore'),
    [],
  );
});

// The cheap check and the sweeps

test('the size-and-time skip is bypassed by a stop check, a forced look and every sixth sweep', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.write('GameUserSettings.ini', d.read('GameUserSettings.ini'));
  await d.check();
  // A same-size change that keeps the file's time: only a full hash can see it.
  d.writeQuietly(
    'GameUserSettings.ini',
    d.read('GameUserSettings.ini').replace('XPMultiplier=1.0', 'XPMultiplier=2.0'),
  );
  assert.equal((await d.check()).changed, false);
  assert.equal((await d.check({ force: false })).changed, false);
  assert.equal((await d.check({ afterStop: true })).changed, true);

  const forced = driftWorld(t);
  await forced.baseline();
  forced.write('GameUserSettings.ini', forced.read('GameUserSettings.ini'));
  await forced.check();
  forced.writeQuietly(
    'GameUserSettings.ini',
    forced.read('GameUserSettings.ini').replace('XPMultiplier=1.0', 'XPMultiplier=2.0'),
  );
  assert.equal((await forced.check()).changed, false);
  assert.equal((await forced.check({ force: true })).changed, true);

  // Sweeps one to five are cheap; the sixth hashes everything.
  const swept = driftWorld(t);
  await swept.baseline();
  swept.write('GameUserSettings.ini', swept.read('GameUserSettings.ini'));
  await swept.check();
  swept.writeQuietly(
    'GameUserSettings.ini',
    swept.read('GameUserSettings.ini').replace('XPMultiplier=1.0', 'XPMultiplier=2.0'),
  );
  const stop = swept.drift.start();
  await swept.drift.idle();
  for (let sweep = 2; sweep <= 5; sweep++) {
    swept.timers.intervals[0].fn();
    await swept.drift.idle();
  }
  assert.equal(swept.driftRow(), undefined);
  swept.timers.intervals[0].fn();
  await swept.drift.idle();
  assert.ok(swept.driftRow());
  stop();
});

test('a sweep does not start while the one before it is still running', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.writeQuietly(
    'GameUserSettings.ini',
    d.read('GameUserSettings.ini').replace('XPMultiplier=1.0', 'XPMultiplier=2.0'),
  );
  const held = gate();
  let entered = 0;
  d.hooks.onHash = async () => {
    entered += 1;
    await held.promise;
  };
  const stop = d.drift.start();
  // Let the first sweep reach the hash, then fire the timer twice more while it is stuck there.
  const deadline = Date.now() + 2000;
  while (!entered && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const inside = entered;
  d.timers.intervals[0].fn();
  d.timers.intervals[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(entered, inside);
  held.open();
  d.hooks.onHash = null;
  await d.drift.idle();
  // With the first sweep over, the next one starts.
  const hashes = d.hashed.length;
  d.timers.intervals[0].fn();
  await d.drift.idle();
  assert.ok(d.hashed.length >= hashes);
  stop();
});

test('while another file job owns the files a check answers with what was last found, marked busy', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  const found = await d.check();
  d.w.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'server.restore', 1, 'running')",
    )
    .run();
  const busy = await d.check();
  assert.equal(busy.busy, true);
  assert.equal(busy.changed, true);
  assert.deepEqual(busy.differences, found.differences);
  // Nothing was compared or recorded meanwhile.
  assert.equal(d.driftRow().live_sha256, found.liveSha256);
  const quiet = driftWorld(t);
  await quiet.baseline();
  quiet.w.db
    .prepare(
      "INSERT INTO jobs (created_at, updated_at, kind, server_id, state) VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'server.switch_map', 1, 'queued')",
    )
    .run();
  const empty = await quiet.check();
  assert.equal(empty.busy, true);
  assert.deepEqual(empty.differences, []);
});

test('an audit event that cannot be written is logged, and the put-back still succeeds', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=7.0');
  const state = await d.check();
  d.w.db.exec(
    "CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit refused'); END",
  );
  const job = d.jobs.enqueue(RESOLVE, { action: 'revert', liveSha256: state.liveSha256 }, target);
  const done = await d.finished(job.id);
  assert.equal(done.state, 'succeeded', done.error);
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.ok(d.logs.some((line) => /Writing the settings audit event for server 1 failed: audit refused/.test(line)));
});
