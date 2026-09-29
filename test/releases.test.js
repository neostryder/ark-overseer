import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  UPDATE_REPO,
  compareVersions,
  parseTag,
  selectReleases,
  createReleaseChecker,
  RELEASE_MESSAGES,
} from '../src/releases.js';

const RELEASES = [
  {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: false,
    body: 'One',
    html_url: 'u1',
    published_at: '2026-01-01T00:00:00Z',
  },
  {
    tag_name: 'v1.2.0',
    draft: false,
    prerelease: false,
    body: 'Two',
    html_url: 'u2',
    published_at: '2026-01-02T00:00:00Z',
  },
  {
    tag_name: 'v1.3.0-beta.1',
    draft: false,
    prerelease: true,
    body: 'Beta one',
    html_url: 'ub1',
    published_at: '2026-01-03T00:00:00Z',
  },
  {
    tag_name: 'v1.3.0-beta.2',
    draft: false,
    prerelease: true,
    body: 'Beta two',
    html_url: 'ub2',
    published_at: '2026-01-04T00:00:00Z',
  },
  {
    tag_name: 'v1.4.0-rc.1',
    draft: false,
    prerelease: true,
    body: 'RC',
    html_url: 'urc',
    published_at: '2026-01-05T00:00:00Z',
  },
  {
    tag_name: 'v9.0.0',
    draft: true,
    prerelease: false,
    body: 'Draft',
    html_url: 'ud',
    published_at: '2026-01-06T00:00:00Z',
  },
];
for (const release of RELEASES) {
  if (!/^v\d+\.\d+\.\d+(-beta\.\d+)?$/.test(release.tag_name)) continue;
  const version = release.tag_name.slice(1);
  const name = `ark-overseer-${version}-win-x64.zip`;
  release.assets = [
    { name, size: 1024, browser_download_url: `https://github.com/${name}` },
    { name: `${name}.sha256`, size: 80, browser_download_url: `https://github.com/${name}.sha256` },
  ];
}
const EDGE_RELEASE = {
  tag_name: 'edge',
  draft: false,
  body: 'Latest work',
  assets: [
    { name: 'ark-overseer-1.4.2-edge.abcdef0-win-x64.zip', size: 2048 },
    { name: 'ark-overseer-1.4.2-edge.abcdef0-win-x64.zip.sha256' },
  ],
};

async function fakeGitHub(t, routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json', ...(route.headers ?? {}) });
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

const releasesUrl = `/repos/${UPDATE_REPO}/releases?per_page=100`;

test('tags parse only as vX.Y.Z or vX.Y.Z-beta.N and versions compare by number', () => {
  assert.deepEqual(parseTag('v1.2.3'), { major: 1, minor: 2, patch: 3, beta: null, tag: 'v1.2.3' });
  assert.equal(parseTag('v1.2.3-beta.4').beta, 4);
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v1.2.3-beta', 'v1.2.3-beta.x', 'release'])
    assert.equal(parseTag(bad), null, bad);
  // v1.10.0 is newer than v1.9.0: text order would say the opposite.
  assert.ok(compareVersions('v1.10.0', 'v1.9.0') > 0);
  assert.ok(compareVersions('v1.9.0', 'v1.10.0') < 0);
  // A plain release beats a beta of the same version.
  assert.ok(compareVersions('v1.3.0', 'v1.3.0-beta.9') > 0);
  assert.ok(compareVersions('v1.3.0-beta.2', 'v1.3.0-beta.1') > 0);
  assert.equal(compareVersions('v2.0.0', 'v2.0.0'), 0);
});

test('Stable skips betas, drafts and tags that are not plain versions, and keeps earlier ones', () => {
  const stable = selectReleases(RELEASES, 'stable');
  assert.deepEqual(
    stable.map((item) => item.tag),
    ['v1.2.0', 'v1.1.0'],
  );
  assert.equal(stable[0].body, 'Two');
});

test('releases without exact package assets are skipped, including duplicate packages', () => {
  const releases = [
    { ...RELEASES[1], assets: [] },
    { ...RELEASES[0], assets: [...RELEASES[0].assets, RELEASES[0].assets[0]] },
    {
      ...RELEASES[2],
      assets: [{ ...RELEASES[2].assets[0], name: 'ark-overseer-1.3.0-beta.1-win-arm64.zip' }, RELEASES[2].assets[1]],
    },
    RELEASES[2],
  ];
  assert.deepEqual(
    selectReleases(releases, 'beta').map((item) => item.tag),
    ['v1.3.0-beta.1'],
  );
});

test('Beta takes the newest of the plain releases and the betas', () => {
  const beta = selectReleases(RELEASES, 'beta');
  assert.deepEqual(
    beta.map((item) => item.tag),
    ['v1.3.0-beta.2', 'v1.3.0-beta.1', 'v1.2.0', 'v1.1.0'],
  );
});

test('the checker reads the newest stable release and the earlier ones from GitHub', async (t) => {
  const { baseUrl, requests } = await fakeGitHub(t, { [releasesUrl]: { body: RELEASES } });
  const checker = createReleaseChecker({ baseUrl, repo: UPDATE_REPO });
  const result = await checker.check('stable');
  assert.equal(result.ok, true);
  assert.equal(result.newest.tag, 'v1.2.0');
  assert.equal(result.newest.body, 'Two');
  assert.deepEqual(
    result.history.map((item) => item.tag),
    ['v1.1.0'],
  );
  assert.equal(requests.length, 1);
});

test('a release without the package is skipped by the GitHub channel check', async (t) => {
  const releases = RELEASES.map((release) => ({ ...release }));
  releases.find((release) => release.tag_name === 'v1.2.0').assets = [];
  const { baseUrl } = await fakeGitHub(t, { [releasesUrl]: { body: releases } });
  const result = await createReleaseChecker({ baseUrl }).check('stable');
  assert.equal(result.ok, true);
  assert.equal(result.newest.tag, 'v1.1.0');
  assert.deepEqual(result.history, []);
});

test('the checker takes the newest beta when the channel is Beta', async (t) => {
  const { baseUrl } = await fakeGitHub(t, { [releasesUrl]: { body: RELEASES } });
  const result = await createReleaseChecker({ baseUrl }).check('beta');
  assert.equal(result.ok, true);
  assert.equal(result.newest.tag, 'v1.3.0-beta.2');
  assert.deepEqual(
    result.history.map((item) => item.tag),
    ['v1.3.0-beta.1', 'v1.2.0', 'v1.1.0'],
  );
});

test('Edge reads the rolling edge release package and has no earlier releases', async (t) => {
  const { baseUrl, requests } = await fakeGitHub(t, { [releasesUrl]: { body: [EDGE_RELEASE] } });
  const result = await createReleaseChecker({ baseUrl }).check('edge');
  assert.equal(result.ok, true);
  assert.equal(result.newest.kind, 'edge');
  assert.equal(result.newest.version, '1.4.2-edge.abcdef0');
  assert.equal(result.newest.commit, 'abcdef0');
  assert.equal(result.newest.asset.size, 2048);
  assert.equal(result.newest.body, 'Latest work');
  assert.deepEqual(result.history, []);
  assert.deepEqual(requests, [releasesUrl]);
});

test('a second check within ten minutes is served from the cache, and after that GitHub is asked again', async (t) => {
  let now = 1_000_000;
  const { baseUrl, requests } = await fakeGitHub(t, { [releasesUrl]: { body: RELEASES } });
  const checker = createReleaseChecker({ baseUrl, now: () => now });
  await checker.check('stable');
  await checker.check('stable');
  assert.equal(requests.length, 1);
  // Exactly ten minutes later the cached answer is still fresh.
  now += 10 * 60 * 1000 - 1;
  await checker.check('stable');
  assert.equal(requests.length, 1);
  now += 2;
  await checker.check('stable');
  assert.equal(requests.length, 2);
  // The cache is per channel: Beta is asked for on its own.
  await checker.check('beta');
  assert.equal(requests.length, 3);
});

test('a rate limit and a network failure are plain messages, and the rest keeps working', async (t) => {
  const limited = await fakeGitHub(t, {
    [releasesUrl]: { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'rate limit' } },
  });
  const limitedResult = await createReleaseChecker({ baseUrl: limited.baseUrl }).check('stable');
  assert.equal(limitedResult.ok, false);
  assert.equal(limitedResult.message, RELEASE_MESSAGES.rateLimited);
  // A later channel that succeeds still answers while another one failed.
  const ok = await fakeGitHub(t, { [releasesUrl]: { body: RELEASES } });
  const checker = createReleaseChecker({ baseUrl: ok.baseUrl });
  assert.equal((await checker.check('stable')).ok, true);

  // A closed port is a network failure, not a crash.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  const unreachable = await createReleaseChecker({ baseUrl: closedUrl }).check('stable');
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.message, RELEASE_MESSAGES.unreachable);
});

test('an unknown channel is refused before any request', async () => {
  await assert.rejects(
    () => createReleaseChecker({ baseUrl: 'http://127.0.0.1:1' }).check('nightly'),
    /Stable, Beta or Edge/,
  );
});
