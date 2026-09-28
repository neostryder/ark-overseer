import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELDS } from '../src/settings/fields.js';
import { validateSettings } from '../src/settings/validate.js';

const field = (key) => SETTINGS_FIELDS.find((f) => f.key === key);
const photoRange = field('PhotoModeRangeLimit');

function assertRejected(body, pattern) {
  const errors = validateSettings(body);
  assert.equal(errors.length, 1, `expected one error for ${JSON.stringify(body)}, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], pattern);
}

test('a valid body returns no errors', () => {
  assert.deepEqual(
    validateSettings({
      sessionName: 'Neo Olympus',
      ServerPVE: true,
      MaxPlayers: 20,
      ServerPassword: 'friends',
      TamingSpeedMultiplier: '2.5',
    }),
    [],
  );
});

test('session name rules', () => {
  assertRejected({ sessionName: 'Neo?Olympus' }, /cannot contain "\?"/);
  assertRejected({ sessionName: 'x'.repeat(61) }, /60 characters or fewer/);
  assertRejected({ sessionName: 'Neo\r\nOlympus' }, /line break/);
  assertRejected({ sessionName: 42 }, /must be text/);
});

test('numeric fields take a finite number or a plain decimal string within range', () => {
  assertRejected({ PhotoModeRangeLimit: photoRange.min - 1 }, /at least/);
  assertRejected({ MaxPlayers: 101 }, /at most 100/);
  // Each of these used to pass Number(): '' and ' ' as 0, the others as a number the game may not
  // parse the same way.
  for (const bad of ['wat', '', ' ', '0x10', '1e3', 'Infinity', NaN, Infinity, true, {}]) {
    assertRejected({ TamingSpeedMultiplier: bad }, /must be a number/);
  }
  assertRejected({ MaxPlayers: 20.5 }, /whole number/);
});

test('string fields must be single-line text within their pattern and length', () => {
  assertRejected({ ServerPassword: 'a?b' }, /Join Password/);
  assertRejected({ ServerPassword: 'x'.repeat(65) }, /64 characters or fewer/);
  assertRejected({ Message: 'hello\r\nServerAdminPassword=taken' }, /line break/);
  assertRejected({ Message: 12 }, /must be text/);
});

test('bool fields must be booleans', () => {
  assertRejected({ ServerPVE: 'false' }, /on or off/);
  assertRejected({ ServerPVE: 1 }, /on or off/);
});

test('a locked field is refused with its reason, even when set to null', () => {
  const reason = field('RCONPort').lockedReason;
  for (const value of [27021, null]) {
    const errors = validateSettings({ RCONPort: value });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(reason));
  }
});

test('null on an unlocked field means remove the key and passes', () => {
  assert.deepEqual(validateSettings({ TamingSpeedMultiplier: null, ServerPVE: null, ServerPassword: null }), []);
});

test('a body that is not an object is refused', () => {
  for (const body of [null, undefined, 'x', 3, []]) {
    assert.deepEqual(validateSettings(body), ['Settings must be sent as an object.']);
  }
});
