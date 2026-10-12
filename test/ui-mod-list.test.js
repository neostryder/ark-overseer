import assert from 'node:assert/strict';
import test from 'node:test';
import { addMod, moveMod, removeMod, MOD_ID } from '../public/js/lib/mod-list.js';
import { checkModList, MESSAGES } from '../src/supervisor/launch.js';

test('the page and the server accept the same mod ids', () => {
  for (const id of ['1740719', '1740719-dev', '0012']) assert.ok(MOD_ID.test(id), id);
  for (const id of ['', 'abc', '12-DEV', '12-dev2', '-dev', '12 ']) assert.ok(!MOD_ID.test(id), id);
});

test('adding keeps the order and refuses a mod that is already listed, test build or not', () => {
  assert.deepEqual(addMod(['5', '6'], '7-dev'), ['5', '6', '7-dev']);
  assert.equal(addMod(['5', '6'], '5-dev'), null);
  assert.equal(addMod(['5-dev'], '5'), null);
});

test('moving and removing change only the one id and stop at the ends', () => {
  assert.deepEqual(moveMod(['1', '2', '3'], 2, -1), ['1', '3', '2']);
  assert.deepEqual(moveMod(['1', '2', '3'], 0, -1), ['1', '2', '3']);
  assert.deepEqual(moveMod(['1', '2', '3'], 2, 1), ['1', '2', '3']);
  assert.deepEqual(removeMod(['1', '2', '3'], 1), ['1', '3']);
});

test('the server turns a request into ids as strings and names what is wrong with a bad list', () => {
  assert.deepEqual(checkModList([1740719, ' 55 ', '9-dev']), ['1740719', '55', '9-dev']);
  assert.throws(() => checkModList('5'), { message: MESSAGES.modsNotList });
  assert.throws(() => checkModList(['x']), { message: MESSAGES.badModId });
  assert.throws(() => checkModList([1.5]), { message: MESSAGES.badModId });
  assert.throws(() => checkModList(['3', '03-dev']), { message: MESSAGES.dupMod });
});
