import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

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
function runHelper(code) {
  return spawnSync('pwsh', ['-NoProfile', '-Command', `. ./tools/update.ps1 -FunctionsOnly; ${code}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}
function runHelperAsync(code) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-Command', `. ./tools/update.ps1 -FunctionsOnly; ${code}`], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function runApiHelperAsync(baseUrl, code) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pwsh',
      ['-NoProfile', '-Command', `. ./tools/update.ps1 -FunctionsOnly -ApiBase ${psQuote(baseUrl)}; ${code}`],
      { cwd: process.cwd(), windowsHide: true },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

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

test('update dry run for GitHub prints package install using the unpacked app folder', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, { source: 'github', channel: 'stable', ref: 'v1.2.3', requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^CHECK: source github$/m);
  assert.match(output, /^CHECK: channel stable$/m);
  assert.match(output, /^CHECK: ref v1\.2\.3$/m);
  assert.match(output, /^ASSET: ark-overseer-1\.2\.3-win-x64\.zip$/m, output);
  assert.match(output, /^UPDATE: .* install -Force -Start -Package -AppDir ".*package" -Root .* -Port 3310$/m, output);
  assert.ok(output.includes(`${checkout}\\tools\\service.ps1 install`), output);
  assert.ok(!output.includes('codeload'), output);
  assert.ok(!output.includes('-Archive'), output);
});

test('update dry run for Edge names the rolling release package', { skip }, (t) => {
  const { root, checkout } = tree(t);
  options(root, checkout);
  request(root, { source: 'github', channel: 'edge', ref: COMMIT, requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^ASSET: ark-overseer-<version>-edge\.<commit>-win-x64\.zip$/m, output);
  assert.ok(!output.includes('codeload'), output);
});

test('a package without a recorded checkout uses the bundled service script', { skip }, (t) => {
  const { root } = tree(t);
  fs.writeFileSync(path.join(root, 'data', 'updater.json'), JSON.stringify({ port: 3310, grantFolder: ['D:\\ARK'] }));
  request(root, { source: 'github', channel: 'stable', ref: 'v1.2.3', requestedAt: now() });
  const result = run(root);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /package\\tools\\service\.ps1 install -Force -Start -Package/);
  assert.match(output, /-GrantFolder "D:\\ARK"/);
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

test('the release host allow-list accepts GitHub hosts and refuses other hosts', { skip }, async () => {
  const result = runHelper(
    "@(Test-AllowedAssetUri 'https://github.com/a' @('github.com'); Test-AllowedAssetUri 'https://evil.example/a' @('github.com')) -join ','",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'True,False');
});

test('PowerShell picks the newest installable release from a local fake API', { skip }, async (t) => {
  const packageName = 'ark-overseer-1.2.0-win-x64.zip';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/repos/neostryder/ark-overseer/releases?per_page=100');
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(
      JSON.stringify([
        { tag_name: 'v1.3.0', assets: [] },
        {
          tag_name: 'v1.2.0',
          assets: [
            { name: packageName, size: 2048, browser_download_url: 'https://github.com/owner/package.zip' },
            { name: `${packageName}.sha256`, browser_download_url: 'https://github.com/owner/package.zip.sha256' },
          ],
        },
      ]),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await runApiHelperAsync(baseUrl, 'Get-NewestRef stable | ConvertTo-Json -Depth 8 -Compress');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ref, 'v1.2.0');
});

test('an asset redirect to a host outside the allow-list is refused', { skip }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: 'http://not-allowed.invalid/package.zip' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const target = path.join(os.tmpdir(), `ao-redirect-${process.pid}-${Date.now()}.zip`);
  t.after(() => fs.rmSync(target, { force: true }));
  const url = `http://127.0.0.1:${server.address().port}/asset`;
  const result = await runHelperAsync(
    `try { Receive-Asset ${psQuote(url)} ${psQuote(target)} @('127.0.0.1') 100; 'DOWNLOADED' } catch { 'REFUSED' }`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'REFUSED');
  assert.equal(fs.existsSync(target), false);
});

test('asset downloads stop above 600 MB', { skip }, () => {
  const result = runHelper("try { Test-AssetSize 629145601; 'ACCEPTED' } catch { 'TOO_LARGE' }");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TOO_LARGE');
});

test('checksum file mismatch removes the package download', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-update-hash-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zip = path.join(base, 'package.zip'),
    checksum = path.join(base, 'package.sha256');
  fs.writeFileSync(zip, 'package bytes');
  fs.writeFileSync(checksum, `${'0'.repeat(64)} package.zip`);
  const result = runHelper(
    `try { Test-PackageHash ${psQuote(zip)} ${psQuote(checksum)} ''; 'MATCH' } catch { 'MISMATCH' }`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'MISMATCH');
  assert.equal(fs.existsSync(zip), false);
});

test('GitHub asset digest mismatch removes the package download', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-update-digest-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zip = path.join(base, 'package.zip'),
    checksum = path.join(base, 'package.sha256');
  const bytes = 'package bytes';
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(zip, bytes);
  fs.writeFileSync(checksum, `${hash} package.zip`);
  const result = runHelper(
    `try { Test-PackageHash ${psQuote(zip)} ${psQuote(checksum)} 'sha256:${'0'.repeat(64)}'; 'MATCH' } catch { 'MISMATCH' }`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'MISMATCH');
  assert.equal(fs.existsSync(zip), false);
});

test('the package temp folder is removed after a failed validation', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-update-cleanup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'partial.zip'), 'partial');
  const result = runHelper(`Remove-UpdateTemp ${psQuote(base)}; 'REMOVED'`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'REMOVED');
  assert.equal(fs.existsSync(base), false);
});

test('zip slip entries are rejected before extraction', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-update-zipslip-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zip = path.join(base, 'hostile.zip');
  const command = `$archive = [IO.Compression.ZipFile]::Open(${psQuote(zip)}, [IO.Compression.ZipArchiveMode]::Create); $entry = $archive.CreateEntry('package/../outside'); $writer = [IO.StreamWriter]::new($entry.Open()); $writer.Write('bad'); $writer.Dispose(); $archive.Dispose()`;
  const made = runHelper(`Add-Type -AssemblyName System.IO.Compression.FileSystem; ${command}`);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const destination = path.join(base, 'unpacked');
  fs.mkdirSync(destination);
  const result = runHelper(
    `try { Expand-ReleasePackage ${psQuote(zip)} ${psQuote(destination)} '1.2.3'; 'EXTRACTED' } catch { 'REFUSED' }`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'REFUSED');
  assert.equal(fs.existsSync(path.join(base, 'outside')), false);
});

test('package metadata must match its version and contain a full commit id', { skip }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-update-release-json-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const zip = path.join(base, 'package.zip');
  const metadata = JSON.stringify({ version: '1.2.3', commit: COMMIT });
  const command = `$archive = [IO.Compression.ZipFile]::Open(${psQuote(zip)}, [IO.Compression.ZipArchiveMode]::Create); $entry = $archive.CreateEntry('package/RELEASE.json'); $writer = [IO.StreamWriter]::new($entry.Open()); $writer.Write(${psQuote(metadata)}); $writer.Dispose(); $archive.Dispose()`;
  const made = runHelper(`Add-Type -AssemblyName System.IO.Compression.FileSystem; ${command}`);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const good = path.join(base, 'good');
  fs.mkdirSync(good);
  const valid = runHelper(`Expand-ReleasePackage ${psQuote(zip)} ${psQuote(good)} '1.2.3' | ConvertTo-Json -Compress`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).commit, COMMIT);
  const wrong = path.join(base, 'wrong');
  fs.mkdirSync(wrong);
  const invalid = runHelper(
    `try { Expand-ReleasePackage ${psQuote(zip)} ${psQuote(wrong)} '9.9.9'; 'ACCEPTED' } catch { 'REFUSED' }`,
  );
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(invalid.stdout.trim(), 'REFUSED');
  const badZip = path.join(base, 'bad-commit.zip');
  const badMetadata = JSON.stringify({ version: '1.2.3', commit: COMMIT.slice(1) });
  const badCommand = `$archive = [IO.Compression.ZipFile]::Open(${psQuote(badZip)}, [IO.Compression.ZipArchiveMode]::Create); $entry = $archive.CreateEntry('package/RELEASE.json'); $writer = [IO.StreamWriter]::new($entry.Open()); $writer.Write(${psQuote(badMetadata)}); $writer.Dispose(); $archive.Dispose()`;
  const badMade = runHelper(`Add-Type -AssemblyName System.IO.Compression.FileSystem; ${badCommand}`);
  assert.equal(badMade.status, 0, badMade.stdout + badMade.stderr);
  const badDestination = path.join(base, 'bad-commit');
  fs.mkdirSync(badDestination);
  const badCommit = runHelper(
    `try { Expand-ReleasePackage ${psQuote(badZip)} ${psQuote(badDestination)} '1.2.3'; 'ACCEPTED' } catch { 'REFUSED' }`,
  );
  assert.equal(badCommit.status, 0, badCommit.stderr);
  assert.equal(badCommit.stdout.trim(), 'REFUSED');
});
