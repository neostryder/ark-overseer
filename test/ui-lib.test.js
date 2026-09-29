import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGameNames, validGameNames } from '../public/js/lib/gaming.js';

test('gaming textarea helper parses and validates executable names', () => {
  assert.deepEqual(parseGameNames(' one.exe \r\n\nTwo.EXE '), ['one.exe', 'Two.EXE']);
  assert.equal(validGameNames(['one.exe', 'Two.EXE']), true);
  assert.equal(validGameNames(['../bad.exe']), false);
});
import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import { parseRoute, buildRoute } from '../public/js/lib/route.js';
import {
  groupFields,
  filterFields,
  searchFields,
  rankedFields,
  controlValue,
  pendingChanges,
  buildPutBody,
  validateField,
} from '../public/js/lib/settings.js';
import { stateName, relativeTime, byteSize, jobSummary, jobState } from '../public/js/lib/format.js';
import { STRINGS } from '../public/js/strings.js';
import { MAPS, mapName, setCatalogMaps } from '../public/js/lib/wizard.js';
import { mapPictureUrl, railPictureUrl, markArtFailed, GENERIC_MAP_ART } from '../public/js/lib/map-art.js';
import { cronToPicker, pickerToCron, parseCountdown } from '../public/js/lib/cron-picker.js';

test('route parsing and building covers supported routes', () => {
  for (const route of [
    { screen: 'overview', id: 3 },
    { screen: 'settings', id: 4 },
    { screen: 'maps', id: 4 },
    { screen: 'backups', id: 4 },
    { screen: 'network', id: 5 },
    { screen: 'automation', id: 5 },
    { screen: 'jobs' },
    { screen: 'account' },
    { screen: 'setup' },
    { screen: 'home' },
  ]) {
    const hash = buildRoute(route);
    assert.deepEqual(parseRoute(hash), route.screen === 'home' ? { screen: 'home' } : route);
  }
  assert.equal(buildRoute({ screen: 'maps', id: 7 }), '#/servers/7/maps');
  assert.deepEqual(parseRoute('#/servers/7/maps'), { screen: 'maps', id: 7 });
  assert.deepEqual(parseRoute('#/servers/7/maps/extra'), { screen: 'unknown' });
  assert.equal(buildRoute({ screen: 'maps', id: 0 }), '#/');
  assert.deepEqual(parseRoute('#/not-a-route'), { screen: 'unknown' });
  assert.deepEqual(parseRoute('#/servers/nope/settings'), { screen: 'unknown' });
  assert.equal(buildRoute({ screen: 'overview', id: 'x' }), '#/');
});

test('automation cron picker converts supported forms and leaves other cron text raw', () => {
  assert.deepEqual(cronToPicker('15 2 * * *'), { type: 'daily', minute: 15, hour: 2 });
  assert.deepEqual(cronToPicker('0 */6 * * *'), { type: 'hourly', minute: 0, hours: 6 });
  assert.deepEqual(cronToPicker('30 4 * * 2'), { type: 'weekly', minute: 30, hour: 4, weekday: 2 });
  assert.equal(cronToPicker('0 0 1 * *'), null);
  assert.equal(pickerToCron({ type: 'hourly', minute: 10, hours: 3 }), '10 */3 * * *');
});

test('settings group in catalog order and filter all searchable text case-insensitively', () => {
  const grouped = groupFields(SETTINGS_FIELDS);
  for (const [category, fields] of Object.entries(grouped))
    assert.deepEqual(
      fields,
      SETTINGS_FIELDS.filter((field) => field.category === category),
    );
  assert.ok(filterFields(SETTINGS_FIELDS, 'serverpassword').some((field) => field.key === 'ServerPassword'));
  const labeled = SETTINGS_FIELDS.find((field) => field.label);
  assert.ok(filterFields([labeled], labeled.label.toUpperCase()).length);
  const described = SETTINGS_FIELDS.find((field) => field.description);
  assert.ok(filterFields([described], described.description.slice(0, 12).toUpperCase()).length);
});

test('null means documented default, pending null is represented, blocked values are omitted', () => {
  const field = SETTINGS_FIELDS.find((item) => item.type === 'int' && item.default === 70);
  assert.deepEqual(controlValue(field, null), { value: 70, isDefault: true, mark: 'default' });
  const editable = SETTINGS_FIELDS.find((item) => !item.locked && !item.launchFlag && item.type === 'bool');
  const locked = SETTINGS_FIELDS.find((item) => item.locked);
  const launch = SETTINGS_FIELDS.find((item) => item.launchFlag);
  const fields = [editable, locked, launch];
  const changes = pendingChanges(
    fields,
    { [editable.key]: true },
    { [editable.key]: null, [locked.key]: 'x', [launch.key]: true },
  );
  assert.deepEqual(changes, [{ key: editable.key, label: editable.label, from: true, to: null }]);
  assert.deepEqual(buildPutBody([...changes, { key: locked.key, to: 9 }, { key: launch.key, to: true }], fields), {
    [editable.key]: null,
  });
  assert.deepEqual(pendingChanges([editable], { [editable.key]: false }, { [editable.key]: false }), []);
});

test('validation names what is wrong for real catalog min, max, whole-number, maxLength and pattern fields', () => {
  const errors = STRINGS.settings.errors;
  const minimum = SETTINGS_FIELDS.find((field) => field.min !== undefined && !field.locked && !field.launchFlag);
  assert.equal(validateField(minimum, minimum.min - 1), `${errors.min} ${minimum.min}.`);
  assert.equal(validateField(minimum, minimum.min), '');
  const maximum = SETTINGS_FIELDS.find((field) => field.max !== undefined && !field.locked && !field.launchFlag);
  assert.equal(validateField(maximum, maximum.max + 1), `${errors.max} ${maximum.max}.`);
  assert.equal(validateField(maximum, maximum.max), '');
  const whole = SETTINGS_FIELDS.find((field) => field.type === 'int' && !field.locked && !field.launchFlag);
  assert.equal(validateField(whole, 'many'), errors.number);
  assert.equal(validateField(whole, Math.max(whole.min ?? 0, 1) + 0.5), errors.whole);
  const length = SETTINGS_FIELDS.find((field) => field.maxLength && !field.pattern && !field.locked);
  assert.equal(
    validateField(length, 'x'.repeat(length.maxLength + 1)),
    `${errors.lengthStart} ${length.maxLength} ${errors.lengthEnd}`,
  );
  assert.equal(validateField(length, 'x'.repeat(length.maxLength)), '');
  const pattern = SETTINGS_FIELDS.find((field) => field.pattern && !field.locked);
  assert.equal(validateField(pattern, '?\n?'), pattern.patternHelp || errors.invalid);
  // Every failure carries a message, so a field with no help text still shows why it was refused.
  for (const field of SETTINGS_FIELDS.filter((item) => item.min !== undefined && !item.locked && !item.launchFlag))
    assert.notEqual(validateField(field, field.min - 1), '', field.key);
});

test('format helpers render states, relative time, bytes and job summaries', () => {
  for (const state of ['stopped', 'starting', 'running', 'stopping', 'crashed'])
    assert.notEqual(stateName(state), 'Unknown');
  assert.equal(relativeTime(0, 120000), '2 minutes ago');
  assert.equal(byteSize(1024), '1.0 KB');
  assert.equal(byteSize(1024 * 1024), '1.0 MB');
  // The shape the job engine emits: kind, installId or serverId, state, a 0 to 1 progress.
  assert.equal(
    jobSummary({ kind: 'install.update', installId: 3, state: 'running', progress: 0.5 }),
    'Update the server files - Install 3',
  );
  assert.equal(jobSummary({ kind: 'future.kind', serverId: 2 }), 'future.kind - Server 2');
  assert.equal(jobState('succeeded'), 'Finished');
  assert.equal(jobState('interrupted'), 'Interrupted');
});

test('the cron picker rejects values out of range in both directions', () => {
  for (const cron of ['60 2 * * *', '0 25 * * *', '0 */0 * * *', '0 */24 * * *', '0 2 * * 8', '0 2 * * 1-5'])
    assert.equal(cronToPicker(cron), null, cron);
  assert.equal(cronToPicker('30 4 * * 7').weekday, 0);
  assert.equal(pickerToCron({ type: 'daily', hour: 24, minute: 0 }), null);
  assert.equal(pickerToCron({ type: 'daily', hour: 3, minute: Number.NaN }), null);
  assert.equal(pickerToCron({ type: 'hourly', minute: 0, hours: 0 }), null);
  assert.equal(pickerToCron({ type: 'weekly', hour: 3, minute: 0, weekday: 7 }), null);
  assert.equal(pickerToCron({ type: 'monthly', hour: 3, minute: 0 }), null);
  assert.equal(pickerToCron({ type: 'weekly', hour: 3, minute: 5, weekday: 6 }), '5 3 * * 6');
});

test('countdown text becomes descending whole minutes or null', () => {
  assert.deepEqual(parseCountdown('10, 5, 1'), [10, 5, 1]);
  assert.deepEqual(parseCountdown(' 60 ,30,'), [60, 30]);
  for (const text of ['', '5, 10', '5, 5', '61', '0', '1.5', 'ten', '6,5,4,3,2,1', '-1'])
    assert.equal(parseCountdown(text), null, text);
});

test('map names come from the built-in list until the catalog has loaded, then from the catalog', () => {
  try {
    assert.equal(mapName('TheIsland_WP'), 'The Island');
    assert.equal(mapName('Homebrew_WP'), 'Homebrew_WP');
    assert.ok(MAPS.length > 0);
    setCatalogMaps([
      { id: 'TheIsland_WP', name: 'Island Renamed' },
      { id: 'NewMap_WP', name: 'A New Map' },
    ]);
    assert.equal(mapName('TheIsland_WP'), 'Island Renamed');
    assert.equal(mapName('NewMap_WP'), 'A New Map');
    // Once loaded, the catalog is the whole list; the built-in one no longer fills gaps.
    assert.equal(mapName('Ragnarok_WP'), 'Ragnarok_WP');
    setCatalogMaps(undefined);
    assert.equal(mapName('Ragnarok_WP'), 'Ragnarok');
  } finally {
    setCatalogMaps(null);
  }
});

test('an official picture is requested only when the setting is on, and a mod picture always', () => {
  const official = { id: 'TheIsland_WP', kind: 'official' };
  const mod = { id: 'ModMap', kind: 'mod' };
  assert.equal(mapPictureUrl(official, 3, true), '/api/maps/TheIsland_WP/art');
  assert.equal(mapPictureUrl(official, 3, false), null);
  assert.equal(mapPictureUrl(mod, 3, false), '/api/servers/3/maps/ModMap/art');
  assert.equal(mapPictureUrl(mod, '3', true), '/api/servers/3/maps/ModMap/art');
  assert.equal(mapPictureUrl(mod, 'x', true), null);
  assert.equal(mapPictureUrl({ id: 'Unknown', kind: null }, 3, true), null);
  assert.equal(mapPictureUrl(undefined, 3, true), null);
});

test('searchFields matches every word across key, label, description and category', () => {
  const fields = [
    {
      key: 'BabyMatureSpeedMultiplier',
      label: 'Baby mature speed',
      description: 'How fast babies grow up',
      category: 'Breeding',
    },
    { key: 'XPMultiplier', label: 'XP multiplier', description: 'Experience gained', category: 'Rates' },
  ];
  assert.deepEqual(
    searchFields(fields, 'baby grow').map((f) => f.key),
    ['BabyMatureSpeedMultiplier'],
  );
  assert.deepEqual(
    searchFields(fields, 'breeding').map((f) => f.key),
    ['BabyMatureSpeedMultiplier'],
  );
  assert.deepEqual(searchFields(fields, 'baby experience'), []);
  assert.deepEqual(searchFields(fields, '   '), []);
  assert.deepEqual(
    rankedFields(fields, [{ key: 'XPMultiplier' }, { key: 'Unknown' }, { key: 'BabyMatureSpeedMultiplier' }]).map(
      (f) => f.key,
    ),
    ['XPMultiplier', 'BabyMatureSpeedMultiplier'],
  );
  assert.deepEqual(rankedFields(fields, null), []);
});

test('the server rail picks the map picture, and the generic one when there is none', () => {
  const maps = { showArt: true, maps: [{ id: 'TheIsland_WP', kind: 'official' }] };
  assert.equal(railPictureUrl({ id: 3, map: 'TheIsland_WP' }, maps), '/api/maps/TheIsland_WP/art');
  // A map missing from the catalog is tried as a mod map on that server.
  assert.equal(railPictureUrl({ id: 3, map: 'Winter_WP' }, maps), '/api/servers/3/maps/Winter_WP/art');
  assert.equal(railPictureUrl({ id: 3, map: 'TheIsland_WP' }, { ...maps, showArt: false }), GENERIC_MAP_ART);
  assert.equal(railPictureUrl({ id: 3, map: 'TheIsland_WP' }, undefined), GENERIC_MAP_ART);
  assert.equal(railPictureUrl({ id: 3, map: '' }, maps), GENERIC_MAP_ART);
  // A picture that failed once is not asked for again when the rail is drawn again.
  markArtFailed('/api/servers/3/maps/Winter_WP/art');
  assert.equal(railPictureUrl({ id: 3, map: 'Winter_WP' }, maps), GENERIC_MAP_ART);
});
