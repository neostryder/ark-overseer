import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkConfig, createCrashHook, fillArgs, firstLine, MAX_DETAIL_LENGTH } from '../src/push/crash-hook.js';

const SERVER = {
  id: 4,
  name: 'Neo "Olympus" & Co',
  log_path: 'C:\\ARK\\Logs\\ShooterGame.log',
  install_path: 'C:\\ARK',
};

async function setup(config, exec) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-hook-'));
  if (config !== undefined)
    await fs.writeFile(
      path.join(dataDir, 'crash-hook.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
    );
  const logged = [];
  const calls = [];
  const run = exec ?? (async (...args) => (calls.push(args), 'Mod conflict: a mod failed to load.\nsecond line'));
  const hook = createCrashHook({ dataDir, exec: run, log: (line) => logged.push(line) });
  return { hook, logged, calls, dataDir };
}

test('the hook is off when there is no config file', async () => {
  const { hook, calls, logged } = await setup(undefined);
  assert.equal(await hook.run(SERVER, 'exit'), null);
  assert.deepEqual([calls, logged], [[], []]);
});

test('the command gets each token as its own argument and no shell', async () => {
  const { hook, calls } = await setup({
    command: 'C:\\Python\\python.exe',
    args: ['triage.py', '--name={serverName}', '{logPath}', '{reason}', '{serverId}', '{installPath}', '{unknown}'],
    timeoutSeconds: 20,
  });
  assert.equal(await hook.run(SERVER, 'crash loop'), 'Mod conflict: a mod failed to load.');
  assert.deepEqual(calls, [
    [
      'C:\\Python\\python.exe',
      ['triage.py', '--name=Neo "Olympus" & Co', SERVER.log_path, 'crash loop', '4', 'C:\\ARK', '{unknown}'],
      20000,
    ],
  ]);
});

test('the config is read again on every run', async () => {
  const { hook, calls, dataDir } = await setup({ command: '/usr/bin/one' });
  await hook.run(SERVER, 'exit');
  await fs.writeFile(path.join(dataDir, 'crash-hook.json'), JSON.stringify({ command: '/usr/bin/two' }));
  await hook.run(SERVER, 'exit');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['/usr/bin/one', '/usr/bin/two'],
  );
});

test('a broken file, a failing command, and a timeout are logged and give no detail', async () => {
  const broken = await setup('{ not json');
  assert.equal(await broken.hook.run(SERVER, 'exit'), null);
  const relative = await setup({ command: 'python' });
  assert.equal(await relative.hook.run(SERVER, 'exit'), null);
  const failing = await setup({ command: '/usr/bin/x' }, async () => {
    throw Object.assign(new Error('Command failed'), { code: 2 });
  });
  assert.equal(await failing.hook.run(SERVER, 'exit'), null);
  const timeout = await setup({ command: '/usr/bin/x' }, async () => {
    throw Object.assign(new Error('timed out'), { killed: true });
  });
  assert.equal(await timeout.hook.run(SERVER, 'exit'), null);
  for (const { logged } of [broken, relative, failing, timeout]) assert.equal(logged.length, 1);
  assert.match(relative.logged[0], /full path/);
});

test('the config is checked', () => {
  assert.deepEqual(checkConfig({ command: 'C:\\x\\a.exe' }), { command: 'C:\\x\\a.exe', args: [], timeoutSeconds: 45 });
  assert.throws(() => checkConfig([]), /one object/);
  assert.throws(() => checkConfig({ command: 'C:\\x\\run.cmd' }), /\.bat or \.cmd/);
  assert.throws(() => checkConfig({ command: 'C:\\x\\a.exe', args: [1] }), /list of strings/);
  assert.throws(() => checkConfig({ command: 'C:\\x\\a.exe', timeoutSeconds: 0 }), /from 1 to/);
  assert.throws(() => checkConfig({ command: 'C:\\x\\a.exe', timeoutSeconds: 500 }), /from 1 to/);
});

test('the detail is one clean, short line', () => {
  assert.equal(firstLine('\n  \nHello \u0007 world\t again \nnext'), 'Hello world again');
  assert.equal(firstLine('   \n'), null);
  assert.equal(firstLine('x'.repeat(500)).length, MAX_DETAIL_LENGTH);
  assert.ok(firstLine('x'.repeat(500)).endsWith('...'));
  assert.deepEqual(fillArgs(['{a}', 'b{serverId}'], { serverId: 7 }), ['{a}', 'b7']);
});
