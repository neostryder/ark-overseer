import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotFiles, hashFile } from '../import/phase0.js';
import { collectFiles } from '../scheduler/backup.js';
import { serverPaths } from '../supervisor/launch.js';
import { readManifest, CONFIG_PREFIX } from '../backups/read.js';
import { artifact, defaultOps } from '../backups/swap.js';

// A baseline is a copy of the settings folder exactly as ARK Overseer last wrote or accepted it. It lives in
// `<dataDir>/baselines/server-<id>/`, in the same layout a snapshot uses, with `baseline.json` as its file
// list. Only the current one is kept. A new one is built beside the old one and renamed over it, and the old
// folder is removed last, so a stop at any point leaves either whole baseline (see healBaseline).

export const BASELINE_FILE = 'baseline.json';

export const baselinesRoot = (dataDir) => path.join(dataDir, 'baselines');
export const baselineDir = (dataDir, serverId) => path.join(baselinesRoot(dataDir), `server-${serverId}`);
// The folder inside a baseline that holds the settings files.
export const baselineConfigDir = (folder) => path.join(folder, ...CONFIG_PREFIX.split('/'));

const byRel = (a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase());

// Every file in the server's settings folder, with the size and change time the cheap check compares. A file
// that disappears while the folder is read is left out.
export function listLiveFiles(installPath) {
  const sources = [];
  collectFiles(serverPaths(installPath).configDir, CONFIG_PREFIX, sources);
  const files = [];
  for (const source of sources) {
    try {
      const stat = fs.statSync(source.path);
      files.push({
        path: source.path,
        relPath: source.relPath,
        rel: source.relPath.slice(CONFIG_PREFIX.length + 1),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      /* the file went away while the folder was read */
    }
  }
  return files.sort(byRel);
}

// One hash for a set of files: their names, sizes and content hashes. Letter case in a name is ignored, as it is
// on Windows.
export function signature(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort(byRel))
    hash.update(`${file.relPath.toLowerCase()}\t${file.size}\t${file.sha256}\n`);
  return hash.digest('hex');
}

// What the cheap check compares before it hashes anything.
export const statSignature = (files) => files.map((file) => `${file.relPath}|${file.size}|${file.mtimeMs}`).join('\n');

// A stop between the two renames leaves the old baseline beside a missing one; this puts it back. A half-built
// new baseline is always removed.
export async function healBaseline(dataDir, serverId, ops = defaultOps) {
  const dir = baselineDir(dataDir, serverId);
  await ops.rm(artifact(dir, 'restore', 'new'));
  const old = artifact(dir, 'old', 'prev');
  if (!(await ops.exists(dir)) && (await ops.exists(old))) await ops.rename(old, dir);
}

// The baseline folder, its file list and the hash of that list, or null when it is missing or unreadable.
export async function readBaselineFolder(dataDir, serverId, ops = defaultOps) {
  const dir = baselineDir(dataDir, serverId);
  try {
    await healBaseline(dataDir, serverId, ops);
    const manifest = await readManifest(dir, BASELINE_FILE);
    const { sha256 } = await hashFile(path.join(dir, BASELINE_FILE));
    return { folder: dir, files: manifest.files, sha256 };
  } catch {
    return null;
  }
}

// Copies `sources` ({ path, relPath }) into a new baseline and puts it in place of the old one. Returns the
// hash of the file list and the files as they were copied.
export async function writeBaseline({ dataDir, serverId, sources, ops = defaultOps, signal }) {
  const dir = baselineDir(dataDir, serverId);
  const staging = artifact(dir, 'restore', 'new');
  const old = artifact(dir, 'old', 'prev');
  await healBaseline(dataDir, serverId, ops);
  const snapshot = await snapshotFiles(sources, staging, { manifestName: BASELINE_FILE, signal });
  let moved = false;
  try {
    if (await ops.exists(dir)) {
      await ops.rm(old).catch(() => {});
      await ops.rename(dir, old);
      moved = true;
    }
    await ops.rename(staging, dir);
  } catch (error) {
    if (moved) await ops.rename(old, dir).catch(() => {});
    await ops.rm(staging).catch(() => {});
    throw error;
  }
  await ops.rm(old).catch(() => {});
  return { sha256: snapshot.sha256, files: snapshot.files };
}

export async function removeBaselineFolder(dataDir, serverId, ops = defaultOps) {
  const dir = baselineDir(dataDir, serverId);
  for (const target of [dir, artifact(dir, 'restore', 'new'), artifact(dir, 'old', 'prev')]) await ops.rm(target);
}
