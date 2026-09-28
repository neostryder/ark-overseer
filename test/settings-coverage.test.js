import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SETTINGS_FIELDS, RAW_ONLY_OPTIONS } from '../src/settings/fields.js';
import { checkCoverage } from '../src/settings/coverage.js';

const REF = (key, extras = {}) => ({ key, file: 'gameusersettings', section: '[ServerSettings]', ...extras });
const FIELD = (key, extras = {}) => ({
  key,
  category: 'General',
  description: 'x',
  type: 'float',
  min: 0,
  max: 1,
  step: 0.1,
  default: 0.5,
  ...extras,
});

// Runs one small catalog and returns the problem messages, so each case names exactly what it expects.
function problemsFor({ reference = [], fields = [], rawOnly = [] }) {
  return checkCoverage({ reference, fields, rawOnly }).problems.map((p) => `${p.kind}: ${p.message}`);
}

test('the real catalog covers every option in the reference', () => {
  const reference = JSON.parse(fs.readFileSync(new URL('../reference/asa-options.json', import.meta.url), 'utf8'));
  const result = checkCoverage({ reference, fields: SETTINGS_FIELDS, rawOnly: RAW_ONLY_OPTIONS });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.unknownFields, []);
  assert.equal(result.ok, true);
  assert.equal(result.counts.reference, 346);
});

test('a clean catalog passes', () => {
  const result = checkCoverage({ reference: [REF('A')], fields: [FIELD('A')], rawOnly: [] });
  assert.equal(result.ok, true);
});

test('each catalog mistake is reported', () => {
  const cases = [
    [{ reference: [REF('A')], fields: [FIELD('A'), FIELD('a')] }, /^duplicate: a appears twice in SETTINGS_FIELDS/],
    [{ reference: [REF('A')], fields: [FIELD('A', { default: 2 })] }, /^range: A default 2 is outside/],
    [{ reference: [REF('A')], fields: [FIELD('A', { default: 0.55 })] }, /^step: A default 0.55 is off-step/],
    [
      { reference: [REF('A')], fields: [FIELD('A', { max: undefined })] },
      /^shape: A is numeric but is missing min or max/,
    ],
    [{ reference: [REF('A')], fields: [FIELD('A', { locked: true })] }, /^shape: A is locked but does not say why/],
    [
      { reference: [REF('A')], fields: [FIELD('A')], rawOnly: [{ key: 'A', reason: 'r' }] },
      /^duplicate: A is both a field and a raw-only entry/,
    ],
    [{ reference: [REF('A')], rawOnly: [{ key: 'A' }] }, /^shape: A is raw-only but gives no reason/],
    [
      { reference: [REF('A', { file: 'game' })], fields: [FIELD('A')] },
      /^routing: A is declared in gameusersettings but the reference puts it in game/,
    ],
    [
      { reference: [REF('A', { section: '[SessionSettings]' })], fields: [FIELD('A')] },
      /^routing: A is declared under \[serversettings\] but the reference puts it under \[SessionSettings\]/,
    ],
  ];
  for (const [catalog, pattern] of cases) {
    const problems = problemsFor(catalog);
    assert.equal(problems.length, 1, `${pattern}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], pattern);
  }
});

test('an option in no list is uncovered, and a field missing from the reference is unknown', () => {
  const result = checkCoverage({
    reference: [REF('A'), REF('Missing')],
    fields: [FIELD('A'), FIELD('Typo')],
    rawOnly: [],
  });
  assert.deepEqual(
    result.uncovered.map((o) => o.key),
    ['Missing'],
  );
  assert.deepEqual(result.unknownFields, ['typo']);
  assert.equal(result.ok, false);
});

test('launch-flag fields and SessionName are not reported', () => {
  const result = checkCoverage({
    reference: [REF('SessionName')],
    fields: [FIELD('MaxPlayers'), FIELD('DisableBattlEye')],
    rawOnly: [],
  });
  assert.equal(result.ok, true);
});
