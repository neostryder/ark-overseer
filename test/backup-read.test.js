import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBackup, verifyBackup, selectFiles, readManifest, isInside, isBelow } from '../src/backups/read.js';
import { restoreWorld, readTree } from './helpers/restore-world.js';

const manifestOf = (row) => path.join(row.path, 'snapshot.json');
const rewriteManifest = (row, change) => {
  const manifest = JSON.parse(fs.readFileSync(manifestOf(row), 'utf8'));
  change(manifest);
  fs.writeFileSync(manifestOf(row), JSON.stringify(manifest));
};

test('readBackup lists the map, the files by kind, and every player and tribe with its id', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const info = await readBackup(row, { dataDir: w.dataDir });
  assert.equal(info.map, 'TheIsland_WP');
  assert.equal(info.files.length, 8);
  assert.deepEqual(
    info.world.map((file) => file.relPath).sort(),
    [
      'SavedArks/TheIsland_WP/0001.arkprofile',
      'SavedArks/TheIsland_WP/0002.arkprofile',
      'SavedArks/TheIsland_WP/1001.arktribe',
      'SavedArks/TheIsland_WP/1002.arktribe',
      'SavedArks/TheIsland_WP/TheIsland_WP.ark',
      'SavedArks/TheIsland_WP/nested/rolling.bak',
    ].sort(),
  );
  assert.deepEqual(info.settings.map((file) => file.relPath).sort(), [
    'Config/WindowsServer/Game.ini',
    'Config/WindowsServer/GameUserSettings.ini',
  ]);
  assert.deepEqual(info.profiles.map((item) => item.id).sort(), ['0001', '0002']);
  assert.deepEqual(info.tribes.map((item) => item.id).sort(), ['1001', '1002']);
  const first = info.profiles.find((item) => item.id === '0001');
  assert.equal(first.size, 'TheIsland_WP profile 0001 v1'.length);
  assert.match(first.modifiedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(info.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
});

test('a modified time in the manifest is used, and the row map wins over the manifest', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  rewriteManifest(row, (manifest) => {
    manifest.files.find((file) => file.relPath.endsWith('0001.arkprofile')).mtime = '2025-05-05T05:05:05.000Z';
  });
  const info = await readBackup(row, { dataDir: w.dataDir });
  assert.equal(info.profiles.find((item) => item.id === '0001').modifiedAt, '2025-05-05T05:05:05.000Z');
  // A backup row from before maps were recorded has no map; the manifest supplies it.
  assert.equal((await readBackup({ ...row, map: null }, { dataDir: w.dataDir })).map, 'TheIsland_WP');
  assert.equal((await readBackup({ ...row, map: 'Other_WP' }, { dataDir: w.dataDir })).world.length, 0);
});

test('a backup without a world holds only settings and has no map', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup({ include: { world: false } });
  const info = await readBackup({ ...row, map: null }, { dataDir: w.dataDir });
  assert.equal(info.map, null);
  assert.deepEqual(info.world, []);
  assert.equal(info.settings.length, 2);
  assert.deepEqual(info.profiles, []);
});

test('a backup outside the backup folder is refused, whatever the row says', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const outside = path.join(w.root, 'elsewhere');
  fs.cpSync(row.path, outside, { recursive: true });
  const refused = /not inside the backup folder/;
  await assert.rejects(readBackup({ ...row, path: outside }, { dataDir: w.dataDir }), refused);
  await assert.rejects(readBackup({ ...row, path: path.join(w.dataDir, 'backups') }, { dataDir: w.dataDir }), refused);
  await assert.rejects(
    readBackup({ ...row, path: path.join(w.dataDir, 'backups', '..', 'x') }, { dataDir: w.dataDir }),
    refused,
  );
  await assert.rejects(
    readBackup({ ...row, path: path.join(w.dataDir, 'backups', 'nothing-here') }, { dataDir: w.dataDir }),
    refused,
  );
  // A junction inside the backup folder that leads outside is followed to where it really goes.
  const link = path.join(w.dataDir, 'backups', 'server-1', 'link');
  fs.symlinkSync(outside, link, 'junction');
  await assert.rejects(readBackup({ ...row, path: link }, { dataDir: w.dataDir }), refused);
  // Positive control: the real folder reads.
  assert.equal((await readBackup(row, { dataDir: w.dataDir })).files.length, 8);
  assert.equal(isInside('C:\\a', 'C:\\a'), true);
  assert.equal(isBelow('C:\\a', 'C:\\a'), false);
  assert.equal(isBelow('C:\\a', 'C:\\a\\b'), true);
  assert.equal(isBelow('C:\\a', 'C:\\ab'), false);
  assert.equal(isBelow('C:\\a', 'C:\\A\\B'), true);
});

test('a manifest that is missing, huge, unreadable or unsafe fails with a message, not a crash', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const read = () => readBackup(row, { dataDir: w.dataDir });
  const original = fs.readFileSync(manifestOf(row));
  fs.rmSync(manifestOf(row));
  await assert.rejects(read(), { code: 'no_manifest', message: /no file list/ });
  // Over 20 MB is refused before it is read.
  fs.writeFileSync(manifestOf(row), Buffer.alloc(20 * 1024 * 1024 + 1, 32));
  await assert.rejects(read(), { code: 'too_large', message: /over 20 MB/ });
  for (const text of ['{not json', 'null', '{"files": 5}', '[]', '{"files":[null]}']) {
    fs.writeFileSync(manifestOf(row), text);
    await assert.rejects(read(), { code: 'bad_manifest' }, text);
  }
  // A file path that climbs out, is absolute, or names another root cannot be in the list.
  const good = JSON.parse(original.toString());
  const entry = good.files[0];
  for (const relPath of [
    'SavedArks/../../x',
    '../SavedArks/M/x',
    'C:/x/y/z',
    'SavedArks\\M\\x',
    '/SavedArks/M/x',
    'Elsewhere/M/x',
    'SavedArks/M',
    'Config/Other/x',
    'SavedArks//x',
  ]) {
    fs.writeFileSync(manifestOf(row), JSON.stringify({ files: [{ ...entry, relPath }] }));
    await assert.rejects(read(), { code: 'bad_manifest' }, relPath);
  }
  for (const bad of [{ sha256: 'zz' }, { size: -1 }, { size: 'big' }]) {
    fs.writeFileSync(manifestOf(row), JSON.stringify({ files: [{ ...entry, ...bad }] }));
    await assert.rejects(read(), { code: 'bad_manifest' }, JSON.stringify(bad));
  }
  await assert.rejects(readManifest(path.join(w.root, 'nowhere')), { code: 'no_manifest' });
  // Positive control: the original list reads again.
  fs.writeFileSync(manifestOf(row), original);
  assert.equal((await read()).files.length, 8);
});

test('verifyBackup passes a good backup for every scope and writes nothing', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const before = readTree(row.path);
  const stat = fs.statSync(row.path).mtimeMs;
  for (const scope of ['everything', 'world', 'settings'])
    assert.deepEqual(await verifyBackup(row, { dataDir: w.dataDir, scope }), {
      ok: true,
      checked: { everything: 8, world: 6, settings: 2 }[scope],
    });
  assert.deepEqual(
    await verifyBackup(row, { dataDir: w.dataDir, scope: 'players', profiles: ['0001'], tribes: ['1002'] }),
    {
      ok: true,
      checked: 2,
    },
  );
  assert.deepEqual(readTree(row.path), before);
  assert.equal(fs.statSync(row.path).mtimeMs, stat);
});

test('verifyBackup names a file that is missing, and only checks what the scope reads', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const verify = (scope, extra = {}) => verifyBackup(row, { dataDir: w.dataDir, scope, ...extra });
  fs.rmSync(path.join(row.path, 'SavedArks', 'TheIsland_WP', '0002.arkprofile'));
  await assert.rejects(verify('world'), {
    code: 'missing',
    message: 'SavedArks/TheIsland_WP/0002.arkprofile is missing from the backup.',
  });
  await assert.rejects(verify('everything'), /0002.arkprofile is missing/);
  // Other scopes do not read that file.
  await verify('settings');
  await verify('players', { profiles: ['0001'], tribes: [] });
  await assert.rejects(verify('players', { profiles: ['0002'], tribes: [] }), /0002.arkprofile is missing/);
});

test('verifyBackup names a file that changed, whether or not its size did, and stops when cancelled', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const verify = (scope, extra = {}) => verifyBackup(row, { dataDir: w.dataDir, scope, ...extra });
  const game = path.join(row.path, 'Config', 'WindowsServer', 'Game.ini');
  const original = fs.readFileSync(game);
  // The same size with different bytes.
  fs.writeFileSync(game, 'X'.repeat(original.length));
  await assert.rejects(verify('settings'), {
    code: 'changed',
    message: 'Config/WindowsServer/Game.ini in the backup no longer matches the hash taken when it was saved.',
  });
  await verify('world');
  // A longer file.
  fs.writeFileSync(game, Buffer.concat([original, Buffer.from('more')]));
  await assert.rejects(verify('everything'), { code: 'changed' });
  fs.writeFileSync(game, original);
  await verify('everything');
  await assert.rejects(verify('settings', { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});

test('selectFiles picks the files of each scope', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const info = await readBackup(row, { dataDir: w.dataDir });
  assert.equal(selectFiles(info, { scope: 'everything' }).world.length, 6);
  assert.equal(selectFiles(info, { scope: 'everything' }).settings.length, 2);
  assert.equal(selectFiles(info, { scope: 'world' }).settings.length, 0);
  assert.equal(selectFiles(info, { scope: 'settings' }).world.length, 0);
  const players = selectFiles(info, { scope: 'players', profiles: ['0002'], tribes: ['1001'] });
  assert.deepEqual(players.players.map((file) => file.relPath).sort(), [
    'SavedArks/TheIsland_WP/0002.arkprofile',
    'SavedArks/TheIsland_WP/1001.arktribe',
  ]);
  assert.equal(players.world.length + players.settings.length, 0);
});

test('a manifest that lists a file twice, in any letter case, or the saves of two maps is refused', async (t) => {
  const w = restoreWorld(t);
  const row = await w.backup();
  const read = () => readBackup(row, { dataDir: w.dataDir });
  const original = JSON.parse(fs.readFileSync(manifestOf(row), 'utf8'));
  const world = original.files.find((file) => file.relPath.endsWith('0001.arkprofile'));
  const write = (files) => fs.writeFileSync(manifestOf(row), JSON.stringify({ ...original, files }));
  write([...original.files, { ...world }]);
  await assert.rejects(read(), { code: 'bad_manifest', message: /twice/ });
  write([...original.files, { ...world, relPath: world.relPath.toUpperCase().replace('SAVEDARKS/', 'SavedArks/') }]);
  await assert.rejects(read(), { code: 'bad_manifest', message: /twice/ });
  write([...original.files, { ...world, relPath: 'SavedArks/Ragnarok_WP/Ragnarok_WP.ark' }]);
  await assert.rejects(read(), { code: 'bad_manifest', message: /more than one map/ });
  await assert.rejects(readManifest(row.path), { code: 'bad_manifest' });
  // Positive control: the original list reads again.
  write(original.files);
  assert.equal((await read()).files.length, original.files.length);
});
