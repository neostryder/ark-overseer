import fsp from 'node:fs/promises';
import path from 'node:path';
import { snapshotFiles, hashFile } from '../import/phase0.js';
import { backupServer, collectFiles } from '../scheduler/backup.js';
import { MESSAGES as SCHEDULE_MESSAGES } from '../scheduler/handlers.js';
import { readIniFile, headerName } from '../settings/ini.js';
import { serverPaths } from '../supervisor/launch.js';
import { readManifest, resolveInside, verifyFiles, isBelow, CONFIG_PREFIX } from './read.js';
import { defaultOps, stageUnit, swapUnit, settle } from './swap.js';
import { restoreLayout, clearEarlierRestore } from './restore.js';

export const SNAPSHOT_MESSAGES = {
  badName: 'Give the snapshot a name of 1 to 64 characters.',
  nameTaken: 'This server already has a settings snapshot with that name.',
  noSettings: 'The settings folder is empty or missing, so there is nothing to save.',
  noSnapshot: 'That settings snapshot was not found.',
  notUsable: 'This settings snapshot cannot be used. Its folder or its file list is missing.',
  safetyFailed: 'The safety backup failed, so the settings were not changed.',
  filesFailed: 'The settings files could not be replaced, so nothing was changed.',
  outsideFolder:
    "This snapshot is saved outside ARK Overseer's snapshot folder, so its files won't be deleted. It stays in the list.",
  filesNotPutBack:
    'The settings files could not be replaced, and they could not be put back either. ARK Overseer will try again the next time it starts.',
  nothingToSave: 'There was nothing to make a safety backup of.',
  cancelled: 'The job was cancelled.',
  steps: {
    checking: 'Checking the snapshot against its file list.',
    safety: 'Backing up the current settings files.',
    restoring: 'Putting the snapshot files in place.',
    done: 'The settings from "{name}" are in place.',
    doneRunning: 'The settings from "{name}" are in place. The running server uses them after its next restart.',
  },
};

export class SnapshotError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
const sentence = (text) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};
const ACTIVE = new Set(['running', 'starting', 'unknown']);

// A name is 1 to 64 characters with no control characters. It is returned trimmed.
export function checkName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 64 || /[\x00-\x1f\x7f]/.test(trimmed))
    throw new SnapshotError(400, 'bad_name', SNAPSHOT_MESSAGES.badName);
  return trimmed;
}
const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'snapshot';

export function findSnapshot(db, serverId, id) {
  const row = Number.isInteger(Number(id))
    ? db.prepare('SELECT * FROM settings_snapshots WHERE id = ? AND server_id = ?').get(Number(id), serverId)
    : null;
  if (!row) throw new SnapshotError(404, 'no_snapshot', SNAPSHOT_MESSAGES.noSnapshot);
  return row;
}

// The snapshot's folder and its files, or an error saying why it cannot be used.
export async function readSnapshot(row, { dataDir }) {
  try {
    const folder = resolveInside(dataDir, 'settings-snapshots', row.path);
    const manifest = await readManifest(folder);
    const files = manifest.files
      .filter((file) => file.relPath.startsWith(`${CONFIG_PREFIX}/`))
      .map((file) => ({ ...file, rel: file.relPath.slice(CONFIG_PREFIX.length + 1) }));
    return { folder, files };
  } catch (error) {
    throw new SnapshotError(409, 'not_usable', error.message || SNAPSHOT_MESSAGES.notUsable);
  }
}

// Copies every file in the server's settings folder. It only reads, so it is safe while the server runs.
export async function saveSnapshot({ db, dataDir, server, name, now = () => Date.now() }) {
  const clean = checkName(name);
  if (db.prepare('SELECT 1 FROM settings_snapshots WHERE server_id = ? AND name = ?').get(server.id, clean))
    throw new SnapshotError(409, 'name_taken', SNAPSHOT_MESSAGES.nameTaken);
  const sources = [];
  collectFiles(serverPaths(server.install_path).configDir, CONFIG_PREFIX, sources);
  if (!sources.length) throw new SnapshotError(409, 'no_settings', SNAPSHOT_MESSAGES.noSettings);
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('.', '-');
  const base = path.join(dataDir, 'settings-snapshots', `server-${server.id}`, `${stamp}-${slugOf(clean)}`);
  // snapshotFiles refuses a folder that already exists, so a second snapshot in the same millisecond gets a
  // numbered folder rather than failing.
  let snapshot;
  for (let attempt = 0; !snapshot; attempt++) {
    try {
      snapshot = await snapshotFiles(sources, attempt ? `${base}-${attempt + 1}` : base);
    } catch (error) {
      if (attempt >= 9 || !/already exists/.test(error.message)) throw error;
    }
  }
  const createdAt = new Date(now()).toISOString();
  try {
    const result = db
      .prepare(
        'INSERT INTO settings_snapshots (server_id, name, created_at, path, size_bytes, sha256) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(server.id, clean, createdAt, snapshot.path, snapshot.sizeBytes, snapshot.sha256);
    return {
      id: Number(result.lastInsertRowid),
      name: clean,
      created_at: createdAt,
      size_bytes: snapshot.sizeBytes,
      files: snapshot.files.length,
    };
  } catch (error) {
    // Two saves of one name sent together: the index refuses the second, and its copy is removed.
    await fsp.rm(snapshot.path, { recursive: true, force: true }).catch(() => {});
    if (/UNIQUE/.test(error.message)) throw new SnapshotError(409, 'name_taken', SNAPSHOT_MESSAGES.nameTaken);
    throw error;
  }
}

export function renameSnapshot({ db, serverId, id, name }) {
  const row = findSnapshot(db, serverId, id);
  const clean = checkName(name);
  try {
    db.prepare('UPDATE settings_snapshots SET name = ? WHERE id = ?').run(clean, row.id);
  } catch (error) {
    if (/UNIQUE/.test(error.message)) throw new SnapshotError(409, 'name_taken', SNAPSHOT_MESSAGES.nameTaken);
    throw error;
  }
  return { id: row.id, name: clean };
}

export async function deleteSnapshot({ db, dataDir, serverId, id }) {
  const row = findSnapshot(db, serverId, id);
  const root = path.resolve(dataDir, 'settings-snapshots');
  const target = path.resolve(row.path);
  // The folder is removed only when it lies inside the snapshot folder, whatever the row says. A row that
  // points anywhere else is kept, so the odd path stays visible rather than being quietly dropped.
  if (!isBelow(root, target)) throw new SnapshotError(409, 'outside', SNAPSHOT_MESSAGES.outsideFolder);
  await fsp.rm(target, { recursive: true, force: true });
  db.prepare('DELETE FROM settings_snapshots WHERE id = ?').run(row.id);
  return { deleted: true };
}

// ---- comparing two copies of the settings ----

const isComment = (line) => /^\s*[;#]/.test(line);

// Sections and keys of one INI file. Section and key names ignore letter case, as ARK reads them, and values
// are trimmed. A key that appears more than once (Game.ini repeats some) keeps every value in file order.
export function parseIni(lines) {
  const sections = new Map();
  let current = null;
  const open = (name) => {
    const id = name.toLowerCase();
    if (!sections.has(id)) sections.set(id, { name, keys: new Map() });
    return sections.get(id);
  };
  for (const line of lines) {
    const header = headerName(line);
    if (header !== null) {
      current = open(
        line
          .trimStart()
          .match(/^\[([^\]]*)\]/)[1]
          .trim(),
      );
      continue;
    }
    if (!line.trim() || isComment(line)) continue;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    current ??= open('');
    const id = match[1].trim().toLowerCase();
    const entry = current.keys.get(id) ?? { key: match[1].trim(), values: [] };
    entry.values.push(match[2].trim());
    current.keys.set(id, entry);
  }
  return sections;
}

function diffIni(oldLines, currentLines) {
  const before = parseIni(oldLines),
    after = parseIni(currentLines);
  const sections = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])]) {
    const old = before.get(id),
      current = after.get(id);
    const added = [],
      removed = [],
      changed = [];
    for (const keyId of [...new Set([...(old?.keys.keys() ?? []), ...(current?.keys.keys() ?? [])])]) {
      const a = old?.keys.get(keyId),
        b = current?.keys.get(keyId);
      const show = (entry) => (entry ? entry.values.join('\n') : null);
      if (!a) added.push({ key: b.key, old: null, current: show(b) });
      else if (!b) removed.push({ key: a.key, old: show(a), current: null });
      else if (a.values.length !== b.values.length || a.values.some((value, index) => value !== b.values[index]))
        changed.push({ key: b.key, old: show(a), current: show(b) });
    }
    const byKey = (x, y) => x.key.localeCompare(y.key, undefined, { sensitivity: 'base' });
    if (added.length || removed.length || changed.length)
      sections.push({
        section: (current ?? old).name,
        added: added.sort(byKey),
        removed: removed.sort(byKey),
        changed: changed.sort(byKey),
      });
  }
  return sections.sort((x, y) => x.section.localeCompare(y.section, undefined, { sensitivity: 'base' }));
}

async function walk(dir, prefix = '') {
  const found = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

// What differs between a snapshot and the settings folder as it is now. `old` is the snapshot's value and
// `current` is the live one: a key is `added` when the live file has it and the snapshot does not, `removed` when
// only the snapshot has it. A file on one side only is listed whole. Comments and blank lines are ignored.
export async function diffSettings(snapshotPath, liveConfigDir, { manifest: manifestName } = {}) {
  const manifest = await readManifest(snapshotPath, manifestName);
  const held = new Map(
    manifest.files
      .filter((file) => file.relPath.startsWith(`${CONFIG_PREFIX}/`))
      .map((file) => [
        file.relPath.slice(CONFIG_PREFIX.length + 1),
        path.join(snapshotPath, ...file.relPath.split('/')),
      ]),
  );
  const live = new Map((await walk(liveConfigDir)).map((rel) => [rel, path.join(liveConfigDir, ...rel.split('/'))]));
  const files = [];
  let same = 0;
  const names = [...new Set([...held.keys(), ...live.keys()])].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  for (const file of names) {
    if (!live.has(file)) files.push({ file, status: 'only_in_snapshot', sections: [] });
    else if (!held.has(file)) files.push({ file, status: 'only_live', sections: [] });
    else if (/\.ini$/i.test(file)) {
      const sections = diffIni(readIniFile(held.get(file)).lines, readIniFile(live.get(file)).lines);
      if (sections.length) files.push({ file, status: 'changed', sections });
      else same++;
    } else {
      const [a, b] = await Promise.all([hashFile(held.get(file)), hashFile(live.get(file))]);
      if (a.sha256 !== b.sha256) files.push({ file, status: 'changed', sections: [] });
      else same++;
    }
  }
  return { files, same };
}

// ---- putting a snapshot back ----

export function createSettingsSnapshotHandlers({
  db,
  dataDir,
  supervisor,
  rcon,
  getRconPassword,
  now = () => Date.now(),
  ops = defaultOps,
  // Called with the server once the snapshot's files are in place, so the baseline follows them.
  onSettingsWritten = async () => {},
}) {
  const stamp = () => new Date(now()).toISOString();
  const serverRow = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);
  const auditEvent = (serverId, detail) => {
    try {
      db.prepare(
        'INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(stamp(), 'job', 'server.settings.restore', 'server', serverId, JSON.stringify(detail));
    } catch {
      /* an audit failure does not change what happened to the files */
    }
  };

  const settingsJob = async ({ job, params = {}, signal, progress }, server, record) => {
    const step = (fraction, key, values = {}) => progress(fraction, fill(SNAPSHOT_MESSAGES.steps[key], values));
    const cancelled = () => signal.reason ?? new Error(SNAPSHOT_MESSAGES.cancelled);
    const tag = String(job.id);
    step(0.05, 'checking');
    await clearEarlierRestore({ db, serverId: server.id, ops, now });
    const row = findSnapshot(db, server.id, params.snapshotId);
    const snapshot = await readSnapshot(row, { dataDir });
    if (!snapshot.files.length) throw new SnapshotError(409, 'not_usable', SNAPSHOT_MESSAGES.notUsable);
    await verifyFiles(snapshot.folder, snapshot.files, signal, 'snapshot');
    if (signal.aborted) throw cancelled();

    step(0.3, 'safety');
    let safety = null;
    let note = null;
    try {
      safety = await backupServer({
        db,
        server,
        dataDir,
        reason: 'pre_restore',
        rcon,
        getRconPassword,
        isRunning: async () => false,
        now,
        jobId: job.id,
        signal,
        include: { world: false },
      });
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (error.code !== 'EMPTY_BACKUP')
        throw new Error(`${SNAPSHOT_MESSAGES.safetyFailed} ${sentence(error.message)}`.trim());
      note = SNAPSHOT_MESSAGES.nothingToSave;
    }
    if (signal.aborted) throw cancelled();

    const layout = restoreLayout(server.install_path);
    const unit = {
      label: 'settings',
      kind: 'files',
      dir: layout.configDir,
      source: snapshot.folder,
      files: snapshot.files,
    };
    const setStage = (stage) =>
      db.prepare('UPDATE pending_restores SET stage = ? WHERE server_id = ?').run(stage, server.id);
    const dropPending = () => {
      try {
        db.prepare('DELETE FROM pending_restores WHERE server_id = ?').run(server.id);
      } catch {
        /* the row is settled by the next start */
      }
    };
    // The row lets the next start of ARK Overseer put the files back if this stops halfway. The server is
    // never stopped or started here, so it is never marked as running.
    db.prepare(
      'INSERT INTO pending_restores (server_id, job_id, backup_id, scope, safety_backup_id, was_running, started_at, stage) VALUES (?, ?, NULL, ?, ?, 0, ?, ?)',
    ).run(server.id, job.id, 'settings_snapshot', safety?.backupId ?? null, stamp(), 'staging');
    step(0.5, 'restoring');
    try {
      await stageUnit(unit, { ops, tag, signal });
      if (signal.aborted) throw cancelled();
      await swapUnit(unit, { ops, tag, onStage: () => setStage('swapping:settings') });
    } catch (error) {
      try {
        await settle({ roots: layout.roots, tag, mode: 'undo', ops });
      } catch {
        throw new Error(SNAPSHOT_MESSAGES.filesNotPutBack);
      }
      dropPending();
      throw signal.aborted
        ? cancelled()
        : new Error(`${SNAPSHOT_MESSAGES.filesFailed} ${sentence(error.message)}`.trim());
    }
    setStage('cleanup');
    let leftovers = false;
    try {
      await settle({ roots: layout.roots, tag, mode: 'finish', ops });
    } catch {
      leftovers = true;
    }
    if (!leftovers) dropPending();
    await onSettingsWritten(server, 'settings_restore').catch(() => {});
    const running = ACTIVE.has(supervisor.status(server.id)?.observedState);
    record('restored', { name: row.name, safetyBackupId: safety?.backupId ?? null });
    step(0.95, running ? 'doneRunning' : 'done', { name: row.name });
    return {
      snapshotId: row.id,
      safetyBackupId: safety?.backupId ?? null,
      appliesAtRestart: running,
      ...(note ? { notes: [note] } : {}),
    };
  };

  return {
    // Writes a snapshot's files over the live settings. The server keeps running: ARK reads these files when
    // it starts, so a running server picks the change up at its next restart.
    'server.settings_restore': async (context) => {
      const { job, params = {}, signal } = context;
      const server = serverRow(job.serverId);
      if (!server) throw new Error(SCHEDULE_MESSAGES.noServer);
      let recorded = false;
      const record = (outcome, extra = {}) => {
        recorded = true;
        auditEvent(server.id, { snapshotId: params.snapshotId ?? null, jobId: job.id, outcome, ...extra });
      };
      try {
        return await settingsJob(context, server, record);
      } catch (error) {
        if (!recorded) record(signal.aborted ? 'cancelled' : 'failed', { reason: String(error?.message ?? error) });
        throw error;
      }
    },
  };
}
