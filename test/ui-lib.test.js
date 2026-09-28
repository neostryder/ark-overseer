import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import { parseRoute, buildRoute } from '../public/js/lib/route.js';
import {
  groupFields,
  filterFields,
  controlValue,
  pendingChanges,
  buildPutBody,
  validateField,
} from '../public/js/lib/settings.js';
import { stateName, relativeTime, byteSize, jobSummary, jobState } from '../public/js/lib/format.js';
import { STRINGS } from '../public/js/strings.js';

test('route parsing and building covers supported routes', () => {
  for (const route of [
    { screen: 'overview', id: 3 },
    { screen: 'settings', id: 4 },
    { screen: 'network', id: 5 },
    { screen: 'jobs' },
    { screen: 'account' },
    { screen: 'setup' },
    { screen: 'home' },
  ]) {
    const hash = buildRoute(route);
    assert.deepEqual(parseRoute(hash), route.screen === 'home' ? { screen: 'home' } : route);
  }
  assert.deepEqual(parseRoute('#/not-a-route'), { screen: 'unknown' });
  assert.deepEqual(parseRoute('#/servers/nope/settings'), { screen: 'unknown' });
  assert.equal(buildRoute({ screen: 'overview', id: 'x' }), '#/');
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
