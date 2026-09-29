import fsp from 'node:fs/promises';
import path from 'node:path';
import { copyHashed } from '../import/phase0.js';

// Replacing files under a server takes three names beside each target, all ending in a tag that belongs to
// one job: `<name>.restore-<tag>` holds the new copy, `<name>.old-<tag>` holds what was there, and
// `<name>.absent-<tag>` is an empty marker for a target that did not exist. With those three, any stopping
// point, including a crash, can be undone by looking at the disk alone (see settle).

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MESSAGES = {
  changedWhileCopying: '{file} did not copy cleanly, so nothing was replaced.',
  cancelled: 'The job was cancelled.',
};

// Windows lets an antivirus scan or an indexer hold a folder for a moment, and a rename fails meanwhile.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      if (!RETRY_CODES.has(error.code) || attempt >= 6) throw error;
      await pause(100 * (attempt + 1));
    }
  }
}

export const defaultOps = {
  rename: renameWithRetry,
  rm: (target) => fsp.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }),
  mkdir: (dir) => fsp.mkdir(dir, { recursive: true }),
  copy: copyHashed,
  // Only a missing path counts as absent. Any other error (a permission problem, say) is thrown, since
  // treating it as "not there" could lead to a file being overwritten or removed.
  exists: (target) =>
    fsp.lstat(target).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      },
    ),
  list: (dir) => fsp.readdir(dir, { withFileTypes: true }).catch(() => []),
  marker: (target) => fsp.writeFile(target, ''),
};

export const artifact = (target, kind, tag) => `${target}.${kind}-${tag}`;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// A unit is one thing to replace. `folder` swaps a whole folder, `files` swaps single files inside `dir`.
// `files` lists { rel, relPath, size, sha256 }: where the file goes under the target and where it is in
// `source`, the backup folder. A folder unit with no files replaces the folder with nothing. In a `files`
// unit an entry marked `remove` has no copy: the target is moved aside and nothing takes its place.
export async function stageUnit(unit, { ops, tag, signal }) {
  const one = async (file, to) => {
    if (signal?.aborted) throw signal.reason ?? new Error(MESSAGES.cancelled);
    await ops.mkdir(path.dirname(to));
    const written = await ops.copy(path.join(unit.source, ...file.relPath.split('/')), to);
    if (written.sha256 !== file.sha256 || written.size !== file.size)
      throw new Error(fill(MESSAGES.changedWhileCopying, { file: file.relPath }));
  };
  if (unit.kind === 'folder') {
    if (!unit.files.length) return;
    const staging = artifact(unit.dir, 'restore', tag);
    await ops.rm(staging);
    await ops.mkdir(staging);
    for (const file of unit.files) await one(file, path.join(staging, ...file.rel.split('/')));
    return;
  }
  for (const file of unit.files) {
    if (file.remove) continue;
    const target = path.join(unit.dir, ...file.rel.split('/'));
    await ops.rm(artifact(target, 'restore', tag));
    await one(file, artifact(target, 'restore', tag));
  }
}

// Puts the staged copy in place. Nothing here checks the abort signal, so a pair of renames is never left
// half done by a cancel. `onStage` runs before each rename, so the pending row names where a stop would land.
export async function swapUnit(unit, { ops, tag, onStage = () => {} }) {
  const replace = async (target, staged) => {
    const exists = await ops.exists(target);
    if (exists) {
      await onStage();
      await ops.rename(target, artifact(target, 'old', tag));
    } else if (staged) {
      await ops.marker(artifact(target, 'absent', tag));
    }
    if (staged) {
      await onStage();
      await ops.rename(artifact(target, 'restore', tag), target);
    }
  };
  if (unit.kind === 'folder') return replace(unit.dir, unit.files.length > 0);
  for (const file of unit.files) await replace(path.join(unit.dir, ...file.rel.split('/')), !file.remove);
}

const ARTIFACT = /^(.+)\.(old|restore|absent)-(\d+r?)$/;

// Undoes or finishes what one tag left on disk.
//   undo:   every target goes back to what `.old` holds, a target that did not exist is removed again, and
//           every staged copy is dropped. The files end up exactly as they were before the job.
//   finish: the swap was complete, so the leftovers of the old files are removed.
// Every target is tried even if one fails, and the first failure is thrown at the end.
export async function settle({ roots, tag, mode, ops }) {
  let failure = null;
  const attempt = async (step) => {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  };
  let touched = 0;
  const seen = new Set();
  // Every folder under the roots can hold something a job left beside a target, at any depth: a settings
  // snapshot may carry a file in a subfolder. Artifact folders are not entered (they are handled as
  // targets), and links and junctions are never followed. A folder is listed just before it is settled, so
  // what an earlier step put back is what gets scanned.
  const visit = async (folder) => {
    if (seen.has(folder)) return;
    seen.add(folder);
    const entries = await ops.list(folder);
    const groups = new Map();
    for (const entry of entries) {
      const match = ARTIFACT.exec(entry.name);
      if (!match || match[3] !== tag) continue;
      const group = groups.get(match[1]) ?? {};
      group[match[2]] = path.join(folder, entry.name);
      groups.set(match[1], group);
    }
    for (const [name, group] of groups) {
      const target = path.join(folder, name);
      touched++;
      await attempt(async () => {
        if (mode === 'finish') {
          for (const leftover of [group.restore, group.old, group.absent]) if (leftover) await ops.rm(leftover);
          return;
        }
        if (group.restore) await ops.rm(group.restore);
        if (group.old) {
          if (await ops.exists(target)) await ops.rm(target);
          await ops.rename(group.old, target);
        } else if (group.absent) {
          await ops.rm(target);
        }
        if (group.absent) await ops.rm(group.absent);
      });
    }
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !ARTIFACT.test(entry.name))
        await visit(path.join(folder, entry.name));
  };
  for (const root of roots) await visit(root);
  if (failure) throw failure;
  return { touched };
}
