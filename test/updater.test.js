import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUpdateInfo } from '../src/updater.js';
import { isLocalPage, shortCommit, updateFinished } from '../public/js/lib/update.js';

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
  for (const host of ['192.168.2.10', 'ark.rpgm.tools', 'eru']) assert.equal(isLocalPage(host), false, host);
  assert.equal(shortCommit(COMMIT), '5bd26cf');
  assert.equal(shortCommit(null), null);
  const before = { startedAt };
  assert.equal(updateFinished(before, { startedAt }), false);
  assert.equal(updateFinished(before, null), false);
  assert.equal(updateFinished(before, { startedAt: '2026-09-28T20:05:00.000Z' }), true);
  assert.equal(updateFinished({ startedAt: null }, { startedAt }), false);
});
