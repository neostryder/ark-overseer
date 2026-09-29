import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkRestore,
  formatTime,
  RestoreError,
  RESTORE_MESSAGES,
  reconcilePendingRestores,
  restoreLayout,
} from '../src/backups/restore.js';
import { PLAYER_MESSAGES } from '../src/scheduler/handlers.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { restoreWorld, readTree, writeTree, NOW } from './helpers/restore-world.js';

const WHEN = formatTime('2026-01-01T00:00:00.000Z');

const chat = (message) => `ServerChat ${message}`;
const worldPath = (w, map = 'TheIsland_WP') => path.join(w.layout.savedArks, map);
const safetyRows = (w) => w.backups().filter((row) => row.reason === 'pre_restore');
const treeOf = (row, ...parts) => readTree(path.join(row.path, ...parts));

// A server with a backup taken at v1 and every live file changed to v2 afterwards.
async function withBackup(t, options) {
  const w = restoreWorld(t, options);
  const row = await w.backup();
  const v1 = { world: w.world(), settings: w.settings() };
  w.change('v2');
  const v2 = { world: w.world(), settings: w.settings() };
  return { w, row, v1, v2 };
}

test('everything: a running server is warned, stopped, backed up, restored, started and waited for', async (t) => {
  const { w, row, v1, v2 } = await withBackup(t);
  const result = await w.restore({ backupId: row.id, scope: 'everything' });
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.settings(), v1.settings);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
  const safety = safetyRows(w);
  assert.equal(safety.length, 1);
  assert.deepEqual(result, {
    backupId: row.id,
    scope: 'everything',
    map: 'TheIsland_WP',
    safetyBackupId: safety[0].id,
    started: true,
    differentMap: false,
  });
  // The safety backup holds exactly what the restore replaced.
  assert.equal(safety[0].map, 'TheIsland_WP');
  assert.deepEqual(treeOf(safety[0], 'SavedArks', 'TheIsland_WP'), v2.world);
  assert.deepEqual(treeOf(safety[0], 'Config', 'WindowsServer'), v2.settings);
  // The order of things: warnings, the stop, the start, the wait.
  assert.deepEqual(
    w.events.filter((event) => event[0] !== 'progress' && event[0] !== 'rename'),
    [
      ['rcon', 27020, chat(PLAYER_MESSAGES.restore(5, 'everything'))],
      ['sleep', 4],
      ['rcon', 27020, chat(PLAYER_MESSAGES.restore(1, 'everything'))],
      ['sleep', 1],
      ['rcon', 27020, chat(PLAYER_MESSAGES.restoring)],
      ['stop', 1],
      ['start', 1],
      ['ready', true],
    ],
  );
  const messages = w.messages();
  assert.equal(messages[0], RESTORE_MESSAGES.steps.checking);
  assert.ok(messages.includes(RESTORE_MESSAGES.steps.safety));
  assert.ok(messages.includes(RESTORE_MESSAGES.steps.restoring));
  assert.ok(messages.includes(RESTORE_MESSAGES.steps.waiting));
  assert.equal(messages.at(-1), `The backup from ${WHEN} is restored.`);
  assert.deepEqual(w.audits(), [
    {
      action: 'server.backup.restore',
      actor: 'job',
      backupId: row.id,
      scope: 'everything',
      jobId: 1,
      outcome: 'restored',
      safetyBackupId: safety[0].id,
      differentMap: false,
    },
  ]);
  // The backup itself is unchanged and there is no pruning.
  assert.equal(w.backups().length, 2);
  assert.deepEqual(treeOf(row, 'SavedArks', 'TheIsland_WP'), v1.world);
});

test('a countdown, the announce style and the marks come from the job parameters', async (t) => {
  const { w, row } = await withBackup(t);
  await w.restore({ backupId: row.id, scope: 'settings', countdownMinutes: [2], announce: 'broadcast' });
  assert.deepEqual(
    w.events.filter((event) => event[0] === 'rcon').map((event) => event[2]),
    [`Broadcast ${PLAYER_MESSAGES.restore(2, 'settings')}`, `Broadcast ${PLAYER_MESSAGES.restoring}`],
  );
  assert.match(
    PLAYER_MESSAGES.restore(1, 'everything'),
    /^Restart in 1 minute to restore a backup\. The world goes back to that backup/,
  );
  assert.match(PLAYER_MESSAGES.restore(3, 'players'), /some players and tribes from a backup/);
});

test('world: the settings are left alone', async (t) => {
  const { w, row, v1, v2 } = await withBackup(t);
  await w.restore({ backupId: row.id, scope: 'world' });
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.settings(), v2.settings);
  // The safety backup holds the world only.
  const safety = safetyRows(w)[0];
  assert.equal(treeOf(safety, 'Config'), null);
  assert.deepEqual(treeOf(safety, 'SavedArks', 'TheIsland_WP'), v2.world);
});

test('settings: the world is left alone, and the safety backup holds the settings only', async (t) => {
  const { w, row, v1, v2 } = await withBackup(t);
  await w.restore({ backupId: row.id, scope: 'settings' });
  assert.deepEqual(w.settings(), v1.settings);
  assert.deepEqual(w.world(), v2.world);
  const safety = safetyRows(w)[0];
  assert.equal(treeOf(safety, 'SavedArks'), null);
  assert.deepEqual(treeOf(safety, 'Config', 'WindowsServer'), v2.settings);
});

test('players: only the listed files are replaced, and everything else is byte for byte unchanged', async (t) => {
  const { w, row, v1, v2 } = await withBackup(t);
  // A player and a tribe that exist only now, and a file changed in another map.
  writeTree(worldPath(w), { '0003.arkprofile': 'new player', '1003.arktribe': 'new tribe' });
  const ragnarok = w.world('Ragnarok_WP');
  const before = w.world();
  const result = await w.restore({ backupId: row.id, scope: 'players', profiles: ['0001'], tribes: ['1002'] });
  const after = w.world();
  const replaced = new Set(['0001.arkprofile', '1002.arktribe']);
  for (const [name, content] of Object.entries(after)) {
    if (replaced.has(name)) assert.equal(content, v1.world[name], name);
    else assert.equal(content, before[name], name);
  }
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.equal(after['0002.arkprofile'], v2.world['0002.arkprofile']);
  assert.equal(after['0003.arkprofile'], 'new player');
  assert.equal(after['TheIsland_WP.ark'], v2.world['TheIsland_WP.ark']);
  assert.deepEqual(w.settings(), v2.settings);
  assert.deepEqual(w.world('Ragnarok_WP'), ragnarok);
  assert.deepEqual(w.artifacts(), []);
  // The safety backup holds the whole world folder as it was.
  assert.deepEqual(treeOf(safetyRows(w)[0], 'SavedArks', 'TheIsland_WP'), before);
  assert.equal(result.scope, 'players');
});

test('a backup of another map restores that map and leaves the server on its own map', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup({ map: 'Ragnarok_WP' });
  const v1 = w.world('Ragnarok_WP');
  w.change('v2', 'Ragnarok_WP');
  const islandBefore = w.world();
  const result = await w.restore({ backupId: row.id, scope: 'world' });
  assert.deepEqual(w.world('Ragnarok_WP'), v1);
  assert.deepEqual(w.world(), islandBefore);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.equal(result.differentMap, true);
  assert.equal(result.map, 'Ragnarok_WP');
  // The safety backup is of the map that was replaced, not the server's own.
  const safety = safetyRows(w)[0];
  assert.equal(safety.map, 'Ragnarok_WP');
  assert.equal(treeOf(safety, 'SavedArks', 'TheIsland_WP'), null);
  assert.ok(treeOf(safety, 'SavedArks', 'Ragnarok_WP'));
  // Settings-only restores are never a different-map case.
  assert.equal((await w.restore({ backupId: row.id, scope: 'settings' })).differentMap, false);
});

test('a map that has no folder yet is created, and there is nothing to make a safety backup of', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup({ map: 'Ragnarok_WP' });
  const v1 = w.world('Ragnarok_WP');
  fs.rmSync(worldPath(w, 'Ragnarok_WP'), { recursive: true });
  const result = await w.restore({ backupId: row.id, scope: 'world' });
  assert.deepEqual(w.world('Ragnarok_WP'), v1);
  assert.deepEqual(safetyRows(w), []);
  assert.equal(result.safetyBackupId, null);
  assert.deepEqual(result.notes, [RESTORE_MESSAGES.nothingToSave]);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
});

test('a server that is stopped is restored and left stopped, with no warning and no start', async (t) => {
  const { w, row, v1 } = await withBackup(t, { running: false });
  const result = await w.restore({ backupId: row.id, scope: 'everything' });
  assert.deepEqual(w.world(), v1.world);
  assert.equal(result.started, false);
  assert.deepEqual(
    w.events.filter((event) => ['rcon', 'stop', 'start', 'ready', 'sleep'].includes(event[0])),
    [],
  );
  assert.equal(
    w.messages().at(-1),
    `The backup from ${WHEN} is restored. The server stays stopped until you start it.`,
  );
  assert.deepEqual(w.pending(), []);
});

test('a server stopped during the countdown is restored without being started', async (t) => {
  const { w, row } = await withBackup(t);
  const push = w.events.push.bind(w.events);
  w.events.push = (entry) => {
    if (entry[0] === 'sleep') w.setState('stopped');
    return push(entry);
  };
  const result = await w.restore({ backupId: row.id, scope: 'world', countdownMinutes: [1] });
  assert.equal(result.started, false);
  assert.ok(!w.events.some((event) => event[0] === 'start'));
});

test('a failed in-game warning does not stop the restore', async (t) => {
  const { w, row } = await withBackup(t);
  w.plan.failRcon = true;
  const result = await w.restore({ backupId: row.id, scope: 'settings', countdownMinutes: [1] });
  assert.equal(result.started, true);
  assert.ok(
    w.events.some((event) => event[0] === 'progress' && /did not get the in-game warning/.test(event[1] ?? '')),
  );
});

// ---- the checking step ----

test('checking refuses a bad request or a bad backup before anything is touched', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  const fails = async (params, code, message) => {
    await assert.rejects(
      w.restore(params),
      (error) => error.code === code && (!message || message.test(error.message)),
      code,
    );
    assert.deepEqual(w.world(), v2.world);
    assert.deepEqual(w.pending(), []);
    assert.deepEqual(w.steps(), []);
    assert.deepEqual(safetyRows(w), []);
  };
  await fails({ backupId: row.id, scope: 'nothing' }, 'bad_scope');
  await fails({ backupId: row.id }, 'bad_scope');
  await fails({ scope: 'world' }, 'no_backup');
  await fails({ backupId: 999, scope: 'world' }, 'no_backup');
  await fails({ backupId: 'x', scope: 'world' }, 'no_backup');
  // A backup that belongs to another server is not found.
  w.db.prepare('UPDATE backups SET server_id = NULL WHERE id = ?').run(row.id);
  await fails({ backupId: row.id, scope: 'world' }, 'no_backup');
  w.db.prepare('UPDATE backups SET server_id = 1 WHERE id = ?').run(row.id);
  await fails({ backupId: row.id, scope: 'players' }, 'no_players');
  await fails({ backupId: row.id, scope: 'players', profiles: [], tribes: [] }, 'no_players');
  await fails({ backupId: row.id, scope: 'players', profiles: 'all' }, 'bad_players');
  await fails({ backupId: row.id, scope: 'players', profiles: ['../x'] }, 'bad_players');
  await fails({ backupId: row.id, scope: 'players', profiles: [5] }, 'bad_players');
  await fails(
    { backupId: row.id, scope: 'players', profiles: ['0001', '9999'], tribes: ['1001'] },
    'unknown_players',
    /9999/,
  );
  // A tribe id is not a profile id.
  await fails({ backupId: row.id, scope: 'players', profiles: ['1001'] }, 'unknown_players');
});

test('checking refuses a backup with a missing or changed file, and names it', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  const file = path.join(row.path, 'SavedArks', 'TheIsland_WP', '1001.arktribe');
  fs.writeFileSync(file, 'tampered');
  await assert.rejects(
    w.restore({ backupId: row.id, scope: 'world' }),
    /1001\.arktribe in the backup no longer matches/,
  );
  fs.rmSync(file);
  await assert.rejects(
    w.restore({ backupId: row.id, scope: 'everything' }),
    /1001\.arktribe is missing from the backup/,
  );
  // A scope that does not read that file is not held back by it.
  await w.restore({ backupId: row.id, scope: 'settings' });
  assert.deepEqual(w.world(), v2.world);
});

test('checking refuses a scope the backup has no files for', async (t) => {
  const w = restoreWorld(t);
  const settingsOnly = await w.backup({ include: { world: false } });
  const worldOnly = await w.backup({ include: { config: false } });
  const server = w.server();
  const check = (row, scope) =>
    checkRestore({ db: w.db, dataDir: w.dataDir, server, params: { backupId: row.id, scope } });
  await assert.rejects(check(settingsOnly, 'world'), { code: 'empty_scope', message: RESTORE_MESSAGES.noWorldFiles });
  await assert.rejects(check(worldOnly, 'settings'), {
    code: 'empty_scope',
    message: RESTORE_MESSAGES.noSettingsFiles,
  });
  assert.equal((await check(settingsOnly, 'everything')).info.settings.length, 2);
  assert.equal((await check(worldOnly, 'everything')).info.world.length, 6);
  // Everything with only one part restores that part.
  w.change('v2');
  const settingsV1 = readTree(path.join(settingsOnly.path, 'Config', 'WindowsServer'));
  const worldNow = w.world();
  await w.restore({ backupId: settingsOnly.id, scope: 'everything' });
  assert.deepEqual(w.settings(), settingsV1);
  assert.deepEqual(w.world(), worldNow);
});

test('checking says whether the world is from another map, and refuses an odd map name', async (t) => {
  const w = restoreWorld(t);
  const island = await w.backup();
  const ragnarok = await w.backup({ map: 'Ragnarok_WP' });
  const server = w.server();
  const check = (row, scope) =>
    checkRestore({ db: w.db, dataDir: w.dataDir, server, params: { backupId: row.id, scope } });
  assert.equal((await check(island, 'world')).differentMap, false);
  assert.equal((await check(ragnarok, 'world')).differentMap, true);
  assert.equal((await check(ragnarok, 'everything')).differentMap, true);
  assert.equal((await check(ragnarok, 'settings')).differentMap, false);
  assert.equal((await check(ragnarok, 'world')).map, 'Ragnarok_WP');
  // A map folder name that could not be a map id: the list itself names it.
  const manifest = path.join(ragnarok.path, 'snapshot.json');
  fs.writeFileSync(
    manifest,
    fs.readFileSync(manifest, 'utf8').replaceAll('SavedArks/Ragnarok_WP/', 'SavedArks/Bad Map/'),
  );
  w.db.prepare('UPDATE backups SET map = NULL WHERE id = ?').run(ragnarok.id);
  await assert.rejects(check(ragnarok, 'world'), { code: 'bad_map' });
  assert.ok(new RestoreError(400, 'x', 'y') instanceof Error);
});

test('a job for a server that is gone fails with a message', async (t) => {
  const { w, row } = await withBackup(t);
  await assert.rejects(
    w.handlers['server.restore']({ ...w.ctx({ backupId: row.id, scope: 'world' }), job: { id: 1, serverId: 99 } }),
    /server was not found/,
  );
});

// ---- failures ----

test('a cancelled countdown tells players, stops nothing and changes nothing', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.abortOnSleep = true;
  await assert.rejects(w.restore({ backupId: row.id, scope: 'everything' }), /cancelled/);
  assert.deepEqual(w.events.at(-1), ['rcon', 27020, chat(PLAYER_MESSAGES.restoreCancelled)]);
  assert.deepEqual(w.steps(), []);
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(safetyRows(w), []);
  assert.deepEqual(
    w.audits().map((audit) => [audit.action, audit.outcome, audit.scope, audit.backupId]),
    [['server.backup.restore', 'cancelled', 'everything', row.id]],
  );
});

test('a server that cannot be stopped changes nothing and is not started', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.stop.push(new Error('the process would not exit'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'everything' }), {
    message: `${RESTORE_MESSAGES.stopFailed} The process would not exit.`,
  });
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.settings(), v2.settings);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.steps(), ['stop']);
  assert.deepEqual(safetyRows(w), []);
});

// Fills the numbered folders the safety backup would use, so that backing up fails.
function blockSafetyBackup(w) {
  const stamp = new Date(NOW).toISOString().replace(/[-:]/g, '').replace('.', '-');
  const base = path.join(w.dataDir, 'backups', 'server-1', `${stamp}-pre_restore`);
  fs.mkdirSync(base, { recursive: true });
  for (let n = 2; n <= 10; n++) fs.mkdirSync(`${base}-${n}`);
}

test('a safety backup that fails changes nothing, starts the server again and fails the job', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  blockSafetyBackup(w);
  await assert.rejects(w.restore({ backupId: row.id, scope: 'everything' }), (error) =>
    error.message.startsWith(RESTORE_MESSAGES.safetyFailed),
  );
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.settings(), v2.settings);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.steps(), ['stop', 'start']);
  assert.equal(w.state(), 'running');
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(
    w.audits().map((audit) => audit.outcome),
    ['failed'],
  );
  // A server that was stopped stays stopped.
  const stopped = await withBackup(t, { running: false });
  blockSafetyBackup(stopped.w);
  await assert.rejects(stopped.w.restore({ backupId: stopped.row.id, scope: 'world' }), /safety backup failed/);
  assert.deepEqual(stopped.w.steps(), []);
  // If it cannot be started again, the failure says so as well.
  const stuck = await withBackup(t);
  blockSafetyBackup(stuck.w);
  stuck.w.plan.start.push(new Error('launch failed'));
  await assert.rejects(stuck.w.restore({ backupId: stuck.row.id, scope: 'world' }), (error) =>
    error.message.endsWith(RESTORE_MESSAGES.restartFailed),
  );
});

test('a copy that fails leaves the live files as they were and removes the staged copy', async (t) => {
  for (const at of [1, 2, 5, 7]) {
    const { w, row, v2 } = await withBackup(t);
    // Only the restore's own copies are counted; the safety backup copies through the app's own routine.
    w.plan.failCopy = at;
    await assert.rejects(w.restore({ backupId: row.id, scope: 'everything' }), (error) =>
      error.message.startsWith(RESTORE_MESSAGES.filesFailed),
    );
    assert.deepEqual(w.world(), v2.world, `copy ${at}`);
    assert.deepEqual(w.settings(), v2.settings, `copy ${at}`);
    assert.deepEqual(w.artifacts(), [], `copy ${at}`);
    assert.deepEqual(w.pending(), []);
    assert.equal(w.state(), 'running');
    assert.deepEqual(w.steps(), ['stop', 'start']);
  }
});

test('a rename that fails, at any of the four, puts every folder back and starts the server again', async (t) => {
  for (const at of [1, 2, 3, 4]) {
    const { w, row, v2 } = await withBackup(t);
    w.plan.failRename = at;
    await assert.rejects(
      w.restore({ backupId: row.id, scope: 'everything' }),
      (error) => error.message.startsWith(RESTORE_MESSAGES.filesFailed) && /rename blocked/i.test(error.message),
    );
    assert.deepEqual(w.world(), v2.world, `rename ${at}`);
    assert.deepEqual(w.settings(), v2.settings, `rename ${at}`);
    assert.deepEqual(w.artifacts(), [], `rename ${at}`);
    assert.deepEqual(w.pending(), [], `rename ${at}`);
    assert.deepEqual(w.steps(), ['stop', 'start'], `rename ${at}`);
    assert.equal(w.state(), 'running');
    assert.equal(w.audits()[0].outcome, 'failed');
  }
});

test('a rename that fails in a players restore puts every file back', async (t) => {
  // Two profile files and a tribe: each swaps with two renames, so any of the six can fail.
  for (const at of [1, 2, 3, 4, 5, 6]) {
    const { w, row, v2 } = await withBackup(t);
    w.plan.failRename = at;
    await assert.rejects(
      w.restore({ backupId: row.id, scope: 'players', profiles: ['0001', '0002'], tribes: ['1001'] }),
      /rename blocked/i,
    );
    assert.deepEqual(w.world(), v2.world, `rename ${at}`);
    assert.deepEqual(w.artifacts(), [], `rename ${at}`);
    assert.deepEqual(w.pending(), []);
  }
});

test('when the files cannot be put back either, the row stays and the server is not started', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  const original = w.ops.rename;
  // The first rename works, then the disk refuses every rename, the undo's too.
  let calls = 0;
  w.ops.rename = async (from, to) => {
    if (++calls > 1) throw Object.assign(new Error('still blocked'), { code: 'EIO' });
    return original(from, to);
  };
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), { message: RESTORE_MESSAGES.filesNotPutBack });
  assert.equal(w.pending().length, 1);
  assert.deepEqual(w.steps(), ['stop']);
  // The next start of ARK Overseer puts the world back once the disk lets it.
  w.ops.rename = original;
  const settled = await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW });
  assert.deepEqual(settled, [{ serverId: 1, wasRunning: true, outcome: 'rolled_back' }]);
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
});

test('a cancel while copying, or between folders, changes nothing', async (t) => {
  const copying = await withBackup(t);
  copying.w.plan.onCopy = (count) => {
    // The safety backup uses the real copy; the restore's own copies use the wrapped one.
    if (count === 3) copying.w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(copying.w.restore({ backupId: copying.row.id, scope: 'everything' }), /cancelled/);
  assert.deepEqual(copying.w.world(), copying.v2.world);
  assert.deepEqual(copying.w.settings(), copying.v2.settings);
  assert.deepEqual(copying.w.artifacts(), []);
  assert.deepEqual(copying.w.steps(), ['stop', 'start']);

  // Cancelled after the world folder is in place: the world goes back too.
  const between = await withBackup(t);
  between.w.plan.onRename = (count) => {
    if (count === 2) between.w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(between.w.restore({ backupId: between.row.id, scope: 'everything' }), /cancelled/);
  assert.deepEqual(between.w.world(), between.v2.world);
  assert.deepEqual(between.w.settings(), between.v2.settings);
  assert.deepEqual(between.w.artifacts(), []);
  assert.deepEqual(between.w.pending(), []);
  assert.equal(between.w.state(), 'running');
});

test('a cancel before the check finishes, or while the server stops, changes nothing', async (t) => {
  const { w, row, v2 } = await withBackup(t, { running: false });
  w.plan.controller.abort(new Error('cancelled'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /cancelled/);
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.pending(), []);
  // Cancelled while the server is being stopped: the stop finishes, then the restore gives up and restarts it.
  const late = await withBackup(t);
  late.w.supervisor.stop = async () => {
    late.w.events.push(['stop', 1]);
    late.w.setState('stopped');
    late.w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(late.w.restore({ backupId: late.row.id, scope: 'world' }), /cancelled/);
  assert.deepEqual(late.w.world(), late.v2.world);
  assert.deepEqual(late.w.steps(), ['stop', 'start']);
  assert.deepEqual(late.w.pending(), []);
  assert.deepEqual(safetyRows(late.w), []);
});

// ---- the start and the wait ----

test('a start that fails puts the earlier files back, starts the server and fails with the reason', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.start.push(new Error('server failed to start after 3 attempt(s)'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'everything' }), {
    message: `The restored files did not start the server: Server failed to start after 3 attempt(s). The server is back as it was before the restore. The backup from ${WHEN} was not changed.`,
  });
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.settings(), v2.settings);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.steps(), ['stop', 'start', 'stop', 'start', 'ready']);
  assert.equal(w.state(), 'running');
  assert.deepEqual(
    w.audits().map((audit) => [audit.action, audit.outcome]),
    [['server.backup.restore_rolled_back', 'rolled_back']],
  );
  // The backup that was restored is not deleted or changed.
  assert.equal(w.backups().length, 2);
  assert.ok(treeOf(row, 'SavedArks', 'TheIsland_WP')['0001.arkprofile'].endsWith('v1'));
});

test('a server that never becomes ready is rolled back to the safety backup', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.ready.push(new Error('The world was still loading after 20 minutes, so ARK Overseer stopped waiting.'));
  await assert.rejects(
    w.restore({ backupId: row.id, scope: 'world' }),
    /The restored files did not start the server: The world was still loading after 20 minutes/,
  );
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.steps(), ['stop', 'start', 'ready', 'stop', 'start', 'ready']);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.artifacts(), []);
  // An empty reason reads well.
  const quiet = await withBackup(t);
  quiet.w.plan.ready.push(new Error(''));
  await assert.rejects(quiet.w.restore({ backupId: quiet.row.id, scope: 'world' }), {
    message: `The restored files did not start the server. It is back as it was before the restore. The backup from ${WHEN} was not changed.`,
  });
});

test('a rollback of a players restore puts the whole world folder back', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.ready.push(new Error('slow'));
  await assert.rejects(
    w.restore({ backupId: row.id, scope: 'players', profiles: ['0001'], tribes: [] }),
    /did not start/,
  );
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.artifacts(), []);
});

test('a rollback of a settings restore puts the settings back and leaves the world alone', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.ready.push(new Error('bad ini'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'settings' }), /did not start/);
  assert.deepEqual(w.settings(), v2.settings);
  assert.deepEqual(w.world(), v2.world);
});

test('a rollback with no safety backup removes what the restore created', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup({ map: 'Ragnarok_WP' });
  fs.rmSync(worldPath(w, 'Ragnarok_WP'), { recursive: true });
  w.plan.ready.push(new Error('will not load'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /did not start/);
  assert.equal(w.world('Ragnarok_WP'), null);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(safetyRows(w), []);
});

test('when the earlier files will not start either, the job says so and points at the log', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.start.push(new Error('first'), new Error('second'));
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), {
    message: `The restored files did not start the server, and it did not start after they were put back. Check the server log. The backup from ${WHEN} was not changed.`,
  });
  assert.deepEqual(w.world(), v2.world);
  assert.deepEqual(w.pending(), []);
  // Ready that never comes after the rollback is the same failure.
  const late = await withBackup(t);
  late.w.plan.ready.push(new Error('slow'), new Error('slow again'));
  await assert.rejects(late.w.restore({ backupId: late.row.id, scope: 'world' }), /Check the server log\./);
});

test('a rollback whose files cannot be put back says so and keeps the row for the next start', async (t) => {
  const { w, row, v1 } = await withBackup(t);
  w.plan.ready.push(new Error('slow'));
  // A world restore swaps with renames 1 and 2; the rollback's first rename is number 3.
  w.plan.failRename = 3;
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /earlier files could not be put back/);
  assert.equal(w.pending().length, 1);
  assert.equal(w.pending()[0].stage, 'rollback');
  assert.deepEqual(
    w.audits().map((audit) => audit.outcome),
    ['files_not_put_back'],
  );
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.artifacts(), []);
});

test('a cancel while the restored world loads stops the wait and keeps the restore', async (t) => {
  const { w, row, v1 } = await withBackup(t);
  w.plan.ready.push(() => {
    w.plan.controller.abort(new Error('cancelled'));
    throw w.plan.controller.signal.reason;
  });
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), { message: 'cancelled' });
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.steps(), ['stop', 'start', 'ready']);
  assert.equal(w.audits()[0].outcome, 'restored_then_cancelled');
  // Cancelled in the moment it finished loading: the job still does not report success.
  const late = await withBackup(t);
  late.w.plan.ready.push(() => late.w.plan.controller.abort(new Error('cancelled')));
  await assert.rejects(late.w.restore({ backupId: late.row.id, scope: 'world' }), { message: 'cancelled' });
  assert.deepEqual(late.w.world(), late.v1.world);
});

test('a start that leaves the old process running is not trusted', async (t) => {
  const { w, row, v2 } = await withBackup(t);
  w.plan.stopLeavesRunning = true;
  await assert.rejects(w.restore({ backupId: row.id, scope: 'world' }), /Check the server log./);
  assert.deepEqual(w.world(), v2.world);
  assert.ok(!w.events.some((event) => event[0] === 'start' || event[0] === 'ready'));
});

test('leftover folders that cannot be removed do not undo a finished restore, and are removed at the next start', async (t) => {
  const { w, row, v1 } = await withBackup(t, { running: false });
  w.plan.failFinish = true;
  const result = await w.restore({ backupId: row.id, scope: 'everything' });
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(result.notes, [RESTORE_MESSAGES.leftovers]);
  assert.equal(w.artifacts().length, 2);
  assert.deepEqual(
    w.pending().map((row) => [row.stage, row.was_running]),
    [['cleanup', 0]],
  );
  w.plan.failFinish = false;
  assert.deepEqual(await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW }), [
    { serverId: 1, wasRunning: false, outcome: 'completed' },
  ]);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.world(), v1.world);
  assert.deepEqual(w.pending(), []);
});

test('the pending row exists while the job runs and names each stage', async (t) => {
  const { w, row } = await withBackup(t);
  const seen = [];
  w.plan.onRename = () => seen.push(w.pending()[0].stage);
  w.plan.onCopy = () => seen.push(w.pending()[0].stage);
  const base = w.supervisor.stop;
  w.supervisor.stop = async (id) => {
    seen.push(w.pending()[0].stage);
    return base(id);
  };
  const start = w.supervisor.start;
  w.supervisor.start = async (id) => {
    seen.push(w.pending()[0].stage);
    return start(id);
  };
  await w.restore({ backupId: row.id, scope: 'everything' });
  assert.deepEqual([...new Set(seen)], ['stopping', 'staging', 'swapping:world', 'swapping:settings', 'starting']);
});

// ---- the startup reconcile ----

// A pending row and the files a job left, for a stage, without running a job.
function cutOff(w, { stage, jobId = 1, wasRunning = 1, safety = null } = {}) {
  w.db
    .prepare(
      'INSERT INTO pending_restores (server_id, job_id, backup_id, scope, safety_backup_id, was_running, started_at, stage) VALUES (1, ?, 1, ?, ?, ?, ?, ?)',
    )
    .run(jobId, 'everything', safety, wasRunning, '2026-01-01T00:00:00.000Z', stage);
}
const swapAside = (w, jobId, tag = String(jobId)) => {
  // The world folder was renamed away and the new one moved in: old holds v1 (the earlier files), live holds v9.
  const world = worldPath(w);
  fs.renameSync(world, `${world}.old-${tag}`);
  writeTree(world, { 'TheIsland_WP.ark': 'restored' });
};

test('reconcile: stopping, safety and staging only drop the row and the staged copy', async (t) => {
  for (const stage of ['stopping', 'safety', 'staging']) {
    const w = restoreWorld(t);
    const before = w.world();
    writeTree(`${worldPath(w)}.restore-1`, { 'TheIsland_WP.ark': 'partly copied' });
    cutOff(w, { stage });
    const settled = await reconcilePendingRestores({ db: w.db, now: () => NOW });
    assert.deepEqual(settled, [{ serverId: 1, wasRunning: true, outcome: 'rolled_back' }], stage);
    assert.deepEqual(w.world(), before, stage);
    assert.deepEqual(w.artifacts(), [], stage);
    assert.deepEqual(w.pending(), [], stage);
    assert.deepEqual(w.audits(), [
      {
        action: 'server.backup.restore_reconciled',
        actor: 'system',
        backupId: 1,
        safetyBackupId: null,
        scope: 'everything',
        stage,
        outcome: 'rolled_back',
        jobId: 1,
      },
    ]);
    const stamp = w.db.prepare('SELECT created_at FROM audit_events').get().created_at;
    assert.equal(stamp, '2026-01-01T00:00:00.000Z');
  }
});

test('reconcile: a swap that stopped after the live folder was renamed puts it back', async (t) => {
  const w = restoreWorld(t);
  const before = w.world();
  fs.renameSync(worldPath(w), `${worldPath(w)}.old-1`);
  writeTree(`${worldPath(w)}.restore-1`, { 'TheIsland_WP.ark': 'staged' });
  cutOff(w, { stage: 'swapping:world' });
  await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.deepEqual(w.world(), before);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
});

test('reconcile: a swap that stopped after one folder was in place puts both back', async (t) => {
  const w = restoreWorld(t);
  const before = { world: w.world(), settings: w.settings() };
  swapAside(w, 1);
  // The settings folder is staged but not yet swapped.
  writeTree(`${w.layout.configDir}.restore-1`, { 'GameUserSettings.ini': 'staged' });
  cutOff(w, { stage: 'swapping:settings' });
  const settled = await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.equal(settled[0].outcome, 'rolled_back');
  assert.deepEqual(w.world(), before.world);
  assert.deepEqual(w.settings(), before.settings);
  assert.deepEqual(w.artifacts(), []);
});

test('reconcile: a folder that did not exist is removed again, and a players file goes back', async (t) => {
  const w = restoreWorld(t);
  const before = w.world();
  // A world folder that the restore created: an absent marker and the new folder.
  writeTree(worldPath(w, 'Fresh_WP'), { 'Fresh_WP.ark': 'created by the restore' });
  fs.writeFileSync(`${worldPath(w, 'Fresh_WP')}.absent-1`, '');
  // A players file that was renamed aside and replaced.
  const profile = path.join(worldPath(w), '0001.arkprofile');
  fs.renameSync(profile, `${profile}.old-1`);
  fs.writeFileSync(profile, 'restored');
  // A players file that did not exist before.
  fs.writeFileSync(path.join(worldPath(w), '0009.arkprofile'), 'created');
  fs.writeFileSync(path.join(worldPath(w), '0009.arkprofile.absent-1'), '');
  cutOff(w, { stage: 'swapping:players' });
  await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.equal(w.world('Fresh_WP'), null);
  assert.deepEqual(w.world(), before);
  assert.deepEqual(w.artifacts(), []);
});

test('reconcile: once the swap is whole, the old copies are removed and the new files stay', async (t) => {
  for (const stage of ['cleanup', 'starting']) {
    const w = restoreWorld(t);
    swapAside(w, 1);
    cutOff(w, { stage });
    const settled = await reconcilePendingRestores({ db: w.db, now: () => NOW });
    assert.deepEqual(settled, [{ serverId: 1, wasRunning: true, outcome: 'completed' }], stage);
    assert.deepEqual(w.world(), { 'TheIsland_WP.ark': 'restored' }, stage);
    assert.deepEqual(w.artifacts(), [], stage);
    assert.deepEqual(w.pending(), [], stage);
    assert.equal(w.audits()[0].outcome, 'completed');
  }
});

test('reconcile: a rollback that was cut off is undone, and one that was whole is finished', async (t) => {
  // rollback: the first restore is whole (its old copy is leftover), the rollback swap is not.
  const cut = restoreWorld(t);
  swapAside(cut, 1);
  const back = cut.world();
  fs.renameSync(worldPath(cut), `${worldPath(cut)}.old-1r`);
  writeTree(worldPath(cut), { 'TheIsland_WP.ark': 'rolled back' });
  cutOff(cut, { stage: 'rollback' });
  assert.deepEqual(await reconcilePendingRestores({ db: cut.db, now: () => NOW }), [
    { serverId: 1, wasRunning: false, outcome: 'completed' },
  ]);
  assert.deepEqual(cut.world(), back);
  assert.deepEqual(cut.artifacts(), []);
  // rollback_cleanup: the rollback swap is whole.
  const whole = restoreWorld(t);
  fs.renameSync(worldPath(whole), `${worldPath(whole)}.old-1r`);
  writeTree(worldPath(whole), { 'TheIsland_WP.ark': 'rolled back' });
  cutOff(whole, { stage: 'rollback_cleanup' });
  assert.equal((await reconcilePendingRestores({ db: whole.db, now: () => NOW }))[0].outcome, 'rolled_back');
  assert.deepEqual(whole.world(), { 'TheIsland_WP.ark': 'rolled back' });
  assert.deepEqual(whole.artifacts(), []);
});

test('reconcile: a server that was not running is not to be started', async (t) => {
  const w = restoreWorld(t);
  const before = w.world();
  fs.renameSync(worldPath(w), `${worldPath(w)}.old-1`);
  cutOff(w, { stage: 'swapping:world', wasRunning: 0 });
  assert.deepEqual(await reconcilePendingRestores({ db: w.db, now: () => NOW }), [
    { serverId: 1, wasRunning: false, outcome: 'rolled_back' },
  ]);
  assert.deepEqual(w.world(), before);
  assert.deepEqual(await reconcilePendingRestores({ db: w.db }), []);
});

test('reconcile: files that cannot be settled keep the row and are reported', async (t) => {
  const w = restoreWorld(t);
  fs.renameSync(worldPath(w), `${worldPath(w)}.old-1`);
  cutOff(w, { stage: 'swapping:world' });
  const blocked = {
    ...w.ops,
    rename: async () => {
      throw Object.assign(new Error('locked'), { code: 'EIO' });
    },
  };
  const settled = await reconcilePendingRestores({ db: w.db, ops: blocked, now: () => NOW });
  assert.deepEqual(settled, [{ serverId: 1, wasRunning: false, outcome: 'failed', failed: 'locked' }]);
  assert.equal(w.pending().length, 1);
  assert.equal(w.audits()[0].outcome, 'failed');
  // The next attempt succeeds.
  assert.equal((await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW }))[0].outcome, 'rolled_back');
  assert.ok(w.world());
});

test('reconcile after a real job was cut off: at a rename, and while the server was starting', async (t) => {
  // Cut off between the two renames of the world folder.
  const first = await withBackup(t);
  first.w.plan.hangRename = 2;
  const cutJob = first.w.restore({ backupId: first.row.id, scope: 'everything' });
  cutJob.catch(() => {});
  while (first.w.counts.rename < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.w.world(), null);
  assert.equal(first.w.pending()[0].stage, 'swapping:world');
  const settled = await reconcilePendingRestores({ db: first.w.db, ops: first.w.ops, now: () => NOW });
  assert.deepEqual(settled, [{ serverId: 1, wasRunning: true, outcome: 'rolled_back' }]);
  assert.deepEqual(first.w.world(), first.v2.world);
  assert.deepEqual(first.w.settings(), first.v2.settings);
  assert.deepEqual(first.w.artifacts(), []);

  // Cut off while the server was starting on the restored files.
  const second = await withBackup(t);
  second.w.plan.hang = 'start';
  const startJob = second.w.restore({ backupId: second.row.id, scope: 'everything' });
  startJob.catch(() => {});
  while (!second.w.events.some((event) => event[0] === 'start')) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(second.w.pending()[0].stage, 'starting');
  assert.deepEqual(await reconcilePendingRestores({ db: second.w.db, ops: second.w.ops, now: () => NOW }), [
    { serverId: 1, wasRunning: true, outcome: 'completed' },
  ]);
  assert.deepEqual(second.w.world(), second.v1.world);
  assert.deepEqual(second.w.artifacts(), []);
});

test('restoreLayout names the folders a restore works in', () => {
  const layout = restoreLayout('C:\\ASA');
  assert.equal(layout.savedArks, path.join('C:\\ASA', 'ShooterGame', 'Saved', 'SavedArks'));
  assert.equal(layout.configDir, path.join('C:\\ASA', 'ShooterGame', 'Saved', 'Config', 'WindowsServer'));
  assert.deepEqual(layout.roots, [layout.savedArks, path.dirname(layout.configDir)]);
});

test('reconcile: a rollback that was starting the server is finished, not undone', async (t) => {
  const w = restoreWorld(t);
  fs.renameSync(worldPath(w), `${worldPath(w)}.old-1r`);
  writeTree(worldPath(w), { 'TheIsland_WP.ark': 'rolled back' });
  cutOff(w, { stage: 'rollback_starting' });
  const settled = await reconcilePendingRestores({ db: w.db, now: () => NOW });
  assert.deepEqual(settled, [{ serverId: 1, wasRunning: false, outcome: 'rolled_back' }]);
  assert.deepEqual(w.world(), { 'TheIsland_WP.ark': 'rolled back' });
  assert.deepEqual(w.artifacts(), []);
});

test('the job engine holds back every other job for the server and its install while a restore runs', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  w.change('v2');
  const started = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const handlers = {
    'server.restore': async (context) => {
      started.push(`restore ${context.job.id}`);
      await gate;
      return w.handlers['server.restore'](context);
    },
  };
  for (const kind of ['server.backup', 'server.switch_map', 'install.update', 'server.settings_restore'])
    handlers[kind] = async (context) => (started.push(kind), {});
  const jobs = createJobEngine({ db: w.db, handlers });
  t.after(() => jobs.stop({ abort: true }));
  w.db.prepare("UPDATE jobs SET state = 'succeeded'").run();
  jobs.start();
  const target = { serverId: 1, installId: 1 };
  const first = jobs.enqueue('server.restore', { backupId: row.id, scope: 'world' }, target);
  jobs.enqueue('server.restore', { backupId: row.id, scope: 'settings' }, target);
  jobs.enqueue('server.backup', {}, { serverId: 1 });
  jobs.enqueue('server.switch_map', {}, target);
  jobs.enqueue('install.update', {}, { installId: 1 });
  jobs.enqueue('server.settings_restore', {}, target);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Only the first job has started; the others wait for it.
  assert.deepEqual(started, [`restore ${first.id}`]);
  assert.deepEqual(
    jobs
      .list({ state: 'queued' })
      .map((job) => job.kind)
      .sort(),
    ['install.update', 'server.backup', 'server.restore', 'server.settings_restore', 'server.switch_map'],
  );
  release();
  const deadline = Date.now() + 5000;
  while (jobs.list({ state: ['queued', 'running'] }).length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobs.get(first.id).state, 'succeeded');
  assert.equal(started.length, 6);
  assert.equal(started[0], `restore ${first.id}`);
});
