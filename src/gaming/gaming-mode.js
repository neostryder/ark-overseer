import { detectGames } from './detect.js';

// Lowers the priority and CPU affinity of the servers ARK Overseer runs while a game is running, and
// puts them back once no game has been seen for two polls in a row.
export function createGamingMode({
  db,
  platform,
  supervisor,
  clock = { now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout },
  pollMs = 15000,
  cpuCount = 1,
  log = () => {},
}) {
  // Windows ProcessorAffinity covers one processor group of at most 64; never build masks beyond it.
  cpuCount = Math.max(1, Math.min(64, Math.floor(cpuCount)));
  const settings = () => db.prepare("SELECT * FROM hosts WHERE name = 'local'").get();
  // A process is its pid plus its start time, so a restarted server that reuses a pid is a new process.
  const keyOf = (server) => `${server.pid}:${server.startedAt ?? ''}`;
  // key -> signature of the policy last applied; failures hold the last error per key.
  const applied = new Map();
  const failures = new Map();
  // Written to the host row, so servers throttled before a crash or restart are still put back.
  const THROTTLED = 'throttled before a restart';
  let state = 'off',
    games = [],
    checkedAt = null,
    timer = null,
    emptyPolls = 0,
    stopped = true,
    tracked = [],
    active = [],
    queue = Promise.resolve();

  const gameCores = (row) => Math.min(cpuCount - 1, Math.max(1, row?.gaming_game_cores ?? Math.floor(cpuCount / 2)));
  function mask(first, count) {
    return (((1n << BigInt(Math.max(1, count))) - 1n) << BigInt(first)).toString();
  }
  function policy(mode, row = settings()) {
    if (mode !== 'gaming') return { priority: 'Normal', affinityMask: mask(0, cpuCount) };
    const priority = row?.gaming_priority ?? 'BelowNormal';
    // With one processor there is no core to set aside, so only the priority drops.
    if (cpuCount < 2) return { priority, affinityMask: mask(0, cpuCount) };
    const cores = gameCores(row);
    return { priority, affinityMask: mask(cores, cpuCount - cores) };
  }
  const normalSignature = () => JSON.stringify(policy('normal'));
  const isGaming = (key, row) => applied.get(key) === JSON.stringify(policy('gaming', row));

  function updateServers() {
    tracked = db
      .prepare('SELECT id, name FROM servers ORDER BY id')
      .all()
      .map((server) => {
        const current = supervisor.status(server.id) ?? {};
        return { ...server, pid: current.pid, startedAt: current.startedAt, observedState: current.observedState };
      })
      .filter((server) => server.pid);
    active = tracked.filter((server) => ['running', 'starting'].includes(server.observedState));
    // A server that is briefly unknown or stopping keeps its entry; only a process that is gone is forgotten.
    const live = new Set(tracked.map(keyOf));
    for (const key of [...applied.keys(), ...failures.keys()])
      if (!live.has(key)) {
        applied.delete(key);
        failures.delete(key);
      }
  }

  function saveThrottled() {
    const normal = normalSignature();
    const list = tracked
      .filter((server) => applied.has(keyOf(server)) && applied.get(keyOf(server)) !== normal)
      .map((server) => ({ pid: server.pid, startedAt: server.startedAt ?? null }));
    db.prepare("UPDATE hosts SET gaming_applied_json = ? WHERE name = 'local'").run(JSON.stringify(list));
  }
  function loadThrottled() {
    let list = [];
    try {
      list = JSON.parse(settings()?.gaming_applied_json || '[]');
    } catch {
      list = [];
    }
    for (const entry of list) applied.set(`${entry.pid}:${entry.startedAt ?? ''}`, THROTTLED);
  }

  async function apply(server, desired) {
    const key = keyOf(server),
      signature = JSON.stringify(desired);
    if (applied.get(key) === signature) return;
    try {
      await platform.setProcessPolicy(server.pid, desired);
      applied.set(key, signature);
      failures.delete(key);
    } catch (error) {
      if (failures.get(key)?.signature !== signature)
        log(`Gaming mode could not change ${server.name} (pid ${server.pid}): ${error.message}`);
      failures.set(key, { signature, error: error.message });
    }
  }

  // Only servers this engine changed are put back, so a server it never touched keeps whatever
  // priority it already had.
  async function restoreAll() {
    const normal = policy('normal'),
      signature = JSON.stringify(normal);
    const changed = active.filter((server) => applied.has(keyOf(server)) && applied.get(keyOf(server)) !== signature);
    await Promise.all(changed.map((server) => apply(server, normal)));
    // A server that could not be throttled has nothing to put back, so its old error no longer applies.
    for (const server of active)
      if (failures.get(keyOf(server))?.signature !== signature) failures.delete(keyOf(server));
  }

  async function pollOnce() {
    const row = settings();
    updateServers();
    if (!row?.gaming_mode) {
      games = [];
      state = 'off';
      emptyPolls = 0;
      checkedAt = new Date(clock.now()).toISOString();
      await restoreAll();
      return;
    }
    let processes;
    try {
      processes = await platform.listAllProcesses();
    } catch (error) {
      log(`Gaming mode could not list processes: ${error.message}`);
      return;
    }
    checkedAt = new Date(clock.now()).toISOString();
    games = detectGames(processes, {
      games: JSON.parse(row.gaming_games_json || '[]'),
      ignore: JSON.parse(row.gaming_ignore_json || '[]'),
    });
    if (games.length) {
      state = 'gaming';
      emptyPolls = 0;
    } else if (state === 'gaming' && ++emptyPolls < 2) {
      return;
    } else {
      state = 'normal';
      emptyPolls = 0;
    }
    if (state === 'gaming') {
      const desired = policy('gaming', row);
      await Promise.all(active.map((server) => apply(server, desired)));
    } else await restoreAll();
  }

  // Polls run one at a time, so a settings change never races the timer's poll.
  function poll() {
    queue = queue
      .then(pollOnce)
      .then(saveThrottled)
      .catch((error) => log(`Gaming mode check failed: ${error.message}`));
    return queue.then(status);
  }

  function status() {
    const row = settings();
    return {
      enabled: Boolean(row?.gaming_mode),
      state: row?.gaming_mode ? state : 'off',
      games,
      checkedAt,
      servers: active.map((server) => {
        const key = keyOf(server);
        return {
          id: server.id,
          name: server.name,
          policy: applied.has(key)
            ? isGaming(key, row) || applied.get(key) === THROTTLED
              ? 'gaming'
              : 'normal'
            : null,
          error: failures.get(key)?.error ?? null,
        };
      }),
      cpuCount,
      gameCores: gameCores(row),
      priority: row?.gaming_priority ?? 'BelowNormal',
      gamesList: JSON.parse(row?.gaming_games_json ?? '[]'),
      ignoreList: JSON.parse(row?.gaming_ignore_json ?? '[]'),
    };
  }

  function schedule() {
    if (stopped) return;
    timer = clock.setTimer(async () => {
      timer = null;
      await poll();
      schedule();
    }, pollMs);
  }
  async function start() {
    stopped = false;
    loadThrottled();
    await poll();
    schedule();
  }
  async function stop() {
    stopped = true;
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
    // Wait for a poll already running, so it cannot throttle a server after the restore below.
    queue = queue
      .then(() => {
        updateServers();
        return restoreAll();
      })
      .then(saveThrottled)
      .catch((error) => log(`Gaming mode restore failed: ${error.message}`));
    await queue;
  }
  return { start, stop, status, refresh: poll };
}
