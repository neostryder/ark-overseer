import { transaction } from '../db/transaction.js';
import { nextRun } from './cron.js';

export const JOB_KINDS = {
  restart: 'server.restart',
  cluster_restart: 'cluster.restart',
  backup: 'server.backup',
  auto_update: 'install.auto_update',
  update_check: 'install.check_update',
};
export const MESSAGES = { noTarget: 'The schedule target is gone.' };
// A schedule that came due while ARK Overseer was not running still runs if it is less late than this.
export const CATCH_UP_MS = 30 * 60 * 1000;
const MAX_WAIT_MS = 60 * 1000;

export function createScheduler({
  db,
  jobs,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null,
    started = false;
  const stamp = (value) => new Date(value).toISOString();
  function scheduleNext(id, after) {
    const row = db.prepare('SELECT cron FROM schedules WHERE id = ?').get(id);
    const next = nextRun(row.cron, after);
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next === null ? null : stamp(next), id);
  }
  function due() {
    if (!started) return;
    const current = now(),
      rows = db
        .prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id')
        .all(stamp(current));
    for (const row of rows) {
      try {
        fire(row, current);
      } catch (error) {
        // One bad row must not stop the others, nor throw out of a timer and take the process down.
        // Clearing next_run_at parks the row until it is edited, instead of failing again every tick.
        db.prepare('UPDATE schedules SET next_run_at = NULL WHERE id = ?').run(row.id);
        audit(current, 'schedule.failed', row, { error: String(error?.message ?? error) });
      }
    }
    arm();
  }
  function audit(current, action, row, detail) {
    db.prepare(
      'INSERT INTO audit_events (created_at, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(stamp(current), 'scheduler', action, 'schedule', row.id, JSON.stringify({ kind: row.kind, ...detail }));
  }
  function fire(row, current) {
    const lateMs = current - Date.parse(row.next_run_at);
    const prev =
      row.last_job_id == null ? null : db.prepare('SELECT state FROM jobs WHERE id = ?').get(row.last_job_id);
    const busy = Boolean(prev && ['queued', 'running'].includes(prev.state));
    const server = row.cluster_id
      ? null
      : db.prepare('SELECT id, install_id FROM servers WHERE id = ?').get(row.server_id);
    const cluster = row.cluster_id ? db.prepare('SELECT id FROM clusters WHERE id = ?').get(row.cluster_id) : null;
    const reason = !(cluster || server)
      ? MESSAGES.noTarget
      : busy
        ? 'last job still running'
        : lateMs >= CATCH_UP_MS
          ? 'too late'
          : null;
    // The schedule moves on before its job is queued. Should the process die between the two, the
    // run is lost rather than repeated, since a second restart or update is the worse mistake.
    transaction(db, () => {
      scheduleNext(row.id, current);
      if (!reason) db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(stamp(current), row.id);
      audit(current, reason ? 'schedule.skipped' : 'schedule.run', row, { lateMs, ...(reason ? { reason } : {}) });
    });
    if (reason) return;
    const install = row.kind === 'auto_update' || row.kind === 'update_check';
    const job = jobs.enqueue(
      JOB_KINDS[row.kind],
      // A scheduled backup is marked as one, so pruning and the backup list can tell it from a manual one.
      {
        ...JSON.parse(row.options_json),
        ...(row.kind === 'backup' ? { reason: 'scheduled' } : {}),
        ...(row.cluster_id ? { clusterId: row.cluster_id } : {}),
      },
      row.cluster_id
        ? {
            targets: {
              servers: db
                .prepare('SELECT id FROM servers WHERE cluster_id = ?')
                .all(row.cluster_id)
                .map((member) => member.id),
              installs: db
                .prepare('SELECT install_id FROM servers WHERE cluster_id = ?')
                .all(row.cluster_id)
                .map((member) => member.install_id),
            },
          }
        : install
          ? { installId: server.install_id }
          : { serverId: server.id },
    );
    db.prepare('UPDATE schedules SET last_job_id = ? WHERE id = ?').run(job.id, row.id);
  }
  function arm() {
    if (!started) return;
    if (timer !== null) clearTimer(timer);
    const earliest = db
      .prepare('SELECT MIN(next_run_at) AS at FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL')
      .get().at;
    const wait = earliest ? Math.max(0, Date.parse(earliest) - now()) : MAX_WAIT_MS;
    timer = setTimer(
      () => {
        timer = null;
        due();
      },
      Math.min(MAX_WAIT_MS, wait),
    );
  }
  function start() {
    started = true;
    const rows = db.prepare('SELECT id, kind, cron FROM schedules WHERE enabled = 1 AND next_run_at IS NULL').all();
    for (const row of rows) {
      try {
        scheduleNext(row.id, now());
      } catch (error) {
        audit(now(), 'schedule.failed', row, { error: String(error?.message ?? error) });
      }
    }
    due();
  }
  function stop() {
    started = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function reschedule(id) {
    scheduleNext(id, now());
    if (started) arm();
  }
  return { start, stop, reschedule };
}
