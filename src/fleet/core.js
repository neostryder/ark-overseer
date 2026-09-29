import fs from 'node:fs/promises';
import path from 'node:path';
import { SESSION_NAME_MAX_LENGTH } from '../settings/fields.js';
import { checkActionOptions } from '../clusters/core.js';

// Sizes are decimal gigabytes, the same unit as the free-space line on the Overview page.
export const gigabytes = (bytes) => (Number(bytes) / 1e9).toFixed(1);

export const MESSAGES = {
  folderUnreadable: 'ARK Overseer cannot open that folder.',
  badFolder: 'Choose a full folder path outside a Steam library.',
  folderUsed: 'That folder is already an install.',
  folderNotEmpty: 'Choose an empty folder.',
  noSpace: 'This copy needs {required} GB free on that drive, and it has {free} GB.',
  badName: 'Give the server a name of up to 64 characters.',
  badSession: 'Give the session a name of up to 60 characters without a question mark or quote.',
  nameTaken: 'A server with this name already exists.',
  badAction: 'Choose servers and a supported action.',
  busy: 'Another job is queued or running for one of these servers or folders.',
  missing: 'The server was not found.',
  copyFailed: 'The copy to {target} failed. The server is still in {source}. The copied folder was kept.',
  startFailed: 'The server moved from {source} to {target}, but it did not start. Review the new folder.',
  network: 'Windows Firewall rules name the server by its folder, so open the Network page and add any rules it lists.',
  oldFolder: 'The old folder is {source}. You can delete it after the server runs well from {target}.',
  cancelled: 'The job was cancelled.',
  saveFailed: 'The world could not be saved before copying.',
  copying: 'Copying server files.',
  validating: 'Validating the new install.',
  pathTooLong: 'This folder path is too long for some of the server files. Choose a shorter one, such as D:\\ARK.',
};
export const folderKey = (value) =>
  path.win32
    .normalize(String(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
export function checkFolder(value) {
  if (
    typeof value !== 'string' ||
    !path.win32.isAbsolute(value) ||
    !/^[A-Za-z]:[\\/]/.test(value) ||
    /["\r\n]/.test(value) ||
    value.split(/[\\/]/).includes('..') ||
    /[\\/]steamapps[\\/]/i.test(value)
  )
    throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
  const normalized = path.win32.normalize(value).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(normalized)) throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
  return normalized;
}
export function checkClone(body, db) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Object.assign(new Error(MESSAGES.badName), { status: 400 });
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 64 || /[\x00-\x1f]/.test(name))
    throw Object.assign(new Error(MESSAGES.badName), { status: 400 });
  const sessionName = typeof body.sessionName === 'string' ? body.sessionName.trim() : '';
  if (!sessionName || sessionName.length > SESSION_NAME_MAX_LENGTH || /[?"\r\n]/.test(sessionName))
    throw Object.assign(new Error(MESSAGES.badSession), { status: 400 });
  if (db.prepare('SELECT 1 FROM servers WHERE name = ? COLLATE NOCASE').get(name))
    throw Object.assign(new Error(MESSAGES.nameTaken), { status: 409 });
  if (body.copyWorld !== undefined && typeof body.copyWorld !== 'boolean')
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  if (body.adminPassword !== undefined && typeof body.adminPassword !== 'string')
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  if (body.joinPassword !== undefined && typeof body.joinPassword !== 'string')
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  return {
    name,
    sessionName,
    copyWorld: body.copyWorld === true,
    path: checkFolder(body.path),
    ...(body.adminPassword === undefined ? {} : { adminPassword: body.adminPassword }),
    ...(body.joinPassword === undefined ? {} : { joinPassword: body.joinPassword }),
  };
}
export function checkFleet(body, db) {
  if (
    !body ||
    !['start', 'stop', 'restart', 'update'].includes(body.action) ||
    !Array.isArray(body.serverIds) ||
    !body.serverIds.length ||
    body.serverIds.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(body.serverIds).size !== body.serverIds.length
  )
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  const options = checkActionOptions(
    body.options ?? { countdownMinutes: body.countdownMinutes, announce: body.announce },
  );
  const rows = db
    .prepare(
      `SELECT s.*, i.path AS install_path, i.source AS install_source FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id IN (${body.serverIds.map(() => '?').join(',')})`,
    )
    .all(...body.serverIds);
  if (rows.length !== body.serverIds.length) throw Object.assign(new Error(MESSAGES.missing), { status: 404 });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    action: body.action,
    serverIds: body.serverIds,
    members: body.serverIds.map((id) => byId.get(id)),
    ...options,
  };
}
export async function folderSize(root, fsOps = fs) {
  let size = 0;
  const source = await fsOps.realpath(root);
  const visited = new Set();
  const inside = (file) => {
    const relative = path.relative(source, file);
    return (
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const visit = async (folder) => {
    const real = await fsOps.realpath(folder);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of await fsOps.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const info = await fsOps.lstat(file);
      if (info.isSymbolicLink() || !inside(await fsOps.realpath(file))) continue;
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) size += info.size;
    }
  };
  await visit(root);
  return size;
}
export async function checkCopyPathLength(source, target, fsOps = fs, { copyWorld = true } = {}) {
  let longest = 0;
  const realSource = await fsOps.realpath(source);
  const visited = new Set();
  const visit = async (folder) => {
    const realFolder = await fsOps.realpath(folder);
    if (visited.has(realFolder)) return;
    visited.add(realFolder);
    for (const entry of await fsOps.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const info = await fsOps.lstat(file);
      if (info.isSymbolicLink()) continue;
      const relativeReal = path.relative(realSource, await fsOps.realpath(file));
      if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) continue;
      if (info.isFile()) {
        const parts = path
          .relative(source, file)
          .split(path.sep)
          .map((part) => part.toLowerCase());
        const inSaved = parts[0] === 'shootergame' && parts[1] === 'saved';
        const setting =
          parts.length === 5 &&
          parts[2] === 'config' &&
          parts[3] === 'windowsserver' &&
          ['game.ini', 'gameusersettings.ini'].includes(parts[4]);
        if (copyWorld || !inSaved || setting) {
          const candidate = path.win32.join(target, path.relative(source, file).replaceAll('/', '\\'));
          longest = Math.max(longest, candidate.length);
        }
      }
      if (info.isDirectory()) await visit(file);
    }
  };
  await visit(source);
  if (longest > 259) throw Object.assign(new Error(MESSAGES.pathTooLong), { status: 400 });
}
export async function freeSpace(target, source, fsOps = fs) {
  let ancestor = checkFolder(target);
  for (;;) {
    try {
      await fsOps.stat(ancestor);
      break;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      const parent = path.win32.dirname(ancestor);
      if (parent === ancestor) throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
      ancestor = parent;
    }
  }
  const disk = await fsOps.statfs(ancestor);
  const freeBytes = disk.bavail * disk.bsize;
  const sourceBytes = source ? await folderSize(source, fsOps) : null;
  const requiredBytes = sourceBytes === null ? null : Math.ceil(sourceBytes * 1.1);
  return { freeBytes, sourceBytes, requiredBytes };
}
export async function checkDestination(db, target, source, fsOps = fs, options = {}) {
  const selected = checkFolder(target);
  if (
    db
      .prepare('SELECT path FROM installs')
      .all()
      .some((row) => folderKey(row.path) === folderKey(selected))
  )
    throw Object.assign(new Error(MESSAGES.folderUsed), { status: 409 });
  const relative = path.win32.relative(source, selected);
  if (!relative || (!relative.startsWith('..') && !path.win32.isAbsolute(relative)))
    throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
  await checkCopyPathLength(source, selected, fsOps, options);
  try {
    if ((await fsOps.readdir(selected)).length)
      throw Object.assign(new Error(MESSAGES.folderNotEmpty), { status: 409 });
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  const space = await freeSpace(selected, source, fsOps);
  if (space.freeBytes < space.requiredBytes)
    throw Object.assign(
      new Error(
        MESSAGES.noSpace
          .replace('{required}', gigabytes(space.requiredBytes))
          .replace('{free}', gigabytes(space.freeBytes)),
      ),
      { status: 409 },
    );
  return { path: selected, ...space };
}
export function activeFor(db, members, target) {
  const serverIds = new Set(members.map((m) => m.id));
  const installIds = new Set(members.map((m) => m.install_id));
  return db
    .prepare("SELECT server_id, install_id, targets_json FROM jobs WHERE state IN ('queued', 'running')")
    .all()
    .some((job) => {
      const targets = JSON.parse(job.targets_json);
      return (
        serverIds.has(job.server_id) ||
        installIds.has(job.install_id) ||
        (targets.servers ?? []).some((id) => serverIds.has(id)) ||
        (targets.installs ?? []).some((id) => installIds.has(id)) ||
        (target && (targets.paths ?? []).some((folder) => folderKey(folder) === folderKey(target)))
      );
    });
}
