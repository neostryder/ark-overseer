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

async function loadChannel({ baseUrl, repo, fetchImpl, channel }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ark-overseer' };
  const releases = await fetchJson({
    fetchImpl,
    url: `${baseUrl}/repos/${repo}/releases?per_page=100`,
    headers,
  });
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

// Asks GitHub for the newest release on a channel, at most once every ten minutes per channel. The
// answer, including a failure, is cached so the page can open and re-check without hammering GitHub.
export function createReleaseChecker({
  baseUrl = 'https://api.github.com',
  repo = UPDATE_REPO,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheMs = CACHE_MS,
} = {}) {
  const cache = new Map();
  async function check(channel) {
    if (!UPDATE_CHANNELS.includes(channel))
      throw Object.assign(new Error(RELEASE_MESSAGES.badChannel), { status: 400 });
    const cached = cache.get(channel);
    if (cached && now() - cached.at < cacheMs) return cached.value;
    let value;
    try {
      value = await loadChannel({ baseUrl, repo, fetchImpl, channel });
      value.checkedAt = new Date(now()).toISOString();
    } catch (error) {
      value = { ok: false, channel, message: messageFor(error) };
    }
    cache.set(channel, { at: now(), value });
    return value;
  }
  return { check, repo, baseUrl };
}
