import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findModMaps, withModMaps, clearModMapCache } from '../src/maps/mod-maps.js';
import { modsFolder } from '../src/maps/art.js';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-modmaps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const URL_A = 'https://www.curseforge.com/ark-survival-ascended/mods/winter-wonderland';

// A temp install with a Mods folder. mod() writes one downloaded mod the way ASA lays it out.
function tree(t) {
  const install = path.join(folder(t), 'ASA');
  const mods = modsFolder(install);
  fs.mkdirSync(mods, { recursive: true });
  const api = {
    install,
    mods,
    mod(folderName, { plugin = 'Plugin', uplugin, manifest, maps } = {}) {
      const dir = path.join(mods, folderName, plugin);
      fs.mkdirSync(dir, { recursive: true });
      if (uplugin !== null)
        fs.writeFileSync(path.join(dir, `${plugin}.uplugin`), uplugin ?? JSON.stringify({ FriendlyName: 'A Mod' }));
      if (manifest !== null) {
        const lines = (maps ?? []).map((file, index) => `${file}\t2026.09.01-00.00.0${index}`);
        fs.writeFileSync(path.join(dir, 'Manifest_UFSFiles_Win64.txt'), manifest ?? lines.join('\r\n'));
      }
      return dir;
    },
    age(folderName, secondsAgo) {
      const when = new Date(Date.now() - secondsAgo * 1000);
      fs.utimesSync(path.join(mods, folderName), when, when);
    },
  };
  return api;
}
const umap = (name) => `ShooterGame/Mods/Something/Content/${name}.umap`;
const summary = (maps) => maps.map((map) => [map.id, map.name, map.modId]);

test('a mod with one map gives the map its mod name, its page and its mod id', (t) => {
  const { install, mod } = tree(t);
  mod('928102_555', {
    plugin: 'WinterWonderland',
    uplugin: JSON.stringify({ FriendlyName: 'Winter Wonderland', MarketplaceURL: URL_A }),
    maps: [umap('WinterWonderland_WP'), 'ShooterGame/Mods/Something/Content/Textures/Snow.uasset'],
  });
  assert.deepEqual(findModMaps(install), [
    { id: 'WinterWonderland_WP', name: 'Winter Wonderland', kind: 'mod', modId: '928102', marketplaceUrl: URL_A },
  ]);
});

test('a mod with several maps names each one after the mod and its id, and lists an id once', (t) => {
  const { install, mod } = tree(t);
  mod('111_2', {
    uplugin: JSON.stringify({ FriendlyName: 'Twin Isles' }),
    maps: [umap('North_WP'), umap('South_WP'), 'Other/Path/North_WP.umap'],
  });
  assert.deepEqual(summary(findModMaps(install)), [
    ['North_WP', 'Twin Isles: North_WP', '111'],
    ['South_WP', 'Twin Isles: South_WP', '111'],
  ]);
});

test('maps whose id does not end in _WP are left out, and so are files that only look like maps', (t) => {
  const { install, mod } = tree(t);
  mod('5_1', {
    uplugin: JSON.stringify({ FriendlyName: 'Tester' }),
    maps: [
      umap('Real_WP'),
      umap('TestMap'),
      umap('Real_WP_Sublevel'),
      umap('lower_wp'),
      'Content/Real2_WP.umap.bak',
      umap('Bad Name_WP'),
    ],
  });
  assert.deepEqual(summary(findModMaps(install)), [['Real_WP', 'Tester', '5']]);
});

test('the newest folder of a mod is the one that is read', (t) => {
  const { install, mod, age } = tree(t);
  mod('928102_100', { uplugin: JSON.stringify({ FriendlyName: 'Old name' }), maps: [umap('Old_WP')] });
  mod('928102_200', { uplugin: JSON.stringify({ FriendlyName: 'New name' }), maps: [umap('New_WP')] });
  age('928102_100', 3000);
  age('928102_200', 1000);
  assert.deepEqual(summary(findModMaps(install)), [['New_WP', 'New name', '928102']]);
  clearModMapCache();
  // The newest by modification time wins, not the highest file id.
  age('928102_100', 5);
  assert.deepEqual(summary(findModMaps(install)), [['Old_WP', 'Old name', '928102']]);
});

test('a mod folder that cannot be parsed is skipped and the others are still read', (t) => {
  const { install, mods, mod } = tree(t);
  mod('1_1', { uplugin: '{ not json', maps: [umap('Broken_WP')] });
  mod('2_1', { uplugin: null, maps: [umap('NoDescriptor_WP')] });
  mod('3_1', { uplugin: JSON.stringify({ FriendlyName: 'No list' }), manifest: null });
  mod('4_1', { uplugin: JSON.stringify(['array']), maps: [umap('Array_WP')] });
  mod('6_1', { uplugin: JSON.stringify({ FriendlyName: 'Fine' }), maps: [umap('Fine_WP')] });
  fs.mkdirSync(path.join(mods, '7_1'));
  fs.writeFileSync(path.join(modsFolder(install), 'stray.txt'), 'not a mod');
  assert.deepEqual(summary(findModMaps(install)), [['Fine_WP', 'Fine', '6']]);
});

test('a missing name falls back to the mod id, a control character is dropped, and only a CurseForge page is kept', (t) => {
  const { install, mod } = tree(t);
  mod('8_1', { uplugin: JSON.stringify({ MarketplaceURL: 'http://www.curseforge.com/x' }), maps: [umap('A_WP')] });
  mod('9_1', {
    uplugin: JSON.stringify({
      FriendlyName: `Tab\tand\nline ${'x'.repeat(80)}`,
      MarketplaceURL: 'https://evil.example/curseforge.com',
    }),
    maps: [umap('B_WP')],
  });
  const [a, b] = findModMaps(install);
  assert.deepEqual([a.name, a.marketplaceUrl], ['Mod 8', null]);
  assert.match(b.name, /^Tab and line x+$/);
  assert.equal(b.name.length, 60);
  assert.equal(b.marketplaceUrl, null);
});

test('a manifest is read to 2 MB at most, and a line cut by the limit is dropped', (t) => {
  const { install, mod } = tree(t);
  const filler = `Content/File.uasset\t2026.09.01-00.00.00\n`.repeat(50_000);
  assert.ok(filler.length < 2 * 1024 * 1024);
  const early = `${umap('Early_WP')}\t2026.09.01-00.00.00\n`;
  const pad = `${'x'.repeat(2 * 1024 * 1024 - filler.length - early.length - 30)}\n`;
  const cut = `${umap('Cut_WP')}\t2026.09.01-00.00.00\n`;
  const late = `${umap('Late_WP')}\t2026.09.01-00.00.00\n`;
  const body = filler + early + pad + cut + late;
  assert.ok(Buffer.byteLength(body) > 2 * 1024 * 1024);
  mod('10_1', { uplugin: JSON.stringify({ FriendlyName: 'Big' }), manifest: body });
  assert.deepEqual(
    findModMaps(install).map((map) => map.id),
    ['Early_WP'],
  );
});

test('a missing Mods folder gives nothing, and nothing is written', (t) => {
  const bare = path.join(folder(t), 'ASA');
  fs.mkdirSync(bare);
  assert.deepEqual(findModMaps(bare), []);
  assert.deepEqual(fs.readdirSync(bare), []);
  assert.deepEqual(findModMaps(path.join(bare, 'missing')), []);
});

test('a link that leads out of the Mods folder is refused', (t) => {
  const { install, mods, mod } = tree(t);
  const outside = folder(t);
  fs.mkdirSync(path.join(outside, 'Plugin'));
  fs.writeFileSync(path.join(outside, 'Plugin', 'Plugin.uplugin'), JSON.stringify({ FriendlyName: 'Outside' }));
  fs.writeFileSync(path.join(outside, 'Plugin', 'Manifest_UFSFiles_Win64.txt'), `${umap('Escaped_WP')}\t1\n`);
  fs.mkdirSync(path.join(mods, '20_1'));
  try {
    // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
    fs.symlinkSync(path.join(outside, 'Plugin'), path.join(mods, '20_1', 'Plugin'), 'junction');
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return;
  }
  // A manifest that is itself a link to a file outside is refused too.
  const inside = mod('21_1', { uplugin: JSON.stringify({ FriendlyName: 'Linked file' }), manifest: null });
  try {
    fs.symlinkSync(
      path.join(outside, 'Plugin', 'Manifest_UFSFiles_Win64.txt'),
      path.join(inside, 'Manifest_UFSFiles_Win64.txt'),
      'file',
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  mod('22_1', { uplugin: JSON.stringify({ FriendlyName: 'Honest' }), maps: [umap('Honest_WP')] });
  assert.deepEqual(summary(findModMaps(install)), [['Honest_WP', 'Honest', '22']]);
});

test('a Mods folder that is itself a link out of the install is refused', (t) => {
  const install = path.join(folder(t), 'ASA');
  const outside = folder(t);
  const plugin = path.join(outside, '30_1', 'Plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'Plugin.uplugin'), JSON.stringify({ FriendlyName: 'Outside' }));
  fs.writeFileSync(path.join(plugin, 'Manifest_UFSFiles_Win64.txt'), `${umap('Escaped_WP')}\t1\n`);
  fs.mkdirSync(path.dirname(modsFolder(install)), { recursive: true });
  try {
    fs.symlinkSync(outside, modsFolder(install), 'junction');
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return;
  }
  assert.deepEqual(findModMaps(install), []);
  // Positive control: the same tree as a real folder inside the install is found.
  clearModMapCache();
  fs.rmSync(modsFolder(install), { recursive: true });
  fs.cpSync(outside, modsFolder(install), { recursive: true });
  assert.deepEqual(summary(findModMaps(install)), [['Escaped_WP', 'Outside', '30']]);
});

test('the answer for an install is kept for a minute', (t) => {
  const { install, mod } = tree(t);
  let time = 1_000_000;
  const now = () => time;
  mod('40_1', { uplugin: JSON.stringify({ FriendlyName: 'First' }), maps: [umap('First_WP')] });
  assert.equal(findModMaps(install, { now }).length, 1);
  mod('41_1', { uplugin: JSON.stringify({ FriendlyName: 'Second' }), maps: [umap('Second_WP')] });
  time += 59_000;
  assert.equal(findModMaps(install, { now }).length, 1);
  // A caller that changes its copy does not change what is kept.
  findModMaps(install, { now })[0].name = 'changed';
  assert.equal(findModMaps(install, { now })[0].name, 'First');
  time += 2_000;
  assert.deepEqual(
    findModMaps(install, { now }).map((map) => map.id),
    ['First_WP', 'Second_WP'],
  );
});

test('a catalog entry wins over a found map with the same id, in any letter case', (t) => {
  const { install, mod } = tree(t);
  mod('50_1', { uplugin: JSON.stringify({ FriendlyName: 'Found' }), maps: [umap('Shared_WP'), umap('OnlyFound_WP')] });
  const catalogData = {
    version: 3,
    maps: [{ id: 'shared_wp', name: 'From the catalog', kind: 'mod', modId: '999' }],
  };
  const merged = withModMaps(catalogData, install);
  assert.equal(merged.version, 3);
  assert.deepEqual(
    merged.maps.map((map) => [map.id, map.name]),
    [
      ['shared_wp', 'From the catalog'],
      ['OnlyFound_WP', 'Found: OnlyFound_WP'],
    ],
  );
  // The catalog itself is not changed.
  assert.equal(catalogData.maps.length, 1);
});

test('a map id is at most 64 characters in total, counting _WP', (t) => {
  const { install, mod } = tree(t);
  const fits = `${'a'.repeat(61)}_WP`;
  const tooLong = `${'b'.repeat(62)}_WP`;
  assert.equal(fits.length, 64);
  mod('60_1', { uplugin: JSON.stringify({ FriendlyName: 'Long' }), maps: [umap(tooLong), umap(fits)] });
  assert.deepEqual(
    findModMaps(install).map((map) => map.id),
    [fits],
  );
});

test('a mod with several maps keeps the whole id in each name and shortens the mod name instead', (t) => {
  const { install, mod } = tree(t);
  const long = `${'c'.repeat(37)}_WP`;
  mod('61_1', {
    uplugin: JSON.stringify({ FriendlyName: 'A very long friendly name that would not fit next to the id' }),
    maps: [umap(long), umap('Short_WP')],
  });
  const [first, second] = findModMaps(install);
  assert.equal(first.name.endsWith(`: ${long}`), true);
  assert.equal(first.name.length, 60);
  assert.match(first.name, /^A very long friend: /);
  assert.equal(second.name.endsWith(': Short_WP'), true);
  assert.ok(second.name.length <= 60);
  // With no room for the mod name at all, the id stands on its own.
  clearModMapCache();
  const huge = `${'d'.repeat(60)}_WP`;
  mod('62_1', { uplugin: JSON.stringify({ FriendlyName: 'Name' }), maps: [umap(huge), umap('Other_WP')] });
  assert.equal(findModMaps(install).find((map) => map.id === huge).name, huge);
});

test('maps are gathered from every plugin folder of a mod, and a broken one does not hide the rest', (t) => {
  const { install, mod } = tree(t);
  mod('63_1', { plugin: 'Alpha', uplugin: JSON.stringify({ FriendlyName: 'Alpha' }), maps: [umap('Alpha_WP')] });
  mod('63_1', { plugin: 'Broken', uplugin: '{ nope', maps: [umap('Broken_WP')] });
  mod('63_1', { plugin: 'Gamma', uplugin: JSON.stringify({ FriendlyName: 'Gamma' }), maps: [umap('Gamma_WP')] });
  mod('63_1', { plugin: 'Dupe', uplugin: JSON.stringify({ FriendlyName: 'Dupe' }), maps: [umap('alpha_wp')] });
  assert.deepEqual(summary(findModMaps(install)), [
    ['Alpha_WP', 'Alpha: Alpha_WP', '63'],
    ['Gamma_WP', 'Gamma: Gamma_WP', '63'],
  ]);
});
