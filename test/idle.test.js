import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createIdleWatch, parsePlayerCount } from '../src/idle/idle.js';
import {
  checkDuration,
  checkSettings,
  choiceText,
  DEFAULT_SETTINGS,
  describeDuration,
  extendLabel,
  extendShortLabel,
  promptText,
} from '../src/idle/settings.js';

const MIN = 60 * 1000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a unit word agrees with its number', () => {
  const cases = [
    [1, 'hour', '1 hour'],
    [2, 'hour', '2 hours'],
    [1, 'minute', '1 minute'],
    [30, 'minute', '30 minutes'],
    [1, 'day', '1 day'],
    [3, 'day', '3 days'],
  ];
  for (const [value, unit, text] of cases) assert.equal(describeDuration(value, unit), text);
  assert.equal(extendLabel(1, 'hour'), 'Leave it running for 1 hour more, then shut down if nobody is on');
  assert.equal(extendLabel(4, 'hour'), 'Leave it running for 4 hours more, then shut down if nobody is on');
  assert.equal(extendShortLabel(1, 'minute'), 'Leave it 1 minute');
  assert.match(choiceText(2, 'day'), /2 days more/);
});

test('the prompt says how long nobody was on, in agreeing words, and what happens with no answer', () => {
  const server = { name: 'Neo Olympus' };
  assert.equal(
    promptText(server, DEFAULT_SETTINGS),
    'Neo Olympus is still running and nobody has been connected for 5 minutes. If nobody answers, it saves and shuts down in 15 minutes.',
  );
  assert.equal(
    promptText(server, { ...DEFAULT_SETTINGS, idleMinutes: 1, autoShutdown: false }),
    'Neo Olympus is still running and nobody has been connected for 1 minute.',
  );
  assert.match(promptText(server, { ...DEFAULT_SETTINGS, autoShutdownMinutes: 1 }), /shuts down in 1 minute\.$/);
});

test('settings have the defaults, merge a change, and refuse bad values whole', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: true,
    idleMinutes: 5,
    extendValue: 1,
    extendUnit: 'hour',
    autoShutdown: true,
    autoShutdownMinutes: 15,
    serverIds: null,
  });
  assert.equal(checkSettings({ idleMinutes: 10 }).idleMinutes, 10);
  assert.deepEqual(checkSettings({ serverIds: [3, 1, 3] }).serverIds, [1, 3]);
  assert.equal(checkSettings({ serverIds: null }, checkSettings({ serverIds: [1] })).serverIds, null);
  for (const bad of [
    null,
    { idleMinutes: 0 },
    { idleMinutes: 241 },
    { idleMinutes: 1.5 },
    { autoShutdownMinutes: '15' },
    { enabled: 'yes' },
    { extendUnit: 'week' },
    { extendValue: 0 },
    { extendValue: 8, extendUnit: 'day' },
    { serverIds: ['1'] },
    { serverIds: 4 },
  ]) {
    assert.throws(() => checkSettings(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(checkDuration(7, 'day'), { value: 7, unit: 'day' });
});

test('ListPlayers answers are read as a count, or as unknown', () => {
  assert.equal(parsePlayerCount('No Players Connected '), 0);
  assert.equal(parsePlayerCount('0. Zed, 0002a1b2\n1. Mira, 0002c3d4\n'), 2);
  assert.equal(parsePlayerCount(''), null);
  assert.equal(parsePlayerCount('Server received, But no response!!'), null);
});

// A database with a local host and two servers, a fake supervisor, and a clock the test moves. The watch looks at
// server 1 only unless a test widens it.
function setup() {
  const db = openDatabase(':memory:');
  const t = 'x';
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(t, t);
  for (const [id, path] of [
    [1, 'C:/ark'],
    [2, 'C:/ark2'],
  ]) {
    db.prepare(
      "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (?, 1, ?, 'installed', ?, ?)",
    ).run(id, path, t, t);
  }
  for (const [id, name, port] of [
    [1, 'Alpha', 7777],
    [2, 'Beta', 7778],
  ]) {
    db.prepare(
      "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, rcon_port, created_at, updated_at) VALUES (?, 1, ?, ?, 'TheIsland_WP', 's', ?, ?, ?, ?)",
    ).run(id, id, name, port, 27020 + id, t, t);
  }
  let clock = 1_000_000_000;
  const players = { 1: 0, 2: 0 };
  const running = new Set([1, 2]);
  const stops = [];
  const said = [];
  const notices = [];
  const logs = [];
  const watch = createIdleWatch({
    db,
    supervisor: {
      status: (id) => ({ observedState: running.has(id) ? 'running' : 'stopped' }),
      stop: async (id) => {
        stops.push(id);
        running.delete(id);
      },
    },
    rcon: async ({ port, command }) => {
      assert.equal(command, 'ListPlayers');
      const count = players[port - 27020];
      if (count === null) throw new Error('RCON timeout');
      return count === 0
        ? 'No Players Connected '
        : Array.from({ length: count }, (_, i) => `${i}. P${i}, id`).join('\n');
    },
    getRconPassword: () => 'adminpw',
    now: () => clock,
    log: (line) => logs.push(line),
    sinks: {
      prompt: async (server, text, extend) => said.push([server.name, text, extend]),
      notice: async (server, text) => notices.push([server.name, text]),
    },
  });
  watch.saveSettings({ serverIds: [1] });
  return {
    db,
    watch,
    players,
    running,
    stops,
    said,
    notices,
    logs,
    tick: (ms = 0) => {
      clock += ms;
      return watch.tick();
    },
  };
}

test('nobody on for five minutes sends one prompt, and a server with players sends none', async () => {
  const world = setup();
  world.watch.saveSettings({ serverIds: null });
  world.players[2] = 3;
  await world.tick();
  await world.tick(4 * MIN);
  assert.deepEqual(world.said, []);
  await world.tick(MIN);
  assert.equal(world.said.length, 1);
  assert.deepEqual(world.said[0], [
    'Alpha',
    'Alpha is still running and nobody has been connected for 5 minutes. If nobody answers, it saves and shuts down in 15 minutes.',
    { value: 1, unit: 'hour' },
  ]);
  await world.tick(MIN);
  assert.equal(world.said.length, 1);
  assert.equal(world.watch.status().pending.length, 1);
  assert.equal(world.watch.status().pending[0].name, 'Alpha');
});

test('a player joining resets the wait, and the prompt comes again after another five empty minutes', async () => {
  const world = setup();
  await world.tick();
  await world.tick(3 * MIN);
  world.players[1] = 1;
  await world.tick(MIN);
  world.players[1] = 0;
  await world.tick(MIN);
  await world.tick(4 * MIN);
  assert.equal(world.said.length, 0);
  await world.tick(MIN);
  assert.equal(world.said.length, 1);
});

test('no answer in fifteen minutes saves and shuts the server down, once, and says so', async () => {
  const world = setup();
  await world.tick();
  await world.tick(5 * MIN);
  await world.tick(14 * MIN);
  assert.deepEqual(world.stops, []);
  await world.tick(MIN);
  await settle();
  assert.deepEqual(world.stops, [1]);
  assert.deepEqual(world.notices, [['Alpha', 'Alpha was saved and shut down (nobody answered).']]);
  assert.ok(world.db.prepare("SELECT 1 FROM audit_events WHERE action = 'idle.shutdown' AND actor = 'system'").get());
});

test('with automatic shutdown off, an unanswered prompt comes back hourly and nothing is stopped', async () => {
  const world = setup();
  world.watch.saveSettings({ autoShutdown: false });
  await world.tick();
  await world.tick(5 * MIN);
  await world.tick(59 * MIN);
  assert.equal(world.said.length, 1);
  await world.tick(MIN);
  assert.equal(world.said.length, 2);
  assert.deepEqual(world.stops, []);
});

test('Leave it running clears the prompt, and the server shuts down at the end only if still empty', async () => {
  const world = setup();
  await world.tick();
  await world.tick(5 * MIN);
  const answer = await world.watch.respond(1, 'extend', undefined, { actor: 'push' });
  assert.equal(answer.outcome, 'extended');
  assert.equal(answer.message, 'Alpha stays running for 1 hour more, then shuts down if nobody is on.');
  assert.equal(world.watch.status().pending.length, 0);
  assert.equal(world.watch.status().extended.length, 1);
  await world.tick(59 * MIN);
  assert.deepEqual(world.stops, []);
  world.players[1] = 2;
  await world.tick(2 * MIN);
  assert.deepEqual(world.stops, []);
  assert.equal(world.watch.status().extended.length, 0);
  world.players[1] = 0;
  await world.tick(MIN);
  await world.tick(5 * MIN);
  assert.equal(world.said.length, 2);
  await world.watch.respond(1, 'extend', { value: 2, unit: 'minute' });
  await world.tick(2 * MIN);
  await settle();
  assert.deepEqual(world.stops, [1]);
  assert.match(world.notices[0][1], /the extra time ended with nobody on/);
});

test('an extension keeps the time and unit as chosen, and its message agrees with them', async () => {
  const world = setup();
  const one = await world.watch.respond(1, 'extend', { value: 1, unit: 'minute' });
  assert.match(one.message, /for 1 minute more/);
  const many = await world.watch.respond(1, 'extend', { value: 3, unit: 'hour' });
  assert.match(many.message, /for 3 hours more/);
  await assert.rejects(world.watch.respond(1, 'extend', { value: 0, unit: 'hour' }), /whole number/);
  await assert.rejects(world.watch.respond(1, 'dance'), /Choose Save and shut down/);
});

test('Save and shut down now stops an empty server, and leaves one alone that has players', async () => {
  const world = setup();
  world.players[1] = 2;
  const left = await world.watch.respond(1, 'shutdown');
  assert.equal(left.outcome, 'players');
  assert.deepEqual(world.stops, []);
  world.players[1] = 0;
  const done = await world.watch.respond(1, 'shutdown', {}, { actor: 'telegram' });
  assert.deepEqual([done.outcome, done.message], ['stopping', 'Saving and shutting down Alpha.']);
  await settle();
  assert.deepEqual(world.stops, [1]);
  assert.ok(world.db.prepare("SELECT 1 FROM audit_events WHERE action = 'idle.shutdown' AND actor = 'telegram'").get());
  const again = await world.watch.respond(1, 'shutdown');
  assert.equal(again.outcome, 'not_running');
});

test('an unreadable player list is never taken for an empty server', async () => {
  const world = setup();
  world.players[1] = null;
  await world.tick();
  await world.tick(30 * MIN);
  assert.deepEqual(world.said, []);
  assert.deepEqual(world.stops, []);
  assert.equal(world.logs.filter((line) => /could not ask Alpha/.test(line)).length, 1);
  assert.ok(world.logs.every((line) => !line.includes('adminpw')));
});

test('a server that is stopped, switched off in the settings, or busy with a job is not watched', async () => {
  const world = setup();
  world.running.delete(1);
  world.watch.saveSettings({ serverIds: [1, 2] });
  world.db
    .prepare(
      "INSERT INTO jobs (kind, state, server_id, install_id, created_at, updated_at) VALUES ('backup.create', 'running', 2, 2, 'x', 'x')",
    )
    .run();
  await world.tick();
  await world.tick(60 * MIN);
  assert.deepEqual(world.said, []);
  world.watch.saveSettings({ enabled: false });
  assert.equal(world.watch.settings().enabled, false);
});

test('a saved extension survives a restart of the watch', async () => {
  const world = setup();
  await world.watch.respond(1, 'extend', { value: 1, unit: 'hour' });
  const next = createIdleWatch({
    db: world.db,
    supervisor: { status: () => ({ observedState: 'running' }), stop: async () => {} },
    rcon: async () => 'No Players Connected ',
    getRconPassword: () => '',
  });
  assert.equal(next.status().extended.length, 1);
  assert.equal(next.status().extended[0].name, 'Alpha');
});
