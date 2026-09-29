import fs from 'node:fs';
import path from 'node:path';

const LINK = /^ark-overseer-update(-[a-z0-9_-]{1,64})?$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

export const UPDATE_SOURCES = ['checkout', 'github'];
export const UPDATE_CHANNELS = ['stable', 'beta', 'edge'];
// A tag the elevated updater accepts: vX.Y.Z or vX.Y.Z-beta.N, nothing else.
export const UPDATE_TAG = /^v\d+\.\d+\.\d+(-beta\.\d+)?$/;
export const UPDATE_COMMIT = /^[0-9a-f]{40}$/;
export const CHECKOUT_MESSAGES = {
  badFolder: 'Choose a full folder path on this computer.',
  notCheckout: 'That folder is not an ARK Overseer checkout.',
  unreadable: 'That folder could not be read.',
};
export const REQUEST_MESSAGES = {
  badSource: 'Choose where to update from.',
  badCheckout: 'Choose a full folder path on this computer.',
  badChannel: 'Choose Stable, Beta or Edge.',
  badRef: 'That release is not one ARK Overseer can install.',
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};
const isoOrNull = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

// Reads a git checkout without running git: the service account does not own the repository, and git
// refuses a repository owned by another user. It reads .git/HEAD, the ref that names, and package.json.
export function readCheckout(folder) {
  if (typeof folder !== 'string' || !folder) return { ok: false, message: CHECKOUT_MESSAGES.badFolder };
  const manifest = readJson(path.join(folder, 'package.json'));
  if (manifest?.name !== 'ark-overseer') return { ok: false, message: CHECKOUT_MESSAGES.notCheckout };
  const gitDir = path.join(folder, '.git');
  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return { ok: false, message: CHECKOUT_MESSAGES.notCheckout };
  }
  let commit = null;
  let stampFile = path.join(gitDir, 'HEAD');
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (ref) {
    const name = ref[1].trim();
    const loose = path.join(gitDir, name);
    try {
      commit = fs.readFileSync(loose, 'utf8').trim();
      stampFile = loose;
    } catch {
      commit = packedRef(gitDir, name);
    }
  } else if (UPDATE_COMMIT.test(head)) {
    commit = head;
  }
  if (!commit || !UPDATE_COMMIT.test(commit)) return { ok: false, message: CHECKOUT_MESSAGES.unreadable };
  // The commit date lives inside a compressed git object, so the ref file's own time is the closest
  // plain read: it changes when the branch moves.
  let date = null;
  try {
    date = fs.statSync(stampFile).mtime.toISOString();
  } catch {
    /* a ref file that just vanished leaves the date out */
  }
  return { ok: true, path: folder, commit: commit.toLowerCase(), date };
}

function packedRef(gitDir, name) {
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === name && UPDATE_COMMIT.test(parts[0])) return parts[0];
    }
  } catch {
    /* no packed-refs file */
  }
  return null;
}

// The strict shape the service may ask an administrator to act on. The repository never comes from here.
export function buildUpdateRequest(body, requestedAt) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Object.assign(new Error(REQUEST_MESSAGES.badSource), { status: 400 });
  if (!UPDATE_SOURCES.includes(body.source))
    throw Object.assign(new Error(REQUEST_MESSAGES.badSource), { status: 400 });
  const request = { source: body.source, requestedAt };
  if (body.source === 'checkout') {
    if (typeof body.checkout !== 'string' || !/^[A-Za-z]:[\\/]/.test(body.checkout) || /^\\\\/.test(body.checkout))
      throw Object.assign(new Error(REQUEST_MESSAGES.badCheckout), { status: 400 });
    request.checkout = body.checkout;
    return request;
  }
  const channel = body.channel ?? 'stable';
  if (!UPDATE_CHANNELS.includes(channel)) throw Object.assign(new Error(REQUEST_MESSAGES.badChannel), { status: 400 });
  request.channel = channel;
  if (body.ref !== undefined && body.ref !== null && body.ref !== '') {
    if (!UPDATE_TAG.test(body.ref) && !UPDATE_COMMIT.test(body.ref))
      throw Object.assign(new Error(REQUEST_MESSAGES.badRef), { status: 400 });
    request.ref = body.ref;
  }
  return request;
}

export function writeUpdateRequest(dataDir, request) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'update-request.json');
  fs.writeFileSync(file, JSON.stringify(request));
  return file;
}

// What the This computer page needs to offer an update: the commit this copy was deployed from, when the
// process started (a new start means the update finished), whether service.ps1 registered the update link,
// and how the last update went. tools/update.ps1 writes that last part to the logs folder.
export function readUpdateInfo({ root, dataDir, logsDir, startedAt, serviceMode }) {
  let commit = null;
  try {
    const text = fs.readFileSync(path.join(root, '.deployed-commit'), 'utf8').trim();
    if (COMMIT.test(text)) commit = text;
  } catch {
    /* a checkout run by hand has no deployed commit */
  }
  const manifest = readJson(path.join(root, 'package.json'));
  const version = typeof manifest?.version === 'string' ? manifest.version : null;
  const options = readJson(path.join(dataDir, 'updater.json'));
  const link = typeof options?.link === 'string' && LINK.test(options.link) ? options.link : null;
  const appDir = typeof options?.appDir === 'string' && path.win32.isAbsolute(options.appDir) ? options.appDir : null;
  const result = readJson(path.join(logsDir, 'update-result.json'));
  let progress = null;
  try {
    const candidate = JSON.parse(
      fs.readFileSync(path.join(logsDir, 'update-progress.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    const stages = new Set([
      'requested',
      'checking',
      'downloading',
      'verifying',
      'installing',
      'restarting',
      'done',
      'failed',
    ]);
    const at = typeof candidate?.at === 'string' ? Date.parse(candidate.at) : NaN;
    if (
      candidate &&
      stages.has(candidate.stage) &&
      Number.isFinite(at) &&
      (Date.now() - at <= 15 * 60 * 1000 || candidate.stage === 'done' || candidate.stage === 'failed')
    ) {
      progress = {
        startedAt: isoOrNull(candidate.startedAt),
        at: isoOrNull(candidate.at),
        stage: candidate.stage,
        message: typeof candidate.message === 'string' ? candidate.message.slice(0, 240) : '',
        step: typeof candidate.step === 'string' ? candidate.step.slice(0, 240) : null,
        source: typeof candidate.source === 'string' ? candidate.source : null,
      };
    }
  } catch {
    /* Progress is advisory; a malformed file must not break this route. */
  }
  const lastUpdate =
    result && typeof result === 'object'
      ? {
          ok: result.ok === true,
          endedAt: isoOrNull(result.endedAt),
          commit: typeof result.commit === 'string' && COMMIT.test(result.commit) ? result.commit : null,
          source: typeof result.source === 'string' ? result.source : null,
          channel: typeof result.channel === 'string' ? result.channel : null,
          ref: typeof result.ref === 'string' ? result.ref : null,
          asset: typeof result.asset === 'string' ? result.asset : null,
          sha256: typeof result.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(result.sha256) ? result.sha256 : null,
          message: typeof result.message === 'string' ? result.message.slice(0, 500) : null,
        }
      : null;
  return {
    version,
    commit,
    startedAt,
    available: Boolean(serviceMode && link && appDir),
    package: options?.package === true,
    link: serviceMode ? link : null,
    appDir: serviceMode ? appDir : null,
    logsDir: serviceMode ? logsDir : null,
    lastUpdate,
    progress,
  };
}
