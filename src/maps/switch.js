import { transaction } from '../db/transaction.js';
import { backupServer } from '../scheduler/backup.js';
import { PLAYER_MESSAGES, MESSAGES } from '../scheduler/handlers.js';
import { createTell, runCountdown, defaultSleep } from '../scheduler/countdown.js';
import { serverPaths } from '../supervisor/launch.js';
import { waitForReady, readLogMarker } from '../supervisor/ready.js';
import { saveFolders } from './inventory.js';
import { findModMaps, withModMaps } from './mod-maps.js';

export const SWITCH_MESSAGES = {
  needsMod: '{map} needs mod {modId}.',
  rolledBack: 'The server did not start on {new}: {reason} It is back on {old}.',
  rolledBackNoReason: 'The server did not start on {new}. It is back on {old}.',
  rollbackFailed: 'The server did not start on {new} or on {old}. Its map is set back to {old}. Check the server log.',
  restoreFailed:
    'The server did not start on {new}, and its map could not be set back to {old}. ARK Overseer will try again the next time it starts.',
  stopFailed: 'The server could not be stopped, so the map was not changed.',
  applyFailed: 'The map could not be changed, so the server stays on {old}.',
  alreadyRunning: 'The server was already running when ARK Overseer went to start it.',
  notRunning: 'The server was not running after ARK Overseer started it.',
  badMap: 'That map is not in the catalog and has no save on this install.',
  sameMap: 'The server is already on {map}.',
  restartFailed: 'It could not be started again either. Start it from the Overview page.',
  steps: {
    checking: 'Checking that {map} can run on this server.',
    countdown: 'Warning players in game before the map change.',
    stopping: 'Saving the world and shutting the server down.',
    backup: 'Backing up the current world and the settings files.',
    applying: 'Setting the launch map to {map}.',
    starting: 'Starting the server on {map}.',
    waiting: '{map} is loading. A big map can take 10 minutes or more.',
    rollingBack: "The new map didn't start, so {map} is going back on.",
    restarting: 'The backup failed, so nothing changed. Starting the server again on {map}.',
    done: 'The server now runs {map}.',
    doneStopped: 'The map is set to {map}. The server stays stopped until you start it.',
  },
};
// A map id ends up in a folder name and a launch line, so it stays to plain characters.
const MAP_ID = /^[A-Za-z0-9_]{1,64}$/;
// A server in one of these states may have a live process, so nothing is changed under it.
const ACTIVE = new Set(['running', 'starting', 'unknown']);

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
// A reason from an error, made into a sentence. Nothing in gives nothing out.
const sentence = (text) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};
const joinReason = (message, reason) => (reason ? `${message} ${reason}` : message);
function settingsOf(server) {
  try {
    const settings =
      typeof server.settings_json === 'string' ? JSON.parse(server.settings_json || '{}') : server.settings_json;
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}
const rawMods = (server) => (Array.isArray(settingsOf(server).mods) ? settingsOf(server).mods : []);
const modsOf = (server) => rawMods(server).map(String);

// The settings JSON with its mod list put back to `mods`. The text is returned as it was when the list
// already matches, so nothing else in it is reformatted.
function restoreMods(settingsJson, mods) {
  let settings;
  try {
    settings = JSON.parse(settingsJson || '{}');
  } catch {
    return settingsJson;
  }
  const current = Array.isArray(settings?.mods) ? settings.mods : [];
  if (current.length === mods.length && current.every((id, index) => String(id) === String(mods[index])))
    return settingsJson;
  const { mods: dropped, ...rest } = settings;
  return JSON.stringify(mods.length ? { ...rest, mods } : rest);
}

// Decides whether a server may be switched to a map. The API answers from this before it queues the job,
// and the job asks again when it runs, because the catalog, the install or the mod list may have changed
// in between. `code` is bad_map, same_map or needs_mod when the answer is no.
export function checkSwitch({ server, mapId, addMod = false, catalog, findMods = findModMaps }) {
  if (typeof mapId !== 'string' || !MAP_ID.test(mapId)) return { ok: false, code: 'bad_map' };
  const wanted = mapId.toLowerCase();
  if (String(server.map).toLowerCase() === wanted) return { ok: false, code: 'same_map' };
  const data = withModMaps(catalog.get(), server.install_path, findMods);
  const nameOf = (id) => data.maps.find((map) => map.id.toLowerCase() === String(id).toLowerCase())?.name ?? id;
  const listed = data.maps.find((map) => map.id === mapId) ?? data.maps.find((map) => map.id.toLowerCase() === wanted);
  let target = listed ? { id: listed.id, name: listed.name, kind: listed.kind, modId: listed.modId ?? null } : null;
  if (!target) {
    const folder = saveFolders(server.install_path).find((name) => name.toLowerCase() === wanted);
    if (folder && MAP_ID.test(folder)) target = { id: folder, name: folder, kind: null, modId: null };
  }
  if (!target) return { ok: false, code: 'bad_map' };
  let willAddMod = false;
  if (target.modId && !modsOf(server).includes(target.modId)) {
    if (addMod !== true) return { ok: false, code: 'needs_mod', modId: target.modId, map: target.name };
    willAddMod = true;
  }
  return { ok: true, map: target, addMod: willAddMod, nameOf };
}

function failureMessage(check, server) {
  if (check.code === 'needs_mod') return fill(SWITCH_MESSAGES.needsMod, { map: check.map, modId: check.modId });
  if (check.code === 'same_map') return fill(SWITCH_MESSAGES.sameMap, { map: server.map });
  return SWITCH_MESSAGES.badMap;
}

const auditEvent = (db, stamp, actor, action, serverId, detail) =>
  db
    .prepare(
      'INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(stamp, actor, action, 'server', serverId, JSON.stringify(detail));

// At startup: a switch that was cut off by a restart is undone. The old map and mod list go back, the
// server is meant to run again if it was running when the switch began, and the row is removed. This runs
// before the supervisor recovers, so a server that should be up is started on the old map. The list says
// which servers had their map or mods put back, since one of those may still have a process on the new map.
export function reconcilePendingSwitches({ db, now = () => Date.now() }) {
  const results = [];
  for (const row of db.prepare('SELECT * FROM pending_switches ORDER BY server_id').all()) {
    let changed = false;
    transaction(db, () => {
      const stamp = new Date(now()).toISOString();
      const server = db.prepare('SELECT map, settings_json FROM servers WHERE id = ?').get(row.server_id);
      if (server) {
        let mods = [];
        try {
          mods = JSON.parse(row.from_mods_json);
        } catch {
          mods = modsOf(server);
        }
        const settingsJson = restoreMods(server.settings_json, Array.isArray(mods) ? mods : []);
        changed = server.map !== row.from_map || settingsJson !== server.settings_json;
        db.prepare(
          "UPDATE servers SET map = ?, settings_json = ?, desired_state = CASE WHEN ? = 1 THEN 'running' ELSE desired_state END, updated_at = ? WHERE id = ?",
        ).run(row.from_map, settingsJson, row.was_running ? 1 : 0, stamp, row.server_id);
        auditEvent(db, stamp, 'system', 'server.map.switch_rolled_back', row.server_id, {
          from: row.to_map,
          to: row.from_map,
          reason: 'interrupted',
          jobId: row.job_id,
        });
      }
      db.prepare('DELETE FROM pending_switches WHERE server_id = ?').run(row.server_id);
    });
    results.push({ serverId: row.server_id, wasRunning: Boolean(row.was_running), changed });
  }
  return results;
}

export function createSwitchHandlers({
  db,
  dataDir,
  supervisor,
  rcon,
  getRconPassword,
  catalog,
  findMods = findModMaps,
  waitReady = waitForReady,
  sleep = defaultSleep,
  now = () => Date.now(),
  readyTimeoutMs,
  readyPollMs,
}) {
  const tell = createTell({ rcon, getRconPassword });
  const stamp = () => new Date(now()).toISOString();
  const serverRow = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);
  const stateOf = (id) => supervisor.status(id)?.observedState;
  const ready = (server, since, marker, signal) =>
    waitReady({
      logPath: serverPaths(server.install_path).logPath,
      since,
      marker,
      isAlive: () => ACTIVE.has(stateOf(server.id)),
      signal,
      sleep,
      now,
      ...(readyTimeoutMs === undefined ? {} : { timeoutMs: readyTimeoutMs }),
      ...(readyPollMs === undefined ? {} : { pollMs: readyPollMs }),
    });

  // Written before the server is stopped, and removed once the switch is settled, so a restart of ARK
  // Overseer in between is undone at the next start (see reconcilePendingSwitches).
  const savePending = (server, target, wasRunning, jobId) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO pending_switches (server_id, job_id, from_map, from_mods_json, to_map, was_running, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(server.id, jobId, server.map, JSON.stringify(rawMods(server)), target.id, wasRunning ? 1 : 0, stamp());
  const dropPending = (serverId) => {
    try {
      db.prepare('DELETE FROM pending_switches WHERE server_id = ?').run(serverId);
    } catch {
      /* the row is undone or dropped by the next start */
    }
  };

  // The process has to be one this call started, not one that was already there.
  async function startConfirmed(server) {
    const before = supervisor.status(server.id) ?? {};
    if (ACTIVE.has(before.observedState)) throw new Error(SWITCH_MESSAGES.alreadyRunning);
    await supervisor.start(server.id);
    const after = supervisor.status(server.id) ?? {};
    if (before.pid != null && after.pid === before.pid) throw new Error(SWITCH_MESSAGES.alreadyRunning);
    if (!['running', 'starting'].includes(after.observedState)) throw new Error(SWITCH_MESSAGES.notRunning);
  }

  // Puts the old map and the old mod list back, and starts the server on the old map again. The job fails
  // either way. If the map cannot be put back, the pending row stays and the next start finishes it.
  async function rollBack({ server, previous, target, error, signal, step }) {
    step(0.8, 'rollingBack', { map: previous.name });
    await supervisor.stop(server.id).catch(() => {});
    try {
      transaction(db, () => {
        const at = stamp();
        db.prepare('UPDATE servers SET map = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(
          previous.map,
          previous.settingsJson,
          at,
          server.id,
        );
        db.prepare('DELETE FROM pending_switches WHERE server_id = ?').run(server.id);
        auditEvent(db, at, 'job', 'server.map.switch_rolled_back', server.id, {
          from: target.id,
          to: previous.map,
          reason: String(error?.message ?? error),
        });
      });
    } catch {
      throw new Error(fill(SWITCH_MESSAGES.restoreFailed, { new: target.name, old: previous.name }));
    }
    let restored = false;
    try {
      const marker = await readLogMarker(serverPaths(server.install_path).logPath);
      const since = now();
      await startConfirmed(server);
      // A cancelled job has no time to wait for a large map; the server is already starting.
      if (!signal.aborted) await ready(server, since, marker, signal);
      restored = true;
    } catch {
      restored = false;
    }
    if (signal.aborted) throw error;
    const values = { new: target.name, old: previous.name, reason: sentence(error?.message) };
    if (!restored) throw new Error(fill(SWITCH_MESSAGES.rollbackFailed, values));
    throw new Error(fill(values.reason ? SWITCH_MESSAGES.rolledBack : SWITCH_MESSAGES.rolledBackNoReason, values));
  }

  return {
    'server.switch_map': async ({ job, params = {}, signal, progress }) => {
      const server = serverRow(job.serverId);
      if (!server) throw new Error(MESSAGES.noServer);
      const announce = params.announce ?? 'chat';
      const step = (fraction, key, values = {}) => progress(fraction, fill(SWITCH_MESSAGES.steps[key], values));
      const cancelled = () => signal.reason ?? new Error('The job was cancelled.');
      step(0.02, 'checking', { map: String(params.mapId ?? '') });
      const check = checkSwitch({ server, mapId: params.mapId, addMod: params.addMod === true, catalog, findMods });
      if (!check.ok) throw new Error(failureMessage(check, server));
      const target = check.map,
        from = server.map,
        oldName = check.nameOf(from);

      // Players are warned only while the server is up. Someone may stop it during the countdown, and then
      // the switch goes on as it would for a stopped server.
      let wasRunning = ACTIVE.has(stateOf(server.id));
      if (stateOf(server.id) === 'running') {
        step(0.05, 'countdown');
        try {
          await runCountdown(
            { tell, sleep },
            [server],
            params.countdownMinutes ?? [5, 1],
            (minutes) => PLAYER_MESSAGES.switchMap(minutes, target.name),
            announce,
            signal,
            progress,
          );
          if (signal.aborted) throw cancelled();
        } catch (error) {
          if (signal.aborted) await tell(server, announce, PLAYER_MESSAGES.switchCancelled).catch(() => {});
          throw error;
        }
        wasRunning = ACTIVE.has(stateOf(server.id));
        if (wasRunning) await tell(server, announce, PLAYER_MESSAGES.switching).catch(() => {});
      }
      if (signal.aborted) throw cancelled();

      // From here on a restart of ARK Overseer is undone at its next start, even before the map changes.
      savePending(server, target, wasRunning, job.id);

      // A server that is not stopped is stopped even when it is not counted as running, so a restart that
      // is waiting to happen cannot bring it back on the old map in the middle of the switch.
      if (stateOf(server.id) !== 'stopped') {
        step(0.3, 'stopping');
        try {
          await supervisor.stop(server.id);
        } catch (error) {
          dropPending(server.id);
          throw new Error(joinReason(SWITCH_MESSAGES.stopFailed, sentence(error.message)));
        }
      }

      // Until the map changes nothing needs undoing, so the server only goes back up on the map it was on.
      const putBack = async (error) => {
        let failed = false;
        if (wasRunning) {
          step(0.45, 'restarting', { map: oldName });
          failed = await supervisor.start(server.id).then(
            () => false,
            () => true,
          );
        }
        dropPending(server.id);
        throw failed ? new Error(`${error.message} ${SWITCH_MESSAGES.restartFailed}`) : error;
      };

      step(0.4, 'backup');
      let backup;
      try {
        backup = await backupServer({
          db,
          server,
          dataDir,
          reason: 'pre_switch',
          rcon,
          getRconPassword,
          isRunning: async () => false,
          now,
          jobId: job.id,
          signal,
        });
      } catch (error) {
        return putBack(error);
      }
      // A cancelled job changes nothing, whether or not the server was running.
      if (signal.aborted) return putBack(cancelled());

      step(0.55, 'applying', { map: target.name });
      let previous;
      try {
        transaction(db, () => {
          const at = stamp();
          const row = db.prepare('SELECT map, settings_json FROM servers WHERE id = ?').get(server.id);
          previous = { map: row.map, settingsJson: row.settings_json, name: oldName };
          let settingsJson = row.settings_json;
          if (check.addMod) {
            const settings = JSON.parse(row.settings_json || '{}');
            const mods = Array.isArray(settings.mods) ? settings.mods : [];
            if (!mods.map(String).includes(target.modId))
              settingsJson = JSON.stringify({ ...settings, mods: [...mods, target.modId] });
          }
          db.prepare('UPDATE servers SET map = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(
            target.id,
            settingsJson,
            at,
            server.id,
          );
          auditEvent(db, at, 'job', 'server.map.switch', server.id, {
            from: row.map,
            to: target.id,
            ...(check.addMod ? { addedMod: target.modId } : {}),
            jobId: job.id,
          });
          // A stopped server is done with the switch here. A running one is done when it is ready.
          if (!wasRunning) db.prepare('DELETE FROM pending_switches WHERE server_id = ?').run(server.id);
        });
      } catch (error) {
        const message = fill(SWITCH_MESSAGES.applyFailed, { old: oldName });
        return putBack(new Error(joinReason(message, sentence(error.message))));
      }
      const result = { from, to: target.id, backupId: backup.backupId, started: wasRunning };
      if (!wasRunning) {
        step(0.95, 'doneStopped', { map: target.name });
        return result;
      }

      step(0.6, 'starting', { map: target.name });
      try {
        const marker = await readLogMarker(serverPaths(server.install_path).logPath);
        const since = now();
        await startConfirmed(server);
        step(0.7, 'waiting', { map: target.name });
        await ready(server, since, marker, signal);
      } catch (error) {
        return rollBack({ server, previous, target, error, signal, step });
      }
      dropPending(server.id);
      // A job that was cancelled does not report success.
      if (signal.aborted) throw cancelled();
      step(0.95, 'done', { map: target.name });
      return result;
    },
  };
}
