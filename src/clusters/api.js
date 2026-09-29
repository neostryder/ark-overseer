import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transaction } from '../db/transaction.js';
import { parseCron, describeCron } from '../scheduler/cron.js';
import {
  activeClusterJob,
  activeJobFor,
  checkActionOptions,
  checkOverrides,
  checkSharedSettings,
  clusterKey,
  clusterRow,
  folderKey,
  isRunning,
  memberRows,
  memberTargets,
  MESSAGES,
  prepareFolder,
} from './core.js';

const execFileAsync = promisify(execFile);
const stamp = () => new Date().toISOString();

export function registerClusterRoutes({
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
  exec = execFileAsync,
}) {
  const running = (id) => isRunning(supervisor, id);
  const get = (id) => clusterRow(db, id) ?? must(null);
  const shape = (row) => ({
    ...row,
    settings: JSON.parse(row.settings_json),
    members: memberRows(db, row.id).map((member) => ({
      id: member.id,
      name: member.name,
      map: member.map,
      install_id: member.install_id,
      status: supervisor.status(member.id),
    })),
  });
  const free = (members) => {
    if (activeJobFor(db, members)) throw error(409, MESSAGES.busy);
  };
  const clusterFree = (clusterId, members) => {
    if (activeClusterJob(db, clusterId)) throw error(409, MESSAGES.busy);
    free(members);
  };
  const apply = (cluster, members, keys) =>
    !keys.length
      ? []
      : members.map((member) =>
          jobs.enqueue(
            'server.cluster_apply',
            { clusterId: cluster.id, keys },
            { serverId: member.id, installId: member.install_id },
          ),
        );
  const cleanName = (name) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f]/.test(name))
      throw error(400, MESSAGES.badName);
    return name.trim();
  };
  const cleanNotes = (notes) => {
    if (notes == null || notes === '') return null;
    if (typeof notes !== 'string' || notes.length > 2000 || /[\x00-\x1f\x7f]/.test(notes))
      throw error(400, MESSAGES.badNotes);
    return notes;
  };
  const folder = async (value, key) => {
    const custom = value != null && value !== '';
    const selected = custom ? value : path.win32.join(dataDir, 'clusters', key);
    return prepareFolder(selected, {
      custom,
      runner,
      isMappedDrive: async (drive) => {
        try {
          const { stdout } = await exec(
            pwshPath,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'").DriveType`,
            ],
            { windowsHide: true, timeout: 20000 },
          );
          const type = String(stdout).trim();
          if (!['2', '3', '4', '5', '6'].includes(type)) throw new Error();
          return type === '4';
        } catch {
          throw error(400, MESSAGES.badFolder);
        }
      },
    });
  };
  const checkFolderFree = (selected, exceptId = null) => {
    if (
      db
        .prepare('SELECT id, shared_dir FROM clusters')
        .all()
        .some((row) => row.id !== exceptId && row.shared_dir && folderKey(row.shared_dir) === folderKey(selected))
    )
      throw error(409, MESSAGES.folderTaken);
  };
  const duplicateName = (cause) =>
    cause.errcode === 2067 || /UNIQUE constraint failed: clusters\.name/i.test(cause.message);

  router.add('GET', '/api/clusters', () => db.prepare('SELECT * FROM clusters ORDER BY name').all().map(shape));
  router.add('GET', '/api/clusters/:id', ({ params }) => shape(get(params.id)));
  router.add(
    'POST',
    '/api/clusters',
    protectedRoute('cluster.create', 'cluster', async ({ body }) => {
      const name = cleanName(body.name);
      const notes = cleanNotes(body.notes);
      let key = clusterKey();
      while (db.prepare('SELECT 1 FROM clusters WHERE cluster_key = ?').get(key)) key = clusterKey();
      const shared = await folder(body.shared_dir, key);
      const at = stamp();
      try {
        const id = transaction(db, () => {
          checkFolderFree(shared);
          return Number(
            db
              .prepare(
                'INSERT INTO clusters (created_at, updated_at, name, cluster_key, shared_dir, notes) VALUES (?, ?, ?, ?, ?, ?)',
              )
              .run(at, at, name, key, shared, notes).lastInsertRowid,
          );
        });
        return shape(get(id));
      } catch (cause) {
        if (duplicateName(cause)) throw error(409, MESSAGES.badName);
        throw cause;
      }
    }),
  );
  router.add(
    'PATCH',
    '/api/clusters/:id',
    protectedRoute('cluster.update', 'cluster', async ({ params, body }) => {
      const old = get(params.id);
      const name = Object.hasOwn(body, 'name') ? cleanName(body.name) : old.name;
      const notes = Object.hasOwn(body, 'notes') ? cleanNotes(body.notes) : old.notes;
      const members = memberRows(db, old.id);
      const shared = Object.hasOwn(body, 'shared_dir')
        ? await folder(body.shared_dir, old.cluster_key)
        : old.shared_dir;
      if (Object.hasOwn(body, 'cluster_key')) throw error(400, MESSAGES.badSettings);
      if (shared !== old.shared_dir) clusterFree(old.id, members);
      try {
        transaction(db, () => {
          checkFolderFree(shared, old.id);
          db.prepare('UPDATE clusters SET name = ?, notes = ?, shared_dir = ?, updated_at = ? WHERE id = ?').run(
            name,
            notes,
            shared,
            stamp(),
            old.id,
          );
        });
      } catch (cause) {
        if (duplicateName(cause)) throw error(409, MESSAGES.badName);
        throw cause;
      }
      return {
        ...shape(get(old.id)),
        appliesAtNextStart: shared !== old.shared_dir && members.some((member) => running(member.id)),
      };
    }),
  );
  router.add(
    'DELETE',
    '/api/clusters/:id',
    protectedRoute('cluster.delete', 'cluster', ({ params }) => {
      const cluster = get(params.id);
      if (memberRows(db, cluster.id).length) throw error(409, MESSAGES.hasMembers);
      clusterFree(cluster.id, []);
      db.prepare('DELETE FROM clusters WHERE id = ?').run(cluster.id);
      return { deleted: true };
    }),
  );
  router.add(
    'POST',
    '/api/clusters/:id/members',
    protectedRoute(
      'cluster.member.add',
      'cluster',
      ({ params, body }) => {
        return transaction(db, () => {
          const cluster = get(params.id);
          if (!cluster.shared_dir) throw error(400, MESSAGES.badFolder);
          if (!Number.isInteger(body.serverId) || body.serverId < 1) throw error(400, MESSAGES.badMember);
          const member = must(serverRow(db, body.serverId));
          if (member.cluster_id) throw error(409, MESSAGES.memberTaken);
          clusterFree(cluster.id, [member]);
          db.prepare(
            "UPDATE servers SET cluster_id = ?, cluster_overrides_json = '[]', updated_at = ? WHERE id = ?",
          ).run(cluster.id, stamp(), member.id);
          const jobsQueued = apply(cluster, [member], Object.keys(JSON.parse(cluster.settings_json)));
          return {
            memberId: member.id,
            jobs: jobsQueued,
            appliesAtNextStart: running(member.id),
            message: running(member.id) ? MESSAGES.nextStart : null,
          };
        });
      },
      (ctx) => ({ serverId: ctx.body.serverId }),
    ),
  );
  router.add(
    'DELETE',
    '/api/clusters/:id/members/:serverId',
    protectedRoute(
      'cluster.member.remove',
      'cluster',
      ({ params }) => {
        get(params.id);
        const member = must(serverRow(db, params.serverId));
        if (member.cluster_id !== Number(params.id)) throw error(404, MESSAGES.memberMissing);
        free([member]);
        db.prepare(
          "UPDATE servers SET cluster_id = NULL, cluster_overrides_json = '[]', updated_at = ? WHERE id = ?",
        ).run(stamp(), member.id);
        return {
          removed: true,
          appliesAtNextStart: running(member.id),
          message: running(member.id) ? MESSAGES.nextStart : null,
        };
      },
      (ctx) => ({ serverId: ctx.params.serverId }),
    ),
  );
  router.add(
    'PUT',
    '/api/clusters/:id/settings',
    protectedRoute(
      'cluster.settings',
      'cluster',
      ({ params, body }) => {
        const cluster = get(params.id);
        const settings = checkSharedSettings(body);
        const members = memberRows(db, cluster.id);
        clusterFree(cluster.id, members);
        const previous = JSON.parse(cluster.settings_json);
        const keys = Object.keys(settings).filter(
          (key) => !Object.hasOwn(previous, key) || previous[key] !== settings[key],
        );
        // PUT supplies the complete set of shared catalog settings.
        const queued = transaction(db, () => {
          db.prepare('UPDATE clusters SET settings_json = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(settings),
            stamp(),
            cluster.id,
          );
          for (const member of members) {
            const kept = JSON.parse(member.cluster_overrides_json).filter((key) => Object.hasOwn(settings, key));
            if (kept.length !== JSON.parse(member.cluster_overrides_json).length)
              db.prepare('UPDATE servers SET cluster_overrides_json = ? WHERE id = ?').run(
                JSON.stringify(kept),
                member.id,
              );
          }
          return apply(get(cluster.id), members, keys);
        });
        return {
          ...shape(get(cluster.id)),
          jobs: queued,
          appliesAtNextRestart: keys.length > 0 && members.some((member) => running(member.id)),
        };
      },
      (ctx) => ({ keys: Object.keys(ctx.body) }),
    ),
  );
  router.add(
    'PUT',
    '/api/servers/:id/cluster-overrides',
    protectedRoute(
      'cluster.overrides',
      'server',
      ({ params, body }) => {
        const member = must(serverRow(db, params.id));
        if (!member.cluster_id) throw error(400, MESSAGES.memberMissing);
        const cluster = get(member.cluster_id);
        const overrides = checkOverrides(body.overrides, cluster);
        free([member]);
        const previous = new Set(JSON.parse(member.cluster_overrides_json));
        const restored = [...previous].filter((key) => !overrides.includes(key));
        db.prepare('UPDATE servers SET cluster_overrides_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(overrides),
          stamp(),
          member.id,
        );
        const queued = apply(cluster, [member], restored);
        return { overrides, jobs: queued, appliesAtNextRestart: restored.length > 0 && running(member.id) };
      },
      (ctx) => ({ keys: ctx.body.overrides }),
    ),
  );
  for (const action of ['restart', 'start', 'stop'])
    router.add(
      'POST',
      `/api/clusters/:id/${action}`,
      protectedRoute(`cluster.${action}`, 'cluster', ({ params, body }) => {
        const cluster = get(params.id);
        const members = memberRows(db, cluster.id);
        clusterFree(cluster.id, members);
        const options = checkActionOptions(body ?? {});
        const job = jobs.enqueue(
          `cluster.${action}`,
          { ...options, clusterId: cluster.id },
          { targets: memberTargets(members) },
        );
        return { ...job, jobId: job.id };
      }),
    );
  router.add('GET', '/api/clusters/:id/schedules', ({ params }) => {
    get(params.id);
    return db
      .prepare(
        'SELECT s.*, j.state AS job_state FROM schedules s LEFT JOIN jobs j ON j.id = s.last_job_id WHERE s.cluster_id = ?',
      )
      .all(params.id)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        cron: row.cron,
        enabled: Boolean(row.enabled),
        options: JSON.parse(row.options_json),
        nextRunAt: row.next_run_at,
        lastJobState: row.job_state,
        describe: describeCron(row.cron),
      }));
  });
  router.add(
    'PUT',
    '/api/clusters/:id/schedules/restart',
    protectedRoute('cluster.schedule.save', 'cluster', ({ params, body }) => {
      const cluster = get(params.id);
      try {
        parseCron(body.cron);
      } catch {
        throw error(400, MESSAGES.badSchedule);
      }
      const options = checkActionOptions(body.options ?? {});
      const enabled = body.enabled ?? true;
      if (typeof enabled !== 'boolean') throw error(400, MESSAGES.badSchedule);
      const at = stamp();
      db.prepare(
        "INSERT INTO schedules (created_at, updated_at, cluster_id, kind, cron, enabled, options_json) VALUES (?, ?, ?, 'cluster_restart', ?, ?, ?) ON CONFLICT(cluster_id, kind) DO UPDATE SET updated_at = excluded.updated_at, cron = excluded.cron, enabled = excluded.enabled, options_json = excluded.options_json, next_run_at = NULL",
      ).run(at, at, cluster.id, body.cron, enabled ? 1 : 0, JSON.stringify(options));
      const row = db
        .prepare("SELECT id FROM schedules WHERE cluster_id = ? AND kind = 'cluster_restart'")
        .get(cluster.id);
      scheduler?.reschedule(row.id);
      return { id: row.id };
    }),
  );
  router.add(
    'DELETE',
    '/api/clusters/:id/schedules/restart',
    protectedRoute('cluster.schedule.delete', 'cluster', ({ params }) => {
      get(params.id);
      db.prepare("DELETE FROM schedules WHERE cluster_id = ? AND kind = 'cluster_restart'").run(params.id);
      return { deleted: true };
    }),
  );
}
