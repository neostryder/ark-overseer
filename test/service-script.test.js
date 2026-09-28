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

test('service script install dry run validates hashes and prints all planned steps', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'repo');
  const serviceRoot = path.join(root, 'ProgramData', 'ARK Overseer');
  fs.mkdirSync(path.join(appDir, 'vendor'), { recursive: true });
  const shawl = path.join(appDir, 'vendor', 'shawl.zip');
  const psh = path.join(appDir, 'vendor', 'pwsh.zip');
  fs.writeFileSync(shawl, 'fake shawl');
  fs.writeFileSync(psh, 'fake pwsh');
  const grant = path.join(root, 'ARK Install');
  fs.mkdirSync(grant);
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      'tools/service.ps1',
      'install',
      '-DryRun',
      '-AppDir',
      appDir,
      '-Root',
      serviceRoot,
      '-ShawlZip',
      shawl,
      '-PwshZip',
      psh,
      '-GrantFolder',
      grant,
      '-ServiceName',
      `ArkOverseerTest${process.pid}`,
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /^FAIL: SHA-256 mismatch for /m);
  const steps = output.split(/\r?\n/).filter((line) => line.startsWith('STEP: '));
  assert.ok(
    steps.some((line) => line.includes('shawl.exe') && line.includes(`"--name" "ArkOverseerTest${process.pid}"`)),
  );
  const shawlLine = steps.find((line) => line.includes('shawl.exe'));
  for (const bit of [
    '"--stop-timeout" "60000"',
    '"--restart-if-not" "0"',
    'OVERSEER_DATA=',
    'OVERSEER_SERVICE=1',
    'OVERSEER_PWSH=',
    'OVERSEER_MODEL_CACHE=',
    'OVERSEER_PORT=3310',
  ])
    assert.ok(shawlLine.includes(bit), bit);
  assert.ok(shawlLine.includes(`"${path.join(serviceRoot, 'runtime', 'node', 'node.exe')}"`));
  // The service runs its own copy of the last commit under the root, never the checkout itself.
  assert.ok(shawlLine.includes(`"${path.join(serviceRoot, 'app', 'src', 'main.js')}"`));
  assert.ok(shawlLine.includes(`"--cwd" "${path.join(serviceRoot, 'app')}"`));
  assert.match(output, /^FAIL: .* is not a git checkout with a commit to deploy\./m);
  assert.ok(steps.some((line) => line.startsWith('STEP: Export commit') && line.includes('"archive"')));
  assert.ok(steps.some((line) => line.includes('robocopy.exe') && line.includes('node_modules')));
  assert.ok(steps.every((line) => !(line.includes('/grant') && line.includes(`"${appDir}"`))));
  const config = steps.find((line) => line.includes('sc.exe" "config"'));
  assert.match(config, /NT AUTHORITY\\NetworkService/);
  assert.match(config, /delayed-auto/);
  assert.ok(steps.some((line) => line.includes('sc.exe" "description"')));
  assert.ok(steps.some((line) => line.includes('sc.exe" "failure"')));
  assert.ok(
    steps.some((line) => line.includes(`*S-1-5-20:(OI)(CI)RX`) && line.includes(path.join(serviceRoot, 'app'))),
  );
  assert.ok(steps.some((line) => line.includes(`*S-1-5-20:(OI)(CI)RX`) && line.includes('runtime')));
  for (const folder of [path.join(serviceRoot, 'data'), path.join(serviceRoot, 'logs'), grant])
    assert.ok(
      steps.some((line) => line.includes(`*S-1-5-20:(OI)(CI)M`) && line.includes(folder)),
      folder,
    );
  // The database folder and the logs stop inheriting read access for every local user.
  for (const folder of [path.join(serviceRoot, 'data'), path.join(serviceRoot, 'logs')])
    assert.ok(
      steps.some((line) => line.includes(folder) && line.includes('/inheritance:r') && !line.includes('*S-1-5-32-545')),
      folder,
    );
  assert.ok(steps.length >= 13);
  assert.deepEqual(fs.readdirSync(root), ['ARK Install', 'repo']);
  assert.deepEqual(fs.readdirSync(path.join(appDir, 'vendor')).sort(), ['pwsh.zip', 'shawl.zip']);
});

test('service status for an unknown service exits cleanly', { skip }, (t) => {
  const name = `ArkOverseerMissing${process.pid}`;
  const result = spawnSync('pwsh', ['-NoProfile', '-File', 'tools/service.ps1', 'status', '-ServiceName', name], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is not installed/);
});

test('service uninstall dry run prints stop, delete, and grant removal without touching data', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'repo');
  fs.mkdirSync(appDir);
  const serviceRoot = path.join(root, 'ARK Overseer');
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      'tools/service.ps1',
      'uninstall',
      '-DryRun',
      '-AppDir',
      appDir,
      '-Root',
      serviceRoot,
      '-ServiceName',
      `ArkOverseerTest${process.pid}`,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const steps = output.split(/\r?\n/).filter((line) => line.startsWith('STEP: '));
  // With no such service installed, a dry run says so instead of planning a stop and delete.
  assert.match(output, /^SKIP: The ArkOverseer\S* service is not installed\./m);
  assert.ok(steps.every((line) => !/Stop the service|Delete the service/.test(line)));
  assert.ok(steps.some((line) => /remove:g/.test(line)));
  assert.ok(steps.every((line) => !line.includes(path.join(serviceRoot, 'data'))));
});

test('uninstall keeps a data folder whose database cannot be read', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-keep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'repo');
  const serviceRoot = path.join(root, 'ARK Overseer');
  fs.mkdirSync(appDir);
  fs.mkdirSync(path.join(serviceRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, 'data', 'overseer.db'), 'not a database');
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      'tools/service.ps1',
      'uninstall',
      '-DryRun',
      '-RemoveData',
      '-AppDir',
      appDir,
      '-Root',
      serviceRoot,
      '-ServiceName',
      `ArkOverseerTest${process.pid}`,
    ],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^KEEP: Could not read /m);
  assert.ok(
    !output
      .split(/\r?\n/)
      .some((line) => line.startsWith('STEP: Remove') && line.includes(path.join(serviceRoot, 'data'))),
  );
  assert.ok(fs.existsSync(path.join(serviceRoot, 'data', 'overseer.db')));
});
