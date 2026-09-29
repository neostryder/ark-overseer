import fs from 'node:fs/promises';
import path from 'node:path';
import { allocatePorts } from '../network/ports.js';
import { copyHashed, hashFile } from '../import/phase0.js';
import { createTell, defaultSleep, runCountdown } from '../scheduler/countdown.js';
import { PLAYER_MESSAGES } from '../scheduler/handlers.js';
import { readLogMarker, waitForReady } from '../supervisor/ready.js';
import { serverPaths } from '../supervisor/launch.js';
import { readIniFile, writeIniFile, setIniKey, SERVER_SETTINGS, SESSION_SETTINGS } from '../settings/ini.js';
import { checkClone, checkCopyPathLength, checkDestination, freeSpace, gigabytes, MESSAGES } from './core.js';
import { checkActionOptions } from '../clusters/core.js';
import { transaction } from '../db/transaction.js';
import { clonePasswords } from './secrets.js';
import { cleanClone, recordClonePath } from './recovery.js';

const stamp = () => new Date().toISOString();
const serverRow = (db, id) =>
  db
    .prepare(
      'SELECT s.*, i.path AS install_path, i.source AS install_source, i.branch AS install_branch FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
    )
    .get(id);
const running = (supervisor, id) => ['running', 'starting', 'unknown'].includes(supervisor.status(id)?.observedState);
const abortIf = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new Error(MESSAGES.cancelled);
};

async function copyInstall(
  source,
  target,
  { copyWorld, signal, fsOps, copy = copyHashed, verify = false, record = () => {} },
) {
  const checked = [];
  const realSource = await fsOps.realpath(source);
  const visited = new Set();
  const safe = async (file) => {
    const info = await fsOps.lstat(file);
    if (info.isSymbolicLink()) return false;
    const real = await fsOps.realpath(file);
    const relative = path.relative(realSource, real);
    return (
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const mkdir = async (folder) => {
    const relative = path.relative(target, folder);
    if (!relative) return;
    let current = target;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        await fsOps.mkdir(current);
        record(current, 'directory');
      } catch (error) {
        if (error.code !== 'EEXIST' || !(await fsOps.lstat(current)).isDirectory()) throw error;
      }
    }
  };
  const reserveFile = async (file) => {
    const handle = await fsOps.open(file, 'wx');
    try {
      record(file, 'file');
    } finally {
      await handle.close();
    }
  };
  const walk = async (from, to, parts = []) => {
    abortIf(signal);
    const realFrom = await fsOps.realpath(from);
    if (visited.has(realFrom)) return;
    visited.add(realFrom);
    if (to === target) await fsOps.mkdir(target, { recursive: true });
    await mkdir(to);
    for (const entry of await fsOps.readdir(from, { withFileTypes: true })) {
      abortIf(signal);
      const original = path.join(from, entry.name);
      if (!(await safe(original))) continue;
      const next = [...parts, entry.name];
      const isSaved = next.length === 2 && next[0].toLowerCase() === 'shootergame' && next[1].toLowerCase() === 'saved';
      if (isSaved && !copyWorld) {
        const config = path.join(from, entry.name, 'Config');
        const windows = path.join(config, 'WindowsServer');
        for (const name of ['GameUserSettings.ini', 'Game.ini']) {
          const original = path.join(windows, name);
          try {
            if (!(await safe(original)) || !(await safe(config)) || !(await safe(windows))) continue;
          } catch (cause) {
            if (cause.code === 'ENOENT') continue;
            throw cause;
          }
          const destination = path.join(to, entry.name, 'Config', 'WindowsServer', name);
          await mkdir(path.dirname(destination));
          await reserveFile(destination);
          await copy(original, destination);
        }
        continue;
      }
      const destination = path.join(to, entry.name);
      if (entry.isDirectory()) await walk(original, destination, next);
      else if (entry.isFile()) {
        await reserveFile(destination);
        if (
          verify &&
          (next.some((part) => part.toLowerCase() === 'saved') ||
            ['gameusersettings.ini', 'game.ini'].includes(entry.name.toLowerCase()))
        ) {
          const sourceHash = await hashFile(original);
          const written = await copy(original, destination);
          if (sourceHash.sha256 !== written.sha256 || sourceHash.size !== written.size)
            throw new Error(MESSAGES.copyFailed.replace('{target}', target).replace('{source}', source));
          checked.push({ original, destination, ...sourceHash });
        } else await copy(original, destination);
      }
    }
  };
  await walk(source, target);
  for (const file of checked) {
    abortIf(signal);
    const actual = await hashFile(file.destination);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size)
      throw new Error(MESSAGES.copyFailed.replace('{target}', target).replace('{source}', source));
  }
  return { verified: checked.length };
}

async function newestWorldTime(root, fsOps) {
  const folder = path.join(root, 'ShooterGame', 'Saved', 'SavedArks');
  let newest = 0;
  const walk = async (dir) => {
    for (const entry of await fsOps.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.ark$/i.test(entry.name))
        newest = Math.max(newest, (await fsOps.stat(file)).mtimeMs);
    }
  };
  await walk(folder).catch((cause) => {
    if (cause.code !== 'ENOENT') throw cause;
  });
  return newest;
}

async function saveWorld(server, { rcon, getRconPassword, fsOps, sleep, signal, now }) {
  const before = await newestWorldTime(server.install_path, fsOps);
  try {
    await rcon({
      host: '127.0.0.1',
      port: server.rcon_port,
      password: await getRconPassword(server),
      command: 'SaveWorld',
    });
  } catch {
    throw new Error(MESSAGES.saveFailed);
  }
  const deadline = now() + 30000;
  while (now() < deadline) {
    abortIf(signal);
    if ((await newestWorldTime(server.install_path, fsOps)) > before) return;
    await sleep(Math.min(1000, deadline - now()), signal);
  }
}

function writeCloneSettings(server, params) {
  const file = serverPaths(server.install_path).gameUserSettingsPath;
  const ini = readIniFile(file);
  setIniKey(ini.lines, SESSION_SETTINGS, 'SessionName', params.sessionName);
  setIniKey(ini.lines, SESSION_SETTINGS, 'Port', String(server.game_port));
  if (server.query_port != null) setIniKey(ini.lines, SESSION_SETTINGS, 'QueryPort', String(server.query_port));
  if (server.rcon_port != null) setIniKey(ini.lines, SERVER_SETTINGS, 'RCONPort', String(server.rcon_port));
  if (params.adminPassword !== undefined)
    setIniKey(ini.lines, SERVER_SETTINGS, 'ServerAdminPassword', params.adminPassword);
  if (params.joinPassword !== undefined) setIniKey(ini.lines, SERVER_SETTINGS, 'ServerPassword', params.joinPassword);
  writeIniFile(file, ini);
}

export function createTransferHandlers({
  db,
  dataDir,
  supervisor,
  steamcmd,
  drift,
  rcon,
  getRconPassword,
  listListeners = async () => [],
  fsOps = fs,
  copy = copyHashed,
  sleep = defaultSleep,
  now = () => Date.now(),
  ready = waitForReady,
  marker = readLogMarker,
}) {
  const tell = createTell({ rcon, getRconPassword });
  return {
    'server.clone': async (ctx) => {
      const { job, params, signal, progress } = ctx;
      const target = db.prepare('SELECT * FROM installs WHERE id = ?').get(job.installId);
      if (!target) throw new Error(MESSAGES.folderUsed);
      db.prepare('INSERT OR REPLACE INTO pending_clones (job_id, install_id, target_path) VALUES (?, ?, ?)').run(
        job.id,
        target.id,
        target.path,
      );
      try {
        const source = serverRow(db, job.serverId);
        if (!source) throw new Error(MESSAGES.missing);
        const input = checkClone({ ...params, ...clonePasswords(db).get(job.id) }, db);
        if (target.path !== input.path) throw new Error(MESSAGES.folderUsed);
        await checkCopyPathLength(source.install_path, target.path, fsOps, { copyWorld: input.copyWorld });
        // The target was reserved when the route queued this job. Recheck the disk before creating anything.
        try {
          if ((await fsOps.readdir(target.path)).length) throw new Error(MESSAGES.folderNotEmpty);
        } catch (cause) {
          if (cause.code !== 'ENOENT') throw cause;
          await fsOps.mkdir(path.dirname(target.path), { recursive: true });
          await fsOps.mkdir(target.path).catch((error) => {
            if (error.code === 'EEXIST') throw new Error(MESSAGES.folderNotEmpty);
            throw error;
          });
          db.prepare('UPDATE pending_clones SET created_root = 1 WHERE job_id = ?').run(job.id);
        }
        const space = await freeSpace(target.path, source.install_path, fsOps);
        if (space.freeBytes < space.requiredBytes)
          throw new Error(
            MESSAGES.noSpace
              .replace('{required}', gigabytes(space.requiredBytes))
              .replace('{free}', gigabytes(space.freeBytes)),
          );
        if (running(supervisor, source.id))
          await saveWorld(source, { rcon, getRconPassword, fsOps, sleep, signal, now });
        abortIf(signal);
        progress(0.1, MESSAGES.copying);
        await copyInstall(source.install_path, target.path, {
          copyWorld: input.copyWorld,
          signal,
          fsOps,
          copy,
          record: (file, kind) => recordClonePath(db, job.id, target.path, file, kind),
        });
        abortIf(signal);
        progress(0.7, MESSAGES.validating);
        const { runInstall } = await import('../steamcmd/handlers.js');
        await runInstall({ db, steamcmd }, { ...ctx, job: { ...job, installId: target.id } }, 'validate');
        abortIf(signal);
        const ports = allocatePorts(db, { hostId: source.host_id, listeners: await listListeners() });
        const serverId = transaction(db, () => {
          const inserted = Number(
            db
              .prepare(
                'INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port, query_port, rcon_port, max_players, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .run(
                stamp(),
                stamp(),
                source.host_id,
                target.id,
                input.name,
                source.map,
                input.sessionName,
                ports.gamePort,
                ports.queryPort,
                ports.rconPort,
                source.max_players,
                source.settings_json,
              ).lastInsertRowid,
          );
          db.prepare('UPDATE pending_clones SET server_id = ? WHERE job_id = ?').run(inserted, job.id);
          return inserted;
        });
        const clone = serverRow(db, serverId);
        await drift.saveSettings(clone, () => writeCloneSettings(clone, input), null);
        abortIf(signal);
        return { serverId, installId: target.id, path: target.path, ports };
      } catch (cause) {
        await cleanClone({ db, dataDir, jobId: job.id, fsOps, drift });
        throw cause;
      } finally {
        clonePasswords(db).delete(job.id);
      }
    },
    'server.move': async ({ job, params, signal, progress }) => {
      checkActionOptions({ countdownMinutes: params.countdownMinutes, announce: params.announce });
      const server = serverRow(db, job.serverId);
      if (!server) throw new Error(MESSAGES.missing);
      const source = server.install_path;
      const target = (await checkDestination(db, params.path, source, fsOps)).path;
      const wasRunning = running(supervisor, server.id);
      let changed = false;
      db.prepare(
        'INSERT OR REPLACE INTO pending_moves (job_id, server_id, source_path, target_path, was_running, stage) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(job.id, server.id, source, target, Number(wasRunning), 'prepared');
      const stage = (value) => db.prepare('UPDATE pending_moves SET stage = ? WHERE job_id = ?').run(value, job.id);
      try {
        if (wasRunning) {
          await runCountdown(
            { tell, sleep },
            [server],
            params.countdownMinutes ?? [10, 5, 1],
            PLAYER_MESSAGES.move,
            params.announce ?? 'chat',
            signal,
            progress,
          );
          await saveWorld(server, { rcon, getRconPassword, fsOps, sleep, signal, now });
          await supervisor.stop(server.id);
          stage('stopped');
        }
        progress(0.2, MESSAGES.copying);
        const copied = await copyInstall(source, target, { copyWorld: true, signal, fsOps, copy, verify: true });
        stage('copied');
        abortIf(signal);
        db.prepare('UPDATE installs SET path = ?, updated_at = ? WHERE id = ?').run(target, stamp(), server.install_id);
        changed = true;
        stage('path_updated');
        await drift.recordBaseline(serverRow(db, server.id), 'server_moved');
        stage('rebaselined');
        if (wasRunning) {
          const logPath = serverPaths(target).logPath;
          const oldMarker = await marker(logPath);
          const since = now();
          try {
            await supervisor.start(server.id);
            await ready({ logPath, since, marker: oldMarker, isAlive: () => running(supervisor, server.id), signal });
            stage('started');
          } catch {
            throw new Error(MESSAGES.startFailed.replace('{source}', source).replace('{target}', target));
          }
        }
        return {
          source,
          target,
          verified: copied.verified,
          message: `${MESSAGES.oldFolder.replace('{source}', source).replace('{target}', target)} ${MESSAGES.network}`,
        };
      } catch (cause) {
        if (!changed) {
          if (wasRunning && !running(supervisor, server.id)) await supervisor.start(server.id).catch(() => {});
          if (cause.message === MESSAGES.folderNotEmpty || cause.status) throw cause;
          throw new Error(
            `${MESSAGES.copyFailed.replace('{source}', source).replace('{target}', target)} ${cause.message}`,
          );
        }
        throw cause;
      } finally {
        db.prepare('DELETE FROM pending_moves WHERE job_id = ?').run(job.id);
      }
    },
  };
}
