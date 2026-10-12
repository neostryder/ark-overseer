import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../public/js/strings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

test('public files have no inline scripts, style elements, style attrs or handler attrs', () => {
  for (const file of files(publicDir)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /<script\b[^>]*>\s*[^\s<][\s\S]*?<\/script\s*>/i, file);
    assert.doesNotMatch(source, /<style\b/i, file);
    assert.doesNotMatch(source, /\sstyle\s*=/i, file);
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i, file);
  }
});

test('the sprite holds every planned icon and every icon the pages use', () => {
  const sprite = fs.readFileSync(path.join(publicDir, 'icons/sprite.svg'), 'utf8');
  const symbols = new Set([...sprite.matchAll(/<symbol\s+id="([^"]+)"/g)].map((match) => match[1]));
  for (const name of [
    'server',
    'play',
    'stop',
    'restart',
    'settings',
    'network',
    'jobs',
    'account',
    'add',
    'check',
    'warning',
    'error',
    'close',
    'menu',
    'search',
    'key',
    'shield',
    'sign-out',
    'chevron',
    'map',
    'backup',
  ])
    assert.ok(symbols.has(name), `sprite has no ${name}`);
  // Pages call icon('name'), or icon({ key: 'name' }[key]) to pick one per button.
  const used = [];
  for (const file of files(path.join(publicDir, 'js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bicon\('([^']+)'\)/g)) used.push([match[1], file]);
    for (const match of source.matchAll(/\bicon\(\{([^}]*)\}/g))
      for (const value of match[1].matchAll(/'([^']+)'/g)) used.push([value[1], file]);
  }
  assert.ok(used.length >= 10, `only ${used.length} icon references found`);
  for (const [name, file] of used) assert.ok(symbols.has(name), `missing icon ${name} in ${file}`);
});

test('the updates card writes release notes as plain text, never as markup', () => {
  const source = fs.readFileSync(path.join(publicDir, 'js/components/ao-host-settings.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /insertAdjacentHTML/);
  assert.match(source, /el\('p', view\.newest\.notes\)/);
});

test('every STRINGS property referenced by browser JavaScript exists', () => {
  const known = new Set();
  function collect(value, prefix = '') {
    for (const [key, item] of Object.entries(value)) {
      const full = prefix ? `${prefix}.${key}` : key;
      known.add(full);
      if (item && typeof item === 'object') collect(item, full);
    }
  }
  collect(STRINGS);
  for (const file of files(path.join(publicDir, 'js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/STRINGS\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g))
      assert.ok(known.has(match[1]), `${match[1]} missing from strings.js in ${file}`);
  }
});

test('HTML loads only local files, with no outside font or script request', () => {
  for (const name of ['index.html', 'login.html']) {
    const source = fs.readFileSync(path.join(publicDir, name), 'utf8');
    const urls = [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    for (const url of urls)
      assert.ok(
        url.startsWith('/') || url.startsWith('#') || url.startsWith('data:image/png;base64,'),
        `${name} references ${url}`,
      );
  }
});

test('every font the stylesheet names is a real WOFF2 file served from /fonts', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const files = [...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map((match) => match[1]);
  assert.equal(files.length, 5);
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(publicDir, file));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', file);
  }
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(css));
});

test('both pages carry the touch icon inline, so a home-screen save needs no second request', () => {
  for (const name of ['index.html', 'login.html']) {
    const source = fs.readFileSync(path.join(publicDir, name), 'utf8');
    const match = source.match(
      /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="data:image\/png;base64,([^"]+)"/,
    );
    assert.ok(match, `${name} has no inline apple-touch-icon`);
    const png = Buffer.from(match[1], 'base64');
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(png.readUInt32BE(16), 180);
    assert.equal(png.readUInt32BE(20), 180);
    assert.match(source, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s+crossorigin="use-credentials"/);
  }
});

test('the manifest names Overseer and offers the three shortcuts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Overseer');
  assert.deepEqual(
    manifest.shortcuts.map((item) => item.url),
    ['/#/servers', '/#/servers?action=restart-all', '/#/servers?action=backup-all'],
  );
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(publicDir, icon.src)), icon.src);
});

test('the app listens to the server change feed and keeps a slow fallback for when it is down', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /new EventSource\('\/api\/servers\/events'/);
  assert.match(app, /addEventListener\('changed'/);
  assert.match(app, /FEED_SAFETY_MS/);
  assert.match(app, /this\.feed\?\.close\(\)/);
});
