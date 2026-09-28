import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGames } from '../src/gaming/detect.js';

test('detects launcher games and descendants while excluding helpers, ignores and ARK servers', () => {
  const procs = [
    { pid: 1, name: 'steam.exe', parentPid: 0 },
    { pid: 2, name: 'steamwebhelper.exe', parentPid: 1 },
    { pid: 3, name: 'Game.EXE', parentPid: 1 },
    { pid: 4, name: 'tiny.exe', parentPid: 1 },
    { pid: 5, name: 'childgame.exe', parentPid: 4 },
    { pid: 6, name: 'grand.exe', parentPid: 5 },
    { pid: 7, name: 'manual.exe', parentPid: 99 },
    { pid: 8, name: 'ignore.exe', parentPid: 1 },
    { pid: 9, name: 'ArkAscendedServer.exe', parentPid: 1 },
    { pid: 10, name: 'orphan.exe', parentPid: 88 },
  ];
  assert.deepEqual(detectGames(procs, { games: ['MANUAL.exe'], ignore: ['GAME.exe', 'manual.exe', 'ignore.exe'] }), [
    'childgame.exe',
    'grand.exe',
    'tiny.exe',
  ]);
  assert.deepEqual(detectGames(procs, { ignore: ['GAME.exe'] }), [
    'childgame.exe',
    'grand.exe',
    'ignore.exe',
    'tiny.exe',
  ]);
});

test('an overlay or console window a game opens is not listed as a game of its own', () => {
  const games = detectGames([
    { pid: 1, parentPid: 0, name: 'steam.exe' },
    { pid: 2, parentPid: 1, name: 'ArkAscended.exe' },
    { pid: 3, parentPid: 2, name: 'gameoverlayui64.exe' },
    { pid: 4, parentPid: 2, name: 'conhost.exe' },
  ]);
  assert.deepEqual(games, ['ArkAscended.exe']);
});

test('the owner list counts a process whatever started it, in any letter case', () => {
  assert.deepEqual(detectGames([{ pid: 5, parentPid: 999, name: 'MyGame.EXE' }], { games: ['mygame.exe'] }), [
    'MyGame.EXE',
  ]);
});

test('launchers other than Steam, a cmd.exe shim, and a game-specific launcher are all followed', () => {
  const games = detectGames([
    { pid: 1, parentPid: 0, name: 'EpicGamesLauncher.exe' },
    { pid: 2, parentPid: 1, name: 'FortniteLauncher.exe' },
    { pid: 3, parentPid: 2, name: 'FortniteClient-Win64-Shipping.exe' },
    { pid: 10, parentPid: 0, name: 'STEAM.EXE' },
    { pid: 11, parentPid: 10, name: 'cmd.exe' },
    { pid: 12, parentPid: 11, name: 'OldGame.exe' },
    { pid: 20, parentPid: 0, name: 'GalaxyClient.exe' },
    { pid: 21, parentPid: 20, name: 'Witcher3.exe' },
  ]);
  assert.deepEqual(games, ['FortniteClient-Win64-Shipping.exe', 'FortniteLauncher.exe', 'OldGame.exe', 'Witcher3.exe']);
});

test('installers a launcher runs, and anything a helper starts, are not games', () => {
  const games = detectGames([
    { pid: 1, parentPid: 0, name: 'steam.exe' },
    { pid: 2, parentPid: 1, name: 'VC_redist.x64.exe' },
    { pid: 3, parentPid: 1, name: 'DXSETUP.exe' },
    { pid: 4, parentPid: 1, name: 'steamwebhelper.exe' },
    { pid: 5, parentPid: 4, name: 'SomeChromiumChild.exe' },
    { pid: 6, parentPid: 0, name: 'Battle.net.exe' },
    { pid: 7, parentPid: 6, name: 'BlizzardBrowser.exe' },
  ]);
  assert.deepEqual(games, []);
});
