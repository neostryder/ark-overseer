import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessJson } from '../src/supervisor/platform.js';

test('process JSON parser maps a single process object', () => {
  assert.deepEqual(
    parseProcessJson(
      '{"ProcessId":3,"ExecutablePath":"C:\\\\x.exe","CommandLine":"-port=7","CreationDate":"/Date(1727000000000)/"}',
    ),
    [{ pid: 3, exePath: 'C:\\x.exe', commandLine: '-port=7', startedAt: '2024-09-22T10:13:20.000Z' }],
  );
});

test('process JSON parser maps arrays', () => {
  assert.equal(parseProcessJson('[{"ProcessId":1},{"ProcessId":2}]').length, 2);
});

test('process JSON parser rejects invalid JSON', () => {
  assert.throws(() => parseProcessJson('nope'), /parse/);
});
