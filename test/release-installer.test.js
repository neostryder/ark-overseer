import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const pwshResult = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
  windowsHide: true,
});
const skip = pwshResult.error ? 'pwsh is not on PATH' : false;

function run(script, args = []) {
  return spawnSync('pwsh', ['-NoProfile', '-File', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('installer dry run prints elevation, port, and service package steps', { skip }, () => {
  const result = run('tools/install.ps1', ['-DryRun', '-TestPortFree']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Request administrator approval once/);
  assert.match(result.stdout, /STEP: Check Windows version and 64-bit support/);
  assert.match(result.stdout, /STEP: Check port 3310/);
  assert.match(result.stdout, /install -Package -Start/);
  assert.match(result.stdout, /-DryRun/);
});

test('installer dry run selects the next free port and updates an existing service', { skip }, () => {
  const result = run('tools/install.ps1', ['-DryRun', '-TestPortBusy', '-TestAlreadyInstalled']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /next free port is 3311/);
  assert.match(result.stdout, /Update the existing service and keep its data and servers/);
  assert.match(result.stdout, /-Port 3311/);
  assert.match(result.stdout, /-Force/);
});

test('uninstaller dry run documents keep as the default data choice', { skip }, () => {
  const result = run('tools/uninstall.ps1', ['-DryRun']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /default keep/);
  assert.doesNotMatch(result.stdout, /Remove-Item.*\\data/);
});

test('package install rejects a missing release manifest and package archive combination', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-package-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safe = ['-Root', path.join(root, 'data-root'), '-ServiceName', `ReleaseTest${process.pid}`];
  const missing = run('tools/service.ps1', ['install', '-DryRun', '-Package', '-AppDir', root, ...safe]);
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /Package RELEASE\.json is missing/);
  const both = run('tools/service.ps1', [
    'install',
    '-DryRun',
    '-Package',
    '-Archive',
    'archive.zip',
    '-AppDir',
    root,
    ...safe,
  ]);
  assert.equal(both.status, 1, both.stdout + both.stderr);
  assert.match(both.stdout + both.stderr, /-Package and -Archive cannot be used together/);
});

test('package install rejects malformed release metadata', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-package-malformed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'RELEASE.json'), '{bad');
  const result = run('tools/service.ps1', [
    'install',
    '-DryRun',
    '-Package',
    '-AppDir',
    root,
    '-Root',
    path.join(root, 'data-root'),
    '-ServiceName',
    `ReleaseTest${process.pid}`,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Package RELEASE\.json is not valid JSON/);
});

test('package install rejects a Node hash that differs from RELEASE.json', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-package-node-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.linkSync(process.execPath, path.join(root, 'runtime', 'node.exe'));
  fs.writeFileSync(
    path.join(root, 'RELEASE.json'),
    JSON.stringify({
      version: '1.2.3',
      commit: '0123456789abcdef0123456789abcdef01234567',
      nodeSha256: '0'.repeat(64),
    }),
  );
  const result = run('tools/service.ps1', [
    'install',
    '-DryRun',
    '-Package',
    '-AppDir',
    root,
    '-Root',
    path.join(root, 'data-root'),
    '-ServiceName',
    `ReleaseTest${process.pid}`,
  ]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Package Node SHA-256 does not match RELEASE\.json/);
  assert.doesNotMatch(output, /STEP: Export commit/);
});

test('package install deploys RELEASE.json commit without git and keeps the packaged modules', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-package-dryrun-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.mkdirSync(path.join(root, 'vendor'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.linkSync(process.execPath, path.join(root, 'runtime', 'node.exe'));
  const service = fs.readFileSync('tools/service.ps1', 'utf8');
  const names = [...service.matchAll(/Join-Path \$AppDir 'vendor\\([^']+)'/g)].map((match) => match[1]);
  for (const name of names) fs.linkSync(path.join('vendor', name), path.join(root, 'vendor', name));
  const nodeSha256 = createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'runtime', 'node.exe')))
    .digest('hex');
  const commit = '0123456789abcdef0123456789abcdef01234567';
  fs.writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ version: '1.2.3', commit, nodeSha256 }));
  const appRoot = path.join(root, 'service-root');
  const result = run('tools/service.ps1', [
    'install',
    '-DryRun',
    '-Package',
    '-AppDir',
    root,
    '-Root',
    appRoot,
    '-ServiceName',
    `ReleaseTest${process.pid}`,
  ]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const steps = output.split(/\r?\n/).filter((line) => line.startsWith('STEP: '));
  assert.ok(steps.some((line) => line.startsWith('STEP: Copy the release app')));
  assert.ok(steps.some((line) => line.includes(`Record the package commit`) && line.includes(commit)));
  assert.ok(
    steps.some((line) => line.startsWith('STEP: Copy Node') && line.includes(path.join(root, 'runtime', 'node.exe'))),
  );
  assert.ok(!steps.some((line) => line.includes('git')));
  assert.ok(!steps.some((line) => line.startsWith('STEP: Copy node_modules')));
  const updater = steps.find((line) => line.startsWith('STEP: Record the update options'));
  assert.match(updater, /"package":true/);
});
