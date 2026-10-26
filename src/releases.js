import fs from 'node:fs/promises';
import path from 'node:path';

// The published repository. Change this constant to point at another fork or mirror before release.
export const UPDATE_REPO = 'neostryder/ark-overseer';
export const UPDATE_CHANNELS = ['stable', 'beta', 'edge'];
export const RELEASE_MESSAGES = {
  badChannel: 'Choose Stable, Beta or Edge.',
  rateLimited: 'GitHub is limiting how often it is asked. Try again later.',
  unreachable: "GitHub could not be reached. Check this computer's connection.",
  unreadable: 'The release list could not be read.',
  noReleases: 'No releases were found for this channel.',
};
const CACHE_MS = 10 * 60 * 1000;
// A failed check is remembered only briefly, so Try again works as soon as GitHub or the network recovers.
const FAILURE_CACHE_MS = 60 * 1000;
// Optional file in the data folder that holds a GitHub access key: {"githubToken": "..."}. A signed-in
// request gets GitHub's far higher rate limit than an anonymous one, which shares 60 an hour per address.
export const GITHUB_FILE = 'github.json';
// vX.Y.Z is a stable release; vX.Y.Z-beta.N is a beta. Anything else, such as a release candidate, is ignored.
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function parseTag(tag) {
  const match = TAG.exec(typeof tag === 'string' ? tag : '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
    tag,
  };
}

// Versions compare by number, never as text: v1.10.0 is newer than v1.9.0. For the same version a plain
// release is newer than a beta, so v1.2.0 beats v1.2.0-beta.3.
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseTag(a) : a;
  const pb = typeof b === 'string' ? parseTag(b) : b;
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const betaA = pa.beta === null ? Number.POSITIVE_INFINITY : pa.beta;
  const betaB = pb.beta === null ? Number.POSITIVE_INFINITY : pb.beta;
  if (betaA === betaB) return 0;
  return betaA < betaB ? -1 : 1;
}

function packageAsset(release) {
  const tag = release?.tag_name;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (tag === 'edge') {
    const matches = assets.filter((asset) =>
      /^ark-overseer-\d+\.\d+\.\d+-edge\.[0-9a-f]{7,40}-win-x64\.zip$/.test(asset?.name ?? ''),
    );
    if (matches.length !== 1) return null;
    const asset = matches[0];
    const version = asset.name.slice('ark-overseer-'.length, -'-win-x64.zip'.length);
    const checksum = assets.filter((item) => item?.name === `${asset.name}.sha256`);
    if (checksum.length !== 1) return null;
    return { name: asset.name, size: Number.isFinite(asset.size) ? asset.size : null, version };
  }
  const parsed = parseTag(tag);
  if (!parsed) return null;
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.beta === null ? '' : `-beta.${parsed.beta}`}`;
  const name = `ark-overseer-${version}-win-x64.zip`;
  const matches = assets.filter((asset) => asset?.name === name);
  const checksums = assets.filter((asset) => asset?.name === `${name}.sha256`);
  if (matches.length !== 1 || checksums.length !== 1) return null;
  return { name, size: Number.isFinite(matches[0].size) ? matches[0].size : null, version };
}

function releaseItem(release, { requirePackage = true } = {}) {
  const asset = packageAsset(release);
  if (requirePackage && !asset) return null;
  if (release?.tag_name === 'edge') {
    if (!asset) return null;
    return {
      kind: 'edge',
      tag: 'edge',
      version: asset.version,
      beta: null,
      body: typeof release.body === 'string' ? release.body : '',
      url: typeof release.html_url === 'string' ? release.html_url : null,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      commit: asset.version.match(/edge\.([0-9a-f]+)$/)?.[1] ?? null,
      asset,
    };
  }
  const parsed = parseTag(release?.tag_name);
  if (!parsed) return null;
  return {
    kind: 'release',
    tag: parsed.tag,
    version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    beta: parsed.beta,
    body: typeof release.body === 'string' ? release.body : '',
    url: typeof release.html_url === 'string' ? release.html_url : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    commit: null,
    asset,
  };
}

// The releases that count for a channel, newest first. Drafts and tags that are not vX.Y.Z or
// vX.Y.Z-beta.N are dropped. Stable keeps only plain versions; Beta keeps plain versions and betas.
export function selectReleases(releases, channel) {
  return (
    (Array.isArray(releases) ? releases : [])
      .filter((release) => !release?.draft)
      // Releases without both package files cannot be installed by the elevated updater.
      .map((release) => releaseItem(release))
      .filter(Boolean)
      .filter((item) => (channel === 'stable' ? item.beta === null : true))
      .sort((a, b) => compareVersions(b.tag, a.tag))
  );
}

// Reads the access key on every check, so adding or changing the file needs no restart. A missing or
// unreadable file means checks go out anonymously.
export function githubKeyFromFile(dataDir, readFile = fs.readFile) {
  const file = path.join(dataDir, GITHUB_FILE);
  return async () => {
    try {
      const value = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
      return typeof value?.githubToken === 'string' && value.githubToken.trim() ? value.githubToken.trim() : null;
    } catch {
      return null;
    }
  };
}

function messageFor(error) {
  if (error?.code === 'rate_limited') return RELEASE_MESSAGES.rateLimited;
  if (error?.code === 'unreachable') return RELEASE_MESSAGES.unreachable;
  return RELEASE_MESSAGES.unreadable;
}

async function fetchJson({ fetchImpl, url, headers }) {
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    throw Object.assign(new Error(RELEASE_MESSAGES.unreachable), { code: 'unreachable' });
  }
  if (!response.ok) {
    if (response.status === 401) throw Object.assign(new Error(RELEASE_MESSAGES.unreadable), { code: 'unauthorized' });
    const limited =
      response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    throw Object.assign(new Error(limited ? RELEASE_MESSAGES.rateLimited : RELEASE_MESSAGES.unreadable), {
      code: limited ? 'rate_limited' : 'unreadable',
    });
  }
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error(RELEASE_MESSAGES.unreadable), { code: 'unreadable' });
  }
}

async function loadChannel({ baseUrl, repo, fetchImpl, channel, readKey, log }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ark-overseer' };
  const url = `${baseUrl}/repos/${repo}/releases?per_page=100`;
  const key = await readKey().catch(() => null);
  let releases;
  try {
    releases = await fetchJson({
      fetchImpl,
      url,
      headers: key ? { ...headers, Authorization: `Bearer ${key}` } : headers,
    });
  } catch (error) {
    if (!key || error.code !== 'unauthorized') throw error;
    // GitHub refused the key (expired or revoked): fall back to an anonymous check rather than failing the update.
    log('Release check: GitHub refused the key in github.json, so the check went out anonymously.');
    releases = await fetchJson({ fetchImpl, url, headers });
  }
  if (channel === 'edge') {
    const release = Array.isArray(releases) ? releases.find((item) => !item?.draft && item?.tag_name === 'edge') : null;
    const newest = release && releaseItem(release);
    if (!newest) throw Object.assign(new Error(RELEASE_MESSAGES.noReleases), { code: 'unreadable' });
    return { ok: true, channel, newest, history: [] };
  }
  const items = selectReleases(releases, channel);
  if (!items.length) throw Object.assign(new Error(RELEASE_MESSAGES.noReleases), { code: 'unreadable' });
  const [newest, ...history] = items;
  return { ok: true, channel, newest, history };
}

// Asks GitHub for the newest release on a channel, at most once every ten minutes per channel. A good answer is
// cached for ten minutes and a failure for one, so the page can open and re-check without hammering GitHub.
export function createReleaseChecker({
  baseUrl = 'https://api.github.com',
  repo = UPDATE_REPO,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheMs = CACHE_MS,
  failureCacheMs = FAILURE_CACHE_MS,
  readKey = async () => null,
  log = () => {},
} = {}) {
  const cache = new Map();
  async function check(channel) {
    if (!UPDATE_CHANNELS.includes(channel))
      throw Object.assign(new Error(RELEASE_MESSAGES.badChannel), { status: 400 });
    const cached = cache.get(channel);
    if (cached && now() - cached.at < (cached.value.ok ? cacheMs : failureCacheMs)) return cached.value;
    let value;
    try {
      value = await loadChannel({ baseUrl, repo, fetchImpl, channel, readKey, log });
      value.checkedAt = new Date(now()).toISOString();
    } catch (error) {
      value = { ok: false, channel, message: messageFor(error) };
    }
    cache.set(channel, { at: now(), value });
    return value;
  }
  return { check, repo, baseUrl };
}
