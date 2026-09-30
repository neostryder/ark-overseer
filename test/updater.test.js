import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUpdateInfo, readCheckout, buildUpdateRequest, CHECKOUT_MESSAGES } from '../src/updater.js';
import {
  isLocalPage,
  shortCommit,
  updateFinished,
  updateCard,
  releaseLabel,
  newestRelease,
  earlierReleases,
  updateSources,
} from '../public/js/lib/update.js';

function tree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-updater-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = { root: path.join(base, 'app'), dataDir: path.join(base, 'data'), logsDir: path.join(base, 'logs') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  return dirs;
}
const COMMIT = '5bd26cf0123456789abcdef0123456789abcdef0';
const startedAt = '2026-09-28T20:00:00.000Z';

test('a deployed service with the update link offers the update and reports the last one', (t) => {
  const d = tree(t);
  fs.writeFileSync(path.join(d.root, '.deployed-commit'), `${COMMIT}\n`);
  // Windows PowerShell's Set-Content may leave a byte order mark; it is ignored.
  fs.writeFileSync(
    path.join(d.dataDir, 'updater.json'),
    '\uFEFF' + JSON.stringify({ appDir: 'C:\\Repositories\\ark-overseer', port: 3310, link: 'ark-overseer-update' }),
  );
  fs.writeFileSync(
    path.join(d.logsDir, 'update-result.json'),
    JSON.stringify({ ok: false, endedAt: '2026-09-28T19:00:00Z', commit: COMMIT, message: 'x'.repeat(900) }),
  );
  const info = readUpdateInfo({ ...d, startedAt, serviceMode: true });
  assert.equal(info.commit, COMMIT);
  assert.equal(info.startedAt, startedAt);
  assert.equal(info.available, true);
  assert.equal(info.link, 'ark-overseer-update');
  assert.equal(info.appDir, 'C:\\Repositories\\ark-overseer');
  assert.equal(info.logsDir, d.logsDir);
  assert.equal(info.lastUpdate.ok, false);
  assert.equal(info.lastUpdate.message.length, 500);
  assert.equal(info.package, false);
});

test('outside service mode, or with bad options, nothing is offered', (t) => {
  const d = tree(t);
  fs.writeFileSync(
    path.join(d.dataDir, 'updater.json'),
    JSON.stringify({ appDir: 'C:\\Repositories\\ark-overseer', link: 'ark-overseer-update' }),
  );
  const manual = readUpdateInfo({ ...d, startedAt, serviceMode: false });
  assert.equal(manual.available, false);
  assert.equal(manual.link, null);
  assert.equal(manual.commit, null);
  assert.equal(manual.lastUpdate, null);
  for (const options of [
    { appDir: 'relative\\path', link: 'ark-overseer-update' },
    { appDir: 'C:\\x', link: 'javascript' },
    { appDir: 'C:\\x', link: 'ark-overseer-update"; calc' },
    'not json',
  ]) {
    fs.writeFileSync(
      path.join(d.dataDir, 'updater.json'),
      typeof options === 'string' ? options : JSON.stringify(options),
    );
    assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).available, false, JSON.stringify(options));
  }
  // A deployed-commit file that isn't a commit id is ignored.
  fs.writeFileSync(path.join(d.root, '.deployed-commit'), 'HEAD');
  assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).commit, null);
});

test('the page helpers', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) assert.equal(isLocalPage(host), true, host);
  for (const host of ['192.168.2.10', 'ark.example.test', 'eru']) assert.equal(isLocalPage(host), false, host);
  assert.equal(shortCommit(COMMIT), '5bd26cf');
  assert.equal(shortCommit(null), null);
  const before = { startedAt };
  assert.equal(updateFinished(before, { startedAt }), false);
  assert.equal(updateFinished(before, null), false);
  assert.equal(updateFinished(before, { startedAt: '2026-09-28T20:05:00.000Z' }), true);
  assert.equal(updateFinished({ startedAt: null }, { startedAt }), false);
});

function checkout(t, { name = 'ark-overseer' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-checkout-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  fs.mkdirSync(path.join(base, '.git'));
  return base;
}

test('the checkout reader follows a loose ref without running git', (t) => {
  const base = checkout(t);
  fs.writeFileSync(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(base, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(base, '.git', 'refs', 'heads', 'main'), `${COMMIT}\n`);
  const result = readCheckout(base);
  assert.equal(result.ok, true);
  assert.equal(result.commit, COMMIT);
  assert.ok(!Number.isNaN(Date.parse(result.date)), result.date);
});

test('the checkout reader reads a packed ref when there is no loose one', (t) => {
  const base = checkout(t);
  fs.writeFileSync(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(base, '.git', 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${COMMIT} refs/heads/main\n`,
  );
  const result = readCheckout(base);
  assert.equal(result.ok, true);
  assert.equal(result.commit, COMMIT);
});

test('the checkout reader accepts a detached HEAD', (t) => {
  const base = checkout(t);
  fs.writeFileSync(path.join(base, '.git', 'HEAD'), `${COMMIT}\n`);
  assert.equal(readCheckout(base).commit, COMMIT);
});

test('the checkout reader reports a missing folder and a folder that is not a checkout', (t) => {
  const missing = readCheckout(path.join(os.tmpdir(), `ao-missing-${process.pid}-${Date.now()}`));
  assert.equal(missing.ok, false);
  assert.ok(missing.message);
  const other = checkout(t, { name: 'not-overseer' });
  fs.writeFileSync(path.join(other, '.git', 'HEAD'), `${COMMIT}\n`);
  const result = readCheckout(other);
  assert.equal(result.ok, false);
  assert.match(result.message, /ARK Overseer checkout/);
  // A checkout whose ref cannot be resolved is unreadable rather than wrong.
  const broken = checkout(t);
  fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(readCheckout(broken).ok, false);
});

test('the update request keeps the strict shape and refuses what it may not choose', () => {
  const at = '2026-09-29T12:00:00.000Z';
  assert.deepEqual(buildUpdateRequest({ source: 'checkout', checkout: 'C:\\Repositories\\ark-overseer' }, at), {
    source: 'checkout',
    requestedAt: at,
    checkout: 'C:\\Repositories\\ark-overseer',
  });
  assert.deepEqual(buildUpdateRequest({ source: 'github', channel: 'beta', ref: 'v1.2.3-beta.1' }, at), {
    source: 'github',
    requestedAt: at,
    channel: 'beta',
    ref: 'v1.2.3-beta.1',
  });
  assert.deepEqual(
    buildUpdateRequest({ source: 'github', channel: 'edge', ref: 'a'.repeat(40) }, at).ref,
    'a'.repeat(40),
  );
  for (const bad of [
    {},
    { source: 'ftp' },
    { source: 'checkout', checkout: 'relative\\path' },
    { source: 'checkout', checkout: '\\\\server\\share' },
    { source: 'github', channel: 'nightly' },
    { source: 'github', ref: 'v1.2' },
    { source: 'github', ref: 'abc123' },
  ])
    assert.throws(() => buildUpdateRequest(bad, at), /choose|full folder|Stable|install/i, JSON.stringify(bad));
});

test('the updates card shows the right thing for each source and channel', () => {
  const release = (tag, body) => ({
    kind: 'release',
    tag,
    version: tag.slice(1),
    commit: null,
    body,
    publishedAt: '2026-01-01T00:00:00Z',
  });
  const stable = {
    ok: true,
    channel: 'stable',
    newest: release('v1.2.0', 'Release notes'),
    history: [release('v1.1.0', 'Older')],
  };
  const view = updateCard({ source: 'github', channel: 'stable', check: stable });
  assert.equal(view.newest.label, 'v1.2.0');
  assert.equal(view.newest.notes, 'Release notes');
  assert.equal(view.newest.size, null);
  assert.deepEqual(
    view.history.map((item) => item.label),
    ['v1.1.0'],
  );
  assert.equal(newestRelease(stable).tag, 'v1.2.0');
  assert.equal(releaseLabel(release('v1.1.0')), 'v1.1.0');
  assert.equal(earlierReleases(stable).length, 1);

  const edge = updateCard({
    source: 'github',
    channel: 'edge',
    check: {
      ok: true,
      channel: 'edge',
      newest: {
        kind: 'edge',
        tag: 'edge',
        version: '1.4.2-edge.abcdef0',
        commit: 'abcdef0',
        body: 'Latest',
        asset: { size: 2048 },
      },
      history: [],
    },
  });
  assert.equal(edge.newest.label, '1.4.2-edge.abcdef0');
  assert.equal(edge.newest.size, 2048);
  assert.deepEqual(edge.history, []);

  const fromCheckout = updateCard({
    source: 'checkout',
    checkout: { ok: true, commit: COMMIT, date: '2026-01-01T00:00:00Z' },
  });
  assert.equal(fromCheckout.newest.label, '5bd26cf');
  assert.equal(fromCheckout.newest.notes, null);
  assert.deepEqual(fromCheckout.history, []);

  const failed = updateCard({ source: 'github', channel: 'stable', check: { ok: false, message: 'GitHub is busy.' } });
  assert.equal(failed.message, 'GitHub is busy.');
  assert.equal(failed.newest, null);
  const badCheckout = updateCard({ source: 'checkout', checkout: { ok: false, message: 'No checkout.' } });
  assert.equal(badCheckout.message, 'No checkout.');
});

test('readUpdateInfo reports the package version and the last update source', (t) => {
  const d = tree(t);
  fs.writeFileSync(path.join(d.root, 'package.json'), JSON.stringify({ name: 'ark-overseer', version: '1.4.2' }));
  fs.writeFileSync(
    path.join(d.dataDir, 'updater.json'),
    JSON.stringify({ appDir: 'C:\\x', link: 'ark-overseer-update' }),
  );
  fs.writeFileSync(
    path.join(d.logsDir, 'update-result.json'),
    JSON.stringify({
      ok: true,
      endedAt: '2026-09-28T19:00:00Z',
      source: 'github',
      channel: 'beta',
      ref: 'v1.4.2-beta.1',
      asset: 'ark-overseer-1.4.2-beta.1-win-x64.zip',
      sha256: 'a'.repeat(64),
    }),
  );
  const info = readUpdateInfo({ ...d, startedAt, serviceMode: true });
  assert.equal(info.version, '1.4.2');
  assert.equal(info.lastUpdate.source, 'github');
  assert.equal(info.lastUpdate.channel, 'beta');
  assert.equal(info.lastUpdate.ref, 'v1.4.2-beta.1');
  assert.equal(info.lastUpdate.asset, 'ark-overseer-1.4.2-beta.1-win-x64.zip');
  assert.equal(info.lastUpdate.sha256, 'a'.repeat(64));
  assert.deepEqual(updateSources({ package: true }), ['github']);
  assert.deepEqual(updateSources({}), ['checkout', 'github']);
  fs.writeFileSync(
    path.join(d.dataDir, 'updater.json'),
    JSON.stringify({ appDir: 'C:\\x', link: 'ark-overseer-update', package: true }),
  );
  assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).package, true);
});

test('readUpdateInfo returns recent progress and ignores stale or malformed progress', (t) => {
  const d = tree(t);
  fs.writeFileSync(
    path.join(d.dataDir, 'updater.json'),
    JSON.stringify({ appDir: 'C:\\x', link: 'ark-overseer-update' }),
  );
  const progressPath = path.join(d.logsDir, 'update-progress.json');
  const progress = {
    startedAt,
    at: new Date().toISOString(),
    stage: 'installing',
    message: 'Copying the new version',
    step: 'Copy node',
    source: 'github',
  };
  fs.writeFileSync(progressPath, JSON.stringify(progress));
  assert.deepEqual(readUpdateInfo({ ...d, startedAt, serviceMode: true }).progress, progress);
  fs.writeFileSync(progressPath, JSON.stringify({ ...progress, at: '2020-01-01T00:00:00Z' }));
  assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).progress, null);
  fs.writeFileSync(progressPath, JSON.stringify({ ...progress, at: '2020-01-01T00:00:00Z', stage: 'failed' }));
  assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).progress.stage, 'failed');
  fs.writeFileSync(progressPath, '{');
  assert.equal(readUpdateInfo({ ...d, startedAt, serviceMode: true }).progress, null);
});

test('a checkout the service account may not open is reported as no access, not as a wrong folder', () => {
  const denied = (code) => () => {
    throw Object.assign(new Error('denied'), { code });
  };
  for (const code of ['EACCES', 'EPERM']) {
    const result = readCheckout('C:\Repositories\ark-overseer', { access: denied(code) });
    assert.deepEqual(result, { ok: false, noAccess: true, message: CHECKOUT_MESSAGES.noAccess });
  }
});

test('a folder that does not exist is still reported as not a checkout', () => {
  const missing = path.join(os.tmpdir(), `ao-noaccess-${process.pid}-${Date.now()}`);
  const result = readCheckout(missing, {
    access: () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.noAccess, undefined);
  assert.equal(result.message, CHECKOUT_MESSAGES.notCheckout);
});
