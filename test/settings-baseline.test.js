import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BASELINE_FILE,
  baselineDir,
  listLiveFiles,
  readBaselineFolder,
  signature,
  statSignature,
} from '../src/settings/baseline.js';
import { reconcilePendingRestores } from '../src/backups/restore.js';
import { driftWorld, GUS, GAME } from './helpers/drift-world.js';
import { writeTree, readTree, NOW } from './helpers/restore-world.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('a baseline copies every settings file with its size and hash, and records where it came from', async (t) => {
  const d = driftWorld(t);
  writeTree(path.join(d.w.layout.configDir, 'Sub'), { 'Extra.ini': '[a]\r\nb=1\r\n' });
  const made = await d.drift.recordBaseline(d.server(), 'settings_save');
  assert.equal(made.files.length, 3);
  const folder = baselineDir(d.w.dataDir, 1);
  assert.deepEqual(readTree(path.join(folder, 'Config', 'WindowsServer')), d.w.settings());
  const list = JSON.parse(fs.readFileSync(path.join(folder, BASELINE_FILE), 'utf8')).files;
  const entry = list.find((file) => file.relPath === 'Config/WindowsServer/GameUserSettings.ini');
  assert.deepEqual(entry, {
    relPath: 'Config/WindowsServer/GameUserSettings.ini',
    size: Buffer.byteLength(GUS),
    sha256: sha(GUS),
  });
  const row = d.baselineRow();
  assert.equal(row.source, 'settings_save');
  assert.equal(row.recorded_at, new Date(NOW).toISOString());
  assert.equal(row.sha256, sha(fs.readFileSync(path.join(folder, BASELINE_FILE))));
  // The live files were only read.
  assert.equal(d.read('GameUserSettings.ini'), GUS);
  assert.equal(d.read('Game.ini'), GAME);
});

test('a new baseline replaces the old one whole, leaves no staging folder and keeps only the current one', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const first = d.baselineRow().sha256;
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=3.0');
  fs.rmSync(d.live('Game.ini'));
  await d.drift.recordBaseline(d.server(), 'restore');
  assert.notEqual(d.baselineRow().sha256, first);
  assert.equal(d.baselineRow().source, 'restore');
  const folder = baselineDir(d.w.dataDir, 1);
  assert.deepEqual(Object.keys(readTree(path.join(folder, 'Config', 'WindowsServer'))), ['GameUserSettings.ini']);
  assert.deepEqual(fs.readdirSync(path.dirname(folder)), ['server-1']);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=3.0/);
});

test('a stop between the two renames leaves the old baseline in use, and a half-built one is dropped', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const folder = baselineDir(d.w.dataDir, 1);
  // The old folder moved aside, the new one not yet in place.
  fs.renameSync(folder, `${folder}.old-prev`);
  fs.mkdirSync(`${folder}.restore-new`);
  fs.writeFileSync(path.join(`${folder}.restore-new`, 'half.txt'), 'x');
  assert.ok(await readBaselineFolder(d.w.dataDir, 1));
  assert.ok(fs.existsSync(path.join(folder, BASELINE_FILE)));
  assert.deepEqual(fs.readdirSync(path.dirname(folder)), ['server-1']);
  // The baseline is whole again, so the next check finds no difference.
  assert.equal((await d.check()).changed, false);
});

test('a rename that fails while the baseline is replaced keeps the old one and removes the new one', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  const before = d.baselineRow();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=9.0');
  d.w.plan.failRename = 2;
  assert.equal(await d.drift.recordBaseline(d.server(), 'settings_save'), null);
  d.w.plan.failRename = null;
  // Only the record of what is still to be taken in differs; the baseline itself is the old one.
  assert.deepEqual({ ...d.baselineRow(), pending_json: null }, { ...before });
  assert.ok(d.baselineRow().pending_json);
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=1.0/);
  assert.deepEqual(fs.readdirSync(path.dirname(baselineDir(d.w.dataDir, 1))), ['server-1']);
});

test('a server with no baseline gets one from its files the first time they are read, and nothing is reported', async (t) => {
  const d = driftWorld(t);
  assert.equal(d.baselineRow(), undefined);
  assert.equal(await d.drift.ensureBaseline(d.server()), true);
  assert.equal(d.baselineRow().source, 'first_read');
  assert.equal(await d.drift.ensureBaseline(d.server()), false);
  assert.equal((await d.check()).changed, false);
  assert.equal(d.driftRow(), undefined);
  // The same goes for a check that is the first thing to look.
  const other = driftWorld(t);
  const state = await other.check();
  assert.equal(state.changed, false);
  assert.deepEqual(state.differences, []);
  assert.equal(other.baselineRow().source, 'first_read');
  // The baseline is taken from the files as they are then, so a later edit is what shows up.
  other.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  assert.equal((await other.check()).differences.length, 1);
});

test('a settings folder with no files gets no baseline until it has some', async (t) => {
  const d = driftWorld(t, { files: {} });
  assert.equal(await d.drift.ensureBaseline(d.server()), false);
  assert.equal((await d.check()).changed, false);
  assert.equal(d.baselineRow(), undefined);
  assert.equal(await d.drift.recordBaseline(d.server(), 'server_created', { skipIfEmpty: true }), null);
  assert.equal(d.baselineRow(), undefined);
  d.write('GameUserSettings.ini', GUS);
  await d.check();
  assert.equal(d.baselineRow().source, 'first_read');
});

test('a baseline that no longer matches its row is taken again from the files', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  fs.appendFileSync(path.join(baselineDir(d.w.dataDir, 1), BASELINE_FILE), ' ');
  assert.equal((await d.check()).changed, false);
  assert.equal(d.baselineRow().source, 'first_read');
  assert.match(d.baselineFile('GameUserSettings.ini'), /XPMultiplier=2.0/);
  assert.deepEqual(d.logs, [
    'The settings baseline for server 1 could not be read, so it is taken again from the files.',
  ]);
  fs.rmSync(baselineDir(d.w.dataDir, 1), { recursive: true });
  assert.equal((await d.check()).changed, false);
  assert.ok(fs.existsSync(path.join(baselineDir(d.w.dataDir, 1), BASELINE_FILE)));
});

test('removing a server removes its rows, and removeBaseline removes its folder', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  await d.check();
  assert.ok(d.driftRow());
  await d.drift.removeBaseline(1);
  assert.equal(d.baselineRow(), undefined);
  assert.equal(d.driftRow(), undefined);
  assert.equal(fs.existsSync(baselineDir(d.w.dataDir, 1)), false);
  // The rows also go with the server itself.
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=2.0', 'XPMultiplier=4.0');
  await d.check();
  d.w.db.prepare('DELETE FROM pending_restores').run();
  d.w.db.prepare('DELETE FROM backups').run();
  d.w.db.prepare('DELETE FROM servers WHERE id = 1').run();
  assert.equal(d.w.db.prepare('SELECT count(*) AS n FROM settings_baselines').get().n, 0);
  assert.equal(d.w.db.prepare('SELECT count(*) AS n FROM settings_drift').get().n, 0);
});

test('the file signature ignores letter case in names and order, and the stat signature notices a moved time', () => {
  const a = [
    { relPath: 'Config/WindowsServer/A.ini', size: 1, sha256: 'x', mtimeMs: 1 },
    { relPath: 'Config/WindowsServer/b.ini', size: 2, sha256: 'y', mtimeMs: 2 },
  ];
  const b = [
    { relPath: 'Config/WindowsServer/B.INI', size: 2, sha256: 'y', mtimeMs: 2 },
    { relPath: 'Config/WindowsServer/a.ini', size: 1, sha256: 'x', mtimeMs: 1 },
  ];
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(a), signature([{ ...a[0], sha256: 'z' }, a[1]]));
  assert.notEqual(statSignature(a), statSignature([{ ...a[0], mtimeMs: 5 }, a[1]]));
  assert.deepEqual(listLiveFiles(path.join(path.sep, 'no', 'such', 'install')), []);
});

test('a settings put-back cut off at a rename is undone at the next start of ARK Overseer', async (t) => {
  const d = driftWorld(t);
  await d.baseline();
  d.edit('GameUserSettings.ini', 'XPMultiplier=1.0', 'XPMultiplier=2.0');
  const state = await d.check();
  // Cut off at the third rename: the first file swapped, the second not started.
  d.w.plan.hangRename = 2;
  const job = d.drift.resolveNow({
    server: d.server(),
    params: { action: 'revert', liveSha256: state.liveSha256 },
    jobId: 1,
  });
  job.catch(() => {});
  while (d.w.counts.rename < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(d.w.pending()[0].scope, 'settings_resolve');
  const settled = await reconcilePendingRestores({ db: d.w.db, ops: d.w.ops, now: () => NOW });
  assert.equal(settled[0].outcome, 'rolled_back');
  assert.match(d.read('GameUserSettings.ini'), /XPMultiplier=2.0/);
  assert.deepEqual(d.w.artifacts(), []);
});
