import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtResolver, validateArtUrl, findModPreview, modsFolder } from '../src/maps/art.js';

const GOOD = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2399830/header.jpg?t=1';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-art-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const steam = (id, headerImage) =>
  new Response(JSON.stringify({ [id]: { success: true, data: { header_image: headerImage } } }), { status: 200 });

function resolverWith(t, answer, dataDir = folder(t)) {
  const state = { time: 1_000_000, calls: [], logs: [] };
  const resolver = createArtResolver({
    dataDir,
    now: () => state.time,
    log: (line) => state.logs.push(line),
    fetch: async (url, init) => {
      state.calls.push([url, init]);
      return typeof answer === 'function' ? answer(url) : answer;
    },
  });
  return { ...state, state, resolver, dataDir };
}

test('only an https address on a steamstatic.com host is accepted', () => {
  assert.equal(validateArtUrl(GOOD), GOOD);
  assert.equal(validateArtUrl('https://cdn.steamstatic.com/a.jpg'), 'https://cdn.steamstatic.com/a.jpg');
  for (const bad of [
    'http://shared.akamai.steamstatic.com/a.jpg',
    'https://example.com/a.jpg',
    'https://steamstatic.com/a.jpg',
    'https://evilsteamstatic.com/a.jpg',
    'https://shared.steamstatic.com.evil.test/a.jpg',
    'https://user:pw@cdn.steamstatic.com/a.jpg',
    'https://cdn.steamstatic.com:8443/a.jpg',
    'javascript:alert(1)',
    '//cdn.steamstatic.com/a.jpg',
    'not a url',
    '',
    null,
    undefined,
    42,
    `https://cdn.steamstatic.com/${'a'.repeat(600)}`,
  ])
    assert.equal(validateArtUrl(bad), null, String(bad));
});

test('a lookup asks Steam for the basic details and returns the header image', async (t) => {
  const f = resolverWith(t, steam(2399830, GOOD));
  assert.equal(await f.resolver.resolve(2399830), GOOD);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'https://store.steampowered.com/api/appdetails?appids=2399830&filters=basic');
  assert.ok(f.calls[0][1].signal instanceof AbortSignal);
});

test('an address on another host, or over http, is refused and counted as a failed lookup', async (t) => {
  for (const image of ['https://example.com/x.jpg', 'http://cdn.steamstatic.com/x.jpg', undefined]) {
    const f = resolverWith(t, steam(5, image));
    assert.equal(await f.resolver.resolve(5), null);
    assert.equal(f.logs.length, 1);
  }
});

test('a hit is remembered for 7 days and a failure for 1 hour', async (t) => {
  const hit = resolverWith(t, () => steam(7, GOOD));
  assert.equal(await hit.resolver.resolve(7), GOOD);
  hit.state.time += 7 * DAY - 1;
  assert.equal(await hit.resolver.resolve(7), GOOD);
  assert.equal(hit.calls.length, 1);
  hit.state.time += 1;
  assert.equal(await hit.resolver.resolve(7), GOOD);
  assert.equal(hit.calls.length, 2);

  const miss = resolverWith(t, () => new Response('nope', { status: 503 }));
  assert.equal(await miss.resolver.resolve(8), null);
  miss.state.time += HOUR - 1;
  assert.equal(await miss.resolver.resolve(8), null);
  assert.equal(miss.calls.length, 1);
  miss.state.time += 1;
  assert.equal(await miss.resolver.resolve(8), null);
  assert.equal(miss.calls.length, 2);
});

test('a network error is a failed lookup, logged and remembered for an hour', async (t) => {
  const f = resolverWith(t, () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await f.resolver.resolve(9), null);
  assert.equal(await f.resolver.resolve(9), null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.length, 1);
});

test('two lookups at once make one request, and the cache survives a restart', async (t) => {
  const f = resolverWith(t, () => steam(3, GOOD));
  const [a, b] = await Promise.all([f.resolver.resolve(3), f.resolver.resolve(3)]);
  assert.deepEqual([a, b], [GOOD, GOOD]);
  assert.equal(f.calls.length, 1);
  const second = resolverWith(t, () => assert.fail('a fresh cache entry needs no request'), f.dataDir);
  second.state.time = f.state.time + HOUR;
  assert.equal(await second.resolver.resolve(3), GOOD);
});

test('a cache file that was edited to hold another host is not trusted', async (t) => {
  const dir = folder(t);
  fs.writeFileSync(
    path.join(dir, 'map-art.json'),
    JSON.stringify({ 4: { url: 'https://example.com/x.jpg', at: 1_000_000 }, x: { url: GOOD, at: 1 } }),
  );
  const f = resolverWith(t, () => steam(4, GOOD), dir);
  // The bad entry counts as a remembered failure, so it is retried only after an hour.
  assert.equal(await f.resolver.resolve(4), null);
  assert.equal(f.calls.length, 0);
  f.state.time += HOUR;
  assert.equal(await f.resolver.resolve(4), GOOD);
});

test('a Steam app id that is not a positive integer makes no request', async (t) => {
  const f = resolverWith(t, () => assert.fail('no request expected'));
  for (const id of [0, -1, 1.5, '12', null, undefined, NaN]) assert.equal(await f.resolver.resolve(id), null);
});

// A mod tree as ASA lays it out under the install.
function modTree(t) {
  const install = folder(t);
  const mods = modsFolder(install);
  fs.mkdirSync(mods, { recursive: true });
  const put = (relative, content = 'png') => {
    const file = path.join(mods, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const age = (name, seconds) => {
    const time = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(path.join(mods, name), time, time);
  };
  return { install, mods, put, age };
}

test('the mod picture comes from the newest folder for that mod', (t) => {
  const tree = modTree(t);
  const older = tree.put('928102_100/Game/Preview/preview_image.png', 'old');
  const newer = tree.put('928102_200/Game/Preview/preview_image.png', 'new');
  const other = tree.put('111_300/Game/Preview/preview_image.png', 'other');
  tree.age('928102_100', 3000);
  tree.age('928102_200', 1000);
  tree.age('111_300', 10);
  assert.equal(fs.readFileSync(findModPreview(tree.install, '928102'), 'utf8'), 'new');
  // The newest by modification time wins, not the highest file id.
  tree.age('928102_100', 5);
  assert.equal(fs.readFileSync(findModPreview(tree.install, '928102'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(findModPreview(tree.install, '111'), 'utf8'), 'other');
  assert.ok([older, newer, other].every((file) => fs.existsSync(file)));
});

test('the folder search stops 3 levels below the mod folder, matches names in any case, and needs the file', (t) => {
  const tree = modTree(t);
  tree.put('1_1/A/B/C/Preview/preview_image.png');
  assert.equal(findModPreview(tree.install, '1'), null);
  tree.put('2_1/A/B/preview/PREVIEW_IMAGE.PNG', 'deep');
  assert.equal(fs.readFileSync(findModPreview(tree.install, '2'), 'utf8'), 'deep');
  tree.put('3_1/A/Preview/other.png');
  assert.equal(findModPreview(tree.install, '3'), null);
  tree.put('4_1/Preview/preview_image.png', 'top');
  assert.equal(fs.readFileSync(findModPreview(tree.install, '4'), 'utf8'), 'top');
});

test('a missing Mods folder, an unknown mod and a mod id that is not digits give nothing', (t) => {
  const bare = folder(t);
  assert.equal(findModPreview(bare, '928102'), null);
  const tree = modTree(t);
  tree.put('928102_1/A/Preview/preview_image.png');
  assert.equal(findModPreview(tree.install, '5'), null);
  // 92810 must not match 928102_..., and a path fragment is never used as a mod id.
  assert.equal(findModPreview(tree.install, '92810'), null);
  for (const bad of ['..', '928102_1/A', '9281 02', '', null, undefined, '9'.repeat(21)])
    assert.equal(findModPreview(tree.install, bad), null, String(bad));
});

test('a link that leads out of the Mods folder is refused', (t) => {
  const tree = modTree(t);
  const outside = folder(t);
  fs.mkdirSync(path.join(outside, 'Preview'));
  fs.writeFileSync(path.join(outside, 'Preview', 'preview_image.png'), 'secret');
  fs.mkdirSync(path.join(tree.mods, '77_1'), { recursive: true });
  try {
    // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
    fs.symlinkSync(outside, path.join(tree.mods, '77_1', 'Linked'), 'junction');
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return;
  }
  assert.equal(findModPreview(tree.install, '77'), null);
  // A link to the picture itself that points outside is refused as well.
  fs.mkdirSync(path.join(tree.mods, '78_1', 'A', 'Preview'), { recursive: true });
  try {
    fs.symlinkSync(
      path.join(outside, 'Preview', 'preview_image.png'),
      path.join(tree.mods, '78_1', 'A', 'Preview', 'preview_image.png'),
      'file',
    );
    assert.equal(findModPreview(tree.install, '78'), null);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  // A link that stays inside is fine.
  const inside = tree.put('79_1/Real/Preview/preview_image.png', 'inside');
  fs.mkdirSync(path.join(tree.mods, '79_2'), { recursive: true });
  const target = path.dirname(path.dirname(inside));
  fs.symlinkSync(target, path.join(tree.mods, '79_2', 'Alias'), 'junction');
  tree.age('79_1', 500);
  tree.age('79_2', 10);
  assert.equal(fs.readFileSync(findModPreview(tree.install, '79'), 'utf8'), 'inside');
});

test('a Mods folder that is itself a link out of the install is refused', (t) => {
  const install = folder(t);
  const outside = folder(t);
  fs.mkdirSync(path.join(outside, '80_1', 'A', 'Preview'), { recursive: true });
  fs.writeFileSync(path.join(outside, '80_1', 'A', 'Preview', 'preview_image.png'), 'secret');
  const parent = path.dirname(modsFolder(install));
  fs.mkdirSync(parent, { recursive: true });
  try {
    fs.symlinkSync(outside, modsFolder(install), 'junction');
  } catch (error) {
    t.skip(`links cannot be created here: ${error.code}`);
    return;
  }
  assert.equal(findModPreview(install, '80'), null);
  // Positive control: the same tree as a real folder inside the install is found.
  fs.rmSync(modsFolder(install), { recursive: true });
  fs.cpSync(outside, modsFolder(install), { recursive: true });
  assert.equal(fs.readFileSync(findModPreview(install, '80'), 'utf8'), 'secret');
});
