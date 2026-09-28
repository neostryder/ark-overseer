import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseNetstat, listListeners } from '../src/network/listeners.js';

test('parseNetstat reads UDP and TCP endpoints including scoped IPv6', () => {
  const rows = parseNetstat(`  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:53             *:*                                    4004
  UDP    [::]:3389              *:*                                    11292
  UDP    [fe80::1c2d:3e4f:5a6b:7c8d%12]:1900  *:*                      4412
  TCP    0.0.0.0:22              0.0.0.0:0              LISTENING       6424
  TCP    [::]:445                [::]:0                 LISTENING       4
  TCP    192.0.2.10:8200         198.51.100.7:59168     ESTABLISHED     33652`);
  assert.deepEqual(
    rows.map(({ protocol, address, port, state, pid }) => ({ protocol, address, port, state, pid })),
    [
      { protocol: 'udp', address: '0.0.0.0', port: 53, state: null, pid: 4004 },
      { protocol: 'udp', address: '[::]', port: 3389, state: null, pid: 11292 },
      { protocol: 'udp', address: '[fe80::1c2d:3e4f:5a6b:7c8d%12]', port: 1900, state: null, pid: 4412 },
      { protocol: 'tcp', address: '0.0.0.0', port: 22, state: 'LISTENING', pid: 6424 },
      { protocol: 'tcp', address: '[::]', port: 445, state: 'LISTENING', pid: 4 },
      { protocol: 'tcp', address: '192.0.2.10', port: 8200, state: 'ESTABLISHED', pid: 33652 },
    ],
  );
});
test('parseNetstat skips headers and blank lines', () =>
  assert.deepEqual(parseNetstat('Active Connections\n\nProto Local Address'), []));
test('listListeners rejects a nonzero netstat exit', async () => {
  await assert.rejects(listListeners({ runner: async () => ({ code: 1 }) }), /netstat exited with code 1/);
});

test('parseNetstat recognises a listening TCP socket in any display language', () => {
  const rows = parseNetstat(`  TCP    0.0.0.0:27020          0.0.0.0:0              ABH\u00d6REN         6424
  TCP    192.0.2.10:8200        198.51.100.7:59168     HERGESTELLT     33652`);
  assert.deepEqual(
    rows.map((r) => [r.port, r.state]),
    [
      [27020, 'LISTENING'],
      [8200, 'HERGESTELLT'],
    ],
  );
});

test('listListeners runs netstat -ano and parses what it prints', async () => {
  const calls = [];
  const rows = await listListeners({
    runner: async (command, args, { onLine }) => {
      calls.push([command, args]);
      onLine('  UDP    0.0.0.0:7777           *:*                                    4004');
      return { code: 0 };
    },
  });
  const root = process.env.SystemRoot || 'C:\\Windows';
  assert.deepEqual(calls, [[path.win32.join(root, 'System32', 'netstat.exe'), ['-ano']]]);
  assert.deepEqual(rows, [{ protocol: 'udp', address: '0.0.0.0', port: 7777, state: null, pid: 4004 }]);
});
