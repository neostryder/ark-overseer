import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const PRUNED = [
  'onnxruntime-web',
  'onnxruntime-node/bin/napi-v6/darwin',
  'onnxruntime-node/bin/napi-v6/linux',
  'onnxruntime-node/bin/napi-v6/win32/arm64',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(name);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (exe, argv, cwd = root) =>
  execFileSync(exe === 'npm' && process.platform === 'win32' ? 'npm.cmd' : exe, argv, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: exe === 'npm' && process.platform === 'win32',
  }).trim();

// Programs the package carries besides node_modules. Their licenses are MIT; Node.js also bundles other
// components under their own terms, which its own LICENSE file lists.
const BUNDLED = [
  ['Node.js', 'runtime/node.exe', 'MIT', 'https://github.com/nodejs/node/blob/main/LICENSE'],
  [
    'PowerShell 7',
    'vendor/PowerShell-7.6.6-win-x64.zip',
    'MIT',
    'https://github.com/PowerShell/PowerShell/blob/master/LICENSE.txt',
  ],
  ['shawl', 'vendor/shawl-v1.9.0-win64.zip', 'MIT', 'https://github.com/mtkennerly/shawl/blob/master/LICENSE'],
];

// Lists every production package with its license, and includes the full license text each package ships,
// so the notices travel with the binaries.
function thirdPartyNotices(modulesDir) {
  const packages = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (name.startsWith('@')) {
        walk(full);
        continue;
      }
      const manifest = path.join(full, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const licenseFile = fs.readdirSync(full).find((file) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(file));
      packages.push({
        name: info.name,
        version: info.version,
        license: typeof info.license === 'string' ? info.license : (info.license?.type ?? 'see package'),
        text: licenseFile ? fs.readFileSync(path.join(full, licenseFile), 'utf8').trim() : '',
      });
      const nested = path.join(full, 'node_modules');
      if (fs.existsSync(nested)) walk(nested);
    }
  };
  walk(modulesDir);
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const lines = ['# Third-party notices', '', 'This release includes the following software.', '', '## Programs', ''];
  for (const [name, file, license, url] of BUNDLED) lines.push(`- ${name} (${file}), ${license} license: ${url}`);
  lines.push('', '## Packages', '');
  for (const pkg of packages) {
    lines.push(`### ${pkg.name} ${pkg.version}`, '', `License: ${pkg.license}`, '');
    if (pkg.text) lines.push('```text', pkg.text, '```', '');
  }
  return `${lines.join('\n')}\n`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, timestamp) {
  const dosTime =
    ((timestamp.getUTCHours() << 11) | (timestamp.getUTCMinutes() << 5) | (timestamp.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((timestamp.getUTCFullYear() - 1980) << 9) | ((timestamp.getUTCMonth() + 1) << 5) | timestamp.getUTCDate()) &
    0xffff;
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'));
    const raw = entry.data;
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(dosTime, 12);
    directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function vendorSpecs(cwd = root) {
  const source = fs.readFileSync(path.join(cwd, 'tools/service.ps1'), 'utf8');
  const matches = [...source.matchAll(/\$([A-Za-z]+Zip)\s*=\s*'([^']+)'/g)];
  const files = [...source.matchAll(/Join-Path \$AppDir 'vendor\\([^']+)'/g)].map((match) => match[1]);
  const hashes = matches.map((match) => match[2]);
  if (files.length !== 2 || hashes.length !== 2)
    throw new Error('Could not read the two vendor files and SHA-256 values from service.ps1.');
  return files.map((name, index) => ({ name, hash: hashes[index] }));
}

function vendorUrl(name) {
  const shawl = name.match(/^shawl-v([0-9.]+)-win64\.zip$/);
  if (shawl) return `https://github.com/mtkennerly/shawl/releases/download/v${shawl[1]}/${name}`;
  const powershell = name.match(/^PowerShell-([0-9.]+)-win-x64\.zip$/);
  if (powershell) return `https://github.com/PowerShell/PowerShell/releases/download/v${powershell[1]}/${name}`;
  throw new Error(`No GitHub release URL is defined for vendor/${name}.`);
}

function build({
  out = path.join(root, 'dist'),
  channel = 'stable',
  allowDirty = false,
  cwd = root,
  runCommand = run,
  nodeVersion = process.versions.node,
} = {}) {
  if (!['stable', 'beta', 'edge'].includes(channel)) throw new Error('Channel must be stable, beta, or edge.');
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const commit = runCommand('git', ['rev-parse', 'HEAD'], cwd);
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('Git did not return a 40 character commit.');
  if (!allowDirty && runCommand('git', ['status', '--porcelain', '--untracked-files=no'], cwd))
    throw new Error('Tracked files have uncommitted changes. Use --allow-dirty to build anyway.');
  const date = new Date(Number(runCommand('git', ['show', '-s', '--format=%ct', 'HEAD'], cwd)) * 1000);
  const version = channel === 'edge' ? `${pkg.version}-edge.${commit.slice(0, 7)}` : pkg.version;
  const folderName = `ark-overseer-${version}-win-x64`;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-release-'));
  try {
    const packageRoot = path.join(stage, folderName);
    fs.mkdirSync(packageRoot, { recursive: true });
    const tracked = runCommand('git', ['ls-files'], cwd).split(/\r?\n/).filter(Boolean).sort();
    // Tests and GitHub workflow definitions are build and CI inputs, not runtime files. Git metadata rules
    // and formatter configuration only affect contributors. Runtime code has no imports from test/ or .github/.
    const excluded = (name) =>
      /^(test|\.github)(\\|\/)/i.test(name) ||
      ['.gitignore', '.prettierrc.json', '.prettierignore', 'CLAUDE.md'].includes(name);
    for (const rel of tracked.filter((name) => !excluded(name))) {
      const from = path.join(cwd, rel);
      const to = path.join(packageRoot, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    const nodeRealPath = fs.realpathSync(process.execPath);
    if (Number(nodeVersion.split('.')[0]) < 26) throw new Error(`Node 26 or later is required. Found ${nodeVersion}.`);
    fs.mkdirSync(path.join(packageRoot, 'runtime'), { recursive: true });
    fs.copyFileSync(nodeRealPath, path.join(packageRoot, 'runtime', 'node.exe'));
    const nodeSha256 = sha(fs.readFileSync(nodeRealPath));
    const release = { version, commit, channel, builtAt: date.toISOString(), nodeVersion, nodeSha256 };
    fs.writeFileSync(path.join(packageRoot, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);

    const depStage = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-deps-'));
    try {
      fs.copyFileSync(path.join(cwd, 'package.json'), path.join(depStage, 'package.json'));
      fs.copyFileSync(path.join(cwd, 'package-lock.json'), path.join(depStage, 'package-lock.json'));
      runCommand('npm', ['ci', '--omit=dev'], depStage);
      fs.cpSync(path.join(depStage, 'node_modules'), path.join(packageRoot, 'node_modules'), { recursive: true });
      // The package is Windows x64 only and the search model runs on onnxruntime-node, so the macOS, Linux
      // and Windows ARM binaries and the browser runtime (onnxruntime-web) are dead weight, about 300 MB.
      // A real embedding still runs without them; keep this list in step with the dependency.
      for (const rel of PRUNED)
        fs.rmSync(path.join(packageRoot, 'node_modules', rel), { recursive: true, force: true });
      fs.writeFileSync(
        path.join(packageRoot, 'THIRD_PARTY_NOTICES.md'),
        thirdPartyNotices(path.join(packageRoot, 'node_modules')),
      );
    } finally {
      fs.rmSync(depStage, { recursive: true, force: true });
    }

    const specs = vendorSpecs(cwd);
    fs.mkdirSync(path.join(packageRoot, 'vendor'), { recursive: true });
    for (const spec of specs) {
      let vendor = path.join(cwd, 'vendor', spec.name);
      if (!fs.existsSync(vendor) || sha(fs.readFileSync(vendor)) !== spec.hash) {
        const response = runCommand('curl.exe', ['-fL', vendorUrl(spec.name), '-o', path.join(stage, spec.name)], cwd);
        void response;
        vendor = path.join(stage, spec.name);
      }
      if (!fs.existsSync(vendor) || sha(fs.readFileSync(vendor)) !== spec.hash)
        throw new Error(`SHA-256 mismatch for vendor/${spec.name}.`);
      fs.copyFileSync(vendor, path.join(packageRoot, 'vendor', spec.name));
    }

    const entries = [];
    const walk = (directory) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const full = path.join(directory, name);
        const rel = path.relative(stage, full).replaceAll('\\', '/');
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else entries.push({ name: `${folderName}/${rel.slice(folderName.length + 1)}`, data: fs.readFileSync(full) });
      }
    };
    walk(packageRoot);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const bytes = zip(entries, date);
    fs.mkdirSync(out, { recursive: true });
    const zipName = `${folderName}.zip`;
    const zipPath = path.join(out, zipName);
    fs.writeFileSync(zipPath, bytes);
    fs.writeFileSync(`${zipPath}.sha256`, `${sha(bytes)}  ${zipName}\n`);
    return { zipPath, release };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = build({
      out: value('--out', path.join(root, 'dist')),
      channel: value('--channel', 'stable'),
      allowDirty: flag('--allow-dirty'),
    });
    process.stdout.write(`${result.zipPath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { build, thirdPartyNotices, vendorSpecs, zip };
