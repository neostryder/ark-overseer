import { nowIso, transaction } from '../db/index.js';
import { redact } from '../util/redact.js';

const INTERRUPTED = 'The manager stopped while this job was running.';
// setTimeout treats anything longer than this (about 24.8 days) as 1 ms, which would turn a job
// scheduled a month out into a busy loop. Longer waits are split into steps of this size.
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createJobEngine({ db, handlers, concurrency = 2, progressWriteMs = 250 }) {
  const listeners = new Set();
  const running = new Map();
  // Jobs whose final database write failed. Their rows still say 'running', so their server and
  // install stay busy until the next start() records them as interrupted.
  const stranded = new Map();
  const idleWaiters = [];
  let sequence = 0;
  let started = false;
  let stopped = false;
  let timer = null;

  const selectJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const selectNextRunAfter = db.prepare(
    "SELECT MIN(run_after) AS run_after FROM jobs WHERE state = 'queued' AND run_after > ?",
  );
  const claimJob = db.prepare(
    "UPDATE jobs SET state = 'running', started_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued'",
  );
  const writeProgress = db.prepare('UPDATE jobs SET progress = ?, message = ?, updated_at = ? WHERE id = ?');
  const writeFinish = db.prepare(
    'UPDATE jobs SET state = ?, progress = ?, message = ?, result_json = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
  );

  function toJob(row) {
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      serverId: row.server_id,
      installId: row.install_id,
      progress: row.progress,
      message: row.message,
      params: JSON.parse(row.params_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      error: row.error,
      runAfter: row.run_after,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  function get(id) {
    const row = selectJob.get(id);
    return row ? toJob(row) : null;
  }

  function emit(type, job) {
    const event = { seq: ++sequence, type, job };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a listener cannot interrupt job processing */
      }
    }
  }

  function list({ state, serverId, limit = 100 } = {}) {
    const conditions = [];
    const values = [];
    if (state !== undefined) {
      const states = Array.isArray(state) ? state : [state];
      if (!states.length) return [];
      conditions.push(`state IN (${states.map(() => '?').join(', ')})`);
      values.push(...states);
    }
    if (serverId !== undefined) {
      conditions.push('server_id = ?');
      values.push(serverId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM jobs ${where} ORDER BY id DESC`;
    if (limit !== null) {
      sql += ' LIMIT ?';
      values.push(limit);
    }
    return db
      .prepare(sql)
      .all(...values)
      .map(toJob);
  }

  function busyTargets() {
    const serverIds = new Set();
    const installIds = new Set();
    for (const { job } of [...running.values(), ...stranded.values()]) {
      if (job.serverId !== null) serverIds.add(job.serverId);
      if (job.installId !== null) installIds.add(job.installId);
    }
    return { serverIds: [...serverIds], installIds: [...installIds] };
  }

  // The oldest eligible queued job, with busy servers and installs filtered out in SQL, so a long
  // backlog is never loaded into memory just to pick one row.
  function nextEligible() {
    const { serverIds, installIds } = busyTargets();
    const conditions = ["state = 'queued'", '(run_after IS NULL OR run_after <= ?)'];
    const values = [nowIso()];
    if (serverIds.length) {
      conditions.push(`(server_id IS NULL OR server_id NOT IN (${serverIds.map(() => '?').join(', ')}))`);
      values.push(...serverIds);
    }
    if (installIds.length) {
      conditions.push(`(install_id IS NULL OR install_id NOT IN (${installIds.map(() => '?').join(', ')}))`);
      values.push(...installIds);
    }
    return db.prepare(`SELECT id FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT 1`).get(...values);
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function scheduleTimer() {
    clearTimer();
    if (stopped) return;
    const next = selectNextRunAfter.get(nowIso())?.run_after;
    if (!next) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(next) - Date.now()));
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, delay);
    timer.unref?.();
  }

  // Writes a finished job and emits its event. If the row cannot be written as succeeded (a result
  // that will not serialize, for example), the job is recorded as failed with that error instead, so
  // it never stays 'running' in the table after its handler has settled.
  function finish(entry, state, { result, error } = {}) {
    const stamp = nowIso();
    const { job } = entry;
    try {
      let resultJson = null;
      if (state === 'succeeded') resultJson = JSON.stringify(result) ?? 'null';
      const progress = state === 'succeeded' ? 1 : job.progress;
      transaction(db, () =>
        writeFinish.run(state, progress, job.message, resultJson, error ?? null, stamp, stamp, job.id),
      );
    } catch (writeError) {
      if (state !== 'succeeded') throw writeError;
      const message = redact(`The job finished but its result could not be saved: ${writeError.message}`);
      transaction(db, () => writeFinish.run('failed', job.progress, job.message, null, message, stamp, stamp, job.id));
      state = 'failed';
    }
    emit(state, get(job.id));
  }

  function run(job) {
    const controller = new AbortController();
    const entry = {
      job,
      controller,
      cancelled: false,
      stopping: false,
      finished: false,
      lastWrite: 0,
      flushTimer: null,
    };
    running.set(job.id, entry);

    function flushProgress() {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
      if (entry.finished) return;
      entry.lastWrite = Date.now();
      const updatedAt = nowIso();
      writeProgress.run(entry.job.progress, entry.job.message, updatedAt, entry.job.id);
      entry.job = { ...entry.job, updatedAt };
    }

    // Every call is emitted, but the row is written at most once per progressWriteMs. A call that
    // lands inside the window schedules one trailing write, so the table catches up with the last
    // value even when a job goes quiet after a burst.
    const progress = (fraction, message) => {
      if (entry.finished) return;
      if (fraction !== null && typeof fraction !== 'number') throw new TypeError('fraction must be a number or null');
      const value = fraction === null ? null : Math.max(0, Math.min(1, fraction));
      const safeMessage = message === undefined ? entry.job.message : redact(message);
      entry.job = { ...entry.job, progress: value, message: safeMessage };
      const wait = progressWriteMs - (Date.now() - entry.lastWrite);
      if (wait <= 0) {
        flushProgress();
      } else if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(flushProgress, wait);
        entry.flushTimer.unref?.();
      }
      emit('progress', entry.job);
    };

    let outcome;
    try {
      outcome = handlers[job.kind]({ job, params: job.params, signal: controller.signal, progress });
    } catch (error) {
      outcome = Promise.reject(error);
    }
    Promise.resolve(outcome)
      .then(
        (result) => ({ state: 'succeeded', result }),
        (error) => {
          if (entry.stopping) return { state: 'interrupted', error: INTERRUPTED };
          if (entry.cancelled) return { state: 'cancelled' };
          return { state: 'failed', error: redact(String(error?.message ?? error)) };
        },
      )
      .then(({ state, ...details }) => {
        entry.finished = true;
        clearTimeout(entry.flushTimer);
        finish(entry, state, details);
      })
      .catch(() => {
        // The database write itself failed. The row stays 'running' and the next start() marks it
        // interrupted, which is the most accurate record available.
        stranded.set(job.id, entry);
      })
      .finally(() => {
        running.delete(job.id);
        if (running.size === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
        pump();
      });
  }

  function pump() {
    if (!started || stopped) return;
    while (running.size < concurrency) {
      const row = nextEligible();
      if (!row) break;
      const stamp = nowIso();
      const changes = transaction(db, () => claimJob.run(stamp, stamp, row.id).changes);
      if (changes !== 1) continue;
      const job = get(row.id);
      emit('started', job);
      run(job);
    }
    scheduleTimer();
  }

  function enqueue(kind, params = {}, { serverId = null, installId = null, runAfter = null } = {}) {
    if (typeof handlers[kind] !== 'function') throw new Error(`No handler registered for job kind: ${kind}`);
    // Stored run_after values are compared as strings, which only works if every one has the exact
    // format nowIso() produces, so anything else is converted or refused here.
    if (runAfter !== null) {
      const time = runAfter instanceof Date ? runAfter.getTime() : Date.parse(runAfter);
      if (Number.isNaN(time)) throw new TypeError(`runAfter is not a valid date: ${runAfter}`);
      runAfter = new Date(time).toISOString();
    }
    const stamp = nowIso();
    const result = transaction(db, () =>
      db
        .prepare(
          'INSERT INTO jobs (created_at, updated_at, kind, server_id, install_id, state, params_json, run_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(stamp, stamp, kind, serverId, installId, 'queued', JSON.stringify(params), runAfter),
    );
    const job = get(Number(result.lastInsertRowid));
    emit('queued', job);
    queueMicrotask(pump);
    return job;
  }

  // Jobs still marked running belong to a manager process that is gone, so they are recorded as
  // interrupted. Queued jobs are untouched and run as normal.
  function start() {
    if (started) {
      // Restarting after stop() resumes work; recovery only makes sense for a fresh process.
      if (stopped) {
        stopped = false;
        pump();
      }
      return 0;
    }
    started = true;
    stopped = false;
    const rows = transaction(db, () => {
      const found = db.prepare("SELECT id FROM jobs WHERE state = 'running' ORDER BY id").all();
      if (found.length) {
        const stamp = nowIso();
        db.prepare(
          "UPDATE jobs SET state = 'interrupted', error = ?, finished_at = ?, updated_at = ? WHERE state = 'running'",
        ).run(INTERRUPTED, stamp, stamp);
      }
      return found;
    });
    for (const row of rows) emit('interrupted', get(row.id));
    pump();
    return rows.length;
  }

  function cancel(id) {
    const job = get(id);
    if (!job) return false;
    if (job.state === 'queued') {
      const stamp = nowIso();
      const changed = transaction(
        db,
        () =>
          db
            .prepare(
              "UPDATE jobs SET state = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
            )
            .run(stamp, stamp, id).changes,
      );
      if (!changed) return false;
      emit('cancelled', get(id));
      return true;
    }
    const entry = running.get(id);
    if (job.state !== 'running' || !entry) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
  }

  // Resolves once every running handler has settled, or after timeoutMs, whichever comes first. A
  // handler that ignores its abort signal cannot hold up a service shutdown past the timeout; its row
  // stays 'running' and the next start() records it as interrupted.
  function stop({ abort = false, timeoutMs = Infinity } = {}) {
    stopped = true;
    clearTimer();
    if (abort) {
      for (const entry of running.values()) {
        entry.stopping = true;
        entry.controller.abort();
      }
    }
    if (running.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
      if (Number.isFinite(timeoutMs)) setTimeout(resolve, timeoutMs).unref?.();
    });
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { enqueue, get, list, start, cancel, stop, subscribe, listenerCount: () => listeners.size };
}
