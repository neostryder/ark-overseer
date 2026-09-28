import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessJson, parseAllProcessJson, createWindowsPlatform } from '../src/supervisor/platform.js';

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

test('all process parser handles one row, rows and empty output', () => {
  assert.deepEqual(parseAllProcessJson('{"ProcessId":1,"ParentProcessId":0,"Name":"a.exe"}'), [
    { pid: 1, parentPid: 0, name: 'a.exe' },
  ]);
  assert.equal(parseAllProcessJson('[{"ProcessId":1,"ParentProcessId":0,"Name":"a"}]').length, 1);
  assert.deepEqual(parseAllProcessJson(''), []);
});

test('policy validation rejects unsafe input before pwsh runs', async () => {
  let calls = 0;
  const platform = createWindowsPlatform({
    exec: async () => {
      calls++;
      return { stdout: '' };
    },
  });
  await assert.rejects(platform.setProcessPolicy('1', { priority: 'Normal', affinityMask: '3' }), /process id/i);
  await assert.rejects(platform.setProcessPolicy(1, { priority: 'High', affinityMask: '3' }), /priority/i);
  assert.equal(calls, 0);
});

test('a real affinity mask reaches pwsh, and a full 64-processor mask wraps to a signed value', async () => {
  const scripts = [];
  const platform = createWindowsPlatform({
    exec: async (file, args) => {
      scripts.push(args.at(-1));
      return { stdout: '' };
    },
  });
  await platform.setProcessPolicy(42, { priority: 'BelowNormal', affinityMask: '65280' });
  assert.match(scripts[0], /Get-Process -Id 42 /);
  assert.match(scripts[0], /PriorityClass = 'BelowNormal'/);
  assert.match(scripts[0], /\[IntPtr\]::new\(\[long\]65280\)/);
  await platform.setProcessPolicy(42, { priority: 'Normal', affinityMask: String((1n << 64n) - 1n) });
  assert.match(scripts[1], /\[long\]-1\)/);
  await assert.rejects(platform.setProcessPolicy(42, { priority: 'Normal', affinityMask: '3; Stop-Computer' }), /mask/);
  await assert.rejects(platform.setProcessPolicy(42, { priority: 'Normal', affinityMask: String(1n << 64n) }), /mask/);
  assert.equal(scripts.length, 2);
});

test('a failed policy change reports the process error, not the whole pwsh command', async () => {
  const platform = createWindowsPlatform({
    exec: async () => {
      const error = new Error('Command failed: pwsh -NoProfile -Command $p = Get-Process -Id 42 ...');
      error.stderr = 'SetValueInvocationException:\r\nException setting "PriorityClass": "Access is denied."\r\n';
      throw error;
    },
  });
  await assert.rejects(platform.setProcessPolicy(42, { priority: 'Normal', affinityMask: '3' }), (error) => {
    assert.equal(error.message, 'Exception setting "PriorityClass": "Access is denied."');
    return true;
  });
});
