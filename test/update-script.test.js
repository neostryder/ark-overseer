import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
  windowsHide: true,
});
const skip = pwsh.error ? 'pwsh is not on PATH' : false;
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const checkout = path.join(root, 'repo');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'ark-overseer', version: '1.0.0' }));
  return { root, checkout };
}
const options = (root, checkout) =>
  fs.writeFileSync(
    path.join(root, 'data', 'updater.json'),
    JSON.stringify({ appDir: checkout, port: 3310, grantFolder: [], link: 'ark-overseer-update' }),
  );
const request = (root, value) =>
  fs.writeFileSync(path.join(root, 'data', 'update-request.json'), JSON.stringify(value));
const now = () => new Date().toISOString();
function run(root) {
  return spawnSync('pwsh', ['-NoProfile', '-File', 'tools/update.ps1', '-DryRun', '-Root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('update dry run accepts a local checkout and shows the exact install command', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, { source: 'checkout', checkout, requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^CHECK: source checkout$/m);
  assert.ok(output.includes(`CHECK: checkout ${checkout}`));
  assert.ok(output.includes(`install -Force -Start -AppDir "${checkout}"`));
  assert.ok(output.includes(`-Root "${root}"`));
  assert.ok(output.includes('-Port 3310'));
  assert.ok(!output.includes('-Archive'), output);
});

test('update dry run for GitHub shows the download URL and the archive command', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, { source: 'github', channel: 'stable', ref: 'v1.2.3', requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^CHECK: source github$/m);
  assert.match(output, /^CHECK: channel stable$/m);
  assert.match(output, /^CHECK: ref v1\.2\.3$/m);
  assert.ok(output.includes('URL: https://codeload.github.com/neostryder/ark-overseer/zip/v1.2.3'), output);
  assert.ok(output.includes('API: https://api.github.com/repos/neostryder/ark-overseer/git/ref/tags/v1.2.3'), output);
  assert.match(output, /^UPDATE: .* -Archive ".*archive\.zip" -Commit "<commit>"$/m, output);
});

test('update dry run for an Edge commit downloads that commit and records it', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, { source: 'github', channel: 'edge', ref: COMMIT, requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.ok(output.includes(`URL: https://codeload.github.com/neostryder/ark-overseer/zip/${COMMIT}`), output);
  assert.ok(output.includes(`-Commit "${COMMIT}"`), output);
  assert.ok(!output.includes('API:'), output);
});

test('update dry run refuses a bad source, a UNC checkout, a bad tag, a bad commit and a repository', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  const cases = [
    [{ source: 'ftp', requestedAt: now() }, /choose a checkout or GitHub/],
    [{ source: 'checkout', checkout: '\\\\server\\share', requestedAt: now() }, /network share/],
    [{ source: 'github', channel: 'stable', ref: 'v1.2', requestedAt: now() }, /release tag or a 40-character commit/],
    [
      { source: 'github', channel: 'stable', ref: 'abc123', requestedAt: now() },
      /release tag or a 40-character commit/,
    ],
    [{ source: 'checkout', checkout, repository: 'evil/evil', requestedAt: now() }, /may not choose the repository/],
  ];
  for (const [value, pattern] of cases) {
    request(root, value);
    const result = run(root);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /^FAIL: /m, JSON.stringify(value));
    assert.match(output, pattern, JSON.stringify(value));
  }
});

test('update dry run refuses a request older than fifteen minutes', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, {
    source: 'checkout',
    checkout,
    requestedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /^FAIL: The request is too old/m);
});

test('update dry run refuses a checkout that is not an ARK Overseer checkout', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else' }));
  request(root, { source: 'checkout', checkout: other, requestedAt: now() });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /^FAIL: That folder is not an ARK Overseer checkout/m);
});
