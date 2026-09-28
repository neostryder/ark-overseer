import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createInstallHandlers } from '../src/steamcmd/handlers.js';

function setup(t) {
  const db = openDatabase(':memory:');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, ?)').run(stamp, stamp, 'host');
  db.prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, 1, ?)').run(
    stamp,
    stamp,
    'C:\\ARK',
  );
  t.after(() => db.close());
  const manifest = { buildId: '123', fullyInstalled: true };
  const calls = [];
  const steamcmd = {
    isInstalled: () => false,
    installSelf: async () => calls.push('self'),
    appUpdate: async (args) => {
      calls.push(args);
      args.progress(0.6, 'downloading');
      return { output: 'installed' };
    },
    readManifest: () => manifest,
  };
  return { db, calls, manifest, steamcmd, handlers: createInstallHandlers({ db, steamcmd }) };
}
const ctx = (installId = 1) => ({ job: { installId }, signal: new AbortController().signal, progress() {} });

test('each install handler updates state and build id', async (t) => {
  for (const [name, expected, validate] of [
    ['install.install', 'installing', false],
    ['install.update', 'updating', false],
    ['install.validate', 'validating', true],
  ]) {
    const f = setup(t);
    let during;
    const appUpdate = f.steamcmd.appUpdate;
    f.steamcmd.appUpdate = async (args) => {
      during = f.db.prepare('SELECT state FROM installs WHERE id = 1').get().state;
      return appUpdate(args);
    };
    const result = await f.handlers[name](ctx());
    assert.equal(during, expected);
    const row = f.db.prepare('SELECT * FROM installs').get();
    assert.equal(row.state, 'installed');
    assert.equal(row.build_id, '123');
    assert.equal(f.calls[0].validate, validate);
    assert.equal(result.buildId, '123');
  }
});

test('running server guard refuses work without changing install state', async (t) => {
  const f = setup(t);
  const s = new Date().toISOString();
  f.db
    .prepare(
      'INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port, observed_state) VALUES (?, ?, 1, 1, ?, ?, ?, 7777, ?)',
    )
    .run(s, s, 'srv', 'map', 'session', 'running');
  await assert.rejects(f.handlers['install.update'](ctx()), /Stop the servers/);
  assert.equal(f.db.prepare('SELECT state FROM installs').get().state, 'missing');
  assert.equal(f.calls.length, 0);
});
test('failed update restores installed state when manifest remains complete', async (t) => {
  const f = setup(t);
  f.steamcmd.appUpdate = async () => {
    throw new Error('failure');
  };
  await assert.rejects(f.handlers['install.update'](ctx()), /failure/);
  assert.equal(f.db.prepare('SELECT state FROM installs').get().state, 'installed');
});
test('failed install without manifest marks install broken', async (t) => {
  const f = setup(t);
  f.manifest.fullyInstalled = false;
  f.steamcmd.appUpdate = async () => {
    throw new Error('failure');
  };
  await assert.rejects(f.handlers['install.install'](ctx()), /failure/);
  assert.equal(f.db.prepare('SELECT state FROM installs').get().state, 'broken');
});
test('install handler requires a real install id', async (t) => {
  const f = setup(t);
  await assert.rejects(f.handlers['install.update'](ctx(null)), /installId/);
});
test('SteamCMD setup skips self installation when already installed', async (t) => {
  const f = setup(t);
  f.steamcmd.isInstalled = () => true;
  assert.deepEqual(await f.handlers['steamcmd.setup'](ctx()), { installed: true });
  assert.deepEqual(f.calls, []);
});

test('install handler progress is emitted through the job engine', async (t) => {
  const f = setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = createJobEngine({ db: f.db, handlers: f.handlers, progressWriteMs: 0 });
  const events = [];
  engine.subscribe((event) => events.push(event));
  const job = engine.enqueue('install.update', {}, { installId: 1 });
  engine.start();
  for (let i = 0; i < 100 && engine.get(job.id).state !== 'succeeded'; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(events.some((event) => event.type === 'progress' && event.job.message === 'downloading'));
  assert.equal(engine.get(job.id).state, 'succeeded');
  await engine.stop();
});

test('an unreadable manifest after a failed update leaves the install broken, not stuck', async (t) => {
  const f = setup(t);
  f.steamcmd.appUpdate = async () => {
    throw new Error('ERROR! Failed to install app 2430930 (Disk write failure)');
  };
  f.steamcmd.readManifest = () => {
    throw new SyntaxError('Unbalanced braces: a block is not closed');
  };
  await assert.rejects(f.handlers['install.update'](ctx()), /Disk write failure/);
  assert.equal(f.db.prepare('SELECT state FROM installs WHERE id = 1').get().state, 'broken');
});
