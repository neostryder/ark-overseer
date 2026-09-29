import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { build, vendorSpecs, zip } from '../tools/build-release.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (data) => createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-fixture-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const vendor = [Buffer.from('fake shawl'), Buffer.from('fake powershell')];
  const names = ['shawl-v1.9.0-win64.zip', 'PowerShell-7.6.6-win-x64.zip'];
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3', engines: { node: '>=26' } }));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  const vendorLines = names
    .map((name, index) => `  $${index ? 'PwshZip' : 'ShawlZip'}  = '${hash(vendor[index])}'`)
    .join('\n');
  const serviceLines = names.map((name) => `Join-Path $AppDir 'vendor\\${name}'`).join('\n');
  fs.mkdirSync(path.join(cwd, 'tools'));
  fs.writeFileSync(path.join(cwd, 'tools', 'service.ps1'), `${serviceLines}\n${vendorLines}`);
  fs.mkdirSync(path.join(cwd, 'vendor'));
  names.forEach((name, index) => fs.writeFileSync(path.join(cwd, 'vendor', name), vendor[index]));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'main.js'), 'runtime');
  fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, 'test', 'secret.test.js'), 'excluded');
  const tracked = [
    'package.json',
    'package-lock.json',
    'tools/service.ps1',
    'src/main.js',
    'test/secret.test.js',
    '.gitignore',
    '.prettierrc.json',
    '.prettierignore',
    'CLAUDE.md',
    '.github/workflows/release.yml',
  ];
  const commands = [];
  const runCommand = (exe, args, at) => {
    commands.push({ exe, args, at });
    if (exe === 'git' && args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567';
    if (exe === 'git' && args[0] === 'status') return '';
    if (exe === 'git' && args[0] === 'show') return '1780000000';
    if (exe === 'git' && args[0] === 'ls-files') return tracked.join('\n');
    if (exe === 'npm') {
      fs.mkdirSync(path.join(at, 'node_modules', 'prod'), { recursive: true });
      fs.writeFileSync(path.join(at, 'node_modules', 'prod', 'index.js'), 'prod');
      return '';
    }
    throw new Error(`Unexpected command ${exe} ${args.join(' ')}`);
  };
  const out = path.join(cwd, 'output');
  return { cwd, out, vendor, names, tracked, commands, runCommand };
}

test('release package selection, metadata, checksum, and zip bytes are stable', (t) => {
  const fx = fixture(t);
  const options = { cwd: fx.cwd, out: fx.out, allowDirty: true, runCommand: fx.runCommand };
  const first = build(options);
  const firstBytes = fs.readFileSync(first.zipPath);
  const second = build(options);
  assert.deepEqual(fs.readFileSync(second.zipPath), firstBytes);
  assert.equal(first.release.version, '1.2.3');
  assert.equal(first.release.commit, '0123456789abcdef0123456789abcdef01234567');
  const sidecar = fs.readFileSync(`${first.zipPath}.sha256`, 'utf8');
  assert.equal(sidecar, `${hash(firstBytes)}  ark-overseer-1.2.3-win-x64.zip\n`);
  assert.match(first.release.nodeSha256, /^[a-f0-9]{64}$/);
  assert.ok(fx.commands.some(({ exe, args }) => exe === 'npm' && args.join(' ') === 'ci --omit=dev'));
  assert.ok(!fx.commands.some(({ exe, args }) => exe === 'npm' && args.includes('node_modules')));
  assert.ok(firstBytes.includes(Buffer.from('ark-overseer-1.2.3-win-x64/src/main.js')));
  assert.ok(!firstBytes.includes(Buffer.from('test/secret.test.js')));
  assert.ok(!firstBytes.includes(Buffer.from('.gitignore')));
  assert.ok(!firstBytes.includes(Buffer.from('.prettierrc.json')));
  assert.ok(!firstBytes.includes(Buffer.from('.prettierignore')));
  assert.ok(!firstBytes.includes(Buffer.from('CLAUDE.md')));
  assert.ok(!firstBytes.includes(Buffer.from('.github/workflows/release.yml')));
});

test('release build refuses tracked changes without the override', (t) => {
  const fx = fixture(t);
  const runCommand = (exe, args, at) => {
    if (exe === 'git' && args[0] === 'status') return ' M src/main.js';
    return fx.runCommand(exe, args, at);
  };
  assert.throws(() => build({ cwd: fx.cwd, out: fx.out, runCommand }), /Tracked files have uncommitted changes/);
});

test('release build refuses Node below 26', (t) => {
  const fx = fixture(t);
  assert.throws(
    () => build({ cwd: fx.cwd, out: fx.out, allowDirty: true, runCommand: fx.runCommand, nodeVersion: '25.9.0' }),
    /Node 26 or later/,
  );
});

test('release build refuses a downloaded vendor zip with the wrong hash', (t) => {
  const fx = fixture(t);
  const shawl = path.join(fx.cwd, 'vendor', fx.names[0]);
  fs.writeFileSync(shawl, 'wrong hash');
  let downloadUrl;
  const runCommand = (exe, args, at) => {
    if (exe === 'curl.exe') {
      downloadUrl = args[1];
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'still wrong');
      return '';
    }
    return fx.runCommand(exe, args, at);
  };
  assert.throws(
    () => build({ cwd: fx.cwd, out: fx.out, allowDirty: true, runCommand }),
    /SHA-256 mismatch for vendor\/shawl-v1.9.0-win64.zip/,
  );
  assert.equal(downloadUrl, 'https://github.com/mtkennerly/shawl/releases/download/v1.9.0/shawl-v1.9.0-win64.zip');
});

test('build vendor names and hashes come from service.ps1', () => {
  const specs = vendorSpecs(repo);
  const script = fs.readFileSync(path.join(repo, 'tools', 'service.ps1'), 'utf8');
  for (const item of specs) {
    assert.ok(script.includes(item.name));
    assert.ok(script.toLowerCase().includes(item.hash));
  }
});

test('both release workflow files parse and use the download asset names and version checks', async () => {
  for (const name of ['release.yml', 'edge.yml']) {
    const file = path.join(repo, '.github', 'workflows', name);
    await prettier.__debug.parse(fs.readFileSync(file, 'utf8'), { parser: 'yaml' });
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /ark-overseer-/);
    assert.match(source, /\.zip/);
    assert.match(source, /\.sha256/);
    assert.match(source, /package\.json/);
    assert.match(source, /engines\.node/);
    assert.match(source, /ark-overseer-\$version-win-x64\.zip/);
  }
});

test('git attributes set the requested line endings', () => {
  const text = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
  assert.match(text, /^\*\.cmd eol=crlf$/m);
  assert.match(text, /^\*\.ps1 eol=lf$/m);
  assert.match(text, /^\*\.js eol=lf$/m);
});

test('zip writer orders entries and reproduces bytes for identical input', () => {
  const time = new Date('2026-01-01T00:00:00Z');
  const entries = [
    { name: 'b', data: Buffer.from('B') },
    { name: 'a', data: Buffer.from('A') },
  ];
  assert.deepEqual(zip(entries, time), zip(entries, time));
});

test('other-platform search runtime binaries are left out and the Windows x64 one stays', (t) => {
  const fx = fixture(t);
  const runCommand = (exe, args, at) => {
    if (exe === 'npm') {
      const modules = path.join(at, 'node_modules');
      for (const rel of [
        'onnxruntime-web',
        'onnxruntime-node/bin/napi-v6/darwin/arm64',
        'onnxruntime-node/bin/napi-v6/linux/x64',
        'onnxruntime-node/bin/napi-v6/win32/arm64',
        'onnxruntime-node/bin/napi-v6/win32/x64',
      ]) {
        fs.mkdirSync(path.join(modules, rel), { recursive: true });
        fs.writeFileSync(path.join(modules, rel, 'onnxruntime.marker'), 'x');
      }
      return '';
    }
    return fx.runCommand(exe, args, at);
  };
  const bytes = fs.readFileSync(build({ cwd: fx.cwd, out: fx.out, allowDirty: true, runCommand }).zipPath);
  const has = (rel) => bytes.includes(Buffer.from(`ark-overseer-1.2.3-win-x64/node_modules/${rel}/onnxruntime.marker`));
  assert.ok(has('onnxruntime-node/bin/napi-v6/win32/x64'));
  assert.ok(!has('onnxruntime-web'));
  assert.ok(!has('onnxruntime-node/bin/napi-v6/darwin/arm64'));
  assert.ok(!has('onnxruntime-node/bin/napi-v6/linux/x64'));
  assert.ok(!has('onnxruntime-node/bin/napi-v6/win32/arm64'));
});
