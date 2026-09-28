import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveInventory } from '../src/maps/inventory.js';

const catalog = {
  version: 1,
  maps: [
    { id: 'TheIsland_WP', name: 'The Island', kind: 'official', steamAppId: 1 },
    { id: 'Ragnarok_WP', name: 'Ragnarok', kind: 'official', steamAppId: 2 },
    { id: 'ModMap', name: 'A mod map', kind: 'mod', modId: '5' },
  ],
};

function install(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = path.join(dir, 'ShooterGame', 'Saved', 'SavedArks');
  const put = (relative, content = 'x', when) => {
    const file = path.join(saved, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (when) fs.utimesSync(file, new Date(when), new Date(when));
    return file;
  };
  return { dir, saved, put };
}
const scan = (dir, currentMap) => saveInventory({ installPath: dir, currentMap, catalog });

test('a missing SavedArks folder gives an empty list', (t) => {
  const { dir } = install(t);
  assert.deepEqual(scan(dir, 'TheIsland_WP'), []);
  assert.deepEqual(scan(path.join(dir, 'nowhere'), 'TheIsland_WP'), []);
});

test('each map folder reports its world file, players and tribes', (t) => {
  const { dir, put } = install(t);
  put('TheIsland_WP/TheIsland_WP.ark', '0123456789', '2026-03-01T10:00:00.000Z');
  put('TheIsland_WP/1.arkprofile');
  put('TheIsland_WP/2.arkprofile');
  put('TheIsland_WP/3.ARKPROFILE');
  put('TheIsland_WP/1.arktribe');
  put('TheIsland_WP/1.profilebak');
  put('TheIsland_WP/TheIsland_WP_02.03.2026_10.00.00.ark', 'a timestamped copy');
  assert.deepEqual(scan(dir, 'TheIsland_WP'), [
    {
      mapId: 'TheIsland_WP',
      name: 'The Island',
      kind: 'official',
      current: true,
      worldBytes: 10,
      lastSavedAt: '2026-03-01T10:00:00.000Z',
      profiles: 3,
      tribes: 1,
    },
  ]);
});

test('folder and world file names match the map in any letter case', (t) => {
  const { dir, put } = install(t);
  put('ragnarok_wp/RAGNAROK_WP.ARK', 'world', '2026-03-02T00:00:00.000Z');
  const [save] = scan(dir, 'Ragnarok_WP');
  assert.equal(save.mapId, 'ragnarok_wp');
  assert.equal(save.name, 'Ragnarok');
  assert.equal(save.kind, 'official');
  assert.equal(save.current, true);
  assert.equal(save.worldBytes, 5);
  assert.equal(scan(dir, 'RAGNAROK_WP')[0].current, true);
  assert.equal(scan(dir, 'TheIsland_WP')[0].current, false);
});

test('a folder with no world file has empty world fields, and one that is not in the catalog keeps its folder name', (t) => {
  const { dir, put } = install(t);
  put('Empty_WP/1.arkprofile');
  put('ModMap/ModMap.ark');
  const saves = scan(dir, null);
  const empty = saves.find((save) => save.mapId === 'Empty_WP');
  assert.deepEqual(empty, {
    mapId: 'Empty_WP',
    name: 'Empty_WP',
    kind: null,
    current: false,
    worldBytes: null,
    lastSavedAt: null,
    profiles: 1,
    tribes: 0,
  });
  assert.equal(saves.find((save) => save.mapId === 'ModMap').kind, 'mod');
});

test('files beside the map folders are ignored and nothing is written', (t) => {
  const { dir, saved, put } = install(t);
  put('TheIsland_WP/TheIsland_WP.ark');
  put('stray.txt');
  const before = fs.readdirSync(saved, { recursive: true }).sort();
  const saves = scan(dir, 'TheIsland_WP');
  assert.deepEqual(
    saves.map((save) => save.mapId),
    ['TheIsland_WP'],
  );
  assert.deepEqual(fs.readdirSync(saved, { recursive: true }).sort(), before);
});

test('folders sort current first, then newest save first, then by name', (t) => {
  const { dir, put } = install(t);
  put('TheIsland_WP/TheIsland_WP.ark', 'x', '2026-01-01T00:00:00.000Z');
  put('Ragnarok_WP/Ragnarok_WP.ark', 'x', '2026-02-01T00:00:00.000Z');
  put('Beta/Beta.ark', 'x', '2026-02-01T00:00:00.000Z');
  put('Alpha_WP/Alpha_WP.ark', 'x', '2026-03-01T00:00:00.000Z');
  put('Zeta_WP/1.arkprofile');
  put('Empty_WP/1.arkprofile');
  assert.deepEqual(
    scan(dir, 'TheIsland_WP').map((save) => save.mapId),
    ['TheIsland_WP', 'Alpha_WP', 'Beta', 'Ragnarok_WP', 'Empty_WP', 'Zeta_WP'],
  );
  // With no current map among the folders, the newest save leads.
  assert.equal(scan(dir, 'Missing_WP')[0].mapId, 'Alpha_WP');
});

test('saves at the same time sort by the name shown, not the folder name', (t) => {
  const { dir, put } = install(t);
  put('Z_WP/Z_WP.ark', 'x', '2026-02-01T00:00:00.000Z');
  put('A_WP/A_WP.ark', 'x', '2026-02-01T00:00:00.000Z');
  const named = {
    version: 1,
    maps: [
      { id: 'Z_WP', name: 'Aardvark', kind: 'official', steamAppId: 3 },
      { id: 'A_WP', name: 'Zebra', kind: 'official', steamAppId: 4 },
    ],
  };
  assert.deepEqual(
    saveInventory({ installPath: dir, currentMap: 'None_WP', catalog: named }).map((save) => save.name),
    ['Aardvark', 'Zebra'],
  );
});
