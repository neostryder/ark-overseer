import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAllWorlds } from '../src/supervisor/save-all.js';

const servers = [
  { id: 1, name: 'Alpha', rcon_port: 1 },
  { id: 2, name: 'Beta', rcon_port: 2 },
  { id: 3, name: 'Stopped', rcon_port: 3 },
];
const fixture = (running = [1, 2]) => ({
  db: { prepare: () => ({ all: () => servers }) },
  supervisor: { status: (id) => ({ observedState: running.includes(id) ? 'running' : 'stopped' }) },
});

test('SaveWorld starts for running servers together and logs an individual failure without passwords', async () => {
  const calls = [],
    logs = [];
  let resolveFirst, resolveSecond;
  const gates = [
    new Promise((resolve) => (resolveFirst = resolve)),
    new Promise((resolve) => (resolveSecond = resolve)),
  ];
  const task = saveAllWorlds({
    ...fixture(),
    rcon: ({ command, password, port }) => {
      calls.push({ command, password, port });
      if (port === 1) return gates[0];
      return gates[1];
    },
    getRconPassword: (server) => `secret-${server.id}`,
    log: (line) => logs.push(line),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => call.port),
    [1, 2],
  );
  assert.ok(calls.every((call) => call.command === 'SaveWorld'));
  resolveFirst();
  resolveSecond();
  await task;
  assert.deepEqual(logs, []);
});

test('a failed save is logged by server name and no password is logged', async () => {
  const logs = [];
  await saveAllWorlds({
    ...fixture(),
    rcon: ({ port }) => (port === 1 ? Promise.reject(new Error('no response secret-1')) : Promise.resolve()),
    getRconPassword: (server) => `secret-${server.id}`,
    log: (line) => logs.push(line),
  });
  assert.match(logs[0], /Alpha/);
  assert.doesNotMatch(logs.join('\n'), /secret-[12]/);
});

test('a non-answering server is abandoned at the shared timeout', async () => {
  const started = Date.now();
  await saveAllWorlds({
    ...fixture([1]),
    rcon: () => new Promise(() => {}),
    getRconPassword: () => 'hidden',
    timeoutMs: 25,
    log: () => {},
  });
  assert.ok(Date.now() - started < 500);
});

test('a server whose password cannot be read is logged and the rest still save', async () => {
  const logs = [],
    saved = [];
  await saveAllWorlds({
    ...fixture(),
    rcon: ({ port }) => {
      saved.push(port);
      return Promise.resolve();
    },
    getRconPassword: (server) => {
      if (server.id === 1) throw new Error('GameUserSettings.ini is missing');
      return 'pw';
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(saved, [2]);
  assert.match(logs[0], /Alpha: GameUserSettings.ini is missing/);
});
