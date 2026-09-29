import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  saveSnapshot,
  renameSnapshot,
  deleteSnapshot,
  diffSettings,
  findSnapshot,
  readSnapshot,
  checkName,
  SnapshotError,
  SNAPSHOT_MESSAGES,
} from '../src/backups/settings-snapshots.js';
import { reconcilePendingRestores } from '../src/backups/restore.js';
import { restoreWorld, readTree, writeTree, NOW } from './helpers/restore-world.js';

const GUS = [
  '[ServerSettings]',
  'Difficulty=1',
  'ServerPVE=False',
  'OldKey=x',
  '; a comment',
  '',
  '[SessionSettings]',
  'SessionName=Base',
  '',
].join('\r\n');
const GAME = ['[/script/shootergame.shootergamemode]', 'MatingIntervalMultiplier=1', ''].join('\r\n');

function server(t, options) {
  const w = restoreWorld(t, options);
  fs.mkdirSync(w.layout.configDir, { recursive: true });
  fs.writeFileSync(path.join(w.layout.configDir, 'GameUserSettings.ini'), GUS);
  fs.writeFileSync(path.join(w.layout.configDir, 'Game.ini'), GAME);
  const save = (name) => saveSnapshot({ db: w.db, dataDir: w.dataDir, server: w.server(), name, now: () => NOW });
  const live = (file, text) => fs.writeFileSync(path.join(w.layout.configDir, file), text);
  const diff = async (row) =>
    diffSettings((await readSnapshot(row, { dataDir: w.dataDir })).folder, w.layout.configDir);
  return { w, save, live, diff };
}
const rowOf = (w, id) => w.db.prepare('SELECT * FROM settings_snapshots WHERE id = ?').get(id);

test('saving copies every settings file, hashed, under the snapshot folder and records a row', async (t) => {
  const { w, save } = server(t);
  writeTree(path.join(w.layout.configDir, 'Sub'), { 'Extra.ini': '[a]\r\nb=1\r\n' });
  const before = w.settings();
  const saved = await save('Before the wipe');
  assert.deepEqual(
    { ...saved, size_bytes: undefined },
    {
      id: 1,
      name: 'Before the wipe',
      created_at: '2026-01-01T00:00:00.000Z',
      size_bytes: undefined,
      files: 3,
    },
  );
  const row = rowOf(w, saved.id);
  assert.equal(row.server_id, 1);
  assert.ok(row.path.startsWith(path.join(w.dataDir, 'settings-snapshots', 'server-1')));
  assert.match(path.basename(row.path), /^20260101T000000-000Z-before-the-wipe$/);
  const snapshot = await readSnapshot(row, { dataDir: w.dataDir });
  assert.deepEqual(snapshot.files.map((file) => file.rel).sort(), [
    'Game.ini',
    'GameUserSettings.ini',
    'Sub/Extra.ini',
  ]);
  assert.deepEqual(readTree(path.join(row.path, 'Config', 'WindowsServer')), before);
  // It only reads: the live files are untouched, and no server was stopped or started.
  assert.deepEqual(w.settings(), before);
  assert.deepEqual(w.steps(), []);
  // Two in the same millisecond get separate folders.
  const second = await save('Second');
  assert.notEqual(rowOf(w, second.id).path, row.path);
});

test('saving works while the server runs, and refuses an empty or missing settings folder', async (t) => {
  const running = server(t, { running: true });
  assert.equal((await running.save('Live')).name, 'Live');
  assert.equal(running.w.state(), 'running');
  const none = server(t, { config: false });
  fs.rmSync(none.w.layout.configDir, { recursive: true, force: true });
  await assert.rejects(none.save('Nothing'), {
    status: 409,
    code: 'no_settings',
    message: SNAPSHOT_MESSAGES.noSettings,
  });
  assert.equal(none.w.db.prepare('SELECT count(*) AS n FROM settings_snapshots').get().n, 0);
});

test('a name is 1 to 64 characters, trimmed, and unique for the server whatever its letter case', async (t) => {
  const { w, save } = server(t);
  for (const bad of ['', '   ', 'x'.repeat(65), 'line\nbreak', 'tab\there', null, undefined, 5, ['a']])
    await assert.rejects(save(bad), { status: 400, code: 'bad_name', message: SNAPSHOT_MESSAGES.badName }, String(bad));
  assert.equal(checkName('  padded  '), 'padded');
  assert.equal(checkName('x'.repeat(64)).length, 64);
  assert.equal(w.db.prepare('SELECT count(*) AS n FROM settings_snapshots').get().n, 0);
  const first = await save('Base');
  await assert.rejects(save('Base'), { status: 409, code: 'name_taken', message: SNAPSHOT_MESSAGES.nameTaken });
  await assert.rejects(save('  base '), { status: 409, code: 'name_taken' });
  // The refused save leaves no folder behind.
  assert.deepEqual(fs.readdirSync(path.join(w.dataDir, 'settings-snapshots', 'server-1')), [
    path.basename(rowOf(w, first.id).path),
  ]);
  assert.equal((await save('x'.repeat(64))).name.length, 64);
});

test('two saves of one name sent together keep one and remove the other copy', async (t) => {
  const { w, save } = server(t);
  const results = await Promise.allSettled([save('Same'), save('Same'), save('Same')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((item) => item.status === 'rejected'))
    assert.ok(result.reason instanceof SnapshotError && result.reason.status === 409);
  assert.equal(w.db.prepare('SELECT count(*) AS n FROM settings_snapshots').get().n, 1);
  assert.equal(fs.readdirSync(path.join(w.dataDir, 'settings-snapshots', 'server-1')).length, 1);
});

test('renaming follows the same rules, and only for the server that owns the snapshot', async (t) => {
  const { w, save } = server(t);
  const a = await save('A'),
    b = await save('B');
  assert.deepEqual(renameSnapshot({ db: w.db, serverId: 1, id: a.id, name: ' Renamed ' }), {
    id: a.id,
    name: 'Renamed',
  });
  assert.equal(rowOf(w, a.id).name, 'Renamed');
  // A change of letter case is allowed for the same snapshot, but not onto another one's name.
  renameSnapshot({ db: w.db, serverId: 1, id: a.id, name: 'RENAMED' });
  assert.equal(rowOf(w, a.id).name, 'RENAMED');
  assert.throws(() => renameSnapshot({ db: w.db, serverId: 1, id: b.id, name: 'renamed' }), {
    status: 409,
    code: 'name_taken',
  });
  for (const bad of ['', 'y'.repeat(65), 'a\nb', null])
    assert.throws(() => renameSnapshot({ db: w.db, serverId: 1, id: b.id, name: bad }), {
      status: 400,
      code: 'bad_name',
    });
  assert.throws(() => renameSnapshot({ db: w.db, serverId: 2, id: b.id, name: 'Q' }), {
    status: 404,
    code: 'no_snapshot',
  });
  assert.throws(() => renameSnapshot({ db: w.db, serverId: 1, id: 99, name: 'Q' }), { status: 404 });
  assert.equal(rowOf(w, b.id).name, 'B');
  assert.throws(() => findSnapshot(w.db, 1, 'x'), { status: 404 });
});

test('deleting removes the folder and the row, and never a folder outside the snapshot folder', async (t) => {
  const { w, save } = server(t);
  const a = await save('A');
  const folder = rowOf(w, a.id).path;
  assert.ok(fs.existsSync(folder));
  assert.deepEqual(await deleteSnapshot({ db: w.db, dataDir: w.dataDir, serverId: 1, id: a.id }), { deleted: true });
  assert.ok(!fs.existsSync(folder));
  assert.equal(rowOf(w, a.id), undefined);
  await assert.rejects(deleteSnapshot({ db: w.db, dataDir: w.dataDir, serverId: 1, id: a.id }), { status: 404 });
  // A row that points elsewhere is refused and kept, and the folder it names is left alone.
  const outside = path.join(w.root, 'precious');
  writeTree(outside, { 'keep.txt': 'keep' });
  for (const target of [outside, path.join(w.dataDir, 'settings-snapshots'), w.dataDir]) {
    w.db
      .prepare('INSERT INTO settings_snapshots (server_id, name, created_at, path) VALUES (1, ?, ?, ?)')
      .run(`odd ${path.basename(target)}`, '2026-01-01T00:00:00.000Z', target);
    const id = w.db.prepare('SELECT max(id) AS id FROM settings_snapshots').get().id;
    await assert.rejects(deleteSnapshot({ db: w.db, dataDir: w.dataDir, serverId: 1, id }), {
      status: 409,
      code: 'outside',
      message: SNAPSHOT_MESSAGES.outsideFolder,
    });
    assert.ok(rowOf(w, id), 'the row stays');
  }
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  assert.ok(fs.existsSync(w.dataDir));
  // Another server's snapshot is not found.
  const b = await save('B');
  await assert.rejects(deleteSnapshot({ db: w.db, dataDir: w.dataDir, serverId: 2, id: b.id }), { status: 404 });
  assert.ok(rowOf(w, b.id));
});

test('a snapshot that cannot be read is reported as unusable', async (t) => {
  const { w, save } = server(t);
  const a = await save('A');
  const row = rowOf(w, a.id);
  fs.rmSync(path.join(row.path, 'snapshot.json'));
  await assert.rejects(readSnapshot(row, { dataDir: w.dataDir }), { status: 409, code: 'not_usable' });
  await assert.rejects(readSnapshot({ ...row, path: w.root }, { dataDir: w.dataDir }), { status: 409 });
});

// ---- comparing ----

test('the diff lists keys added, removed and changed, with both values, and ignores comments and blank lines', async (t) => {
  const { w, save, live, diff } = server(t);
  const snapshot = rowOf(w, (await save('Base')).id);
  // No change at all is no difference.
  assert.deepEqual(await diff(snapshot), { files: [], same: 2 });
  live(
    'GameUserSettings.ini',
    [
      '[ServerSettings]',
      '; a different comment',
      '',
      '',
      'Difficulty=2',
      'serverpve = False',
      'NewKey=Fresh',
      '',
      '[SessionSettings]',
      'SessionName=Base',
    ].join('\r\n'),
  );
  const result = await diff(snapshot);
  assert.equal(result.same, 1);
  assert.deepEqual(result.files, [
    {
      file: 'GameUserSettings.ini',
      status: 'changed',
      sections: [
        {
          section: 'ServerSettings',
          added: [{ key: 'NewKey', old: null, current: 'Fresh' }],
          removed: [{ key: 'OldKey', old: 'x', current: null }],
          changed: [{ key: 'Difficulty', old: '1', current: '2' }],
        },
      ],
    },
  ]);
  // Nothing about ServerPVE: its key case and the spaces around = do not count.
  assert.ok(!JSON.stringify(result).includes('erverPVE') && !JSON.stringify(result).includes('erverpve'));
});

test('section headers and key names ignore letter case, and a repeated key is compared as a list', async (t) => {
  const { w, save, live, diff } = server(t);
  live('Game.ini', ['[/script/shootergame.shootergamemode]', 'Cfg=(A=1)', 'Cfg=(B=2)', 'Single=1', ''].join('\r\n'));
  const snapshot = rowOf(w, (await save('Lists')).id);
  live('Game.ini', ['[/Script/ShooterGame.ShooterGameMode]', 'cfg=(A=1)', 'CFG=(B=2)', 'SINGLE=1', ''].join('\r\n'));
  assert.deepEqual((await diff(snapshot)).files, []);
  live(
    'Game.ini',
    ['[/Script/ShooterGame.ShooterGameMode]', 'Cfg=(A=1)', 'Cfg=(B=3)', 'Cfg=(C=4)', 'Single=1', ''].join('\r\n'),
  );
  const changed = (await diff(snapshot)).files[0].sections[0];
  assert.equal(changed.section, '/Script/ShooterGame.ShooterGameMode');
  assert.deepEqual(changed.changed, [{ key: 'Cfg', old: '(A=1)\n(B=2)', current: '(A=1)\n(B=3)\n(C=4)' }]);
  assert.deepEqual([changed.added, changed.removed], [[], []]);
});

test('a section that exists on one side only lists all of its keys, and values are compared trimmed', async (t) => {
  const { w, save, live, diff } = server(t);
  const snapshot = rowOf(w, (await save('Sections')).id);
  live(
    'GameUserSettings.ini',
    ['[ServerSettings]', 'Difficulty =  1 ', 'ServerPVE=False', 'OldKey=x', '', '[Extra]', 'One=1', 'Two=2', ''].join(
      '\r\n',
    ),
  );
  const result = await diff(snapshot);
  const file = result.files.find((item) => item.file === 'GameUserSettings.ini');
  assert.deepEqual(file.sections.map((section) => section.section).sort(), ['Extra', 'SessionSettings']);
  assert.deepEqual(file.sections.find((section) => section.section === 'Extra').added, [
    { key: 'One', old: null, current: '1' },
    { key: 'Two', old: null, current: '2' },
  ]);
  assert.deepEqual(file.sections.find((section) => section.section === 'SessionSettings').removed, [
    { key: 'SessionName', old: 'Base', current: null },
  ]);
});

test('a file on one side only is listed whole, and other files are compared by hash', async (t) => {
  const { w, save, live, diff } = server(t);
  live('notes.txt', 'first');
  const snapshot = rowOf(w, (await save('Whole')).id);
  fs.rmSync(path.join(w.layout.configDir, 'Game.ini'));
  live('Engine.ini', '[a]\r\nb=1\r\n');
  live('notes.txt', 'second');
  writeTree(path.join(w.layout.configDir, 'Deep'), { 'x.ini': '[a]\r\nb=1\r\n' });
  const result = await diff(snapshot);
  assert.deepEqual(
    result.files.map((item) => [item.file, item.status, item.sections.length]),
    [
      ['Deep/x.ini', 'only_live', 0],
      ['Engine.ini', 'only_live', 0],
      ['Game.ini', 'only_in_snapshot', 0],
      ['notes.txt', 'changed', 0],
    ],
  );
  assert.equal(result.same, 1);
  // A missing live folder lists every file as only in the snapshot.
  fs.rmSync(w.layout.configDir, { recursive: true });
  const gone = await diff(snapshot);
  assert.deepEqual(new Set(gone.files.map((item) => item.status)), new Set(['only_in_snapshot']));
  assert.equal(gone.files.length, 3);
});

test('the diff reads UTF-16 files with a byte order mark', async (t) => {
  const { w, save, live, diff } = server(t);
  const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  fs.writeFileSync(path.join(w.layout.configDir, 'Game.ini'), utf16('[a]\r\nk=1\r\n'));
  const snapshot = rowOf(w, (await save('Wide')).id);
  fs.writeFileSync(path.join(w.layout.configDir, 'Game.ini'), utf16('[a]\r\nk=2\r\n'));
  assert.deepEqual((await diff(snapshot)).files[0].sections[0].changed, [{ key: 'k', old: '1', current: '2' }]);
  void live;
});

// ---- putting a snapshot back ----

const restoreJob = (w, snapshotId) => w.handlers['server.settings_restore'](w.ctx({ snapshotId }));

test('restoring writes the snapshot files over the live ones without stopping the server', async (t) => {
  const { w, save, live } = server(t);
  const snapshotFiles = w.settings();
  const snapshot = await save('Base');
  live('GameUserSettings.ini', '[ServerSettings]\r\nDifficulty=9\r\n');
  fs.rmSync(path.join(w.layout.configDir, 'Game.ini'));
  live('Engine.ini', 'live only');
  const result = await restoreJob(w, snapshot.id);
  const after = w.settings();
  assert.equal(after['GameUserSettings.ini'], snapshotFiles['GameUserSettings.ini']);
  assert.equal(after['Game.ini'], snapshotFiles['Game.ini']);
  // A live file the snapshot does not have is left alone.
  assert.equal(after['Engine.ini'], 'live only');
  assert.deepEqual(w.steps(), []);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
  assert.equal(result.appliesAtRestart, true);
  assert.equal(result.snapshotId, snapshot.id);
  // A pre_restore backup of the settings was taken first, with the world left out.
  const safety = w.backups().filter((row) => row.reason === 'pre_restore');
  assert.equal(safety.length, 1);
  assert.equal(result.safetyBackupId, safety[0].id);
  assert.equal(readTree(path.join(safety[0].path, 'SavedArks')), null);
  assert.equal(
    readTree(path.join(safety[0].path, 'Config', 'WindowsServer'))['GameUserSettings.ini'],
    '[ServerSettings]\r\nDifficulty=9\r\n',
  );
  assert.equal(
    w.messages().at(-1),
    'The settings from "Base" are in place. The running server uses them after its next restart.',
  );
  assert.deepEqual(
    w.audits('server.settings.restore').map((audit) => [audit.snapshotId, audit.outcome, audit.actor]),
    [[snapshot.id, 'restored', 'job']],
  );
});

test('a stopped server is told nothing about a restart', async (t) => {
  const { w, save, live } = server(t, { running: false });
  const snapshot = await save('Base');
  live('Game.ini', 'changed');
  const result = await restoreJob(w, snapshot.id);
  assert.equal(result.appliesAtRestart, false);
  assert.equal(w.messages().at(-1), 'The settings from "Base" are in place.');
});

test('a snapshot whose file no longer matches its hash, or is gone, changes nothing', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  const row = rowOf(w, snapshot.id);
  live('Game.ini', 'live');
  const file = path.join(row.path, 'Config', 'WindowsServer', 'GameUserSettings.ini');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, 'tampered');
  await assert.rejects(restoreJob(w, snapshot.id), /GameUserSettings\.ini in the snapshot no longer matches/);
  fs.rmSync(file);
  await assert.rejects(restoreJob(w, snapshot.id), /GameUserSettings\.ini is missing from the snapshot/);
  assert.equal(w.settings()['Game.ini'], 'live');
  assert.deepEqual(
    w.backups().filter((backup) => backup.reason === 'pre_restore'),
    [],
  );
  assert.deepEqual(w.pending(), []);
  // Another server's snapshot is not found, and neither is one that does not exist.
  fs.writeFileSync(file, original);
  await assert.rejects(w.handlers['server.settings_restore']({ ...w.ctx({ snapshotId: 99 }) }), { status: 404 });
  await assert.rejects(
    w.handlers['server.settings_restore']({ ...w.ctx({}), job: { id: 1, serverId: 99 } }),
    /server was not found/,
  );
});

test('a rename that fails puts every settings file back', async (t) => {
  // Three files replaced with two renames each.
  for (const at of [1, 2, 3, 4, 5, 6]) {
    const { w, save, live } = server(t);
    live('Engine.ini', 'engine');
    const snapshot = await save('Base');
    live('GameUserSettings.ini', 'x1');
    live('Game.ini', 'x2');
    live('Engine.ini', 'x3');
    const before = w.settings();
    w.plan.failRename = at;
    await assert.rejects(
      restoreJob(w, snapshot.id),
      (error) => error.message.startsWith(SNAPSHOT_MESSAGES.filesFailed) && /rename blocked/i.test(error.message),
    );
    assert.deepEqual(w.settings(), before, `rename ${at}`);
    assert.deepEqual(w.artifacts(), [], `rename ${at}`);
    assert.deepEqual(w.pending(), [], `rename ${at}`);
  }
});

test('a copy that fails, or a cancel while copying, changes nothing', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('Game.ini', 'changed');
  const before = w.settings();
  w.plan.failCopy = 2;
  await assert.rejects(restoreJob(w, snapshot.id), /could not be replaced/);
  assert.deepEqual(w.settings(), before);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
  w.plan.failCopy = null;
  const copied = w.counts.copy;
  w.plan.onCopy = (count) => {
    if (count === copied + 1) w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(restoreJob(w, snapshot.id), /cancelled/);
  assert.deepEqual(w.settings(), before);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
});

test('a cancel that arrives while the files are being swapped lets the swap finish', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  const snapshotFiles = w.settings();
  live('Game.ini', 'changed');
  w.plan.onRename = (count) => {
    if (count === 1) w.plan.controller.abort(new Error('cancelled'));
  };
  await restoreJob(w, snapshot.id);
  assert.deepEqual(w.settings(), snapshotFiles);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.pending(), []);
});

test('a safety backup that cannot be made stops the restore before any file changes', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('Game.ini', 'changed');
  const stamp = new Date(NOW).toISOString().replace(/[-:]/g, '').replace('.', '-');
  const base = path.join(w.dataDir, 'backups', 'server-1', `${stamp}-pre_restore`);
  fs.mkdirSync(base, { recursive: true });
  for (let n = 2; n <= 10; n++) fs.mkdirSync(`${base}-${n}`);
  await assert.rejects(restoreJob(w, snapshot.id), (error) => error.message.startsWith(SNAPSHOT_MESSAGES.safetyFailed));
  assert.equal(w.settings()['Game.ini'], 'changed');
  assert.deepEqual(w.pending(), []);
});

test('a live settings folder that is gone is created from the snapshot, with nothing to back up', async (t) => {
  const { w, save } = server(t);
  const snapshot = await save('Base');
  const snapshotFiles = w.settings();
  fs.rmSync(w.layout.configDir, { recursive: true });
  const result = await restoreJob(w, snapshot.id);
  assert.deepEqual(w.settings(), snapshotFiles);
  assert.deepEqual(result.notes, [SNAPSHOT_MESSAGES.nothingToSave]);
  assert.deepEqual(w.artifacts(), []);
});

test('a restore cut off half way is settled at the next start and never starts the server', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('GameUserSettings.ini', 'x1');
  live('Game.ini', 'x2');
  const before = w.settings();
  w.plan.hangRename = 3;
  const job = restoreJob(w, snapshot.id);
  job.catch(() => {});
  while (w.counts.rename < 3) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.pending()[0].scope, 'settings_snapshot');
  assert.equal(w.pending()[0].was_running, 0);
  const settled = await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW });
  assert.deepEqual(settled, [{ serverId: 1, wasRunning: false, outcome: 'rolled_back' }]);
  assert.deepEqual(w.settings(), before);
  assert.deepEqual(w.artifacts(), []);
});

test('leftover copies that cannot be removed keep the row until the next start', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('Game.ini', 'x2');
  w.plan.failFinish = true;
  await restoreJob(w, snapshot.id);
  assert.equal(w.pending().length, 1);
  assert.equal(w.pending()[0].stage, 'cleanup');
  w.plan.failFinish = false;
  assert.equal((await reconcilePendingRestores({ db: w.db, ops: w.ops, now: () => NOW }))[0].outcome, 'completed');
  assert.deepEqual(w.artifacts(), []);
  assert.equal(w.settings()['Game.ini'], GAME);
});

// ---- review fixes ----

test('a snapshot with files in subfolders is put back on a failure and leaves nothing behind on success', async (t) => {
  // Two renames per file: Game.ini, GameUserSettings.ini, Sub/Deep/Y.ini and Sub/Extra.ini are eight renames.
  for (const failAt of [null, 5, 6, 7, 8]) {
    const { w, save, live } = server(t);
    writeTree(path.join(w.layout.configDir, 'Sub', 'Deep'), { 'Y.ini': 'deep v1' });
    writeTree(path.join(w.layout.configDir, 'Sub'), { 'Extra.ini': 'nested v1' });
    const snapshot = await save('Base');
    const snapshotFiles = w.settings();
    live('Game.ini', 'live 1');
    writeTree(path.join(w.layout.configDir, 'Sub', 'Deep'), { 'Y.ini': 'deep live' });
    writeTree(path.join(w.layout.configDir, 'Sub'), { 'Extra.ini': 'nested live' });
    const before = w.settings();
    if (failAt) {
      w.plan.failRename = failAt;
      await assert.rejects(restoreJob(w, snapshot.id), /rename blocked/i);
      assert.deepEqual(w.settings(), before, `rename ${failAt}`);
    } else {
      await restoreJob(w, snapshot.id);
      assert.deepEqual(w.settings(), snapshotFiles);
    }
    assert.deepEqual(w.artifacts(), [], `rename ${failAt}`);
    assert.deepEqual(w.pending(), [], `rename ${failAt}`);
  }
});

test('an earlier restore that left files behind is settled before a snapshot restore, or the job changes nothing', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  const snapshotFiles = w.settings();
  live('Game.ini', 'live');
  // A row from a restore (job 9) that stopped with Game.ini renamed aside.
  const game = path.join(w.layout.configDir, 'Game.ini');
  const stale = () => {
    fs.renameSync(game, `${game}.old-9`);
    w.db
      .prepare(
        "INSERT INTO pending_restores (server_id, job_id, backup_id, scope, was_running, started_at, stage) VALUES (1, 9, NULL, 'settings_snapshot', 0, 'x', 'swapping:settings')",
      )
      .run();
  };
  stale();
  const original = w.ops.rename;
  w.ops.rename = async () => {
    throw Object.assign(new Error('still blocked'), { code: 'EIO' });
  };
  await assert.rejects(restoreJob(w, snapshot.id), {
    message:
      "An earlier restore on this server left files it couldn't put back, and ARK Overseer couldn't sort them out: Still blocked. Nothing was changed. Check the world and settings folders, then restart ARK Overseer to try again.",
  });
  assert.equal(w.pending().length, 1);
  assert.equal(w.pending()[0].job_id, 9);
  assert.ok(fs.existsSync(`${game}.old-9`));
  assert.deepEqual(
    w.backups().filter((row) => row.reason === 'pre_restore'),
    [],
  );
  assert.deepEqual(
    w.audits('server.settings.restore').map((audit) => audit.outcome),
    ['failed'],
  );
  // Once the disk lets it, the row is settled, the file is back, and the job goes on.
  w.ops.rename = original;
  await restoreJob(w, snapshot.id);
  assert.deepEqual(w.settings(), snapshotFiles);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.artifacts(), []);
  assert.deepEqual(w.steps(), []);
  assert.equal(w.audits('server.backup.restore_reconciled')[0].actor, 'job');
});

test('a snapshot restore leaves an audit event when it fails or is cancelled', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('Game.ini', 'live');
  await assert.rejects(restoreJob(w, 99), { status: 404 });
  w.plan.failRename = 1;
  await assert.rejects(restoreJob(w, snapshot.id), /rename blocked/i);
  w.plan.failRename = null;
  const copied = w.counts.copy;
  w.plan.onCopy = (count) => {
    if (count === copied + 1) w.plan.controller.abort(new Error('cancelled'));
  };
  await assert.rejects(restoreJob(w, snapshot.id), /cancelled/);
  assert.deepEqual(
    w.audits('server.settings.restore').map((audit) => [audit.outcome, audit.snapshotId]),
    [
      ['failed', 99],
      ['failed', snapshot.id],
      ['cancelled', snapshot.id],
    ],
  );
  assert.match(w.audits('server.settings.restore')[1].reason, /rename blocked/i);
});

test('a safety backup of the settings alone records no map', async (t) => {
  const { w, save, live } = server(t);
  const snapshot = await save('Base');
  live('Game.ini', 'live');
  const result = await restoreJob(w, snapshot.id);
  const safety = w.db.prepare('SELECT * FROM backups WHERE id = ?').get(result.safetyBackupId);
  assert.equal(safety.reason, 'pre_restore');
  assert.equal(safety.map, null);
});
