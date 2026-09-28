import fs from 'node:fs';
import path from 'node:path';

const LINK = /^ark-overseer-update(-[a-z0-9_-]{1,64})?$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};
const isoOrNull = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

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
  const options = readJson(path.join(dataDir, 'updater.json'));
  const link = typeof options?.link === 'string' && LINK.test(options.link) ? options.link : null;
  const appDir = typeof options?.appDir === 'string' && path.win32.isAbsolute(options.appDir) ? options.appDir : null;
  const result = readJson(path.join(logsDir, 'update-result.json'));
  const lastUpdate =
    result && typeof result === 'object'
      ? {
          ok: result.ok === true,
          endedAt: isoOrNull(result.endedAt),
          commit: typeof result.commit === 'string' && COMMIT.test(result.commit) ? result.commit : null,
          message: typeof result.message === 'string' ? result.message.slice(0, 500) : null,
        }
      : null;
  return {
    commit,
    startedAt,
    available: Boolean(serviceMode && link && appDir),
    link: serviceMode ? link : null,
    appDir: serviceMode ? appDir : null,
    logsDir: serviceMode ? logsDir : null,
    lastUpdate,
  };
}
