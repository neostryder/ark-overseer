import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import { validateField } from '../public/js/lib/settings.js';
import { validInstallFolder } from '../public/js/lib/install-folder.js';
import {
  MAPS,
  PRESETS,
  validateMapId,
  isAbsolutePath,
  validateServerStep,
  validatePorts,
  generatePassword,
  settingsBody,
  createPlan,
  mapName,
} from '../public/js/lib/wizard.js';

test('official maps have valid unique ids in order', () => {
  assert.deepEqual(
    MAPS.map(({ id }) => id),
    [
      'TheIsland_WP',
      'TheCenter_WP',
      'ScorchedEarth_WP',
      'Ragnarok_WP',
      'Aberration_WP',
      'Extinction_WP',
      'Valguero_WP',
      'Genesis_WP',
      'Astraeos_WP',
      'LostColony_WP',
      'BobsMissions_WP',
    ],
  );
  assert.equal(new Set(MAPS.map(({ id }) => id)).size, MAPS.length);
  assert.ok(MAPS.every(({ id }) => validateMapId(id)));
});
test('presets only contain valid editable catalog values', () => {
  assert.deepEqual(PRESETS[0], { id: 'default', settings: {} });
  for (const preset of PRESETS)
    for (const [key, value] of Object.entries(preset.settings)) {
      const field = SETTINGS_FIELDS.find((item) => item.key === key);
      assert.ok(field, key);
      assert.ok(!field.locked, key);
      assert.ok(!field.launchFlag, key);
      assert.equal(validateField(field, value), '', key);
    }
});
test('server step checks names, map, player limit and new install path', () => {
  const fields = SETTINGS_FIELDS;
  const good = {
    name: 'Server',
    sessionName: 'Session',
    map: MAPS[0].id,
    maxPlayers: 70,
    installPath: 'D:\\ARK\\Server1',
  };
  assert.deepEqual(validateServerStep(good, fields), {});
  for (const name of ['', 'x'.repeat(65), 'bad\u0001name'])
    assert.ok(validateServerStep({ ...good, name }, fields).name);
  for (const sessionName of ['a?b', 'a"b', 'a\nb', 'x'.repeat(61)])
    assert.ok(validateServerStep({ ...good, sessionName }, fields).sessionName);
  assert.ok(validateServerStep({ ...good, map: 'map with spaces' }, fields).map);
  // The limit is the launch flag the server checks as 1 to 1000, not the INI field.
  assert.deepEqual(validateServerStep({ ...good, maxPlayers: 1000 }, fields), {});
  for (const maxPlayers of [0, 1001, 1.5, null])
    assert.ok(validateServerStep({ ...good, maxPlayers }, fields).maxPlayers);
  assert.ok(validateServerStep({ ...good, installPath: 'relative' }, fields).installPath);
  assert.ok(
    validateServerStep(
      {
        ...good,
        installPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ARK Survival Ascended Dedicated Server',
      },
      fields,
    ).installPath,
  );
  assert.deepEqual(validateServerStep({ ...good, installId: 2, installPath: 'relative' }, fields), {});
});
test('ports validate ranges and collisions including peer port', () => {
  assert.deepEqual(validatePorts({ gamePort: 7777, queryPort: 27015, rconPort: 27020 }), {});
  assert.equal(validatePorts({ gamePort: 7777, queryPort: 7778, rconPort: 27020 }).queryPort, 'duplicatePort');
  assert.equal(validatePorts({ gamePort: 7777, queryPort: 27015, rconPort: 7777 }).rconPort, 'duplicatePort');
  assert.ok(validatePorts({ gamePort: 7777, queryPort: 27020, rconPort: 27020 }).rconPort);
  // The same ranges the server enforces: 1024 up, and the game port stops at 65534 so its peer fits.
  for (const port of [0, 1023, 65535, 65536, 7777.5])
    assert.equal(
      validatePorts({ gamePort: port, queryPort: null, rconPort: null }).gamePort,
      'badGamePort',
      String(port),
    );
  assert.deepEqual(validatePorts({ gamePort: 65534, queryPort: 1024, rconPort: 65533 }), {});
  for (const port of [1023, 65536, 27015.5, '27015'])
    assert.equal(validatePorts({ gamePort: 7777, queryPort: port, rconPort: null }).queryPort, 'badPort', String(port));
  assert.deepEqual(validatePorts({ gamePort: 7777, queryPort: null, rconPort: 27020 }), {});
  assert.ok(validatePorts({ queryPort: 27015, rconPort: 27020 }).gamePort);
});
test('password generation is deterministic, unbiased by rejection, and replenishes bytes', () => {
  const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
  const first = generatePassword(bytes);
  assert.equal(first.length, 20);
  assert.match(first, /^[A-Za-z0-9]{20}$/);
  // Byte n picks the nth character, so bytes 0 to 19 spell the first 20 letters.
  assert.equal(first, 'ABCDEFGHIJKLMNOPQRST');
  assert.equal(generatePassword(Uint8Array.from({ length: 20 }, () => 62 + 61)), '9'.repeat(20));
  let drawn = 0;
  const value = generatePassword(new Uint8Array(0), (length) => {
    drawn += length;
    return new Uint8Array(length).fill(255).map((_, i) => i % 62);
  });
  assert.equal(value.length, 20);
  assert.ok(drawn >= 40);
  let calls = 0;
  const skipped = generatePassword(new Uint8Array(40).fill(255), (length) => {
    calls++;
    return new Uint8Array(length).fill(0);
  });
  // Every 255 is skipped rather than folded in, so the whole password comes from the zeros drawn later.
  assert.equal(skipped, 'A'.repeat(20));
  assert.ok(calls > 0);
  assert.equal(
    generatePassword(Uint8Array.from([248, 249, 250, 251, 252, 253, 254, 255, ...new Array(20).fill(1)])),
    'B'.repeat(20),
  );
});
test('install and dashboard folders use the same absolute-path rule as the server', () => {
  for (const good of ['D:\\ARK\\Server1', 'D:/ARK/Server1', 'C:\\', '\\\\nas\\ark\\server', '//nas/ark/server'])
    assert.ok(isAbsolutePath(good), good);
  for (const bad of ['', 'ARK\\Server1', 'D:ARK', '\\ARK', '/ARK', '\\\\nas', null])
    assert.ok(!isAbsolutePath(bad), String(bad));
  const good = { name: 'Server', sessionName: 'Session', map: 'TheIsland_WP', maxPlayers: 70 };
  assert.deepEqual(validateServerStep({ ...good, installPath: 'D:/ARK/Server1' }, SETTINGS_FIELDS), {});
  assert.ok(validateServerStep({ ...good, installPath: 'd:/steam/SteamApps/Common/x' }, SETTINGS_FIELDS).installPath);
  // The server trims the name before checking its length, so surrounding spaces do not count.
  assert.deepEqual(
    validateServerStep({ ...good, name: `  ${'x'.repeat(64)}  `, installPath: 'D:\\A' }, SETTINGS_FIELDS),
    {},
  );
});

test('shared install folder checks reject used, relative, Steam and traversal paths', () => {
  const installs = [{ path: 'D:\\ARK\\Existing' }];
  assert.equal(validInstallFolder('D:/ARK/New', installs), true);
  for (const value of [
    'relative',
    'D:\\ARK\\..\\Other',
    'D:\\Steam\\steamapps\\common\\ASA',
    'd:/ark/existing',
    '\\\\host\\share\\ASA',
    '\\\\?\\D:\\ASA',
  ])
    assert.equal(validInstallFolder(value, installs), false, value);
  assert.equal(validInstallFolder('\\\\host\\share\\ASA', [], { allowUnc: true }), true);
});
test('settings body includes preset and admin password but omits blank join password', () => {
  const body = settingsBody({ adminPassword: 'secret', joinPassword: '', presetId: 'relaxed' });
  assert.equal(body.ServerAdminPassword, 'secret');
  assert.equal('ServerPassword' in body, false);
  assert.equal(body.XPMultiplier, 2);
  assert.equal(settingsBody({ adminPassword: 'x', joinPassword: 'join', presetId: 'pve' }).ServerPassword, 'join');
});
test('create plan orders install, server and settings and reuses existing install id', () => {
  const base = {
    installPath: 'D:\\ARK\\Server',
    name: 'A',
    sessionName: 'A session',
    map: 'TheIsland_WP',
    maxPlayers: 70,
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    adminPassword: 'x',
    presetId: 'default',
  };
  const fresh = createPlan(base);
  assert.deepEqual(
    fresh.map((x) => x.step),
    ['install', 'server', 'settings'],
  );
  assert.deepEqual(fresh[0].body, { path: base.installPath });
  const existing = createPlan({ ...base, installId: 9 });
  assert.deepEqual(
    existing.map((x) => x.step),
    ['server', 'settings'],
  );
  assert.equal(existing[0].body.installId, 9);
});

test('mapName shows a known map by name and a custom map by its id', () => {
  assert.equal(mapName('Astraeos_WP'), 'Astraeos');
  assert.equal(mapName('TheIsland_WP'), 'The Island');
  assert.equal(mapName('MyModMap_WP'), 'MyModMap_WP');
});
