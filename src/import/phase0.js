import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { readAppManifest } from '../steamcmd/steamcmd.js';
import { readIniLines, getIniKey, SESSION_SETTINGS, SERVER_SETTINGS } from '../settings/ini.js';
import { serverPaths } from '../supervisor/launch.js';
import { findConflicts } from '../network/ports.js';
import { nowIso, transaction } from '../db/index.js';

export const MESSAGES = {
  noProfiles: 'No profiles.json was found in that folder, or it could not be read.',
  badProfile: 'This profile is missing a name, a valid map name or a valid port.',
  noExe: 'ArkAscendedServer.exe was not found in the install folder.',
  noConfig: 'GameUserSettings.ini was not found, so the server settings cannot be read.',
  changedSincePreview: 'A settings file changed after the preview. Run the preview again before importing.',
  nameTaken: 'A server with this name already exists.',
  alreadyImported: 'This server has already been imported.',
  installHasServer: 'This install already runs {name}. Each server needs its own install.',
  steamClient:
    'This server runs from a Steam library, so Steam keeps it up to date. ARK Overseer will not update or validate it.',
  noAdminPassword: 'No admin password is set, so saving before a shutdown and in-game warnings will not work.',
  noWorld: 'No saved world was found for this map. The server will start a new world.',
  noServerPassword: 'No join password is set, so anyone can join.',
  steamClientInstall:
    'This install is kept up to date by Steam. Update it in Steam, or install a separate copy with SteamCMD.',
};

// The world and player files the server needs to come back as it was. ASA's own timestamped world
// copies and other leftovers in the same folder are several gigabytes and are left out.
const SAVE_FILE = /\.(arkprofile|profilebak|arktribe|tribebak)$/i;
const CONFIG_FILES = ['GameUserSettings.ini', 'Game.ini', 'Engine.ini'];

export const hashFile = async (file) => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
};
const safeJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const pathKey = (value) =>
  path.win32
    .normalize(String(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
// Removing a folder on the way out of a failure must never replace the error that caused it.
const removeQuietly = (dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
const portGood = (n, game = false) => Number.isInteger(n) && n >= 1024 && n <= (game ? 65534 : 65535);

// The id names a folder under profile-data and the snapshot folder, so it may not climb out of either.
function profileValid(profile) {
  return (
    /^[A-Za-z0-9_-]+$/.test(String(profile?.id ?? '')) &&
    typeof profile?.name === 'string' &&
    profile.name.trim() !== '' &&
    /^[A-Za-z0-9_]+$/.test(String(profile?.map ?? '')) &&
    typeof profile?.serverRoot === 'string' &&
    path.win32.isAbsolute(profile.serverRoot) &&
    portGood(profile?.gamePort, true) &&
    portGood(profile?.queryPort) &&
    portGood(profile?.rconPort)
  );
}

// Phase 0 reads the per-profile file whole and falls back to the top-level file only when it is
// missing, so the two are never merged key by key. Values that the launch line could not use are
// refused here rather than when the server first starts.
function launchSettings(dashboardDir, profileId) {
  const settings =
    safeJson(path.join(dashboardDir, 'profile-data', profileId, 'dashboard-settings.json')) ??
    safeJson(path.join(dashboardDir, 'dashboard-settings.json')) ??
    {};
  const maxPlayers = settings.maxPlayers ?? 70;
  const mods = settings.mods ?? [];
  const valid =
    Number.isInteger(maxPlayers) &&
    maxPlayers >= 1 &&
    maxPlayers <= 1000 &&
    Array.isArray(mods) &&
    mods.every((id) => /^\d+$/.test(String(id)));
  return {
    valid,
    maxPlayers,
    mods: Array.isArray(mods) ? mods.map(String) : [],
    disableBattlEye: settings.disableBattlEye === true,
  };
}

export async function detectPhase0(dashboardDir) {
  const profiles = safeJson(path.join(dashboardDir, 'profiles.json'));
  if (!Array.isArray(profiles)) throw new Error(MESSAGES.noProfiles);
  const servers = [];
  for (const profile of profiles) {
    const valid = profileValid(profile);
    const profileId = String(profile?.id ?? '');
    const settings = valid ? launchSettings(dashboardDir, profileId) : null;
    const problems = [];
    if (!valid || !settings.valid) problems.push({ code: 'profile', message: MESSAGES.badProfile });
    // Nothing is read from a profile that fails validation: a relative or empty server root would
    // resolve against whatever folder this process happens to run in.
    const installPath = valid ? profile.serverRoot : String(profile?.serverRoot ?? '');
    const paths = valid ? serverPaths(installPath) : null;
    const exeExists = Boolean(paths && fs.existsSync(paths.exePath));
    const gameUser = paths?.gameUserSettingsPath;
    const hasConfig = Boolean(gameUser && fs.existsSync(gameUser));
    if (valid && !exeExists) problems.push({ code: 'exe', message: MESSAGES.noExe });
    if (valid && !hasConfig) problems.push({ code: 'config', message: MESSAGES.noConfig });
    const lines = hasConfig ? readIniLines(gameUser) : [];
    const sessionName = getIniKey(lines, SESSION_SETTINGS, 'SessionName') || profile?.name || '';
    // Only whether a password is set leaves this function, never its value.
    const passwordSet = (key) => Boolean(getIniKey(lines, SERVER_SETTINGS, key));

    const files = [];
    if (valid) {
      const savedDir = path.join(installPath, 'ShooterGame', 'Saved');
      const addFile = async (role, absolute) => {
        const relPath = path.relative(savedDir, absolute).replaceAll('\\', '/');
        files.push({ role, relPath, path: absolute, ...(await hashFile(absolute)) });
      };
      for (const name of CONFIG_FILES) {
        const file = path.join(path.dirname(gameUser), name);
        if (fs.existsSync(file)) await addFile('config', file);
      }
      const worldDir = path.join(savedDir, 'SavedArks', profile.map);
      // Windows file names ignore case, so the live world may be spelled differently from the map.
      const worldName = `${profile.map}.ark`.toLowerCase();
      if (fs.existsSync(worldDir))
        for (const entry of await fsp.readdir(worldDir, { withFileTypes: true })) {
          if (entry.isFile() && (entry.name.toLowerCase() === worldName || SAVE_FILE.test(entry.name)))
            await addFile('save', path.join(worldDir, entry.name));
        }
    }
    const manifest = valid ? readAppManifest(installPath) : null;
    servers.push({
      profileId,
      name: profile?.name ?? '',
      map: profile?.map ?? '',
      installPath,
      installSource: /[\\/]steamapps[\\/]common[\\/]/i.test(installPath) ? 'steam-client' : 'steamcmd',
      exeExists,
      buildId: manifest?.buildId ?? null,
      gamePort: profile?.gamePort,
      queryPort: profile?.queryPort,
      rconPort: profile?.rconPort,
      sessionName,
      maxPlayers: settings?.maxPlayers ?? 70,
      mods: settings?.mods ?? [],
      disableBattlEye: settings?.disableBattlEye ?? false,
      hasServerPassword: passwordSet('ServerPassword'),
      hasAdminPassword: passwordSet('ServerAdminPassword'),
      files,
      problems,
    });
  }
  return { dashboardDir, servers };
}

function analyze(db, server, options) {
  const host = db.prepare('SELECT * FROM hosts WHERE name = ?').get(options.hostName);
  const installs = host ? db.prepare('SELECT * FROM installs WHERE host_id = ?').all(host.id) : [];
  const install = installs.find((row) => pathKey(row.path) === pathKey(server.installPath)) ?? null;
  const ports = host
    ? findConflicts(db, {
        hostId: host.id,
        proposal: { gamePort: server.gamePort, queryPort: server.queryPort, rconPort: server.rconPort },
        listeners: options.listeners,
        ignorePids: options.ignorePids,
      })
    : [];
  const conflicts = ports.map((item) => ({
    code: 'port',
    message: `${item.protocol.toUpperCase()} ${item.port} (${item.role}): ${item.reason}`,
  }));
  if (db.prepare('SELECT 1 FROM servers WHERE name = ? COLLATE NOCASE').get(server.name))
    conflicts.push({ code: 'name', message: MESSAGES.nameTaken });
  // One server per install: ASA keeps a server's settings and saves inside its install. The same server
  // imported twice gets its own message, since that is the more useful thing to tell someone.
  const holders = install ? db.prepare('SELECT name, map FROM servers WHERE install_id = ?').all(install.id) : [];
  if (holders.some((row) => row.name === server.name && row.map === server.map))
    conflicts.push({ code: 'imported', message: MESSAGES.alreadyImported });
  else if (holders.length)
    conflicts.push({ code: 'install', message: MESSAGES.installHasServer.replace('{name}', () => holders[0].name) });
  const warnings = [];
  if (server.installSource === 'steam-client') warnings.push({ code: 'steamClient', message: MESSAGES.steamClient });
  if (!server.hasAdminPassword) warnings.push({ code: 'noAdminPassword', message: MESSAGES.noAdminPassword });
  const world = `SavedArks/${server.map}/${server.map}.ark`.toLowerCase();
  if (!server.files.some((file) => file.relPath.toLowerCase() === world))
    warnings.push({ code: 'noWorld', message: MESSAGES.noWorld });
  if (!server.hasServerPassword) warnings.push({ code: 'noServerPassword', message: MESSAGES.noServerPassword });
  return {
    profileId: server.profileId,
    name: server.name,
    ok: !server.problems.length && !conflicts.length,
    host: { id: host?.id ?? null, name: host?.name ?? options.hostName },
    install: {
      id: install?.id ?? null,
      path: server.installPath,
      source: server.installSource,
      buildId: server.buildId,
      state: server.exeExists ? 'installed' : 'missing',
    },
    server: {
      name: server.name,
      map: server.map,
      session_name: server.sessionName,
      game_port: server.gamePort,
      query_port: server.queryPort,
      rcon_port: server.rconPort,
      max_players: server.maxPlayers,
      settings: { mods: server.mods, disableBattlEye: server.disableBattlEye },
    },
    conflicts,
    problems: server.problems,
    warnings,
    files: server.files,
  };
}

export function previewImport(db, detection, { hostName = 'local', listeners = [], ignorePids = [] } = {}) {
  const options = { hostName, listeners, ignorePids };
  return { servers: detection.servers.map((server) => analyze(db, server, options)) };
}

// Copies one file and returns the hash of what was written, computed as it streams through.
export async function copyHashed(source, target) {
  const hash = createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(source), hasher, fs.createWriteStream(target));
  return { size, sha256: hash.digest('hex') };
}

export async function snapshotFiles(files, destDir, { copy = copyHashed, signal } = {}) {
  await fsp.mkdir(path.dirname(destDir), { recursive: true });
  // A plain mkdir fails if the folder exists, so two imports can never write into one snapshot, and a
  // snapshot this call did not create is never removed by it.
  try {
    await fsp.mkdir(destDir);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Snapshot destination already exists: ${destDir}`);
    throw error;
  }
  try {
    const copied = [];
    for (const file of files) {
      // A cancelled job stops between files, and the catch below removes the partial snapshot.
      if (signal?.aborted) throw signal.reason;
      const target = path.join(destDir, ...file.relPath.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      // A running server saves every few minutes. A copy is kept only if the source still hashes the
      // same afterwards, so a file caught mid-save is copied again.
      let result = null;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        const written = await copy(file.path, target);
        const source = await hashFile(file.path);
        if (written.sha256 === source.sha256) result = written;
      }
      if (!result) throw new Error(`${file.relPath} kept changing while it was copied`);
      copied.push({ relPath: file.relPath, size: result.size, sha256: result.sha256 });
    }
    const manifestPath = path.join(destDir, 'snapshot.json');
    await fsp.writeFile(manifestPath, JSON.stringify({ createdAt: nowIso(), files: copied }, null, 2));
    const manifest = await hashFile(manifestPath);
    const sizeBytes = copied.reduce((sum, file) => sum + file.size, manifest.size);
    return { path: destDir, sizeBytes, sha256: manifest.sha256, files: copied };
  } catch (error) {
    await removeQuietly(destDir);
    throw error;
  }
}

function changedSincePreview() {
  const error = new Error(MESSAGES.changedSincePreview);
  error.code = 'CHANGED_SINCE_PREVIEW';
  return error;
}

export async function applyImport(
  db,
  detection,
  profileId,
  { snapshotRoot, hostName = 'local', listeners = [], ignorePids = [] },
) {
  const server = detection.servers.find((item) => item.profileId === profileId);
  if (!server) throw new Error(`Profile ${profileId} was not detected`);
  if (server.problems.length) throw new Error(server.problems.map((item) => item.message).join(' '));
  // The rows are built from the settings files as the preview read them, so an edited settings file
  // stops the import. Save files change on their own while the server runs, and that is expected.
  const configs = server.files.filter((file) => file.role === 'config');
  for (const file of configs) {
    const current = await hashFile(file.path).catch(() => null);
    if (current?.sha256 !== file.sha256) throw changedSincePreview();
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const snapshotPath = path.join(snapshotRoot, `${profileId}-${timestamp}`);
  const snapshot = await snapshotFiles(server.files, snapshotPath);
  try {
    // A settings file edited between the check above and its copy would leave a snapshot that does
    // not match the rows, so the copies are checked too.
    for (const file of configs) {
      if (snapshot.files.find((copy) => copy.relPath === file.relPath)?.sha256 !== file.sha256)
        throw changedSincePreview();
    }
    return transaction(db, () => {
      const stamp = nowIso();
      let host = db.prepare('SELECT * FROM hosts WHERE name = ?').get(hostName);
      if (!host) {
        const id = db
          .prepare("INSERT INTO hosts (created_at, updated_at, name, kind) VALUES (?, ?, ?, 'local')")
          .run(stamp, stamp, hostName).lastInsertRowid;
        host = { id: Number(id), name: hostName };
      }
      let install = db
        .prepare('SELECT * FROM installs WHERE host_id = ?')
        .all(host.id)
        .find((row) => pathKey(row.path) === pathKey(server.installPath));
      if (!install) {
        const id = db
          .prepare(
            'INSERT INTO installs (created_at, updated_at, host_id, path, build_id, state, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            stamp,
            stamp,
            host.id,
            server.installPath,
            server.buildId,
            server.exeExists ? 'installed' : 'missing',
            server.installSource,
          ).lastInsertRowid;
        install = { id: Number(id) };
      }
      // Checked again inside the write lock: another server may have been added since the preview.
      const check = analyze(db, server, { hostName, listeners, ignorePids });
      if (check.conflicts.length) {
        const error = new Error(check.conflicts.map((c) => c.message).join(' '));
        error.conflicts = check.conflicts;
        throw error;
      }
      // Imported stopped: the Phase 0 dashboard still runs this server, so nothing here starts,
      // stops or restarts it until someone does so on purpose.
      const serverId = Number(
        db
          .prepare(
            `INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port,
               query_port, rcon_port, max_players, desired_state, settings_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?)`,
          )
          .run(
            stamp,
            stamp,
            host.id,
            install.id,
            server.name,
            server.map,
            server.sessionName,
            server.gamePort,
            server.queryPort,
            server.rconPort,
            server.maxPlayers,
            JSON.stringify({ mods: server.mods, disableBattlEye: server.disableBattlEye }),
          ).lastInsertRowid,
      );
      const backupId = Number(
        db
          .prepare(
            "INSERT INTO backups (created_at, server_id, reason, path, size_bytes, sha256) VALUES (?, ?, 'pre_import', ?, ?, ?)",
          )
          .run(stamp, serverId, snapshot.path, snapshot.sizeBytes, snapshot.sha256).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, 'system', 'server.import', 'server', ?, ?)",
      ).run(stamp, serverId, JSON.stringify({ profileId, dashboardDir: detection.dashboardDir, snapshotPath }));
      return { hostId: host.id, installId: install.id, serverId, backupId, snapshotPath };
    });
  } catch (error) {
    await removeQuietly(snapshotPath);
    throw error;
  }
}
