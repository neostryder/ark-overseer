import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SETTINGS_FIELDS } from '../settings/fields.js';
import { validateSettings } from '../settings/validate.js';
import { createSettingsStore } from '../settings/store.js';
import { serverPaths } from '../supervisor/launch.js';
import { settingKeys } from '../settings/drift.js';

export const MESSAGES = {
  missing: 'The cluster was not found.',
  badName: 'Give the cluster a name of up to 64 characters.',
  badNotes: 'Notes can be up to 2000 characters, without control characters.',
  badFolder:
    'Use a full local drive path for the cluster folder. Network shares and mapped drives are not supported yet.',
  folderTaken: 'Another cluster uses this folder.',
  folderAccess:
    'Network Service cannot write to this folder. Create it if needed, then run icacls "{folder}" /grant "*S-1-5-20:(OI)(CI)M" as an administrator.',
  badSettings: 'Choose catalog settings that can be shared by a cluster.',
  badAction: 'Check the cluster action options.',
  badSchedule: 'Check the cluster restart schedule.',
  badOverrides: 'Overrides must list keys shared by this cluster.',
  memberTaken: 'This server already belongs to a cluster.',
  hasMembers: 'Remove every member before deleting the cluster.',
  busy: 'Another job is queued or running for a member. Wait for it to finish, then try again.',
  memberMissing: 'The server is not a member of this cluster.',
  badMember: 'Choose a server to add to this cluster.',
  failedMember: '{name} did not come back. The remaining servers were left running.',
  nextStart: 'This change takes effect at the next start.',
  nextRestart: 'The running server uses the shared settings after its next restart.',
  probeLeft: 'ARK Overseer could not remove its test file from the cluster folder. You can delete {path} yourself.',
  progress: '{action}: {name} ({index} of {count}).',
  actions: { restart: 'Restarting', start: 'Starting', stop: 'Stopping' },
};

const shareable = new Map(
  SETTINGS_FIELDS.filter((field) => !field.locked && !field.launchFlag && field.type !== 'password').map((field) => [
    field.key,
    field,
  ]),
);
export const sharedFields = () => [...shareable.values()];
export const clusterKey = () => crypto.randomBytes(8).toString('hex');
export const isRunning = (supervisor, id) =>
  ['running', 'starting', 'unknown'].includes(supervisor.status(id)?.observedState);
export const folderKey = (folder) =>
  path.win32
    .normalize(folder)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

export function checkActionOptions(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['countdownMinutes', 'announce'].includes(key))
  )
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  const marks = value.countdownMinutes;
  if (
    marks !== undefined &&
    (!Array.isArray(marks) ||
      !marks.length ||
      marks.length > 5 ||
      marks.some((n, i) => !Number.isInteger(n) || n < 1 || n > 60 || (i && marks[i - 1] <= n)))
  )
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  if (value.announce !== undefined && !['chat', 'broadcast'].includes(value.announce))
    throw Object.assign(new Error(MESSAGES.badAction), { status: 400 });
  return value;
}
export const clusterRow = (db, id) => db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
export const memberRows = (db, clusterId) =>
  db
    .prepare(
      'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.cluster_id = ? ORDER BY s.id',
    )
    .all(clusterId);
export const memberTargets = (members) => ({
  servers: members.map((m) => m.id),
  installs: members.map((m) => m.install_id),
});

export function checkSharedSettings(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !shareable.has(key))
  )
    throw Object.assign(new Error(MESSAGES.badSettings), { status: 400 });
  const errors = validateSettings(value);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { status: 400, errors });
  return value;
}

export function checkOverrides(value, cluster) {
  const shared = JSON.parse(cluster.settings_json);
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    value.some((key) => typeof key !== 'string' || !Object.hasOwn(shared, key))
  )
    throw Object.assign(new Error(MESSAGES.badOverrides), { status: 400 });
  return value;
}

export function settingsForMember(cluster, member, keys = Object.keys(JSON.parse(cluster.settings_json))) {
  const settings = JSON.parse(cluster.settings_json);
  const overrides = new Set(JSON.parse(member.cluster_overrides_json));
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(settings, key) && !overrides.has(key)).map((key) => [key, settings[key]]),
  );
}

export async function applySharedSettings({ db, cluster, member, drift, keys }) {
  const values = settingsForMember(cluster, member, keys);
  if (!Object.keys(values).length) return { written: [] };
  const result = await drift.saveSettings(
    member,
    () => createSettingsStore(serverPaths(member.install_path)).writeSettings(values),
    settingKeys(values),
  );
  if (Object.hasOwn(values, 'MaxPlayers'))
    db.prepare('UPDATE servers SET max_players = ?, updated_at = ? WHERE id = ?').run(
      values.MaxPlayers ?? shareable.get('MaxPlayers').default,
      new Date().toISOString(),
      member.id,
    );
  return result;
}

export function validateFolder(folder, { isMappedDrive = async () => false, allowUnc = false } = {}) {
  if (
    typeof folder !== 'string' ||
    (!/^[A-Za-z]:[\\/]/.test(folder) && !(allowUnc && /^\\\\(?![?.]\\)/.test(folder))) ||
    !path.win32.isAbsolute(folder) ||
    /["\r\n]/.test(folder)
  )
    throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
  const normalized = path.win32.normalize(folder).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(normalized) || folder.split(/[\\/]/).includes('..'))
    throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
  return Promise.resolve(/^[A-Za-z]:/.test(folder) ? isMappedDrive(folder[0].toUpperCase()) : false).then((mapped) => {
    if (mapped) throw Object.assign(new Error(MESSAGES.badFolder), { status: 400 });
    return normalized;
  });
}

export async function prepareFolder(folder, { custom = false, runner, fsOps = fs, isMappedDrive } = {}) {
  const local = await validateFolder(folder, { isMappedDrive: custom ? isMappedDrive : undefined, allowUnc: !custom });
  const accessError = () => Object.assign(new Error(MESSAGES.folderAccess.replace('{folder}', local)), { status: 400 });
  try {
    await fsOps.mkdir(local, { recursive: true });
  } catch {
    throw accessError();
  }
  if (custom && runner) {
    const icacls = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    try {
      const result = await runner(icacls, [local, '/grant', '*S-1-5-20:(OI)(CI)M']);
      if (result.code !== 0) throw new Error(result.stderr || '');
    } catch {
      throw accessError();
    }
  }
  const probe = path.win32.join(local, `.overseer-write-${crypto.randomUUID()}`);
  let wrote = false;
  try {
    await fsOps.writeFile(probe, 'cluster write test');
    wrote = true;
    await fsOps.unlink(probe);
  } catch {
    try {
      await fsOps.unlink(probe);
    } catch {
      const remains =
        wrote ||
        (await fsOps.stat?.(probe).then(
          () => true,
          () => false,
        ));
      if (remains) throw Object.assign(new Error(MESSAGES.probeLeft.replace('{path}', probe)), { status: 400 });
    }
    throw accessError();
  }
  return local;
}

export function activeJobFor(db, members) {
  return members.some((member) =>
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND (server_id = ? OR install_id = ? OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.servers') WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.installs') WHERE value = ?)) LIMIT 1",
      )
      .get(member.id, member.install_id, member.id, member.install_id),
  );
}

export function activeClusterJob(db, clusterId) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE kind IN ('cluster.restart', 'cluster.start', 'cluster.stop') AND state IN ('queued', 'running') AND json_extract(params_json, '$.clusterId') = ? LIMIT 1",
      )
      .get(clusterId),
  );
}
