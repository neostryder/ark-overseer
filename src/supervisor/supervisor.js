import { buildLaunch } from './launch.js';
import { isSameProcess, pickOwnedProcess } from './ownership.js';
import { rconCommand } from './rcon.js';

const DEFAULTS = {
  // How long a launch must stay alive before it counts. The crashes this guards against (BattlEye, a
  // Steam client that is not ready yet) land within the first few seconds.
  surviveMs: 25000,
  // This launch fails intermittently while loading the world, and a retry has cleared it every time.
  startupAttempts: 3,
  retryDelayMs: 5000,
  // A large world takes well over a minute to save and exit. A 15 second budget once reached the force
  // kill while the save was still being written, which corrupted it for every later start.
  saveTimeoutMs: 120000,
  stopTimeoutMs: 180000,
  pollMs: 5000,
  adoptionMissMs: 15000,
  restartBackoffMs: [10000, 30000, 60000, 120000, 300000],
  crashLoopLimit: 3,
  crashLoopWindowMs: 600000,
  // Consecutive failed lookups during a startup or stop before the state is given up as unknown.
  lookupRetries: 3,
  // A process that seems to be gone is looked up once more after this delay before anything acts on
  // it. Acting on one empty lookup could start a second instance next to a live one.
  goneConfirmMs: 1000,
};

const realClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('Aborted'));
        },
        { once: true },
      );
    }),
};

export function createSupervisor({
  db,
  platform,
  rcon = rconCommand,
  getRconPassword = () => '',
  clock = realClock,
  options = {},
  // Runs before every start, after the checks that can refuse one and before anything is launched. The
  // settings drift check uses it to put ARK Overseer's values back first. A failure here never stops a start.
  beforeStart = async () => {},
}) {
  const config = { ...DEFAULTS, ...options };
  const listeners = new Set();
  const queues = new Map();
  const crashes = new Map();
  const restartTimers = new Map();
  const adoptionMissUntil = new Map();
  let pollAbort = null;
  let pollTask = null;
  let closing = false;

  const selectServer = db.prepare(
    'SELECT s.*, i.path AS install_path, i.state AS install_state FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
  );
  const selectIds = db.prepare('SELECT id FROM servers ORDER BY id');
  const writeState = db.prepare(
    'UPDATE servers SET observed_state = ?, state_changed_at = ?, pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ?',
  );
  const writeDesired = db.prepare('UPDATE servers SET desired_state = ?, updated_at = ? WHERE id = ?');

  const stamp = () => new Date(clock.now()).toISOString();
  const allIds = () => selectIds.all().map((entry) => entry.id);

  function row(id) {
    const found = selectServer.get(id);
    if (!found) throw new Error(`Server ${id} not found`);
    return found;
  }

  function exePathFor(server) {
    return buildLaunch(server, { path: server.install_path }).exePath;
  }

  function recordOf(server) {
    return { pid: server.pid, exePath: exePathFor(server), startedAt: server.pid_started_at };
  }

  function emit(serverId, from, to, reason) {
    const event = { serverId, from, to, reason };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a listener cannot interrupt supervision */
      }
    }
  }

  // Writes the observed state. state_changed_at moves and an event is emitted only when the state
  // itself changes, so a poll that finds a running server still running leaves no trace.
  function setState(id, state, reason, fields = {}) {
    const server = row(id);
    const pid = Object.hasOwn(fields, 'pid') ? fields.pid : server.pid;
    const startedAt = Object.hasOwn(fields, 'startedAt') ? fields.startedAt : server.pid_started_at;
    const changed = server.observed_state !== state;
    if (!changed && pid === server.pid && startedAt === server.pid_started_at) return;
    const now = stamp();
    writeState.run(state, changed ? now : server.state_changed_at, pid, startedAt, now, id);
    if (changed) emit(id, server.observed_state, state, reason);
  }

  function setDesired(id, desired) {
    writeDesired.run(desired, stamp(), id);
  }

  function status(id) {
    const server = row(id);
    return {
      id,
      desiredState: server.desired_state,
      observedState: server.observed_state,
      pid: server.pid,
      startedAt: server.pid_started_at,
      changedAt: server.state_changed_at,
      crashLoop: Boolean(crashes.get(id)?.blocked),
    };
  }

  // Every action for one server runs after the previous one finishes, so a start, a stop and a poll
  // never interleave for the same server. Different servers have separate queues.
  function enqueue(id, task) {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(id, next);
    return next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
  }

  function cancelRestart(id) {
    restartTimers.get(id)?.abort();
    restartTimers.delete(id);
  }

  // Watches a fresh launch through the survive window. Returns 'alive', 'exited', or 'unknown' when
  // the process could not be looked up several times in a row.
  // Looks the process up again before treating it as gone. Returns true if it is gone, false if it is
  // still there, and null if the lookup failed.
  async function confirmGone(record) {
    await clock.sleep(config.goneConfirmMs);
    try {
      return !isSameProcess(record, await platform.processInfo(record.pid));
    } catch {
      return null;
    }
  }

  // Only a lookup that finds our process counts as alive, so a window in which every lookup failed
  // is 'unknown', never a success.
  async function watchStartup(id, record) {
    let failures = 0;
    let confirmed = false;
    let elapsed = 0;
    // At least one lookup runs, even when surviveMs is 0.
    do {
      const wait = Math.min(1000, config.surviveMs - elapsed);
      await clock.sleep(wait);
      elapsed += wait;
      let info;
      try {
        info = await platform.processInfo(record.pid);
        failures = 0;
      } catch {
        failures += 1;
        confirmed = false;
        if (failures >= config.lookupRetries) return 'unknown';
        continue;
      }
      // The start time is read right after spawning; if that lookup failed, fill it in now.
      if (!record.startedAt && info && info.pid === record.pid && isSameProcess({ ...record, startedAt: null }, info)) {
        record.startedAt = info.startedAt;
        setState(id, 'starting', 'start time recorded', { startedAt: record.startedAt });
      }
      if (!isSameProcess(record, info)) {
        const gone = await confirmGone(record);
        if (gone === null) return 'unknown';
        if (gone) return 'exited';
      }
      confirmed = true;
    } while (elapsed < config.surviveMs);
    return confirmed ? 'alive' : 'unknown';
  }

  // A pid from spawn proves nothing: the server can die within a couple of seconds, and reporting
  // that pid as a success is how a dead server once showed as started. Only a launch that exited is
  // retried. One still alive but slow must not be, since a second instance would fight over the port.
  // An install that SteamCMD is changing, or one it left broken, must not be launched from.
  const BUSY_INSTALL_STATES = new Set(['installing', 'updating', 'validating', 'broken']);

  async function startInternal(id, { manual }) {
    const server = row(id);
    if (server.observed_state === 'starting' || server.observed_state === 'running') return status(id);
    if (BUSY_INSTALL_STATES.has(server.install_state)) {
      const error = new Error(`The server cannot start while its install is ${server.install_state}.`);
      error.code = 'INSTALL_BUSY';
      throw error;
    }
    try {
      await beforeStart(id);
    } catch {
      /* the start goes ahead without it */
    }
    if (manual) crashes.delete(id);
    cancelRestart(id);
    setDesired(id, 'running');
    setState(id, 'starting', manual ? 'start requested' : 'automatic restart', { pid: null, startedAt: null });

    let launch;
    try {
      launch = buildLaunch(server, { path: server.install_path });
    } catch (error) {
      setState(id, 'crashed', 'launch settings are invalid');
      throw error;
    }

    let reason = 'the server process exited during startup';
    for (let attempt = 1; attempt <= config.startupAttempts; attempt++) {
      let pid;
      try {
        ({ pid } = await platform.spawnServer(launch));
      } catch (error) {
        setState(id, 'crashed', 'launch failed', { pid: null, startedAt: null });
        throw new Error(`could not launch the server: ${error.message}`);
      }
      let startedAt = null;
      try {
        startedAt = (await platform.processInfo(pid))?.startedAt ?? null;
      } catch {
        /* filled in during the survive window */
      }
      const record = { pid, exePath: launch.exePath, startedAt };
      setState(id, 'starting', 'process launched', { pid, startedAt });

      const outcome = await watchStartup(id, record);
      if (outcome === 'alive') {
        setState(id, 'running', 'startup survived');
        return status(id);
      }
      if (outcome === 'unknown') {
        // The pid stays recorded, so the next successful poll can tell whether it is still ours.
        setState(id, 'unknown', 'process lookup failed during startup');
        throw new Error('could not confirm the server started: process lookups kept failing');
      }
      setState(id, 'starting', 'startup process exited', { pid: null, startedAt: null });
      if (attempt < config.startupAttempts) await clock.sleep(config.retryDelayMs);
    }
    setState(id, 'crashed', 'startup failed');
    throw new Error(`server failed to start after ${config.startupAttempts} attempt(s): ${reason}`);
  }

  // SaveWorld first, so a finished save is on disk before exit begins; DoExit saves too. The server
  // often closes the connection as DoExit takes effect, so a socket closed after the command counts
  // as sent.
  async function requestExit(server) {
    let password;
    try {
      password = await getRconPassword(server);
    } catch {
      return false;
    }
    const target = { host: '127.0.0.1', port: server.rcon_port, password };
    try {
      await rcon({ ...target, command: 'SaveWorld', timeoutMs: config.saveTimeoutMs });
    } catch {
      /* DoExit is still worth trying */
    }
    try {
      await rcon({ ...target, command: 'DoExit', timeoutMs: 10000 });
      return true;
    } catch (error) {
      return /closed early/.test(error.message);
    }
  }

  async function stopInternal(id) {
    let server = row(id);
    setDesired(id, 'stopped');
    cancelRestart(id);

    // No recorded pid can still mean a live server this manager has not adopted yet, for example just
    // after the manager itself restarted. Look before declaring it stopped.
    if (!server.pid) {
      let processes;
      try {
        processes = await platform.listServerProcesses();
      } catch {
        setState(id, 'unknown', 'process lookup failed');
        throw new Error('could not check whether the server is running');
      }
      const picked = pickOwnedProcess(processes, exePathFor(server), server.game_port);
      if (!picked) {
        setState(id, 'stopped', 'stop requested');
        return { graceful: true, forced: false };
      }
      setState(id, 'running', 'adopted process', { pid: picked.pid, startedAt: picked.startedAt });
      server = row(id);
    }

    const record = recordOf(server);
    setState(id, 'stopping', 'stop requested');
    const graceful = await requestExit(server);

    let elapsed = 0;
    while (elapsed < config.stopTimeoutMs) {
      const wait = Math.min(1000, config.stopTimeoutMs - elapsed);
      await clock.sleep(wait);
      elapsed += wait;
      let info;
      try {
        info = await platform.processInfo(record.pid);
      } catch {
        continue;
      }
      if (!isSameProcess(record, info)) {
        setState(id, 'stopped', 'process exited', { pid: null, startedAt: null });
        return { graceful, forced: false };
      }
    }

    // Force-stop only the exact process this manager owns, after confirming the pid still belongs to
    // it rather than to a process that reused the number.
    let latest;
    try {
      latest = await platform.processInfo(record.pid);
    } catch {
      setState(id, 'unknown', 'process lookup failed');
      throw new Error('could not confirm the server stopped: process lookup failed');
    }
    let forced = false;
    if (isSameProcess(record, latest)) {
      // Without a start time the match rests on the pid and path alone, which a reused pid can pass.
      if (!record.startedAt) {
        setState(id, 'unknown', 'process start time unknown');
        throw new Error('the server did not exit, and it cannot be force-stopped safely: its start time is unknown');
      }
      try {
        await platform.killPid(record.pid);
      } catch {
        /* it may have exited between the lookup and the kill */
      }
      forced = true;
    }
    setState(id, 'stopped', forced ? 'process force-stopped' : 'process exited', { pid: null, startedAt: null });
    return { graceful, forced };
  }

  async function pollInternal(id) {
    const server = row(id);
    if (server.pid) {
      let info;
      try {
        info = await platform.processInfo(server.pid);
      } catch {
        setState(id, 'unknown', 'process lookup failed');
        return status(id);
      }
      if (isSameProcess(recordOf(server), info)) {
        setState(id, 'running', 'owned process found');
        return status(id);
      }
      const gone = await confirmGone(recordOf(server));
      if (gone === null) {
        setState(id, 'unknown', 'process lookup failed');
        return status(id);
      }
      if (!gone) {
        setState(id, 'running', 'owned process found');
        return status(id);
      }
      // The process is gone. It was up if the server was meant to run and was not being stopped;
      // that covers 'unknown' too, so a crash during a lookup outage is still restarted.
      const crashed = server.desired_state === 'running' && server.observed_state !== 'stopping';
      setState(id, crashed ? 'crashed' : 'stopped', crashed ? 'server process exited' : 'owned process gone', {
        pid: null,
        startedAt: null,
      });
      if (crashed) scheduleRestart(id);
      return status(id);
    }

    if ((adoptionMissUntil.get(id) ?? 0) > clock.now()) return status(id);
    let processes;
    try {
      processes = await platform.listServerProcesses();
    } catch {
      setState(id, 'unknown', 'process lookup failed');
      return status(id);
    }
    const picked = pickOwnedProcess(processes, exePathFor(server), server.game_port);
    if (picked) {
      adoptionMissUntil.delete(id);
      setState(id, 'running', 'adopted process', { pid: picked.pid, startedAt: picked.startedAt });
      return status(id);
    }
    // A miss is remembered briefly, so a stopped server does not cost a process listing every poll.
    adoptionMissUntil.set(id, clock.now() + config.adoptionMissMs);
    // 'crashed' stays as it is, so a failed start is not quietly relabelled as a normal stop.
    if (server.observed_state !== 'crashed') setState(id, 'stopped', 'no owned process');
    return status(id);
  }

  function scheduleRestart(id) {
    if (closing) return;
    const now = clock.now();
    const history = crashes.get(id) ?? { times: [], blocked: false };
    history.times = history.times.filter((time) => now - time <= config.crashLoopWindowMs);
    history.times.push(now);
    crashes.set(id, history);
    if (history.times.length > config.crashLoopLimit) {
      history.blocked = true;
      emit(id, 'crashed', 'crashed', 'crash loop');
      return;
    }
    armRestart(id, config.restartBackoffMs[Math.min(history.times.length - 1, config.restartBackoffMs.length - 1)]);
  }

  function armRestart(id, delay) {
    cancelRestart(id);
    const controller = new AbortController();
    restartTimers.set(id, controller);
    clock
      .sleep(delay, controller.signal)
      .then(() =>
        enqueue(id, async () => {
          if (controller.signal.aborted || closing) return;
          if (row(id).desired_state !== 'running' || crashes.get(id)?.blocked) return;
          try {
            await startInternal(id, { manual: false });
          } catch (error) {
            // An install being updated is not a crash: wait and try again without counting it.
            if (error.code === 'INSTALL_BUSY') armRestart(id, config.pollMs);
            // A restart that fails is another crash: it backs off further and counts toward the loop.
            else if (row(id).observed_state === 'crashed') scheduleRestart(id);
          }
        }),
      )
      .catch(() => {
        /* cancelled */
      })
      .finally(() => {
        if (restartTimers.get(id) === controller) restartTimers.delete(id);
      });
  }

  // For manager startup: every server is checked, and one that should be running but is not is
  // started. A failed start is recorded as crashed and does not stop the others.
  async function recover() {
    await Promise.all(
      allIds().map(async (id) => {
        await enqueue(id, () => pollInternal(id));
        const current = row(id);
        // Only a server known to be down is started. 'unknown' means the lookup failed, and the
        // server may well be running, so starting it could put a second instance on its port.
        if (current.desired_state === 'running' && ['stopped', 'crashed'].includes(current.observed_state)) {
          await enqueue(id, () => startInternal(id, { manual: false })).catch(() => {});
        }
      }),
    );
  }

  async function pollingLoop(signal) {
    while (!signal.aborted) {
      await Promise.all(allIds().map((id) => enqueue(id, () => pollInternal(id)).catch(() => {})));
      try {
        await clock.sleep(config.pollMs, signal);
      } catch {
        break;
      }
    }
  }

  function startPolling() {
    if (pollTask) return pollTask;
    closing = false;
    pollAbort = new AbortController();
    pollTask = pollingLoop(pollAbort.signal).finally(() => {
      pollTask = null;
    });
    return pollTask;
  }

  async function stopPolling() {
    closing = true;
    pollAbort?.abort();
    for (const id of [...restartTimers.keys()]) cancelRestart(id);
    if (pollTask) await pollTask;
  }

  return {
    start: (id) => enqueue(id, () => startInternal(id, { manual: true })),
    stop: (id) => enqueue(id, () => stopInternal(id)),
    restart: (id) =>
      enqueue(id, async () => {
        await stopInternal(id);
        return startInternal(id, { manual: true });
      }),
    poll: (id) => enqueue(id, () => pollInternal(id)),
    status,
    recover,
    startPolling,
    stopPolling,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
