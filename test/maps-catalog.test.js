import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCatalog, createCatalog, scheduleCatalogRefresh } from '../src/maps/catalog.js';

const bundled = JSON.parse(fs.readFileSync(new URL('../src/maps/catalog.json', import.meta.url), 'utf8'));
const official = { id: 'Extra_WP', name: 'Extra', kind: 'official', steamAppId: 1 };
const mod = { id: 'ModMap', name: 'A mod map', kind: 'mod', modId: '928102' };
const catalogOf = (version, maps = []) => ({ version, maps });

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const response = (body, { status = 200, headers = {} } = {}) =>
  new Response(typeof body === 'string' || body === null ? body : JSON.stringify(body), { status, headers });

test('the bundled catalog is valid and lists the eleven official maps in order', () => {
  const checked = validateCatalog(bundled);
  assert.deepEqual(
    checked.maps.map((map) => map.id),
    [
      'TheIsland_WP',
      'TheCenter_WP',
      'ScorchedEarth_WP',
      'Aberration_WP',
      'Extinction_WP',
      'Ragnarok_WP',
      'Valguero_WP',
      'Genesis_WP',
      'Astraeos_WP',
      'LostColony_WP',
      'BobsMissions_WP',
    ],
  );
  assert.ok(checked.maps.every((map) => map.kind === 'official' && Number.isInteger(map.steamAppId)));
  assert.equal(checked.maps.find((map) => map.id === 'Genesis_WP').name, 'Genesis: Part 1');
});

test('validation accepts official and mod maps and drops unknown fields', () => {
  const checked = validateCatalog({ ...catalogOf(2, [{ ...official, extra: 1 }, mod]), note: 'x' });
  assert.deepEqual(checked, catalogOf(2, [official, mod]));
});

test('validation rejects each bad field', () => {
  const bad = (value) => assert.throws(() => validateCatalog(value), TypeError, JSON.stringify(value));
  for (const value of [null, [], 'x', 3]) bad(value);
  for (const version of [0, -1, 1.5, '1', undefined]) bad({ version, maps: [] });
  bad({ version: 1 });
  bad({ version: 1, maps: {} });
  bad(
    catalogOf(
      1,
      Array.from({ length: 201 }, (_, i) => ({ ...official, id: `Map${i}` })),
    ),
  );
  validateCatalog(
    catalogOf(
      1,
      Array.from({ length: 200 }, (_, i) => ({ ...official, id: `Map${i}` })),
    ),
  );
  for (const entry of [
    null,
    'x',
    { ...official, id: '' },
    { ...official, id: 'has space' },
    { ...official, id: 'has-dash' },
    { ...official, id: 'x'.repeat(65) },
    { ...official, id: 7 },
    { ...official, name: '' },
    { ...official, name: 'x'.repeat(61) },
    { ...official, name: 'tab\there' },
    { ...official, name: 'line\nbreak' },
    { ...official, name: 5 },
    { ...official, kind: 'other' },
    { ...official, kind: undefined },
    { ...official, steamAppId: undefined },
    { ...official, steamAppId: 1.5 },
    { ...official, steamAppId: '123' },
    { ...official, modId: '123' },
    { ...mod, modId: undefined },
    { ...mod, modId: '12a' },
    { ...mod, modId: '' },
    { ...mod, modId: 123 },
    { ...mod, steamAppId: 5 },
  ])
    bad(catalogOf(1, [entry]));
  bad(catalogOf(1, [official, official]));
  validateCatalog(catalogOf(1, [{ ...official, name: 'x'.repeat(60) }]));
});

test('get() returns the bundled catalog when nothing is cached', (t) => {
  const catalog = createCatalog({ dataDir: folder(t), url: null, log: () => {} });
  assert.deepEqual(catalog.get(), validateCatalog(bundled));
});

test('get() prefers a higher cached version, and ignores a lower, equal or invalid one', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'map-catalog.json');
  const use = (value) => {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return createCatalog({ dataDir: dir, url: null, log: () => {} }).get();
  };
  assert.deepEqual(use(catalogOf(bundled.version + 1, [official])), catalogOf(bundled.version + 1, [official]));
  assert.equal(use(catalogOf(bundled.version, [official])).maps.length, bundled.maps.length);
  assert.equal(use(catalogOf(0, [official])).version, bundled.version);
  assert.equal(use('{ not json').version, bundled.version);
  assert.equal(use(catalogOf(bundled.version + 5, [{ ...official, id: 'bad id' }])).version, bundled.version);
  fs.unlinkSync(file);
  assert.equal(createCatalog({ dataDir: dir, url: null, log: () => {} }).get().version, bundled.version);
});

function refresher(t, fetch, url = 'https://example.test/maps.json') {
  const dir = folder(t);
  const logs = [];
  const catalog = createCatalog({ dataDir: dir, url, fetch, log: (line) => logs.push(line) });
  return { catalog, dir, logs, cache: path.join(dir, 'map-catalog.json') };
}

test('refresh() does nothing when no URL is set', async (t) => {
  let calls = 0;
  const { catalog, cache, logs } = refresher(t, async () => (calls++, response(catalogOf(99))), null);
  assert.equal(await catalog.refresh(), false);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(cache), false);
  assert.deepEqual(logs, []);
});

test('refresh() stores a newer catalog, sends the timeout signal, and uses it at once', async (t) => {
  const seen = [];
  const fresh = catalogOf(bundled.version + 1, [official, mod]);
  const { catalog, cache, logs } = refresher(t, async (url, init) => {
    seen.push([url, init]);
    return response(fresh, { headers: { ETag: '"v2"' } });
  });
  assert.equal(await catalog.refresh(), true);
  assert.equal(seen[0][0], 'https://example.test/maps.json');
  assert.ok(seen[0][1].signal instanceof AbortSignal);
  assert.equal(seen[0][1].headers['If-None-Match'], undefined);
  assert.deepEqual(catalog.get(), fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), fresh);
  assert.deepEqual(logs, []);
  // A new process reads the cached copy without asking again.
  assert.deepEqual(createCatalog({ dataDir: path.dirname(cache), url: null }).get(), fresh);
});

test('refresh() leaves the catalog alone when the fetched version is not higher', async (t) => {
  const same = refresher(t, async () => response(catalogOf(bundled.version, [official])));
  const before = same.catalog.get();
  assert.equal(await same.catalog.refresh(), false);
  assert.equal(same.catalog.get(), before);
  assert.equal(fs.existsSync(same.cache), false);
  // A cached copy that is already newer than the fetched one is not replaced either.
  const newer = refresher(t, async () => response(catalogOf(bundled.version + 1, [official])));
  const cached = catalogOf(bundled.version + 5, [mod]);
  fs.writeFileSync(newer.cache, JSON.stringify(cached));
  const again = createCatalog({
    dataDir: newer.dir,
    url: 'https://example.test/maps.json',
    fetch: async () => response(catalogOf(bundled.version + 1, [official])),
    log: () => {},
  });
  assert.equal(await again.refresh(), false);
  assert.deepEqual(again.get(), cached);
  assert.deepEqual(JSON.parse(fs.readFileSync(newer.cache, 'utf8')), cached);
});

test('refresh() sends the last ETag and treats a 304 as no change', async (t) => {
  const sent = [];
  const answers = [
    response(catalogOf(bundled.version + 1, [official]), { headers: { ETag: '"abc"' } }),
    response(null, { status: 304 }),
  ];
  const { catalog, logs } = refresher(
    t,
    async (url, init) => (sent.push(init.headers['If-None-Match']), answers.shift()),
  );
  assert.equal(await catalog.refresh(), true);
  assert.equal(await catalog.refresh(), false);
  assert.deepEqual(sent, [undefined, '"abc"']);
  assert.equal(catalog.get().version, bundled.version + 1);
  assert.deepEqual(logs, []);
});

test('refresh() keeps the current catalog and logs once on each kind of failure', async (t) => {
  const huge = JSON.stringify(catalogOf(bundled.version + 1, [{ ...official, name: 'x'.repeat(300 * 1024) }]));
  const cases = {
    'a non-https URL': { url: 'http://example.test/maps.json', fetch: async () => response(catalogOf(99)) },
    'a URL that is not a URL': { url: 'nope', fetch: async () => response(catalogOf(99)) },
    'an error status': { fetch: async () => response('gone', { status: 404 }) },
    'an oversize body': { fetch: async () => response(huge) },
    'an oversize length header': {
      fetch: async () => response(catalogOf(99), { headers: { 'Content-Length': String(300 * 1024) } }),
    },
    'invalid JSON': { fetch: async () => response('{ nope') },
    'an invalid catalog': { fetch: async () => response({ version: 'x', maps: [] }) },
    'a timeout': {
      fetch: async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
    },
    'a network error': {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    },
    'a redirect out of https': {
      fetch: async () => Object.defineProperty(response(catalogOf(99)), 'url', { value: 'http://example.test/x' }),
    },
  };
  for (const [name, { url, fetch }] of Object.entries(cases)) {
    const { catalog, logs, cache } = refresher(t, fetch, url);
    const before = catalog.get();
    assert.equal(await catalog.refresh(), false, name);
    assert.equal(catalog.get(), before, name);
    assert.equal(fs.existsSync(cache), false, name);
    assert.equal(logs.length, 1, name);
  }
});

test('a body just under the limit is accepted', async (t) => {
  const pad = 'x'.repeat(59);
  const maps = Array.from({ length: 200 }, (_, i) => ({ ...official, id: `M${i}`, name: pad }));
  const body = JSON.stringify(catalogOf(bundled.version + 1, maps));
  assert.ok(Buffer.byteLength(body) < 256 * 1024);
  const { catalog } = refresher(t, async () => response(body));
  assert.equal(await catalog.refresh(), true);
  assert.equal(catalog.get().maps.length, 200);
});

test('the daily refresh runs at once, then on a timer that does not keep the process alive', () => {
  let refreshes = 0;
  const timer = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  };
  const cleared = [];
  const stop = scheduleCatalogRefresh(
    { refresh: () => refreshes++ },
    {
      setTimer: (fn, ms) => {
        timer.fn = fn;
        timer.ms = ms;
        return timer;
      },
      clearTimer: (value) => cleared.push(value),
    },
  );
  assert.equal(refreshes, 1);
  assert.equal(timer.ms, 24 * 60 * 60 * 1000);
  assert.equal(timer.unrefCalled, true);
  timer.fn();
  assert.equal(refreshes, 2);
  stop();
  assert.deepEqual(cleared, [timer]);
});
