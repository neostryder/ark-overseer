import test from 'node:test';
import assert from 'node:assert/strict';
import { serverPaths, buildLaunch } from '../src/supervisor/launch.js';
const install = { path: 'C:\\ARK' };
const server = {
  map: 'TheIsland',
  session_name: 'My Server',
  game_port: 7777,
  query_port: 27015,
  max_players: 50,
  settings_json: '{}',
};

test('server paths use the legacy Windows layout on every platform', () => {
  assert.deepEqual(serverPaths(install.path), {
    exePath: 'C:\\ARK\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe',
    exeDir: 'C:\\ARK\\ShooterGame\\Binaries\\Win64',
    configDir: 'C:\\ARK\\ShooterGame\\Saved\\Config\\WindowsServer',
    gameUserSettingsPath: 'C:\\ARK\\ShooterGame\\Saved\\Config\\WindowsServer\\GameUserSettings.ini',
    gameIniPath: 'C:\\ARK\\ShooterGame\\Saved\\Config\\WindowsServer\\Game.ini',
    logPath: 'C:\\ARK\\ShooterGame\\Saved\\Logs\\ShooterGame.log',
  });
});

test('launch arguments preserve order and include optional mods and BattlEye flags', () => {
  assert.deepEqual(
    buildLaunch({ ...server, settings_json: JSON.stringify({ mods: [1, '22'], disableBattlEye: true }) }, install).args,
    [
      'TheIsland?listen?SessionName=My Server',
      '-port=7777',
      '-QueryPort=27015',
      '-WinLiveMaxPlayers=50',
      '-log',
      '-mods=1,22',
      '-NoBattlEye',
    ],
  );
  assert.deepEqual(buildLaunch({ ...server, query_port: null }, install).args, [
    'TheIsland?listen?SessionName=My Server',
    '-port=7777',
    '-WinLiveMaxPlayers=50',
    '-log',
  ]);
});

test('launch arguments never contain passwords in settings', () => {
  assert.equal(
    buildLaunch(
      { ...server, settings_json: JSON.stringify({ ServerAdminPassword: 'secret', ServerPassword: 'other' }) },
      install,
    ).args.some((arg) => arg.includes('secret') || arg.includes('other')),
    false,
  );
});

test('launch rejects question marks in map and session name', () => {
  assert.throws(() => buildLaunch({ ...server, map: 'Bad?Map' }, install), TypeError);
  assert.throws(() => buildLaunch({ ...server, session_name: 'Bad?Name' }, install), TypeError);
  assert.throws(() => buildLaunch({ ...server, session_name: 'Bad "Name"' }, install), TypeError);
});

test('launch rejects mod ids containing non-digits', () => {
  assert.throws(() => buildLaunch({ ...server, settings_json: '{"mods":["1;evil"]}' }, install), TypeError);
});
