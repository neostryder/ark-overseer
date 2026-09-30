import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { transaction } from '../db/transaction.js';
import { hashFile } from '../import/phase0.js';
import { backupServer } from '../scheduler/backup.js';
import { MESSAGES as SCHEDULE_MESSAGES } from '../scheduler/handlers.js';
import { CONFIG_PREFIX } from '../backups/read.js';
import { clearEarlierRestore } from '../backups/restore.js';
import { parseIni, diffSettings } from '../backups/settings-snapshots.js';
import { defaultOps, stageUnit, swapUnit, settle } from '../backups/swap.js';
import { serverPaths } from '../supervisor/launch.js';
import { redact } from '../util/redact.js';
import { SETTINGS_FIELDS } from './fields.js';
import {
  readIniFile,
  iniBytes,
  headerName,
  findSections,
  findKeyLines,
  setIniKey,
  removeIniKey,
  fileFor,
  sectionFor,
} from './ini.js';
import {
  BASELINE_FILE,
  baselineConfigDir,
  listLiveFiles,
  signature,
  statSignature,
  readBaselineFolder,
  writeBaseline,
  removeBaselineFolder,
} from './baseline.js';

export const DRIFT_MESSAGES = {
  noServer: 'The server was not found.',
  badAction: "Choose to keep the current values, put ARK Overseer's values back, or choose setting by setting.",
  noLook: 'Open the differences before choosing what to do with them.',
  changedSince: 'The settings files changed after you looked at them. Look at the differences again.',
  nothing: 'The settings files already match what ARK Overseer last wrote.',
  badChoices: 'Send the choices as a list, each with a file, a section, a key and a choice of baseline or live.',
  missingChoice: 'Choose a value for every setting that differs. {count} still need a choice.',
  badKeepOption: 'Send enabled as true or false.',
  safetyFailed: 'The safety backup failed, so the settings were not changed.',
  filesFailed: 'The settings files could not be replaced, so nothing was changed.',
  startWaited:
    "Server {id} started on the values ASA wrote at shutdown, because putting ARK Overseer's settings back was still running after {seconds} seconds.",
  filesNotPutBack:
    'The settings files could not be replaced, and they could not be put back either. ARK Overseer will try again the next time it starts.',
  cancelled: 'The job was cancelled.',
  serverRunning:
    'The server is running. It keeps its current settings until it restarts, and it may write its own values back when it shuts down. Putting values back is safest while the server is stopped.',
  steps: {
    checking: 'Checking the settings files again.',
    building: 'Preparing the new settings files.',
    safety: 'Backing up the current settings files.',
    writing: 'Putting the settings files in place.',
    done: 'The settings files are updated.',
    doneRunning: 'The settings files are updated. The running server uses them after its next restart.',
  },
};

export class DriftError extends Error {
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
export const ACTIONS = ['adopt', 'revert', 'merge'];
export const RESOLVE_JOB = 'server.settings_resolve';
// Jobs that change the files under a server without going through this module. While one is queued or
// running, the files are not compared: they are part way between two states.
const OTHER_FILE_JOBS = [
  'server.switch_map',
  'server.restore',
  'server.settings_restore',
  'server.cluster_apply',
  'server.move',
  'server.clone',
  'server.remove',
  'fleet.action',
];
const ACTIVE = new Set(['running', 'starting', 'unknown']);
// The states a server may be in when the put-back before a start is allowed to write its files.
const START_STATES = new Set(['stopped', 'crashed']);
const INTERVAL_MS = 10 * 60 * 1000;
// A start waits this long at most for the put-back that runs before it.
const START_HOOK_MS = 120 * 1000;
// Every sixth sweep, once an hour, hashes every file instead of trusting size and change time.
const FULL_SWEEP_EVERY = 6;

// ---- which keys are secret, and which ARK Overseer has a control for ----

const PASSWORD_KEYS = new Set(
  SETTINGS_FIELDS.filter((field) => field.type === 'password').map((f) => f.key.toLowerCase()),
);

// A password field, or any key the log redaction would mask, never has its value sent to a browser.
export function isSecretKey(key) {
  const name = String(key);
  return PASSWORD_KEYS.has(name.trim().toLowerCase()) || redact(`${name}=probe`) !== `${name}=probe`;
}

const FILE_IDS = { 'gameusersettings.ini': 'gameusersettings', 'game.ini': 'game' };
const coverKey = (file, section, key) => `${file}|${section.toLowerCase()}|${key.trim().toLowerCase()}`;
const COVERED = new Set([
  coverKey('gameusersettings', 'sessionsettings', 'SessionName'),
  ...SETTINGS_FIELDS.filter((field) => !field.launchFlag).map((field) =>
    coverKey(fileFor(field), headerName(sectionFor(field)), field.key),
  ),
]);

// True for a single key that one of ARK Overseer's own settings controls. Whole files are never covered.
export function isCovered(difference) {
  const file = FILE_IDS[String(difference.file).toLowerCase()];
  return Boolean(file && difference.key && COVERED.has(coverKey(file, difference.section, difference.key)));
}

// The keys a settings save writes, as { file, section, key }, for the baseline to take over from the files.
export function settingKeys(body) {
  const keys = [];
  if (typeof body?.sessionName === 'string' && body.sessionName.trim())
    keys.push({ file: 'GameUserSettings.ini', section: 'SessionSettings', key: 'SessionName' });
  for (const field of SETTINGS_FIELDS) {
    if (!Object.hasOwn(body ?? {}, field.key) || field.launchFlag || field.locked) continue;
    keys.push({
      file: fileFor(field) === 'game' ? 'Game.ini' : 'GameUserSettings.ini',
      section: headerName(sectionFor(field)),
      key: field.key,
    });
  }
  return keys;
}

const idOf = (item) => [item.file, item.section, item.key].map((part) => String(part).toLowerCase()).join('\u0000');

// ---- reading the differences ----

// The comparison as one flat list. Values of secret keys are left out: those entries say only that the key differs.
function flatten(diff) {
  const list = [];
  for (const file of diff.files) {
    if (file.status !== 'changed' || !file.sections.length) {
      const kind = { only_in_snapshot: 'file_removed', only_live: 'file_added', changed: 'file_changed' }[file.status];
      list.push({ file: file.file, section: '', key: '', kind, baseline: null, live: null, secret: false });
      continue;
    }
    for (const section of file.sections)
      for (const [kind, items] of [
        ['changed', section.changed],
        ['added', section.added],
        ['removed', section.removed],
      ])
        for (const item of items) {
          const secret = isSecretKey(item.key);
          list.push({
            file: file.file,
            section: section.section,
            key: item.key,
            kind,
            baseline: secret ? null : item.old,
            live: secret ? null : item.current,
            secret,
          });
        }
  }
  return list;
}

// Checks a request to resolve the differences against the differences as they are now, and says which side
// each setting takes. The API and the job both use it, so both refuse exactly the same requests.
export function planResolve(state, { action, choices, liveSha256 } = {}) {
  if (!ACTIONS.includes(action)) throw new DriftError(400, 'bad_action', DRIFT_MESSAGES.badAction);
  if (typeof liveSha256 !== 'string' || !liveSha256) throw new DriftError(400, 'no_look', DRIFT_MESSAGES.noLook);
  if (state.liveSha256 !== liveSha256) throw new DriftError(409, 'changed', DRIFT_MESSAGES.changedSince);
  if (!state.changed) throw new DriftError(409, 'nothing', DRIFT_MESSAGES.nothing);
  const all = state.differences;
  if (action === 'adopt') return { action, entries: all.map((diff) => ({ diff, use: 'live' })) };
  if (action === 'revert') return { action, entries: all.map((diff) => ({ diff, use: 'baseline' })) };
  if (
    !Array.isArray(choices) ||
    choices.length > 200000 ||
    choices.some(
      (item) =>
        !item ||
        typeof item.file !== 'string' ||
        typeof item.section !== 'string' ||
        typeof item.key !== 'string' ||
        !['baseline', 'live'].includes(item.choice),
    )
  )
    throw new DriftError(400, 'bad_choices', DRIFT_MESSAGES.badChoices);
  // A choice for a setting that no longer differs is ignored; every setting that does differ needs one.
  const chosen = new Map(choices.map((item) => [idOf(item), item.choice]));
  const missing = all.filter((diff) => !chosen.has(idOf(diff)));
  if (missing.length)
    throw new DriftError(400, 'missing_choice', fill(DRIFT_MESSAGES.missingChoice, { count: missing.length }));
  return { action, entries: all.map((diff) => ({ diff, use: chosen.get(idOf(diff)) })) };
}

// True when a difference is the setting `key` names ({ file, section, key }). Letter case is ignored.
const sameKey = (diff, key) =>
  diff.file.toLowerCase() === key.file.toLowerCase() &&
  diff.section.toLowerCase() === key.section.toLowerCase() &&
  diff.key.trim().toLowerCase() === key.key.trim().toLowerCase();
const mergeKeys = (a, b) => {
  const seen = new Set();
  return [...a, ...b].filter((key) => {
    const id = idOf(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

export const keysOf = (entries) =>
  entries.map(({ diff }) => ({ file: diff.file, section: diff.section, key: diff.key }));

// ---- editing a file's lines ----

function firstHeader(lines) {
  const index = lines.findIndex((line) => headerName(line) !== null);
  return index < 0 ? lines.length : index;
}

// Makes `key` hold exactly `values` (none removes it) in the named section, leaving every other line as it is.
// One value in a named section goes through setIniKey; the rest (a key repeated on several lines, or a key above
// the first section) needs the same care with more than one line.
export function putKey(lines, sectionName, key, values) {
  if (sectionName !== '') {
    if (!values.length) return removeIniKey(lines, `[${sectionName}]`, key);
    if (values.length === 1) return setIniKey(lines, `[${sectionName}]`, key, values[0]);
  }
  const sections =
    sectionName === '' ? [{ start: -1, end: firstHeader(lines) }] : findSections(lines, `[${sectionName}]`);
  const found = findKeyLines(lines, sections, key);
  const added = values.map((value) => `${key}=${value}`);
  // A key that keeps the same number of lines keeps each line where it is, in the order of its values.
  if (found.length && found.length === added.length) {
    found.forEach(({ index }, at) => (lines[index] = added[at]));
    return;
  }
  const first = found[0]?.index;
  for (const { index } of [...found].reverse()) lines.splice(index, 1);
  if (first !== undefined) return void lines.splice(first, 0, ...added);
  if (!added.length) return;
  if (!sections[0]) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${sectionName}]`, ...added);
    return;
  }
  lines.splice(sections[0].start + 1, 0, ...added);
}

// Edits the files under `targetRoot` so each entry takes the value `otherRoot` holds, and writes the results
// under `stagingRoot`, never over the target. A file the other side does not have is a removal. Returns the
// staged files and the files to remove, named relative to the settings folder.
async function buildEdits({ targetRoot, otherRoot, entries, stagingRoot }) {
  const byFile = new Map();
  for (const entry of entries) {
    const list = byFile.get(entry.diff.file.toLowerCase()) ?? [];
    list.push(entry);
    byFile.set(entry.diff.file.toLowerCase(), list);
  }
  const files = [],
    removals = [];
  const at = (root, rel) => path.join(root, ...rel.split('/'));
  const stage = async (rel, bytes, copyFrom) => {
    const staged = at(stagingRoot, rel);
    await fsp.mkdir(path.dirname(staged), { recursive: true });
    if (copyFrom) await fsp.copyFile(copyFrom, staged);
    else await fsp.writeFile(staged, bytes);
    const hashed = await hashFile(staged);
    files.push({ rel, relPath: rel, abs: staged, size: hashed.size, sha256: hashed.sha256 });
  };
  for (const list of byFile.values()) {
    const rel = list[0].diff.file;
    const other = at(otherRoot, rel),
      target = at(targetRoot, rel);
    const whole = list.some((entry) => entry.diff.key === '');
    if (whole) {
      if (fs.existsSync(other)) await stage(rel, null, other);
      else removals.push({ rel });
      continue;
    }
    const edited = readIniFile(target);
    const wanted = parseIni(readIniFile(other).lines);
    for (const { diff } of list) {
      const values = wanted.get(diff.section.toLowerCase())?.keys.get(diff.key.trim().toLowerCase())?.values ?? [];
      putKey(edited.lines, diff.section, diff.key, values);
    }
    await stage(rel, iniBytes(edited));
  }
  return { files, removals };
}

// ---- the service ----

export function createDrift({
  db,
  dataDir,
  supervisor,
  rcon,
  getRconPassword,
  now = () => Date.now(),
  ops = defaultOps,
  hash = hashFile,
  log = () => {},
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  intervalMs = INTERVAL_MS,
  hookLimitMs = START_HOOK_MS,
}) {
  let jobs = null;
  const chains = new Map();
  const cache = new Map();
  const afterStop = new Map();
  const sweeps = new Set();
  let sequence = 0;
  let sweepCount = 0;
  const stamp = () => new Date(now()).toISOString();
  const serverRow = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);
  const driftRow = (id) => db.prepare('SELECT * FROM settings_drift WHERE server_id = ?').get(id);
  const keepEnabled = (server) => {
    try {
      return JSON.parse(server.settings_json || '{}').keepSettingsAfterStop === true;
    } catch {
      return false;
    }
  };
  const otherFileJobActive = (id) =>
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM jobs WHERE kind IN (${OTHER_FILE_JOBS.map(() => '?').join(', ')}) AND state IN ('queued', 'running') AND (server_id = ? OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.servers') WHERE value = ?)) LIMIT 1`,
        )
        .get(...OTHER_FILE_JOBS, id, id),
    );
  const resolveQueued = (id) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued', 'running') AND server_id = ? LIMIT 1")
        .get(RESOLVE_JOB, id),
    );

  const pendingOf = (id) => {
    const row = db.prepare('SELECT pending_json FROM settings_baselines WHERE server_id = ?').get(id);
    try {
      return row?.pending_json ? JSON.parse(row.pending_json) : null;
    } catch {
      return null;
    }
  };
  const setPending = (id, value) => {
    db.prepare('UPDATE settings_baselines SET pending_json = ? WHERE server_id = ?').run(
      value ? JSON.stringify(value) : null,
      id,
    );
    cache.delete(id);
  };

  // Everything that reads or replaces one server's baseline or settings files runs one at a time.
  function serial(id, task) {
    const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    chains.set(id, next);
    const clear = () => {
      if (chains.get(id) === next) chains.delete(id);
    };
    next.then(clear, clear);
    return next;
  }

  const emptyState = (liveSha256 = null) => ({
    changed: false,
    busy: false,
    detectedAt: null,
    afterStop: false,
    seen: false,
    liveSha256,
    differences: [],
  });

  // ---- the baseline ----

  async function loadBaseline(server) {
    const row = db.prepare('SELECT * FROM settings_baselines WHERE server_id = ?').get(server.id);
    if (!row) return null;
    const folder = await readBaselineFolder(dataDir, server.id, ops);
    // A baseline that no longer matches its row cannot be trusted, so it is taken again from the files.
    if (!folder || folder.sha256 !== row.sha256) {
      log(`The settings baseline for server ${server.id} could not be read, so it is taken again from the files.`);
      return null;
    }
    return { row, ...folder };
  }

  async function recordCore(server, source, { sources, keepDrift = false, skipIfEmpty = false } = {}) {
    const list = sources ?? listLiveFiles(server.install_path).map(({ path: p, relPath }) => ({ path: p, relPath }));
    if (skipIfEmpty && !list.length) return null;
    const written = await writeBaseline({ dataDir, serverId: server.id, sources: list, ops });
    transaction(db, () => {
      // A baseline that was recorded whole, or with every pending key in it, has nothing left pending.
      db.prepare(
        `INSERT INTO settings_baselines (server_id, recorded_at, sha256, source, pending_json) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(server_id) DO UPDATE SET recorded_at = excluded.recorded_at, sha256 = excluded.sha256,
           source = excluded.source, pending_json = NULL`,
      ).run(server.id, stamp(), written.sha256, source);
      if (!keepDrift) db.prepare('DELETE FROM settings_drift WHERE server_id = ?').run(server.id);
    });
    cache.delete(server.id);
    return { sha256: written.sha256, files: written.files, liveSha256: signature(written.files) };
  }

  // Compares the files with the baseline. The cheap check comes first: when no file's size or change time moved
  // since the last look, and the baseline is the same one, the last answer stands and nothing is hashed.
  async function inspect(server, { force = false, raw = false } = {}) {
    const base = await loadBaseline(server);
    if (!base) return { noBaseline: true };
    const live = listLiveFiles(server.install_path);
    const stat = statSignature(live);
    const cached = cache.get(server.id);
    if (!force && cached && cached.stat === stat && cached.baseline === base.sha256) return cached.core;
    const hashed = [];
    for (const file of live) {
      const result = await hash(file.path).catch(() => null);
      if (result) hashed.push({ relPath: file.relPath, size: result.size, sha256: result.sha256 });
    }
    const liveSha256 = signature(hashed);
    let differences = [];
    if (liveSha256 !== signature(base.files)) {
      const diff = await diffSettings(base.folder, serverPaths(server.install_path).configDir, {
        manifest: BASELINE_FILE,
      });
      differences = flatten(diff);
    }
    // What ARK Overseer itself wrote and could not yet record is not a change made from outside. `raw` keeps it.
    const pending = raw ? null : pendingOf(server.id);
    if (pending?.full && pending.liveSha256 === liveSha256) differences = [];
    else if (pending?.keys) differences = differences.filter((diff) => !pending.keys.some((key) => sameKey(diff, key)));
    const core = { changed: differences.length > 0, liveSha256, differences };
    if (!raw) cache.set(server.id, { stat, baseline: base.sha256, core });
    return core;
  }

  // The signature of the files as they are on disk right now, always read in full.
  async function liveSignature(server) {
    const hashed = [];
    for (const file of listLiveFiles(server.install_path)) {
      const result = await hash(file.path).catch(() => null);
      if (result) hashed.push({ relPath: file.relPath, size: result.size, sha256: result.sha256 });
    }
    return signature(hashed);
  }

  // Keeps the drift row in step with what was found. The same drift, found again, keeps the time it was first found
  // and whether anyone has looked at it.
  function finalize(server, core, isAfterStop) {
    const row = driftRow(server.id);
    if (!core.changed) {
      if (row) db.prepare('DELETE FROM settings_drift WHERE server_id = ?').run(server.id);
      return emptyState(core.liveSha256);
    }
    let current = row;
    if (!row || row.live_sha256 !== core.liveSha256) {
      db.prepare(
        `INSERT INTO settings_drift (server_id, detected_at, live_sha256, seen_at, after_stop) VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(server_id) DO UPDATE SET detected_at = excluded.detected_at, live_sha256 = excluded.live_sha256,
           seen_at = NULL, after_stop = excluded.after_stop`,
      ).run(server.id, stamp(), core.liveSha256, isAfterStop ? 1 : 0);
      current = driftRow(server.id);
    } else if (isAfterStop && !row.after_stop) {
      // The same drift, found again by the check after a stop: a page load or a sweep may have recorded it first,
      // but it is what the shutdown left, and the put-back has to see it as that.
      db.prepare('UPDATE settings_drift SET after_stop = 1 WHERE server_id = ?').run(server.id);
      current = driftRow(server.id);
    }
    return {
      changed: true,
      busy: false,
      detectedAt: current.detected_at,
      afterStop: Boolean(current.after_stop),
      seen: current.seen_at != null,
      liveSha256: core.liveSha256,
      differences: core.differences,
    };
  }

  // Takes into the baseline whatever a failed record left pending, before anything is compared.
  async function retryPending(server) {
    const pending = pendingOf(server.id);
    if (!pending) return;
    try {
      if (pending.full) {
        // Only the files as ARK Overseer wrote them can be recorded whole. If they moved since, what changed is not
        // known, so the baseline stays and the differences are reported.
        if ((await liveSignature(server)) !== pending.liveSha256) {
          setPending(server.id, null);
          log(
            `The settings of server ${server.id} changed before their baseline could be recorded, so it was left as it was.`,
          );
          return;
        }
        await applyKeys(server, null, pending.source);
      } else await applyKeys(server, pending.keys, pending.source);
    } catch (error) {
      log(`Recording the settings baseline for server ${server.id} failed again: ${error.message}`);
    }
  }

  async function checkCore(server, { afterStop: isAfterStop = false, force = false } = {}) {
    await retryPending(server);
    const looked = await inspect(server, { force });
    if (looked.noBaseline) {
      // A server with no baseline gets one from the files as they are now, and nothing is reported as changed.
      const made = await recordCore(server, 'first_read', { skipIfEmpty: true });
      return emptyState(made?.liveSha256 ?? signature([]));
    }
    return finalize(server, looked, isAfterStop);
  }

  // ---- public checks ----

  // A check after a stop, and one for a page that is being loaded, hash every file; the size and time of a file
  // rewritten in place by ASA cannot always be trusted.
  function checkDrift(server, options = {}) {
    return serial(server.id, async () => {
      if (otherFileJobActive(server.id)) {
        // Another job owns the files. What was last found is shown, and nothing is compared or recorded.
        const cached = cache.get(server.id)?.core;
        const row = driftRow(server.id);
        if (cached?.changed && row)
          return {
            changed: true,
            busy: true,
            detectedAt: row.detected_at,
            afterStop: Boolean(row.after_stop),
            seen: row.seen_at != null,
            liveSha256: cached.liveSha256,
            differences: cached.differences,
          };
        return { ...emptyState(), busy: true };
      }
      return checkCore(server, { ...options, force: Boolean(options.force || options.afterStop) });
    });
  }

  // Takes the pending keys (or the whole baseline, for `keys` of null) from the files into the baseline. Only the
  // keys named join it, so changes made outside ARK Overseer to other keys are still reported. Throws when the
  // baseline cannot be written; the old one is then still in place.
  async function applyKeys(server, keys, source) {
    if (keys === null) return recordCore(server, source);
    const base = await loadBaseline(server);
    if (!base) return recordCore(server, 'first_read', { skipIfEmpty: true });
    const looked = await inspect(server, { force: true, raw: true });
    const mine = looked.differences.filter((diff) => keys.some((key) => sameKey(diff, key)));
    if (looked.differences.length === mine.length) return recordCore(server, source);
    if (!mine.length) {
      setPending(server.id, null);
      return finalize(server, await inspect(server, { force: true }), false);
    }
    const stagingRoot = path.join(dataDir, 'settings-staging', `server-${server.id}-save`);
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    try {
      const edits = await buildEdits({
        targetRoot: baselineConfigDir(base.folder),
        otherRoot: serverPaths(server.install_path).configDir,
        entries: mine.map((diff) => ({ diff, use: 'live' })),
        stagingRoot,
      });
      const replaced = new Set(
        [...edits.files.map((f) => f.rel), ...edits.removals.map((r) => r.rel)].map((r) => r.toLowerCase()),
      );
      const sources = [
        ...base.files
          .filter((file) => !replaced.has(file.relPath.slice(CONFIG_PREFIX.length + 1).toLowerCase()))
          .map((file) => ({ path: path.join(base.folder, ...file.relPath.split('/')), relPath: file.relPath })),
        ...edits.files.map((file) => ({ path: file.abs, relPath: `${CONFIG_PREFIX}/${file.rel}` })),
      ];
      await recordCore(server, source, { sources, keepDrift: true });
    } finally {
      await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
    return finalize(server, await inspect(server, { force: true }), false);
  }

  // What still has to be recorded is kept beside the last good baseline, which stays in place. The next check
  // tries again before it compares anything, and meanwhile ARK Overseer's own write is not reported as a change.
  async function markPending(server, source, keys) {
    if (!db.prepare('SELECT 1 FROM settings_baselines WHERE server_id = ?').get(server.id)) return;
    let named = keys;
    if (named === null) {
      // A whole-baseline record: what differs now is what ARK Overseer just wrote.
      try {
        const looked = await inspect(server, { force: true, raw: true });
        named = (looked.differences ?? []).map(({ file, section, key }) => ({ file, section, key }));
        if (!named.length) return;
      } catch {
        named = null;
      }
    }
    if (named) return setPending(server.id, { source, keys: named });
    try {
      setPending(server.id, { source, full: true, liveSha256: await liveSignature(server) });
    } catch (error) {
      log(`The settings baseline for server ${server.id} could not be marked for a retry: ${error.message}`);
    }
  }

  // Records a baseline and never throws: on a failure the last good baseline is kept and the record is retried.
  // `work` gets the keys to record, which include any that an earlier failure left pending.
  async function guarded(server, source, keys, work) {
    const pending = pendingOf(server.id);
    let all = keys;
    if (pending && all !== null) all = pending.full ? null : mergeKeys(pending.keys, all);
    try {
      return await work(all);
    } catch (error) {
      log(`Recording the settings baseline for server ${server.id} failed: ${error.message}`);
      await markPending(server, source, all).catch(() => {});
      return null;
    }
  }

  // Called after ARK Overseer wrote the settings files. A failed write never gets here.
  function recordBaseline(server, source, options = {}) {
    return serial(server.id, () => guarded(server, source, null, () => recordCore(server, source, options)));
  }

  // The first time a server's settings are read, or any time the baseline is missing.
  function ensureBaseline(server) {
    return serial(server.id, async () => {
      if (await loadBaseline(server)) return false;
      return Boolean(await recordCore(server, 'first_read', { skipIfEmpty: true }));
    });
  }

  // A settings save. The write and the record of it happen in one turn of the per-server lock, so no check of the
  // files (the one after a stop, in particular) can see the write before its baseline is in place, and no write
  // by ASA can be taken for the save's own. `write` throws when the save is refused, and then nothing is recorded.
  function saveSettings(server, write, saved) {
    return serial(server.id, async () => {
      const written = await write();
      await guarded(server, 'settings_save', saved, (keys) => applyKeys(server, keys, 'settings_save'));
      return written;
    });
  }

  // Records keys already written, for callers that made the write themselves.
  function recordAfterSave(server, saved) {
    return serial(server.id, () =>
      guarded(server, 'settings_save', saved, (keys) => applyKeys(server, keys, 'settings_save')),
    );
  }

  // Drops a server's baseline and open drift, for when the server itself is removed.
  function forgetBaseline(serverId) {
    db.prepare('DELETE FROM settings_baselines WHERE server_id = ?').run(serverId);
    db.prepare('DELETE FROM settings_drift WHERE server_id = ?').run(serverId);
    cache.delete(serverId);
  }

  async function removeBaseline(serverId) {
    forgetBaseline(serverId);
    await removeBaselineFolder(dataDir, serverId, ops);
  }

  function markSeen(serverId) {
    db.prepare('UPDATE settings_drift SET seen_at = ? WHERE server_id = ? AND seen_at IS NULL').run(stamp(), serverId);
    return { seen: true };
  }

  // Keeps the files as they are now: only the baseline changes.
  function adopt(server, liveSha256) {
    return serial(server.id, async () => {
      const looked = await inspect(server, { force: true });
      if (looked.noBaseline) throw new DriftError(409, 'nothing', DRIFT_MESSAGES.nothing);
      const plan = planResolve(looked, { action: 'adopt', liveSha256 });
      const made = await recordCore(server, 'drift_adopt');
      return { ...emptyState(made.liveSha256), adopted: true, keys: keysOf(plan.entries) };
    });
  }

  // The differences as they are now, checked against a request, without starting anything.
  function planFor(server, request) {
    return serial(server.id, async () => {
      const looked = await inspect(server, { force: true });
      if (looked.noBaseline) throw new DriftError(409, 'nothing', DRIFT_MESSAGES.nothing);
      return planResolve(looked, request);
    });
  }

  // ---- putting values back ----

  const syntheticTag = () => Number(`${now()}${sequence++ % 10}`);

  // The job behind revert and merge, and what a start runs inline when the server was shut down with settings
  // changed. It checks again, backs the settings up, builds the new files aside, swaps them in and takes the result
  // as the baseline.
  function resolveCore({ server, params = {}, jobId = null, signal, progress = () => {} }) {
    const auto = params.auto === true;
    const controller = signal ? null : new AbortController();
    const abort = signal ?? controller.signal;
    const tagNumber = jobId ?? syntheticTag();
    const tag = String(tagNumber);
    const step = (fraction, key) => progress(fraction, DRIFT_MESSAGES.steps[key]);
    const cancelled = () => abort.reason ?? new Error(DRIFT_MESSAGES.cancelled);
    let recorded = false;
    const audit = (outcome, extra = {}) => {
      recorded = true;
      try {
        db.prepare(
          'INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          stamp(),
          jobId == null ? 'system' : 'job',
          `server.settings.drift_${params.action ?? 'revert'}`,
          'server',
          server.id,
          JSON.stringify({ jobId, auto, outcome, ...extra }),
        );
      } catch (error) {
        // An audit failure does not change what happened to the files, but it is not lost silently.
        log(`Writing the settings audit event for server ${server.id} failed: ${error.message}`);
      }
    };
    const skip = (reason) => ({ skipped: reason });

    const run = async () => {
      step(0.05, 'checking');
      await clearEarlierRestore({ db, serverId: server.id, ops, now });
      const state = await checkCore(server, { force: true });
      let entries, partial;
      if (auto) {
        if (!keepEnabled(serverRow(server.id) ?? server)) return skip('off');
        if (!state.changed || !state.afterStop) return skip('nothing');
        if (params.liveSha256 && params.liveSha256 !== state.liveSha256) return skip('changed');
        entries = state.differences.filter(isCovered).map((diff) => ({ diff, use: 'baseline' }));
        if (!entries.length) return skip('nothing known');
        partial = entries.length < state.differences.length;
      } else {
        ({ entries } = planResolve(state, params));
        partial = false;
      }
      const action = auto ? 'revert' : params.action;
      const applied = entries.filter((entry) => entry.use === 'baseline');
      const keys = keysOf(applied);
      const base = await loadBaseline(server);
      const layout = serverPaths(server.install_path);
      const stagingRoot = path.join(dataDir, 'settings-staging', `server-${server.id}-${tag}`);
      let safety = null;
      try {
        if (applied.length) {
          step(0.15, 'building');
          await fsp.rm(stagingRoot, { recursive: true, force: true });
          const edits = await buildEdits({
            targetRoot: layout.configDir,
            otherRoot: baselineConfigDir(base.folder),
            entries: applied,
            stagingRoot,
          });
          if (abort.aborted) throw cancelled();
          step(0.3, 'safety');
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
              jobId,
              signal: abort,
              include: { world: false },
            });
          } catch (error) {
            if (abort.aborted) throw cancelled();
            if (error.code !== 'EMPTY_BACKUP')
              throw new Error(`${DRIFT_MESSAGES.safetyFailed} ${sentence(error.message)}`.trim());
          }
          if (abort.aborted) throw cancelled();
          // The plan, the new files and the safety backup were made from the files as the check saw them. If they
          // moved since, the new files are stale, so nothing is swapped.
          if ((await liveSignature(server)) !== state.liveSha256)
            throw new DriftError(409, 'changed', DRIFT_MESSAGES.changedSince);
          const unit = {
            label: 'settings',
            kind: 'files',
            dir: layout.configDir,
            source: stagingRoot,
            files: [...edits.files, ...edits.removals.map((removal) => ({ rel: removal.rel, remove: true }))],
          };
          const roots = [path.dirname(layout.configDir)];
          const setStage = (stage) =>
            db.prepare('UPDATE pending_restores SET stage = ? WHERE server_id = ?').run(stage, server.id);
          const dropPending = () => {
            try {
              db.prepare('DELETE FROM pending_restores WHERE server_id = ?').run(server.id);
            } catch {
              /* the row is settled by the next start */
            }
          };
          // From here a stop of ARK Overseer is settled at its next start, as a settings restore is.
          db.prepare(
            'INSERT INTO pending_restores (server_id, job_id, backup_id, scope, safety_backup_id, was_running, started_at, stage) VALUES (?, ?, NULL, ?, ?, 0, ?, ?)',
          ).run(server.id, tagNumber, 'settings_resolve', safety?.backupId ?? null, stamp(), 'staging');
          step(0.5, 'writing');
          try {
            await stageUnit(unit, { ops, tag, signal: abort });
            if (abort.aborted) throw cancelled();
            await swapUnit(unit, { ops, tag, onStage: () => setStage('swapping:settings') });
          } catch (error) {
            try {
              await settle({ roots, tag, mode: 'undo', ops });
            } catch {
              throw new Error(DRIFT_MESSAGES.filesNotPutBack);
            }
            dropPending();
            throw abort.aborted
              ? cancelled()
              : new Error(`${DRIFT_MESSAGES.filesFailed} ${sentence(error.message)}`.trim());
          }
          setStage('cleanup');
          let leftovers = false;
          try {
            await settle({ roots, tag, mode: 'finish', ops });
          } catch {
            leftovers = true;
          }
          if (!leftovers) dropPending();
        }
      } finally {
        await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
      // The result is the new baseline. After a partial put-back the baseline stays, so what ARK Overseer did not
      // cover is still reported.
      if (partial) await checkCore(server, { force: true, afterStop: true });
      else await recordCore(server, `drift_${action}`);
      const running = ACTIVE.has(supervisor?.status(server.id)?.observedState);
      audit('applied', { keys, safetyBackupId: safety?.backupId ?? null, ...(partial ? { partial: true } : {}) });
      step(0.95, running ? 'doneRunning' : 'done');
      return {
        action,
        changed: keys.length,
        safetyBackupId: safety?.backupId ?? null,
        appliesAtRestart: running,
        ...(partial ? { partial: true } : {}),
      };
    };
    return serial(server.id, async () => {
      try {
        return await run();
      } catch (error) {
        if (!recorded) audit(abort.aborted ? 'cancelled' : 'failed', { reason: String(error?.message ?? error) });
        throw error;
      }
    });
  }

  // ---- the option that puts ARK Overseer's values back after a stop ----

  function setKeepAfterStop(serverId, enabled) {
    const row = db.prepare('SELECT settings_json FROM servers WHERE id = ?').get(serverId);
    const settings = JSON.parse(row?.settings_json || '{}');
    if (enabled) settings.keepSettingsAfterStop = true;
    else delete settings.keepSettingsAfterStop;
    db.prepare('UPDATE servers SET settings_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(settings),
      stamp(),
      serverId,
    );
    return { enabled: Boolean(enabled) };
  }

  function queueAutoRevert(server, state) {
    if (!jobs || !keepEnabled(serverRow(server.id) ?? server)) return null;
    if (!state.changed || !state.afterStop || !state.differences.some(isCovered) || resolveQueued(server.id))
      return null;
    return jobs.enqueue(
      RESOLVE_JOB,
      { action: 'revert', auto: true, liveSha256: state.liveSha256 },
      { serverId: server.id, installId: server.install_id },
    );
  }

  // The supervisor reports a server that stopped. ASA rewrites its settings while it shuts down, so the files are
  // compared now, and a revert is queued when the server's option asks for one.
  function onStateChange(event) {
    if (event.to !== 'stopped' || event.from === 'stopped') return;
    const id = event.serverId;
    const task = (async () => {
      const server = serverRow(id);
      if (!server) return;
      queueAutoRevert(server, await checkDrift(server, { afterStop: true }));
    })().catch((error) => log(`Checking the settings after server ${id} stopped failed: ${error.message}`));
    afterStop.set(id, task);
    task.then(() => {
      if (afterStop.get(id) === task) afterStop.delete(id);
    });
  }

  // Run by the supervisor before it starts a server. A revert that the option asks for finishes first, so the
  // server never starts on the values it wrote itself. It runs only for a server that is stopped or crashed (a start
  // on a server whose state is unknown must not write files), and not while a restore, map switch or settings restore
  // owns the files. A queued put-back job for the server is not one of those: the start runs that revert itself. The
  // start waits at most `hookLimitMs`; after that it goes ahead, the put-back is cancelled if it has not begun to
  // swap, and the delay is logged.
  async function beforeStart(id) {
    const controller = new AbortController();
    let timer;
    const limit = new Promise((resolve) => {
      timer = timers.setTimeout(() => {
        log(fill(DRIFT_MESSAGES.startWaited, { id, seconds: Math.round(hookLimitMs / 1000) }));
        controller.abort(new Error(DRIFT_MESSAGES.cancelled));
        resolve();
      }, hookLimitMs);
      timer.unref?.();
    });
    const work = (async () => {
      await afterStop.get(id);
      const server = serverRow(id);
      if (!server || !keepEnabled(server)) return;
      if (!START_STATES.has(supervisor?.status(id)?.observedState)) return;
      if (otherFileJobActive(id) || !driftRow(id)?.after_stop) return;
      await resolveCore({ server, params: { action: 'revert', auto: true }, signal: controller.signal });
    })().catch((error) => log(`Putting the settings back before starting server ${id} failed: ${error.message}`));
    try {
      await Promise.race([work, limit]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  // `force` hashes every file of every server instead of trusting sizes and change times.
  async function checkAll({ force = false } = {}) {
    const rows = db
      .prepare('SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id ORDER BY s.id')
      .all();
    for (const server of rows) {
      try {
        await checkDrift(server, { force });
      } catch (error) {
        log(`Checking the settings of server ${server.id} failed: ${error.message}`);
      }
    }
  }

  // Checks every server now and then every ten minutes, and never starts a sweep while the last is still running.
  // Every sixth sweep, once an hour, hashes every file. There is no file watcher: Windows does not report a file
  // that is rewritten in place reliably.
  function start() {
    const run = () => {
      if (sweeps.size) return;
      sweepCount += 1;
      const task = checkAll({ force: sweepCount % FULL_SWEEP_EVERY === 0 });
      sweeps.add(task);
      task.then(() => sweeps.delete(task));
    };
    run();
    const timer = timers.setInterval(run, intervalMs);
    timer.unref?.();
    return () => timers.clearInterval(timer);
  }

  return {
    attach: (engine) => {
      jobs = engine;
    },
    checkDrift,
    checkAll,
    recordBaseline,
    recordAfterSave,
    saveSettings,
    ensureBaseline,
    forgetBaseline,
    removeBaseline,
    markSeen,
    adopt,
    planFor,
    setKeepAfterStop,
    keepEnabled,
    resolveNow: resolveCore,
    onStateChange,
    beforeStart,
    start,
    idle: () => Promise.all([...afterStop.values(), ...sweeps]),
    handlers: {
      [RESOLVE_JOB]: async ({ job, params = {}, signal, progress }) => {
        const server = serverRow(job.serverId);
        if (!server) throw new Error(SCHEDULE_MESSAGES.noServer);
        return resolveCore({ server, params, jobId: job.id, signal, progress });
      },
    },
  };
}
