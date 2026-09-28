import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyValues, findAppInfo } from '../src/steamcmd/keyvalues.js';

const manifest = `"AppState" { "appid" "2430930" "StateFlags" "4" "depots" { "branches" { "public" { "buildid" "25535041" } } } }`;

test('manifest KeyValues parse into nested objects', () => {
  assert.equal(parseKeyValues(manifest).AppState.depots.branches.public.buildid, '25535041');
});

test('KeyValues handles escapes and comments', () => {
  assert.deepEqual(parseKeyValues('// comment\n"a" "say \\"hi\\" \\\\ ok"'), { a: 'say "hi" \\ ok' });
});

test('KeyValues rejects unbalanced braces and unterminated strings', () => {
  assert.throws(() => parseKeyValues('"a" {'), SyntaxError);
  assert.throws(() => parseKeyValues('"a" "unfinished'), SyntaxError);
});

test('findAppInfo skips status lines before the app block', () => {
  assert.equal(
    findAppInfo(
      'Logging in\nUpdate complete\n"2430930"\n{ "depots" { "branches" { "public" { "buildid" "42" } } } }',
      '2430930',
    )['2430930'].depots.branches.public.buildid,
    '42',
  );
});
