import { activeJobFor } from '../clusters/core.js';
import {
  checkDuration,
  checkSettings,
  DEFAULT_SETTINGS,
  describeDuration,
  durationMs,
  IDLE_MESSAGES,
  promptText,
} from './settings.js';

const SETTINGS_KEY = 'idle_watch';
const SNOOZE_KEY = 'idle_snoozes';
// With automatic shutdown off, an unanswered prompt comes back this often while the server stays empty.
const REMIND_MS = 60 * 60 * 1000;

// ListPlayers answers "No Players Connected", or one numbered line per player. Anything else is not a count.
export function parsePlayerCount(text) {
  const body = String(text ?? '');
  if (/no players connected/i.test(body)) return 0;
  const lines = body.split(/\r?\n/).filter((line) => /^\s*\d+\.\s+\S/.test(line));
  return lines.length ? lines.length : null;
}

// Watches for a server that is running with nobody on it, asks whether to shut it down, and does what the answer
// says. `sinks.prompt(server, text, extend)` and `sinks.notice(server, text)` carry the words to wherever they are
// shown: phones, Telegram. Nothing here stops a server without an answer unless automatic shutdown is on.
export function createIdleWatch({
  db,
  supervisor,
  rcon,
  getRconPassword,
  sinks = {},
  now = () => Date.now(),
  log = () => {},
  intervalMs = 60 * 1000,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const states = new Map();
  const stopping = new Set();
  const warned = new Set();
  let timer = null;
  let ticking = false;
  const stamp = () => new Date(now()).toISOString();

  const readJson = (key, fallback) => {
    try {
      const value = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value;
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (key, value) =>
    db
      .prepare(
        'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, JSON.stringify(value), stamp());

  function settings() {
    try {
      return checkSettings(readJson(SETTINGS_KEY, {}), DEFAULT_SETTINGS);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings(input) {
    const next = checkSettings(input, settings());
    writeJson(SETTINGS_KEY, next);
    return next;
  }
  const snoozes = () => readJson(SNOOZE_KEY, {});
  function setSnooze(id, until) {
    const all = snoozes();
    if (until === null) delete all[id];
    else all[id] = until;
    writeJson(SNOOZE_KEY, all);
  }

  const serverRows = () =>
    db
      .prepare('SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id ORDER BY s.id')
      .all();
  const serverRow = (id) =>
    db
      .prepare(
        'SELECT s.*, i.path AS install_path FROM servers s JOIN installs i ON i.id = s.install_id WHERE s.id = ?',
      )
      .get(id);

  function audit(action, server, actor, detail = {}, userId = null) {
    try {
      db.prepare(
        'INSERT INTO audit_events (created_at, user_id, actor, action, target_kind, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(stamp(), userId, actor, action, 'server', server.id, JSON.stringify(detail));
    } catch (cause) {
      log(`The audit record for ${action} could not be written: ${cause.message}`);
    }
  }

  async function playerCount(server) {
    let password = '';
    try {
      password = await getRconPassword(server);
      const text = await rcon({
        host: '127.0.0.1',
        port: server.rcon_port,
        password,
        command: 'ListPlayers',
      });
      const count = parsePlayerCount(text);
      if (count === null && !warned.has(server.id)) {
        warned.add(server.id);
        log(
          `Idle watch: ListPlayers on ${server.name} gave an answer it could not read: ${JSON.stringify(String(text).slice(0, 80))}`,
        );
      }
      return count;
    } catch (cause) {
      if (!warned.has(server.id)) {
        warned.add(server.id);
        const message = `Idle watch: could not ask ${server.name} who is connected: ${cause.message}`;
        log(password ? message.split(password).join('[redacted]') : message);
      }
      return null;
    }
  }

  async function say(kind, ...args) {
    try {
      await sinks[kind]?.(...args);
    } catch (cause) {
      log(`Idle watch: sending ${kind} failed: ${cause.message}`);
    }
  }

  // The stop saves the world first. It runs on, so the answer does not wait minutes for it.
  function beginStop(server, why, actor, userId = null) {
    stopping.add(server.id);
    states.delete(server.id);
    setSnooze(server.id, null);
    audit('idle.shutdown', server, actor, { why }, userId);
    supervisor
      .stop(server.id)
      .then(() => say('notice', server, `${server.name} was saved and shut down${why ? ` (${why})` : ''}.`))
      .catch((cause) => {
        log(`Idle watch: stopping ${server.name} failed: ${cause.message}`);
        return say('notice', server, `${server.name} could not be shut down: ${cause.message}`);
      })
      .finally(() => stopping.delete(server.id));
  }

  async function prompt(server, state, config) {
    const t = now();
    state.promptedAt ??= t;
    state.lastPromptAt = t;
    audit('idle.prompt', server, 'system');
    await say('prompt', server, promptText(server, config), { value: config.extendValue, unit: config.extendUnit });
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const config = settings();
      const watched = new Set();
      for (const server of serverRows()) {
        const id = server.id;
        const on = config.enabled && (config.serverIds === null || config.serverIds.includes(id));
        if (
          !on ||
          stopping.has(id) ||
          supervisor.status(id)?.observedState !== 'running' ||
          activeJobFor(db, [{ id, install_id: server.install_id }])
        ) {
          states.delete(id);
          continue;
        }
        watched.add(id);
        const count = await playerCount(server);
        if (count === null) {
          states.delete(id);
          continue;
        }
        warned.delete(id);
        if (count > 0) {
          states.delete(id);
          if (snoozes()[id]) setSnooze(id, null);
          continue;
        }
        const t = now();
        const state = states.get(id) ?? { idleSince: t };
        states.set(id, state);
        const until = snoozes()[id];
        if (until) {
          if (t >= until) beginStop(server, 'the extra time ended with nobody on', 'system');
          continue;
        }
        if (t - state.idleSince < config.idleMinutes * 60 * 1000) continue;
        if (!state.promptedAt) await prompt(server, state, config);
        else if (config.autoShutdown) {
          if (t - state.promptedAt >= config.autoShutdownMinutes * 60 * 1000) {
            beginStop(server, 'nobody answered', 'system');
          }
        } else if (t - state.lastPromptAt >= REMIND_MS) await prompt(server, state, config);
      }
      for (const id of [...states.keys()]) if (!watched.has(id)) states.delete(id);
    } finally {
      ticking = false;
    }
  }

  // Answers to a prompt, from a button on a phone, in Telegram, or on the page. Each one checks the server as it
  // is now, so an old button pressed late can do no harm.
  async function respond(serverId, action, { value, unit } = {}, { actor = 'user', userId = null } = {}) {
    const server = serverRow(serverId);
    if (!server) return { ok: false, outcome: 'missing', message: 'That server is not here any more.' };
    if (supervisor.status(server.id)?.observedState !== 'running' || stopping.has(server.id)) {
      return { ok: true, outcome: 'not_running', message: `${server.name} is not running, so there is nothing to do.` };
    }
    if (activeJobFor(db, [{ id: server.id, install_id: server.install_id }])) {
      return { ok: false, outcome: 'busy', message: `${server.name} is busy with another task right now.` };
    }
    if (action === 'shutdown') {
      const count = await playerCount(server);
      if (count > 0) {
        states.delete(server.id);
        return { ok: true, outcome: 'players', message: `Someone is on ${server.name} now, so it was left running.` };
      }
      beginStop(server, 'you asked for it', actor, userId);
      return { ok: true, outcome: 'stopping', message: `Saving and shutting down ${server.name}.` };
    }
    if (action === 'extend') {
      const chosen =
        value === undefined ? { value: settings().extendValue, unit: settings().extendUnit } : { value, unit };
      checkDuration(chosen.value, chosen.unit);
      const until = now() + durationMs(chosen);
      setSnooze(server.id, until);
      const state = states.get(server.id);
      if (state) delete state.promptedAt;
      audit('idle.extend', server, actor, { value: chosen.value, unit: chosen.unit }, userId);
      return {
        ok: true,
        outcome: 'extended',
        until: new Date(until).toISOString(),
        message: `${server.name} stays running for ${describeDuration(chosen.value, chosen.unit)} more, then shuts down if nobody is on.`,
      };
    }
    throw new Error(IDLE_MESSAGES.badAction);
  }

  // What the page shows: prompts nobody has answered yet, and extensions in force.
  function status() {
    const config = settings();
    const names = new Map(serverRows().map((row) => [row.id, row.name]));
    const pending = [];
    for (const [id, state] of states) {
      if (!state.promptedAt || !names.has(id) || snoozes()[id]) continue;
      pending.push({
        serverId: id,
        name: names.get(id),
        since: new Date(state.promptedAt).toISOString(),
        autoShutdownAt: config.autoShutdown
          ? new Date(state.promptedAt + config.autoShutdownMinutes * 60 * 1000).toISOString()
          : null,
        text: promptText({ name: names.get(id) }, config),
        extend: { value: config.extendValue, unit: config.extendUnit },
      });
    }
    const extended = Object.entries(snoozes())
      .filter(([id]) => names.has(Number(id)))
      .map(([id, until]) => ({
        serverId: Number(id),
        name: names.get(Number(id)),
        until: new Date(until).toISOString(),
      }));
    return { settings: config, pending, extended };
  }

  function start() {
    if (timer) return;
    timer = setTimer(() => void tick().catch((cause) => log(`Idle watch: ${cause.message}`)), intervalMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, tick, respond, status, settings, saveSettings };
}
