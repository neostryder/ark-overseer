import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore, decodeSetting } from '../src/settings/store.js';

const USER_INI =
  '; kept comment\r\n[ServerSettings]\r\nUnknown=abc\r\nServerPVE=False\r\nServerAdminPassword=secret\r\nRCONPort=27020\r\n';

function setup(t, userIni = USER_INI) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = path.join(dir, 'GameUserSettings.ini');
  const game = path.join(dir, 'Game.ini');
  if (userIni !== null) fs.writeFileSync(user, userIni);
  return { user, game, store: createSettingsStore({ gameUserSettingsPath: user, gameIniPath: game }) };
}

test('an absent key reads as null, a present key as its typed value', (t) => {
  const { store } = setup(t);
  const settings = store.readSettings();
  assert.equal(settings.TamingSpeedMultiplier, null);
  assert.equal(settings.MaxPlayers, null);
  assert.equal(settings.ServerHardcore, null);
  assert.equal(settings.ServerPVE, false);
  assert.equal(settings.RCONPort, 27020);
  assert.equal(settings.sessionName, '');
});

test('decodeSetting turns bool and number text into values and leaves anything else alone', () => {
  const bool = { type: 'bool' },
    int = { type: 'int' },
    float = { type: 'float' },
    text = { type: 'string' };
  assert.equal(decodeSetting(bool, 'False'), false);
  assert.equal(decodeSetting(bool, 'true'), true);
  assert.equal(decodeSetting(bool, '0'), false);
  assert.equal(decodeSetting(bool, 'maybe'), 'maybe');
  assert.equal(decodeSetting(int, '20'), 20);
  assert.equal(decodeSetting(float, '0.5'), 0.5);
  assert.equal(decodeSetting(float, ''), '');
  assert.equal(decodeSetting(float, 'fast'), 'fast');
  assert.equal(decodeSetting(text, '123'), '123');
  assert.equal(decodeSetting(int, null), null);
});

test('missing files read as empty settings', (t) => {
  const { store } = setup(t, null);
  assert.equal(store.readSettings().ServerPVE, null);
});

test('a write changes only the keys it names and leaves the rest of the file alone', (t) => {
  const { user, store } = setup(t);
  store.writeSettings({ ServerHardcore: true });
  assert.equal(
    fs.readFileSync(user, 'utf8'),
    USER_INI.replace('[ServerSettings]\r\n', '[ServerSettings]\r\nServerHardcore=True\r\n'),
  );
  assert.equal(store.readSettings().TamingSpeedMultiplier, null);
});

test('bools are written as True and False, numbers as plain text', (t) => {
  const { user, store } = setup(t);
  store.writeSettings({ ServerPVE: true, ServerHardcore: false, TamingSpeedMultiplier: 2.5 });
  const text = fs.readFileSync(user, 'utf8');
  assert.match(text, /^ServerPVE=True$/m);
  assert.match(text, /^ServerHardcore=False$/m);
  assert.match(text, /^TamingSpeedMultiplier=2\.5$/m);
});

test('null removes a key', (t) => {
  const { user, store } = setup(t);
  store.writeSettings({ ServerPVE: null });
  assert.doesNotMatch(fs.readFileSync(user, 'utf8'), /ServerPVE/i);
  assert.equal(store.readSettings().ServerPVE, null);
});

test('Game.ini is only created by a write that touches a Game.ini field', (t) => {
  const { game, store } = setup(t);
  assert.deepEqual(store.writeSettings({ ServerPVE: true }).written, ['gameusersettings']);
  assert.equal(fs.existsSync(game), false);
  assert.deepEqual(store.writeSettings({ BabyCuddleIntervalMultiplier: 0.5 }).written, ['game']);
  assert.equal(
    fs.readFileSync(game, 'utf8'),
    '[/script/shootergame.shootergamemode]\r\nBabyCuddleIntervalMultiplier=0.5',
  );
});

test('an invalid body throws with its errors and writes nothing', (t) => {
  const { user, game, store } = setup(t);
  const before = fs.readFileSync(user);
  for (const body of [
    { TamingSpeedMultiplier: -2 },
    { RCONPort: null },
    { ServerPVE: true, Message: 'hi\r\nServerAdminPassword=taken' },
    { ServerPVE: true, TamingSpeedMultiplier: '' },
  ]) {
    assert.throws(
      () => store.writeSettings(body),
      (error) => Array.isArray(error.errors) && error.errors.length > 0,
    );
    assert.deepEqual(fs.readFileSync(user), before);
    assert.equal(fs.existsSync(game), false);
  }
});

test('a launch-flag field is never written and never read', (t) => {
  const { user, game, store } = setup(t);
  store.writeSettings({ DisableBattlEye: true });
  assert.equal(fs.readFileSync(user, 'utf8'), USER_INI);
  assert.equal(fs.existsSync(game), false);
  assert.equal('DisableBattlEye' in store.readSettings(), false);
});

test('session name is trimmed and written to [SessionSettings]', (t) => {
  const { store } = setup(t);
  store.writeSettings({ sessionName: '  Neo Olympus  ' });
  assert.equal(store.readSettings().sessionName, 'Neo Olympus');
});

test('reset writes defaults, removes game-default keys and keeps the admin password and locked fields', (t) => {
  const { user, game, store } = setup(t);
  store.writeSettings({ ServerPassword: 'friends', OverrideMaxExperiencePointsPlayer: 5000, TamingSpeedMultiplier: 3 });
  const { skipped } = store.resetToDefaults();
  assert.ok(skipped.includes('ServerAdminPassword'));
  assert.ok(skipped.includes('RCONPort'));
  const userText = fs.readFileSync(user, 'utf8');
  const gameText = fs.readFileSync(game, 'utf8');
  assert.match(userText, /^ServerPassword=$/m);
  assert.match(userText, /^TamingSpeedMultiplier=1$/m);
  assert.match(userText, /^ServerAdminPassword=secret$/m);
  assert.match(userText, /^RCONPort=27020$/m);
  assert.match(userText, /^Unknown=abc$/m);
  assert.match(userText, /^; kept comment$/m);
  assert.doesNotMatch(gameText, /OverrideMaxExperiencePointsPlayer/i);
});
