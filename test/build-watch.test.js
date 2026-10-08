import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { checkWebhook, createBuildWatch, MESSAGES } from '../src/builds/watch.js';
import { listInstallBuilds, recordInstallBuild } from '../src/builds/history.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF_-0123456789';
const T = '2026-01-01T00:00:00.000Z';

function setup(t, { installed = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let branches = {
    public: { buildId: '100', timeUpdated: '2026-10-07T01:00:00.000Z', manifestId: 'm100' },
    public_test_realm: { buildId: '200', timeUpdated: '2026-10-07T22:00:00.000Z', manifestId: 'm200' },
  };
  const posts = [];
  const logs = [];
  const watch = createBuildWatch({
    db,
    steamcmd: { isInstalled: () => installed, branchInfo: async () => branches },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    },
    log: (line) => logs.push(line),
    now: () => Date.parse('2026-10-08T00:00:00.000Z'),
  });
  return { db, watch, posts, logs, set: (next) => (branches = next), get: () => branches };
}

test('the first look records every branch and reports no change', async (t) => {
  const { watch, db } = setup(t);
  const result = await watch.check();
  assert.deepEqual(result, { checked: true, changes: [] });
  const rows = watch.list();
  assert.deepEqual(
    rows.map((row) => [row.branch, row.build_id, row.manifest_id, row.previous_build_id]),
    [
      ['public', '100', 'm100', null],
      ['public_test_realm', '200', 'm200', null],
    ],
  );
  // The change time is when Steam built it, not when this looked.
  assert.equal(rows[1].changed_at, '2026-10-07T22:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM steam_builds').get().n, 2);
});

test('a new build id on a branch is a change, remembered with the one it replaced', async (t) => {
  const { watch, set, get } = setup(t);
  await watch.check();
  set({ ...get(), public_test_realm: { buildId: '201', timeUpdated: '2026-10-08T05:00:00.000Z', manifestId: 'm201' } });
  const result = await watch.check();
  assert.deepEqual(result.changes, [{ branch: 'public_test_realm', buildId: '201', previousBuildId: '200' }]);
  const row = watch.list().find((entry) => entry.branch === 'public_test_realm');
  assert.equal(row.build_id, '201');
  assert.equal(row.previous_build_id, '200');
  assert.equal(row.manifest_id, 'm201');
  // A third look with nothing new reports nothing and keeps the history.
  assert.deepEqual((await watch.check()).changes, []);
  assert.equal(watch.list().find((entry) => entry.branch === 'public_test_realm').previous_build_id, '200');
});

test('a branch that appears later is recorded without being announced as a change', async (t) => {
  const { watch, set, get } = setup(t);
  await watch.check();
  set({ ...get(), beta: { buildId: '300', timeUpdated: null, manifestId: null } });
  assert.deepEqual((await watch.check()).changes, []);
  assert.equal(
    watch.list().some((row) => row.branch === 'beta'),
    true,
  );
});

test('a configured webhook receives one silent post per check that found changes', async (t) => {
  const { watch, posts, set, get } = setup(t);
  watch.setWebhook(HOOK);
  assert.deepEqual(watch.webhook(), { configured: true });
  await watch.check();
  assert.equal(posts.length, 0);
  set({
    public: { buildId: '101', timeUpdated: null, manifestId: 'm101' },
    public_test_realm: { buildId: '201', timeUpdated: null, manifestId: 'm201' },
  });
  await watch.check();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, HOOK);
  assert.equal(posts[0].body.flags, 4096);
  assert.match(posts[0].body.content, /build 101 on the live game \(was 100\)/);
  assert.match(posts[0].body.content, /build 201 on the Public Test Realm \(was 200\)/);
  assert.equal(get().public.buildId, '101');
});

test('a failed webhook post is logged and does not fail the check', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const logs = [];
  let id = 1;
  const watch = createBuildWatch({
    db,
    steamcmd: {
      isInstalled: () => true,
      branchInfo: async () => ({ public: { buildId: String(id++), timeUpdated: null, manifestId: null } }),
    },
    fetch: async () => ({ ok: false, status: 404 }),
    log: (line) => logs.push(line),
  });
  watch.setWebhook(HOOK);
  await watch.check();
  const result = await watch.check();
  assert.equal(result.changes.length, 1);
  assert.match(logs[0], /did not reach Discord: HTTP 404/);
});

test('only a Discord webhook address is accepted, and an empty value clears it', (t) => {
  const { watch } = setup(t);
  assert.throws(() => checkWebhook('https://example.com/api/webhooks/1/2'), { message: MESSAGES.badWebhook });
  assert.throws(() => checkWebhook('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), {
    status: 400,
  });
  assert.throws(() => checkWebhook(5));
  assert.equal(checkWebhook(''), null);
  assert.equal(watch.setWebhook(HOOK), true);
  assert.equal(watch.setWebhook(''), false);
  assert.deepEqual(watch.webhook(), { configured: false });
});

test('without SteamCMD nothing is checked and the reason says so', async (t) => {
  const { watch } = setup(t, { installed: false });
  const result = await watch.check();
  assert.equal(result.checked, false);
  assert.equal(result.reason, MESSAGES.notInstalled);
});

test('a check is skipped while a job is using SteamCMD', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let busy = true;
  let calls = 0;
  const watch = createBuildWatch({
    db,
    isBusy: () => busy,
    steamcmd: {
      isInstalled: () => true,
      branchInfo: async () => {
        calls += 1;
        return {};
      },
    },
  });
  assert.equal((await watch.check()).reason, MESSAGES.busy);
  assert.equal(calls, 0);
  busy = false;
  assert.equal((await watch.check()).checked, true);
});

test('two overlapping checks share one run of SteamCMD', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const watch = createBuildWatch({
    db,
    steamcmd: {
      isInstalled: () => true,
      branchInfo: async () => {
        calls += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { public: { buildId: '1', timeUpdated: null, manifestId: null } };
      },
    },
  });
  await Promise.all([watch.check(), watch.check()]);
  assert.equal(calls, 1);
});

test('the timer checks after start-up, then every interval, and stops when told', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const timers = [];
  let calls = 0;
  const watch = createBuildWatch({
    db,
    intervalMs: 900000,
    steamcmd: {
      isInstalled: () => true,
      branchInfo: async () => {
        calls += 1;
        return {};
      },
    },
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false, unref() {} };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      entry.cleared = true;
    },
  });
  watch.start();
  assert.equal(timers[0].ms, 30000);
  await timers[0].fn();
  assert.equal(calls, 1);
  assert.equal(timers[1].ms, 900000);
  watch.stop();
  assert.equal(timers[1].cleared, true);
  await timers[1].fn();
  assert.equal(timers.length, 2);
});

test('an install build records the manifest only when Steam still offers that build', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (1, 1, 'C:\\ASA', 'installed', ?, ?)",
  ).run(T, T);
  db.prepare(
    "INSERT INTO steam_builds (branch, build_id, manifest_id, first_seen_at, changed_at, checked_at) VALUES ('public', '100', 'm100', ?, ?, ?)",
  ).run(T, T, T);
  recordInstallBuild(db, 1, { branch: 'public', buildId: 100, reason: 'update', now: () => 1 });
  recordInstallBuild(db, 1, { branch: 'public', buildId: '99', reason: 'update', now: () => 2 });
  recordInstallBuild(db, 1, { branch: 'public_test_realm', buildId: null, reason: 'branch_switch', now: () => 3 });
  const rows = listInstallBuilds(db, 1);
  assert.deepEqual(
    rows.map((row) => [row.branch, row.build_id, row.manifest_id, row.reason]),
    [
      ['public_test_realm', null, null, 'branch_switch'],
      ['public', '99', null, 'update'],
      ['public', '100', 'm100', 'update'],
    ],
  );
});
