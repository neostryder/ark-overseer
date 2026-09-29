import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRouter, SECURITY_HEADERS } from './http/router.js';
import { serveStatic } from './http/static.js';
import { createAuth, AUTH_MESSAGES, originAllowed, hostAllowed } from './auth/auth.js';
import { transaction } from './db/transaction.js';
import { allocatePorts, assignPorts, findConflicts } from './network/ports.js';
import { streamJobEvents } from './jobs/sse.js';
import { firewallPreview, applyFirewallScript } from './network/firewall.js';
import { detectPhase0, previewImport, applyImport } from './import/phase0.js';
import { createSettingsStore } from './settings/store.js';
import { SESSION_NAME_MAX_LENGTH } from './settings/fields.js';
import { serverPaths } from './supervisor/launch.js';
import { redact } from './util/redact.js';
import { parseCron, describeCron } from './scheduler/cron.js';
import { createCatalog } from './maps/catalog.js';
import { createArtResolver, findModPreview } from './maps/art.js';
import { saveInventory } from './maps/inventory.js';
import { findModMaps, withModMaps } from './maps/mod-maps.js';
import { checkSwitch, SWITCH_MESSAGES } from './maps/switch.js';
import { registerBackupRoutes, FILE_JOBS } from './backups/api.js';
import { createDrift, settingKeys } from './settings/drift.js';
import { registerDriftRoutes } from './settings/api.js';
import { registerClusterRoutes } from './clusters/api.js';
import { registerFleetRoutes } from './fleet/api.js';
import { clonePasswords } from './fleet/secrets.js';
import {
  clusterRow,
  memberRows,
  activeJobFor,
  MESSAGES as CLUSTER_MESSAGES,
  checkSharedSettings,
} from './clusters/core.js';

export const API_MESSAGES = {
  firewallChanged: 'The firewall rules changed after the preview. Look at the new preview before applying it.',
  firewallService:
    "A Windows service can't ask for administrator approval. Download the script and run it as an administrator.",
  previewExpired: 'That preview has expired. Run it again.',
  notFound: 'Not found.',
  badJson: 'The request body must be JSON.',
  tooLarge: 'The request is too large.',
  steamLibraryPath: 'That folder is inside a Steam library. Pick a folder outside Steam, so SteamCMD can manage it.',
  relativePath: 'Use a full folder path, such as D:\\ARK\\Server.',
  serverError: 'Something went wrong in ARK Overseer. The details are in its log.',
  installExists: 'That folder is already an install.',
  portsInUse: 'Some of those ports are already in use.',
  badMap: 'Use a map name made of letters, numbers and underscores.',
  badPlayers: 'The player limit must be a whole number from 1 to 1000.',
  badName: 'Give the server a name of up to 64 characters.',
  nameTaken: 'A server with this name already exists.',
  badSessionName:
    'The session name can be up to 60 characters, without a question mark, a double quote or a line break.',
  badSchedule: 'Choose a supported schedule kind and a valid cron time.',
  badScheduleOptions: 'Check the schedule options.',
  steamSchedule: 'This install is kept up to date by Steam.',
  badGaming:
    'Gaming mode needs a priority of Below normal or Lowest, fewer cores set aside than this PC has, and program names that end in .exe.',
  gamingUnavailable: 'Gaming mode did not start with ARK Overseer, so its settings cannot be read or saved.',
  installHasServer: 'This install already runs {name}. Each server needs its own install.',
  badMapArt: 'Send enabled as true or false.',
  badAccessSettings: 'Enter both a plain team hostname and a 64 character AUD, or leave both empty.',
  accessKeysUnavailable: 'Cloudflare Access keys could not be reached. Check the team domain and try again.',
  sameMap: 'The server is already on that map.',
  jobRunning: 'Another job is queued or running for this server. Wait for it to finish, then try again.',
  clusterChoice: 'Choose whether this setting changes for the cluster or only this server.',
};
const PREVIEW_MS = 10 * 60 * 1000;
const pathKey = (value) =>
  path.win32
    .normalize(String(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
const absolute = (value) =>
  typeof value === 'string' && path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]|^\\\\/.test(value);
function error(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
function audit(db, user, action, targetKind, targetId, detail = {}) {
  db.prepare(
    'INSERT INTO audit_events (created_at, user_id, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(new Date().toISOString(), user.id, 'user', action, targetKind, targetId, JSON.stringify(detail));
}
// Windows folder names ignore case, so map ids are compared without regard to it.
const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function must(value) {
  if (!value) throw error(404, API_MESSAGES.notFound);
  return value;
}
function serverRow(db, id) {
  return db
    .prepare(
      'SELECT s.*, i.path AS install_path, i.state AS install_state, i.source AS install_source, i.branch AS install_branch, i.build_id AS install_build_id, i.latest_build_id, i.update_checked_at, c.name AS cluster_name FROM servers s JOIN installs i ON i.id = s.install_id LEFT JOIN clusters c ON c.id = s.cluster_id WHERE s.id = ?',
    )
    .get(id);
}
function shapeServer(row, supervisor, unseenDrift = new Set()) {
  const settings = JSON.parse(row.settings_json || '{}');
  return {
    ...row,
    cluster_overrides_json: JSON.parse(row.cluster_overrides_json || '[]'),
    settingsChanged: unseenDrift.has(row.id),
    settings_json: { mods: settings.mods ?? [], disableBattlEye: settings.disableBattlEye ?? false },
    status: supervisor.status(row.id),
    install: {
      path: row.install_path,
      state: row.install_state,
      source: row.install_source,
      build_id: row.install_build_id,
      latest_build_id: row.latest_build_id,
      update_checked_at: row.update_checked_at,
    },
  };
}
export function createApp({
  db,
  dataDir,
  publicDir,
  jobs,
  supervisor,
  steamcmd,
  runner,
  platform,
  listListeners,
  firewallRules,
  isElevated,
  pwshPath = 'pwsh',
  clusterExec,
  rankFields,
  updateInfo = () => ({ commit: null, startedAt: null, available: false, lastUpdate: null }),
  allowedHosts = [],
  log = console.error,
  now = () => Date.now(),
  scheduler,
  gaming,
  rcon,
  getRconPassword,
  serviceMode = false,
  // The settings drift service. The real app shares one with the job engine and the supervisor.
  drift = null,
  // Tests pass stand-ins; the real app passes ones that may fetch from the network.
  catalog = createCatalog({ dataDir, url: null, log }),
  artResolver = createArtResolver({ dataDir, log }),
  findMods = findModMaps,
  accessKeySetFactory,
  accessJwtVerify,
}) {
  const auth = createAuth({ db, now, accessKeySetFactory, accessJwtVerify }),
    router = createRouter({ log }),
    previews = new Map();
  const settingsDrift = drift ?? createDrift({ db, dataDir, supervisor, rcon, getRconPassword, now, log });
  if (!drift) settingsDrift.attach(jobs);
  const unseenDrift = () =>
    new Set(
      db
        .prepare('SELECT server_id FROM settings_drift WHERE seen_at IS NULL')
        .all()
        .map((row) => row.server_id),
    );
  const hostRow = () => db.prepare("SELECT * FROM hosts WHERE name = 'local'").get();
  function record(user, action, kind, id, detail) {
    if (user) audit(db, user, action, kind, id, detail);
  }
  const protectedRoute =
    (action, kind, handler, detail = (ctx) => ({})) =>
    async (ctx) => {
      const result = await handler(ctx);
      record(
        ctx.user,
        typeof action === 'function' ? action(ctx) : action,
        kind,
        ctx.params.id ?? result?.id ?? null,
        detail(ctx, result),
      );
      return result;
    };
  // The jobs that change the files under a server, or stop and start it in steps that must not be interleaved.
  const fileJobRunning = (serverId) => {
    const server = db.prepare('SELECT install_id FROM servers WHERE id = ?').get(serverId);
    if (!server) return false;
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM jobs WHERE kind IN (${FILE_JOBS.map(() => '?').join(', ')}) AND state IN ('queued', 'running') AND (server_id = ? OR install_id = ? OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.servers') WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.installs') WHERE value = ?)) LIMIT 1`,
        )
        .get(...FILE_JOBS, serverId, server.install_id, serverId, server.install_id),
    );
  };
  const showArt = () => Boolean(hostRow()?.show_map_art ?? 1);
  for (const [key, route] of Object.entries(auth.routes)) {
    const urls = {
      state: 'GET /api/auth/state',
      setup: 'POST /api/auth/setup',
      login: 'POST /api/auth/login',
      logout: 'POST /api/auth/logout',
      password: 'POST /api/auth/password',
      passkey_register_options: 'POST /api/auth/passkey/register/options',
      passkey_register_verify: 'POST /api/auth/passkey/register/verify',
      passkey_login_options: 'POST /api/auth/passkey/login/options',
      passkey_login_verify: 'POST /api/auth/passkey/login/verify',
      passkeys: 'GET /api/auth/passkeys',
      passkey_remove: 'POST /api/auth/passkey/remove',
    };
    const [method, url] = urls[key].split(' ');
    router.add(method, url, async (ctx) => {
      const result = await route(ctx);
      if (method !== 'GET') {
        const actor = ctx.user ?? db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
        if (actor) audit(db, actor, `auth.${key.replaceAll('_', '.')}`, 'user', actor.id, {});
      }
      return result;
    });
  }
  router.add('GET', '/api/version', () => updateInfo());
  router.add('GET', '/api/access', () => {
    const row = hostRow();
    const teamDomain = row?.access_team_domain ?? '';
    const aud = row?.access_aud ?? '';
    return { enabled: Boolean(teamDomain && aud), teamDomain, aud };
  });
  router.add(
    'PUT',
    '/api/access',
    protectedRoute('access.save', 'host', async ({ body }) => {
      const teamDomain = typeof body.teamDomain === 'string' ? body.teamDomain.trim() : null;
      const aud = typeof body.aud === 'string' ? body.aud.trim() : null;
      const validHost =
        teamDomain === '' ||
        (typeof teamDomain === 'string' &&
          teamDomain.length <= 253 &&
          teamDomain.split('.').length >= 2 &&
          teamDomain.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)));
      const validAud = aud === '' || (typeof aud === 'string' && /^[A-Fa-f0-9]{64}$/.test(aud));
      if (!validHost || !validAud || Boolean(teamDomain) !== Boolean(aud))
        throw error(400, API_MESSAGES.badAccessSettings);
      if (teamDomain) {
        try {
          await auth.saveAccessSettings(teamDomain, aud);
        } catch {
          throw error(400, API_MESSAGES.accessKeysUnavailable);
        }
      } else await auth.saveAccessSettings('', '');
      const stamp = new Date(now()).toISOString();
      let host = hostRow();
      if (!host) {
        const id = Number(
          db.prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'local')").run(stamp, stamp)
            .lastInsertRowid,
        );
        host = { id };
      }
      db.prepare('UPDATE hosts SET updated_at = ?, access_team_domain = ?, access_aud = ? WHERE id = ?').run(
        stamp,
        teamDomain || null,
        aud || null,
        host.id,
      );
      return { enabled: Boolean(teamDomain), teamDomain: teamDomain || '', aud: aud || '' };
    }),
  );
  router.add('GET', '/api/host', async () => ({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    hostname: (await import('node:os')).hostname(),
    cpuCount: (await import('node:os')).availableParallelism(),
    memoryBytes: (await import('node:os')).totalmem(),
    dataDir,
    freeDiskBytes: (await fs.statfs(dataDir)).bavail * (await fs.statfs(dataDir)).bsize,
    steamcmd: { installed: steamcmd.isInstalled(), path: steamcmd.exePath ?? null },
    elevated: serviceMode ? false : await isElevated(),
    ...(serviceMode ? { service: true } : {}),
  }));
  router.add('GET', '/api/gaming', () => {
    if (!gaming) throw error(503, API_MESSAGES.gamingUnavailable);
    return gaming.status();
  });
  router.add(
    'PUT',
    '/api/gaming',
    protectedRoute('gaming.save', 'host', async ({ body }) => {
      if (!gaming) throw error(503, API_MESSAGES.gamingUnavailable);
      const cpuCount = gaming.status().cpuCount;
      const validNames = (list) =>
        Array.isArray(list) &&
        list.length <= 50 &&
        list.every(
          (name) =>
            typeof name === 'string' &&
            name.trim() === name &&
            name.length >= 1 &&
            name.length <= 64 &&
            /\.exe$/i.test(name) &&
            !/[\\/\x00-\x1f\x7f]/.test(name),
        );
      if (
        typeof body.enabled !== 'boolean' ||
        !['Idle', 'BelowNormal'].includes(body.priority) ||
        !(
          body.gameCores === null ||
          (Number.isInteger(body.gameCores) && body.gameCores >= 1 && body.gameCores < cpuCount)
        ) ||
        !validNames(body.games) ||
        !validNames(body.ignore)
      )
        throw error(400, API_MESSAGES.badGaming);
      const stamp = new Date(now()).toISOString();
      let host = hostRow();
      if (!host) {
        const id = Number(
          db.prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'local')").run(stamp, stamp)
            .lastInsertRowid,
        );
        host = { id };
      }
      db.prepare(
        'UPDATE hosts SET updated_at = ?, gaming_mode = ?, gaming_priority = ?, gaming_game_cores = ?, gaming_games_json = ?, gaming_ignore_json = ? WHERE id = ?',
      ).run(
        stamp,
        body.enabled ? 1 : 0,
        body.priority,
        body.gameCores,
        JSON.stringify(body.games),
        JSON.stringify(body.ignore),
        host.id,
      );
      await gaming.refresh();
      return gaming.status();
    }),
  );
  // A failed read leaves the preview proposing every rule, and says so, rather than failing the page.
  // The whole script is still safe to run because it only replaces ARK Overseer's own rules.
  const readFirewallRules = async () => {
    try {
      const { rules, localRulesIgnored = false } = await firewallRules();
      return { rules, checked: true, localRulesIgnored };
    } catch (cause) {
      log(`Reading firewall rules failed: ${cause.message}`);
      return { rules: [], checked: false, localRulesIgnored: false };
    }
  };
  router.add(
    'PUT',
    '/api/host/map-art',
    protectedRoute(
      'host.map_art',
      'host',
      ({ body }) => {
        if (typeof body.enabled !== 'boolean') throw error(400, API_MESSAGES.badMapArt);
        const stamp = new Date(now()).toISOString();
        let host = hostRow();
        if (!host)
          host = {
            id: Number(
              db.prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'local')").run(stamp, stamp)
                .lastInsertRowid,
            ),
          };
        db.prepare('UPDATE hosts SET updated_at = ?, show_map_art = ? WHERE id = ?').run(
          stamp,
          body.enabled ? 1 : 0,
          host.id,
        );
        return { enabled: body.enabled };
      },
      (ctx) => ({ enabled: ctx.body.enabled }),
    ),
  );
  router.add('GET', '/api/maps', () => ({ ...catalog.get(), showArt: showArt() }));
  // A redirect to Steam's own picture, so the browser fetches it and this app never proxies the bytes.
  router.add('GET', '/api/maps/:id/art', async ({ params, res }) => {
    const map = catalog.get().maps.find((item) => sameId(item.id, params.id));
    if (!showArt() || map?.kind !== 'official') throw error(404, API_MESSAGES.notFound);
    const url = await artResolver.resolve(map.steamAppId);
    if (!url) throw error(404, API_MESSAGES.notFound);
    res.writeHead(302, { Location: url, 'Cache-Control': 'private, max-age=3600' });
    res.end();
  });
  router.add('GET', '/api/servers/:id/maps/:mapId/art', async ({ params, res }) => {
    const row = must(serverRow(db, params.id));
    const map = withModMaps(catalog.get(), row.install_path, findMods).maps.find((item) =>
      sameId(item.id, params.mapId),
    );
    if (map?.kind !== 'mod') throw error(404, API_MESSAGES.notFound);
    const file = findModPreview(row.install_path, map.modId);
    if (!file) throw error(404, API_MESSAGES.notFound);
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600', 'Content-Length': data.length });
    res.end(data);
  });
  router.add('GET', '/api/installs', () => db.prepare('SELECT * FROM installs ORDER BY id').all());
  router.add(
    'POST',
    '/api/installs',
    protectedRoute(
      'install.create',
      'install',
      async ({ body }) => {
        const installPath = body.path;
        if (!absolute(installPath)) throw error(400, API_MESSAGES.relativePath);
        if (/[\\/]steamapps[\\/]common[\\/]/i.test(installPath)) throw error(400, API_MESSAGES.steamLibraryPath);
        const stamp = new Date(now()).toISOString();
        const id = transaction(db, () => {
          let host = hostRow();
          if (!host) {
            const result = db
              .prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'local')")
              .run(stamp, stamp);
            host = { id: Number(result.lastInsertRowid) };
          }
          const existing = db
            .prepare('SELECT path FROM installs WHERE host_id = ?')
            .all(host.id)
            .some((row) => pathKey(row.path) === pathKey(installPath));
          if (existing) throw error(409, API_MESSAGES.installExists);
          return Number(
            db
              .prepare(
                "INSERT INTO installs (created_at, updated_at, host_id, path, state) VALUES (?, ?, ?, ?, 'missing')",
              )
              .run(stamp, stamp, host.id, installPath).lastInsertRowid,
          );
        });
        const job = jobs.enqueue('install.install', {}, { installId: id });
        return { id, jobId: job.id };
      },
      (ctx) => ({ path: ctx.body.path }),
    ),
  );
  for (const [verb, action] of [
    ['update', 'install.update'],
    ['validate', 'install.validate'],
  ])
    router.add(
      'POST',
      `/api/installs/:id/${verb}`,
      protectedRoute(action, 'install', ({ params }) => {
        must(db.prepare('SELECT id FROM installs WHERE id = ?').get(params.id));
        return jobs.enqueue(`install.${verb}`, {}, { installId: params.id });
      }),
    );
  router.add(
    'POST',
    '/api/steamcmd/setup',
    protectedRoute('steamcmd.setup', 'steamcmd', () => jobs.enqueue('steamcmd.setup')),
  );
  const listServers = (unseen) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path, i.state AS install_state, i.source AS install_source, i.build_id AS install_build_id, i.latest_build_id, i.update_checked_at, c.name AS cluster_name FROM servers s JOIN installs i ON i.id = s.install_id LEFT JOIN clusters c ON c.id = s.cluster_id ORDER BY s.id',
      )
      .all()
      .map((row) => shapeServer(row, supervisor, unseen));
  router.add('GET', '/api/servers', () => listServers(unseenDrift()));
  router.add('GET', '/api/servers/:id', ({ params }) => {
    const server = shapeServer(must(serverRow(db, params.id)), supervisor, unseenDrift());
    const move = db
      .prepare(
        "SELECT result_json FROM jobs WHERE kind = 'server.move' AND server_id = ? AND state = 'succeeded' ORDER BY id DESC LIMIT 1",
      )
      .get(server.id);
    const result = move?.result_json ? JSON.parse(move.result_json) : null;
    if (result && pathKey(result.target) === pathKey(server.install.path)) server.lastMove = result;
    return server;
  });
  registerFleetRoutes({ router, db, jobs, protectedRoute, must, error, serverRow });
  registerClusterRoutes({
    router,
    db,
    dataDir,
    jobs,
    supervisor,
    protectedRoute,
    must,
    error,
    serverRow,
    runner,
    scheduler,
    pwshPath,
    exec: clusterExec,
  });
  router.add('GET', '/api/servers/:id/schedules', ({ params }) => {
    must(serverRow(db, params.id));
    return db
      .prepare(
        'SELECT s.*, j.state AS job_state FROM schedules s LEFT JOIN jobs j ON j.id = s.last_job_id WHERE s.server_id = ? ORDER BY s.kind',
      )
      .all(params.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        cron: row.cron,
        enabled: Boolean(row.enabled),
        options: JSON.parse(row.options_json),
        lastRunAt: row.last_run_at,
        nextRunAt: row.next_run_at,
        lastJobState: row.job_state,
        describe: describeCron(row.cron),
      }));
  });
  router.add(
    'PUT',
    '/api/servers/:id/schedules/:kind',
    protectedRoute('schedule.save', 'schedule', ({ params, body }) => {
      const server = must(serverRow(db, params.id));
      if (!['restart', 'backup', 'update_check', 'auto_update'].includes(params.kind))
        throw error(400, API_MESSAGES.badSchedule);
      try {
        parseCron(body.cron);
      } catch (cause) {
        throw error(400, cause.message);
      }
      const options = body.options ?? {};
      if (!options || typeof options !== 'object' || Array.isArray(options))
        throw error(400, API_MESSAGES.badScheduleOptions);
      const allowedOptions = {
        restart: ['countdownMinutes', 'announce'],
        backup: ['keep'],
        update_check: [],
        auto_update: ['countdownMinutes', 'announce', 'keep'],
      }[params.kind];
      if (Object.keys(options).some((key) => !allowedOptions.includes(key)))
        throw error(400, API_MESSAGES.badScheduleOptions);
      const countdown = options.countdownMinutes;
      if (
        countdown !== undefined &&
        (!Array.isArray(countdown) ||
          countdown.length < 1 ||
          countdown.length > 5 ||
          countdown.some((n, i) => !Number.isInteger(n) || n < 1 || n > 60 || (i && countdown[i - 1] <= n)))
      )
        throw error(400, API_MESSAGES.badScheduleOptions);
      if (options.announce !== undefined && !['chat', 'broadcast'].includes(options.announce))
        throw error(400, API_MESSAGES.badScheduleOptions);
      if (options.keep !== undefined && (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 100))
        throw error(400, API_MESSAGES.badScheduleOptions);
      if (['update_check', 'auto_update'].includes(params.kind) && server.install_source === 'steam-client')
        throw error(400, API_MESSAGES.steamSchedule);
      const enabled = body.enabled === undefined ? true : body.enabled;
      if (typeof enabled !== 'boolean') throw error(400, API_MESSAGES.badScheduleOptions);
      const stamp = new Date(now()).toISOString();
      db.prepare(
        `INSERT INTO schedules (created_at, updated_at, server_id, kind, cron, enabled, options_json, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(server_id, kind) DO UPDATE SET updated_at = excluded.updated_at, cron = excluded.cron, enabled = excluded.enabled, options_json = excluded.options_json, next_run_at = NULL`,
      ).run(stamp, stamp, params.id, params.kind, body.cron, enabled ? 1 : 0, JSON.stringify(options));
      const row = db.prepare('SELECT id FROM schedules WHERE server_id = ? AND kind = ?').get(params.id, params.kind);
      scheduler?.reschedule(row.id);
      return { id: row.id };
    }),
  );
  router.add(
    'DELETE',
    '/api/servers/:id/schedules/:kind',
    protectedRoute('schedule.delete', 'schedule', ({ params }) => {
      must(serverRow(db, params.id));
      db.prepare('DELETE FROM schedules WHERE server_id = ? AND kind = ?').run(params.id, params.kind);
      return { deleted: true };
    }),
  );
  router.add('GET', '/api/servers/:id/maps', ({ params }) => {
    const row = must(serverRow(db, params.id)),
      current = withModMaps(catalog.get(), row.install_path, findMods);
    const saves = saveInventory({ installPath: row.install_path, currentMap: row.map, catalog: current });
    const saved = new Set(saves.map((save) => save.mapId.toLowerCase()));
    return {
      current: row.map,
      saves,
      catalog: {
        version: current.version,
        maps: current.maps.map((map) => ({ ...map, hasSave: saved.has(map.id.toLowerCase()) })),
      },
      showArt: showArt(),
    };
  });
  // The only way a server's map changes. The job backs the world up first and checks that the server
  // starts on the new map, so no other route may write servers.map for an existing server.
  router.add(
    'POST',
    '/api/servers/:id/map',
    protectedRoute(
      'server.map.switch_requested',
      'server',
      ({ params, body }) => {
        const row = must(serverRow(db, params.id));
        const check = checkSwitch({ server: row, mapId: body.mapId, addMod: body.addMod === true, catalog, findMods });
        if (!check.ok) {
          if (check.code === 'same_map') throw error(409, API_MESSAGES.sameMap);
          if (check.code === 'needs_mod')
            throw error(
              409,
              SWITCH_MESSAGES.needsMod.replace('{map}', () => check.map).replace('{modId}', () => check.modId),
              { code: 'needs_mod', modId: check.modId, map: check.map },
            );
          throw error(400, API_MESSAGES.badMap);
        }
        // No await from here to the enqueue, so two requests cannot both find the server free.
        const busy = db
          .prepare(
            "SELECT 1 FROM jobs WHERE state IN ('queued', 'running') AND (server_id = ? OR install_id = ? OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.servers') WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(jobs.targets_json, '$.installs') WHERE value = ?)) LIMIT 1",
          )
          .get(row.id, row.install_id, row.id, row.install_id);
        if (busy) throw error(409, API_MESSAGES.jobRunning);
        // Both ids are set, so the engine also holds back any job for the install while this one runs.
        const job = jobs.enqueue(
          'server.switch_map',
          { mapId: check.map.id, addMod: check.addMod },
          { serverId: row.id, installId: row.install_id },
        );
        return { jobId: job.id };
      },
      (ctx) => ({ mapId: ctx.body.mapId, addMod: ctx.body.addMod === true }),
    ),
  );
  router.add(
    'POST',
    '/api/servers/:id/backups',
    protectedRoute('backup.create', 'server', ({ params }) => {
      must(serverRow(db, params.id));
      // A manual backup prunes to the backup schedule's own limit, so it never removes backups that
      // schedule means to keep.
      const scheduled = db
        .prepare("SELECT options_json FROM schedules WHERE server_id = ? AND kind = 'backup'")
        .get(params.id);
      const keep = scheduled ? JSON.parse(scheduled.options_json).keep : undefined;
      return jobs.enqueue('server.backup', { reason: 'manual', ...(keep ? { keep } : {}) }, { serverId: params.id });
    }),
  );
  registerBackupRoutes({
    router,
    db,
    dataDir,
    jobs,
    supervisor,
    protectedRoute,
    must,
    error,
    serverRow,
    messages: API_MESSAGES,
    // A backups page load is also a look at whether the settings files still match ARK Overseer's last write.
    onServerLoad: (server) =>
      void settingsDrift
        .checkDrift(server, { force: true })
        .catch((cause) => log(`Checking the settings failed: ${cause.message}`)),
  });
  registerDriftRoutes({
    router,
    db,
    drift: settingsDrift,
    jobs,
    supervisor,
    protectedRoute,
    must,
    error,
    serverRow,
    messages: API_MESSAGES,
    fileJobRunning,
  });
  router.add(
    'POST',
    '/api/installs/:id/check-update',
    protectedRoute('install.check_update', 'install', ({ params }) => {
      must(db.prepare('SELECT id FROM installs WHERE id = ?').get(params.id));
      return jobs.enqueue('install.check_update', {}, { installId: params.id });
    }),
  );
  router.add(
    'POST',
    '/api/servers',
    protectedRoute(
      'server.create',
      'server',
      async ({ body }) => {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 64 || /[\x00-\x1f]/.test(name)) throw error(400, API_MESSAGES.badName);
        // The launch line carries the session name, so it may not hold what would end or split it.
        if (
          typeof body.sessionName !== 'string' ||
          !body.sessionName.trim() ||
          body.sessionName.length > SESSION_NAME_MAX_LENGTH ||
          /[?"\r\n]/.test(body.sessionName)
        )
          throw error(400, API_MESSAGES.badSessionName);
        if (typeof body.map !== 'string' || !/^[A-Za-z0-9_]+$/.test(body.map)) throw error(400, API_MESSAGES.badMap);
        if (!Number.isInteger(body.maxPlayers) || body.maxPlayers < 1 || body.maxPlayers > 1000)
          throw error(400, API_MESSAGES.badPlayers);
        const listeners = await listListeners();
        let result;
        result = transaction(db, () => {
          const install = must(db.prepare('SELECT * FROM installs WHERE id = ?').get(body.installId));
          const host = install.host_id;
          const clashes = findConflicts(db, {
            hostId: host,
            proposal: { gamePort: body.gamePort, queryPort: body.queryPort, rconPort: body.rconPort },
            listeners,
          });
          if (clashes.length) throw error(409, API_MESSAGES.portsInUse, { conflicts: clashes });
          if (db.prepare('SELECT 1 FROM servers WHERE name = ? COLLATE NOCASE').get(name))
            throw error(409, API_MESSAGES.nameTaken);
          // ASA keeps a server's settings and saves inside its install, so a second server would overwrite them.
          const holder = db.prepare('SELECT name FROM servers WHERE install_id = ? LIMIT 1').get(install.id);
          if (holder)
            throw error(
              409,
              API_MESSAGES.installHasServer.replace('{name}', () => holder.name),
            );
          const stamp = new Date(now()).toISOString();
          const id = Number(
            db
              .prepare(
                "INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port, query_port, rcon_port, max_players, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')",
              )
              .run(
                stamp,
                stamp,
                host,
                install.id,
                name,
                body.map,
                body.sessionName,
                body.gamePort,
                body.queryPort ?? null,
                body.rconPort ?? null,
                body.maxPlayers,
              ).lastInsertRowid,
          );
          return serverRow(db, id);
        });
        // The install may already hold settings files, so they are the starting point for what is reported as changed.
        await settingsDrift.recordBaseline(result, 'server_created', { skipIfEmpty: true });
        return shapeServer(result, supervisor);
      },
      (ctx) => ({ name: ctx.body.name, map: ctx.body.map }),
    ),
  );
  router.add(
    'PUT',
    '/api/servers/:id/ports',
    protectedRoute(
      'server.ports',
      'server',
      async ({ params, body }) => {
        const row = must(serverRow(db, params.id)),
          listeners = await listListeners();
        try {
          assignPorts(db, params.id, body, { listeners, ignorePids: row.pid == null ? [] : [row.pid] });
        } catch (e) {
          if (e.conflicts) e.status = 409;
          throw e;
        }
        return shapeServer(serverRow(db, params.id), supervisor);
      },
      (ctx) => ({ ports: ctx.body }),
    ),
  );
  router.add('GET', '/api/ports/suggest', async () =>
    allocatePorts(db, { hostId: hostRow()?.id ?? 0, listeners: await listListeners() }),
  );
  for (const verb of ['start', 'stop', 'restart'])
    router.add(
      'POST',
      `/api/servers/:id/${verb}`,
      protectedRoute(`server.${verb}`, 'server', async ({ params }) => {
        must(serverRow(db, params.id));
        // A map switch or a restore stops and starts the server itself, in steps that must not be interleaved.
        if (fileJobRunning(params.id)) throw error(409, API_MESSAGES.jobRunning);
        return supervisor[verb](params.id);
      }),
    );
  router.add('GET', '/api/settings/fields', async () => (await import('./settings/fields.js')).SETTINGS_FIELDS);
  router.add('GET', '/api/settings/search', async ({ query }) =>
    rankFields(query.q ?? '', (await import('./settings/fields.js')).SETTINGS_FIELDS),
  );
  const storeFor = (id) => {
    const row = must(serverRow(db, id));
    const paths = serverPaths(row.install_path);
    return createSettingsStore(paths);
  };
  router.add('GET', '/api/servers/:id/settings', async ({ params }) => {
    const settings = storeFor(params.id).readSettings();
    // The first read of an older server takes its baseline from the files as they are now.
    await settingsDrift
      .ensureBaseline(serverRow(db, params.id))
      .catch((cause) => log(`Recording the settings baseline failed: ${cause.message}`));
    return settings;
  });
  router.add(
    'PUT',
    '/api/servers/:id/settings',
    protectedRoute(
      'server.settings',
      'server',
      async ({ params, body, user }) => {
        const row = must(serverRow(db, params.id));
        // A restore swaps settings files one by one, and a save in the middle would mix with it.
        if (fileJobRunning(params.id)) throw error(409, API_MESSAGES.jobRunning);
        const { clusterChoice, ...values } = body;
        let queued = [];
        let clusterChange = null;
        let overrideChange = null;
        if (row.cluster_id) {
          const cluster = clusterRow(db, row.cluster_id);
          const shared = JSON.parse(cluster.settings_json);
          const overrides = new Set(JSON.parse(row.cluster_overrides_json));
          const inherited = Object.keys(values).filter((key) => Object.hasOwn(shared, key) && !overrides.has(key));
          if (inherited.length && !['keep', 'cluster'].includes(clusterChoice))
            throw error(400, API_MESSAGES.clusterChoice);
          if (inherited.length && clusterChoice === 'keep') {
            for (const key of inherited) overrides.add(key);
            overrideChange = [...overrides];
          }
          if (inherited.length && clusterChoice === 'cluster') {
            const members = memberRows(db, cluster.id);
            if (activeJobFor(db, members)) throw error(409, CLUSTER_MESSAGES.busy);
            const changed = Object.fromEntries(inherited.map((key) => [key, values[key]]));
            checkSharedSettings(changed);
            clusterChange = { cluster, settings: { ...shared, ...changed }, members, keys: inherited };
          }
        }
        // The write and the record of it are one step, so a check of the files cannot fall between them.
        try {
          const result = await settingsDrift.saveSettings(
            row,
            () => storeFor(params.id).writeSettings(values),
            settingKeys(values),
          );
          if (Object.hasOwn(values, 'MaxPlayers'))
            db.prepare('UPDATE servers SET max_players = ?, updated_at = ? WHERE id = ?').run(
              values.MaxPlayers ?? 70,
              new Date(now()).toISOString(),
              row.id,
            );
          if (overrideChange)
            db.prepare('UPDATE servers SET cluster_overrides_json = ?, updated_at = ? WHERE id = ?').run(
              JSON.stringify(overrideChange),
              new Date(now()).toISOString(),
              row.id,
            );
          if (clusterChange)
            queued = transaction(db, () => {
              db.prepare('UPDATE clusters SET settings_json = ?, updated_at = ? WHERE id = ?').run(
                JSON.stringify(clusterChange.settings),
                new Date(now()).toISOString(),
                clusterChange.cluster.id,
              );
              const clusterJobs = clusterChange.members.map((member) =>
                jobs.enqueue(
                  'server.cluster_apply',
                  { clusterId: clusterChange.cluster.id, keys: clusterChange.keys },
                  { serverId: member.id, installId: member.install_id },
                ),
              );
              record(user, 'cluster.settings', 'cluster', clusterChange.cluster.id, { keys: clusterChange.keys });
              return clusterJobs;
            });
          return {
            ...result,
            jobs: queued,
            appliesAtNextRestart: queued.length > 0 && supervisor.status(row.id)?.observedState === 'running',
          };
        } catch (e) {
          if (e.errors) e.status = 400;
          throw e;
        }
      },
      (ctx) => ({ keys: Object.keys(ctx.body) }),
    ),
  );
  router.add('GET', '/api/jobs', ({ query }) =>
    jobs.list({
      ...(query.state ? { state: query.state } : {}),
      ...(query.serverId ? { serverId: Number(query.serverId) } : {}),
    }),
  );
  router.add('GET', '/api/jobs/events', ({ req, res }) => streamJobEvents(jobs, req, res));
  router.add(
    'POST',
    '/api/jobs/:id/cancel',
    protectedRoute('job.cancel', 'job', ({ params }) => {
      const job = jobs.get(params.id);
      if (!job) throw error(404, API_MESSAGES.notFound);
      const cancelled = jobs.cancel(params.id);
      if (cancelled && jobs.get(params.id)?.state === 'cancelled' && job.kind === 'server.clone') {
        clonePasswords(db).delete(job.id);
        db.prepare('DELETE FROM installs WHERE id = ?').run(job.installId);
      }
      return { cancelled };
    }),
  );
  router.add('GET', '/api/servers/:id/firewall', async ({ params }) => {
    const row = must(serverRow(db, params.id));
    const { rules, checked, localRulesIgnored } = await readFirewallRules();
    const preview = firewallPreview([{ server: row, install: { path: row.install_path } }], rules);
    return {
      ...preview,
      checked,
      localRulesIgnored,
      token: preview.script ? crypto.createHash('sha256').update(preview.script).digest('hex') : null,
    };
  });
  router.add(
    'POST',
    '/api/servers/:id/firewall/apply',
    protectedRoute(
      'server.firewall.apply',
      'server',
      async ({ params, body }) => {
        const row = must(serverRow(db, params.id)),
          preview = firewallPreview(
            [{ server: row, install: { path: row.install_path } }],
            (await readFirewallRules()).rules,
          );
        if (!preview.script) return { applied: false };
        if (serviceMode) throw error(409, API_MESSAGES.firewallService, { script: preview.script });
        const token = crypto.createHash('sha256').update(preview.script).digest('hex');
        if (token !== body.token) throw error(409, API_MESSAGES.firewallChanged);
        const result = await applyFirewallScript(preview.script, {
          runner,
          elevated: await isElevated(),
          dir: path.join(dataDir, 'firewall', String(now())),
          pwshPath,
        });
        return { applied: result.ok, ...result };
      },
      (ctx) => ({ token: ctx.body.token }),
    ),
  );
  router.add(
    'POST',
    '/api/import/preview',
    protectedRoute('import.preview', 'import', async ({ body }) => {
      // A relative folder would be read against whatever folder ARK Overseer runs in.
      if (!absolute(body.dashboardDir)) throw error(400, API_MESSAGES.relativePath);
      const detection = await detectPhase0(body.dashboardDir);
      const result = previewImport(db, detection, { listeners: await listListeners() });
      const token = crypto.randomBytes(24).toString('base64url');
      for (const [key, entry] of previews) if (entry.expires < now()) previews.delete(key);
      previews.set(token, { detection, expires: now() + PREVIEW_MS });
      return { token, servers: result.servers };
    }),
  );
  router.add(
    'POST',
    '/api/import/apply',
    protectedRoute(
      'import.apply',
      'server',
      async ({ body }) => {
        const entry = previews.get(body.token);
        previews.delete(body.token);
        if (!entry || entry.expires < now()) throw error(410, API_MESSAGES.previewExpired);
        try {
          const imported = await applyImport(db, entry.detection, body.profileId, {
            snapshotRoot: path.join(dataDir, 'snapshots'),
            listeners: await listListeners(),
          });
          await settingsDrift.recordBaseline(serverRow(db, imported.serverId), 'import', { skipIfEmpty: true });
          return imported;
        } catch (e) {
          if (e.code === 'CHANGED_SINCE_PREVIEW') e.status = 409;
          if (e.conflicts) e.status = 409;
          throw e;
        }
      },
      (ctx) => ({ profileId: ctx.body.profileId }),
    ),
  );
  // Scripts, styles and icons hold nothing private, and the sign-in page needs them before anyone is
  // signed in. Only the app page itself and the API wait for a session.
  const publicFiles = new Set(['/login.html', '/style.css', '/favicon.svg']);
  const isPublic = (pathname) =>
    publicFiles.has(pathname) || pathname.startsWith('/icons/') || pathname.startsWith('/js/');
  const sendJson = (res, status, value) => {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      try {
        log(redact(e?.stack || String(e)));
      } catch {
        /* logging cannot prevent the response */
      }
      sendJson(res, 500, { error: API_MESSAGES.serverError });
    });
  });
  async function handleRequest(req, res) {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    if (!hostAllowed(req.headers.host, allowedHosts)) return sendJson(res, 421, { error: AUTH_MESSAGES.unknownHost });
    // A request line such as "GET //" is not a URL the parser accepts, and it answers 400 before
    // anything else looks at it.
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: API_MESSAGES.notFound });
    }
    const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (
      unsafe &&
      !originAllowed({
        origin: req.headers.origin,
        secFetchSite: req.headers['sec-fetch-site'],
        host: req.headers.host,
      })
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: AUTH_MESSAGES.crossSite }));
      return;
    }
    const authRoute = pathname.startsWith('/api/auth/');
    const user = await auth.identify(req, res);
    if (req.accessAuditEmail !== undefined && user)
      audit(db, user, 'auth.access.login', 'user', user.id, { email: req.accessAuditEmail });
    if (!authRoute && !isPublic(pathname)) {
      if (!user) {
        if (pathname.startsWith('/api/')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: AUTH_MESSAGES.signedOut }));
        } else {
          res.writeHead(302, { Location: '/login.html' });
          res.end();
        }
        return;
      }
    }
    if (await router.handle(req, res, user)) return;
    if ((isPublic(pathname) || (user && !pathname.startsWith('/api/'))) && (await serveStatic(publicDir, req, res)))
      return;
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: API_MESSAGES.notFound });
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(API_MESSAGES.notFound);
  }
  // server.close waits for every open connection, and a browser on the Jobs page holds one open for
  // live updates, so shutting down closes them too.
  const close = () =>
    new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((e) => (e ? reject(e) : resolve()));
      server.closeAllConnections();
    });
  return { server, close };
}
