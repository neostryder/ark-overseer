import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { createSwitchHandlers, checkSwitch, reconcilePendingSwitches, SWITCH_MESSAGES } from '../src/maps/switch.js';
import { PLAYER_MESSAGES } from '../src/scheduler/handlers.js';
import { serverPaths } from '../src/supervisor/launch.js';

const T = '2026-01-01T00:00:00.000Z';
const NOW = Date.parse(T);
const bundled = JSON.parse(fs.readFileSync(new URL('../src/maps/catalog.json', import.meta.url), 'utf8')).maps;
const MOD_MAP = { id: 'ModMap_WP', name: 'A mod map', kind: 'mod', modId: '928102' };
const FOUND = { id: 'Found_WP', name: 'Found map', kind: 'mod', modId: '777', marketplaceUrl: null };
const catalog = { get: () => ({ version: 1, maps: [...bundled, MOD_MAP] }) };
const findMods = () => [FOUND];

// One server on TheIsland_WP with real folders, so a backup has files to copy. The supervisor, the
// warning channel, the clock and the ready check are all stand-ins; nothing here starts a process.
function world(t, { running = true, settings = '{}', folders = ['TheIsland_WP', 'Ragnarok_WP'], config = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installPath = path.join(root, 'ASA');
  for (const map of folders) {
    const saves = path.join(installPath, 'ShooterGame', 'Saved', 'SavedArks', map);
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(saves, `${map}.ark`), `world ${map}`);
  }
  if (config) {
    fs.mkdirSync(serverPaths(installPath).configDir, { recursive: true });
    fs.writeFileSync(serverPaths(installPath).gameUserSettingsPath, '[ServerSettings]\r\n');
  }
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (1, 1, ?, 'installed', ?, ?)",
  ).run(installPath, T, T);
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, rcon_port, settings_json, created_at, updated_at) VALUES (1, 1, 1, 'One', 'TheIsland_WP', 's', 7777, 27020, ?, ?, ?)",
  ).run(settings, T, T);
  db.prepare("INSERT INTO jobs (id, created_at, updated_at, kind, state) VALUES (1, ?, ?, 'x', 'running')").run(T, T);
  const events = [];
  const plan = {
    start: [],
    stop: [],
    ready: [],
    readyOptions: [],
    abortOnSleep: false,
    abortInBackup: false,
    hang: null,
    stopLeavesRunning: false,
    startLeavesStopped: false,
    failRcon: false,
    controller: new AbortController(),
  };
  let inBackup = 0;
  const mapNow = () => db.prepare('SELECT map FROM servers').get().map;
  let state = running ? 'running' : 'stopped';
  const supervisor = {
    status: () => ({ observedState: state, pid: null }),
    stop: async (id) => {
      events.push([
        'stop',
        id,
        mapNow(),
        db
          .prepare('SELECT * FROM pending_switches')
          .all()
          .map((row) => ({ ...row })),
      ]);
      if (plan.hang === 'stop') await new Promise(() => {});
      const outcome = plan.stop.shift();
      if (outcome instanceof Error) throw outcome;
      if (!plan.stopLeavesRunning) state = 'stopped';
    },
    start: async (id) => {
      events.push(['start', id, mapNow()]);
      if (plan.hang === 'start') await new Promise(() => {});
      const outcome = plan.start.shift();
      if (outcome instanceof Error) throw outcome;
      if (plan.startLeavesStopped) plan.startLeavesStopped = false;
      else state = 'running';
    },
  };
  const handlers = createSwitchHandlers({
    db,
    dataDir: path.join(root, 'data'),
    supervisor,
    rcon: async ({ port, command }) => {
      events.push(['rcon', port, command]);
      if (plan.failRcon) throw new Error('connection refused');
    },
    getRconPassword: () => 'pw',
    catalog,
    findMods,
    sleep: async (ms, signal) => {
      events.push(['sleep', ms / 60000]);
      if (plan.abortOnSleep) plan.controller.abort(new Error('cancelled'));
      if (signal.aborted) throw signal.reason;
    },
    now: () => {
      // The second reading of the clock inside a backup comes after the files are copied.
      if (inBackup && ++inBackup === 3) plan.controller.abort(new Error('cancelled'));
      return NOW;
    },
    waitReady: async (options) => {
      plan.readyOptions.push(options);
      events.push(['ready', options.logPath, options.since, options.isAlive()]);
      const outcome = plan.ready.shift();
      if (typeof outcome === 'function') await outcome();
      if (outcome instanceof Error) throw outcome;
      return { ready: true };
    },
  });
  const ctx = (params) => ({
    job: { id: 1, serverId: 1 },
    params,
    signal: plan.controller.signal,
    progress: (fraction, message) => {
      events.push(['progress', message]);
      if (plan.abortInBackup && /backing up/i.test(message)) inBackup = 1;
      if (/Pointing/.test(message)) inBackup = 0;
    },
  });
  const server = () => ({ ...db.prepare('SELECT * FROM servers').get() });
  const backups = () => db.prepare('SELECT id, reason, path FROM backups ORDER BY id').all();
  const audits = () =>
    db
      .prepare("SELECT action, detail_json FROM audit_events WHERE action LIKE 'server.map.%' ORDER BY id")
      .all()
      .map((row) => ({ action: row.action, ...JSON.parse(row.detail_json) }));
  const pending = () =>
    db
      .prepare('SELECT * FROM pending_switches')
      .all()
      .map((row) => ({ ...row }));
  const steps = () => events.filter((event) => event[0] !== 'progress' && event[0] !== 'rcon').map((event) => event[0]);
  return {
    db,
    events,
    plan,
    handlers,
    ctx,
    server,
    backups,
    audits,
    pending,
    steps,
    installPath,
    root,
    setState: (s) => (state = s),
  };
}
const run = (w, params) => w.handlers['server.switch_map'](w.ctx({ mapId: 'Ragnarok_WP', ...params }));
const chat = (message) => `ServerChat ${message}`;

test('a running server is warned, stopped, backed up, moved to the new map, started, and checked for readiness', async (t) => {
  const w = world(t);
  const result = await run(w);
  const backup = w.backups()[0];
  assert.deepEqual(result, { from: 'TheIsland_WP', to: 'Ragnarok_WP', backupId: backup.id, started: true });
  assert.deepEqual(
    w.events
      .filter((event) => event[0] !== 'progress')
      .map((event) => (event[0] === 'stop' ? event.slice(0, 3) : event)),
    [
      ['rcon', 27020, chat(PLAYER_MESSAGES.switchMap(5, 'Ragnarok'))],
      ['sleep', 4],
      ['rcon', 27020, chat(PLAYER_MESSAGES.switchMap(1, 'Ragnarok'))],
      ['sleep', 1],
      ['rcon', 27020, chat(PLAYER_MESSAGES.switching)],
      // The server is stopped, and later started, with the map it had at that moment.
      ['stop', 1, 'TheIsland_WP'],
      ['start', 1, 'Ragnarok_WP'],
      ['ready', serverPaths(w.installPath).logPath, NOW, true],
    ],
  );
  assert.equal(w.server().map, 'Ragnarok_WP');
  assert.equal(w.server().settings_json, '{}');
  // The backup holds the world the server was on, and the settings.
  assert.equal(backup.reason, 'pre_switch');
  const files = JSON.parse(fs.readFileSync(path.join(backup.path, 'snapshot.json'), 'utf8')).files.map(
    (file) => file.path ?? file.relPath ?? file,
  );
  assert.ok(files.some((file) => String(file).includes('SavedArks/TheIsland_WP/TheIsland_WP.ark')));
  assert.ok(!files.some((file) => String(file).includes('Ragnarok_WP')));
  assert.deepEqual(w.audits(), [{ action: 'server.map.switch', from: 'TheIsland_WP', to: 'Ragnarok_WP', jobId: 1 }]);
  assert.match(PLAYER_MESSAGES.switchMap(1, 'Ragnarok'), /^Map change in 1 minute\. .* comes back on Ragnarok\.$/);
  assert.equal(PLAYER_MESSAGES.switching, 'Saving the world and changing the map now.');
  assert.equal(PLAYER_MESSAGES.switchCancelled, 'The map change is off. Keep playing.');
  // Each step is reported.
  const messages = w.events.filter((event) => event[0] === 'progress').map((event) => event[1]);
  assert.ok(messages.some((message) => /backing up/i.test(message)));
  assert.equal(messages.at(-1), 'The server now runs Ragnarok.');
});

test('broadcast and the countdown marks are taken from the job parameters', async (t) => {
  const w = world(t);
  await run(w, { announce: 'broadcast', countdownMinutes: [2] });
  const rcons = w.events.filter((event) => event[0] === 'rcon').map((event) => event[2]);
  assert.deepEqual(rcons, [
    `Broadcast ${PLAYER_MESSAGES.switchMap(2, 'Ragnarok')}`,
    `Broadcast ${PLAYER_MESSAGES.switching}`,
  ]);
});

test('a stopped server is backed up and switched, and left stopped', async (t) => {
  const w = world(t, { running: false });
  const result = await run(w);
  assert.deepEqual(result, { from: 'TheIsland_WP', to: 'Ragnarok_WP', backupId: w.backups()[0].id, started: false });
  assert.deepEqual(w.steps(), []);
  assert.ok(!w.events.some((event) => event[0] === 'rcon'));
  assert.equal(w.server().map, 'Ragnarok_WP');
  assert.equal(w.backups()[0].reason, 'pre_switch');
  assert.equal(
    w.events.filter((event) => event[0] === 'progress').at(-1)[1],
    'The map is set to Ragnarok. The server stays stopped until you start it.',
  );
});

test('a failed backup changes nothing and starts a running server again on its old map', async (t) => {
  const w = world(t, { folders: [], config: false });
  await assert.rejects(run(w), /no save or settings files/);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.backups(), []);
  assert.deepEqual(w.audits(), []);
  assert.deepEqual(w.steps(), ['sleep', 'sleep', 'stop', 'start']);
  assert.equal(w.events.find((event) => event[0] === 'start')[2], 'TheIsland_WP');
  // A stopped server is simply left as it was.
  const stopped = world(t, { running: false, folders: [], config: false });
  await assert.rejects(run(stopped), /no save or settings files/);
  assert.deepEqual(stopped.steps(), []);
  // If it cannot be started again, the failure says so as well.
  const stuck = world(t, { folders: [], config: false });
  stuck.plan.start.push(new Error('launch failed'));
  await assert.rejects(run(stuck), (error) => error.message.endsWith(SWITCH_MESSAGES.restartFailed));
  assert.equal(stuck.server().map, 'TheIsland_WP');
});

test('a start that fails puts the old map back, starts it again and fails the job with the reason', async (t) => {
  const w = world(t);
  w.plan.start.push(new Error('server failed to start after 3 attempt(s): the server process exited during startup'));
  await assert.rejects(run(w), {
    message:
      'The server did not start on Ragnarok: Server failed to start after 3 attempt(s): the server process exited during startup. It is back on The Island.',
  });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(
    w.events.filter((event) => ['stop', 'start', 'ready'].includes(event[0])).map((event) => event.slice(0, 3)),
    [
      ['stop', 1, 'TheIsland_WP'],
      ['start', 1, 'Ragnarok_WP'],
      ['stop', 1, 'Ragnarok_WP'],
      ['start', 1, 'TheIsland_WP'],
      ['ready', serverPaths(w.installPath).logPath, NOW],
    ],
  );
  assert.deepEqual(
    w.audits().map((audit) => audit.action),
    ['server.map.switch', 'server.map.switch_rolled_back'],
  );
  assert.equal(w.backups().length, 1);
});

test('a server that starts but never finishes loading is rolled back the same way', async (t) => {
  const w = world(t);
  w.plan.ready.push(new Error('The server did not finish starting within 20 minutes.'));
  await assert.rejects(run(w), {
    message:
      'The server did not start on Ragnarok: The server did not finish starting within 20 minutes. It is back on The Island.',
  });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.steps(), ['sleep', 'sleep', 'stop', 'start', 'ready', 'stop', 'start', 'ready']);
});

test('when the old map will not start either, the job says so and the map is still the old one', async (t) => {
  const w = world(t);
  w.plan.start.push(new Error('first'), new Error('second'));
  await assert.rejects(run(w), {
    message:
      'The server did not start on Ragnarok or on The Island. Its map is set back to The Island. Check the server log.',
  });
  assert.equal(w.server().map, 'TheIsland_WP');
  // The old map starting but never getting ready is a failed rollback as well.
  const late = world(t);
  late.plan.ready.push(new Error('slow'), new Error('slow again'));
  await assert.rejects(run(late), /Check the server log\.$/);
  assert.equal(late.server().map, 'TheIsland_WP');
  assert.equal(
    SWITCH_MESSAGES.rollbackFailed,
    'The server did not start on {new} or on {old}. Its map is set back to {old}. Check the server log.',
  );
  assert.equal(SWITCH_MESSAGES.rolledBack, 'The server did not start on {new}: {reason} It is back on {old}.');
  assert.equal(SWITCH_MESSAGES.needsMod, '{map} needs mod {modId}.');
});

test('a cancelled countdown tells players, stops nothing and changes nothing', async (t) => {
  const w = world(t);
  w.plan.abortOnSleep = true;
  await assert.rejects(run(w), /cancelled/);
  assert.deepEqual(w.events.at(-1), ['rcon', 27020, chat(PLAYER_MESSAGES.switchCancelled)]);
  assert.deepEqual(w.steps(), ['sleep']);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.backups(), []);
  assert.deepEqual(w.audits(), []);
});

test('a failed in-game warning does not stop the switch', async (t) => {
  const w = world(t);
  w.plan.failRcon = true;
  const result = await run(w, { countdownMinutes: [1] });
  assert.equal(result.started, true);
  assert.match(
    w.events.find((event) => event[0] === 'progress' && /warning/.test(event[1] ?? ''))[1],
    /One did not get the in-game warning/,
  );
  assert.equal(w.server().map, 'Ragnarok_WP');
});

test('a server stopped during the countdown is switched without being started', async (t) => {
  const w = world(t);
  const original = w.events.push.bind(w.events);
  w.events.push = (entry) => {
    if (entry[0] === 'sleep') w.setState('stopped');
    return original(entry);
  };
  const result = await run(w, { countdownMinutes: [1] });
  assert.equal(result.started, false);
  assert.deepEqual(w.steps(), ['sleep']);
  assert.equal(w.server().map, 'Ragnarok_WP');
});

test('a mod map needs its mod in the server list, or the switch adds it when asked to', async (t) => {
  const w = world(t);
  await assert.rejects(run(w, { mapId: 'ModMap_WP' }), { message: 'A mod map needs mod 928102.' });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.steps(), []);
  assert.deepEqual(w.backups(), []);
  const result = await run(w, { mapId: 'ModMap_WP', addMod: true });
  assert.equal(result.to, 'ModMap_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json), { mods: ['928102'] });
  assert.deepEqual(w.audits(), [
    { action: 'server.map.switch', from: 'TheIsland_WP', to: 'ModMap_WP', addedMod: '928102', jobId: 1 },
  ]);
});

test('a mod that is already in the list is not added twice, and other settings are kept', async (t) => {
  const w = world(t, { settings: JSON.stringify({ mods: [928102, '55'], disableBattlEye: true }), running: false });
  await run(w, { mapId: 'ModMap_WP', addMod: true });
  assert.deepEqual(JSON.parse(w.server().settings_json), { mods: [928102, '55'], disableBattlEye: true });
  const other = world(t, { settings: JSON.stringify({ mods: ['55'], disableBattlEye: true }), running: false });
  await run(other, { mapId: 'ModMap_WP', addMod: true });
  assert.deepEqual(JSON.parse(other.server().settings_json), { mods: ['55', '928102'], disableBattlEye: true });
});

test('a mod map found on the install is switchable, and its mod is added the same way', async (t) => {
  const w = world(t, { running: false });
  await assert.rejects(run(w, { mapId: 'Found_WP' }), { message: 'Found map needs mod 777.' });
  await run(w, { mapId: 'found_wp', addMod: true });
  assert.equal(w.server().map, 'Found_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json).mods, ['777']);
});

test('a failed start after adding a mod puts the old mod list back as well', async (t) => {
  const w = world(t, { settings: JSON.stringify({ mods: ['55'] }) });
  const before = w.server().settings_json;
  w.plan.start.push(new Error('launch failed'));
  await assert.rejects(run(w, { mapId: 'ModMap_WP', addMod: true }), /It is back on The Island\.$/);
  assert.equal(w.server().settings_json, before);
  assert.equal(w.server().map, 'TheIsland_WP');
});

test('the current map, an unknown map and a map name with odd characters are refused before anything happens', async (t) => {
  const w = world(t);
  await assert.rejects(run(w, { mapId: 'TheIsland_WP' }), { message: 'The server is already on TheIsland_WP.' });
  await assert.rejects(run(w, { mapId: 'theisland_wp' }), /already on/);
  await assert.rejects(run(w, { mapId: 'Nowhere_WP' }), { message: SWITCH_MESSAGES.badMap });
  for (const bad of ['', '..\\Ragnarok_WP', 'A B', 'x'.repeat(65), null, undefined, 5, ['Ragnarok_WP']])
    await assert.rejects(run(w, { mapId: bad }), { message: SWITCH_MESSAGES.badMap }, String(bad));
  assert.deepEqual(w.steps(), []);
  assert.deepEqual(w.backups(), []);
  assert.equal(w.server().map, 'TheIsland_WP');
});

test('a folder under SavedArks that is not in the catalog can be switched to, spelled as it is on disk', async (t) => {
  const w = world(t, { folders: ['TheIsland_WP', 'Homebrew_WP'], running: false });
  const result = await run(w, { mapId: 'homebrew_wp' });
  assert.equal(result.to, 'Homebrew_WP');
  assert.equal(w.server().map, 'Homebrew_WP');
});

test('a job for a server that is gone fails with a message', async (t) => {
  const w = world(t);
  await assert.rejects(
    w.handlers['server.switch_map']({ ...w.ctx({ mapId: 'Ragnarok_WP' }), job: { id: 1, serverId: 99 } }),
    /server was not found/,
  );
});

test('checkSwitch answers with a code, the map to use and whether a mod will be added', (t) => {
  const w = world(t, { folders: ['TheIsland_WP', 'Homebrew_WP'] });
  const server = { ...w.server(), install_path: w.installPath };
  const check = (mapId, addMod) => checkSwitch({ server, mapId, addMod, catalog, findMods });
  assert.deepEqual(
    { ...check('Ragnarok_WP'), nameOf: undefined },
    {
      ok: true,
      map: { id: 'Ragnarok_WP', name: 'Ragnarok', kind: 'official', modId: null },
      addMod: false,
      nameOf: undefined,
    },
  );
  assert.equal(check('Ragnarok_WP').nameOf('TheIsland_WP'), 'The Island');
  assert.equal(check('Ragnarok_WP').nameOf('Unlisted'), 'Unlisted');
  assert.deepEqual(check('Homebrew_WP').map, { id: 'Homebrew_WP', name: 'Homebrew_WP', kind: null, modId: null });
  assert.deepEqual(check('ModMap_WP'), { ok: false, code: 'needs_mod', modId: '928102', map: 'A mod map' });
  assert.equal(check('ModMap_WP', true).addMod, true);
  // Only a real true counts.
  assert.equal(check('ModMap_WP', 'true').code, 'needs_mod');
  assert.deepEqual(check('TheIsland_WP'), { ok: false, code: 'same_map' });
  assert.deepEqual(check('Nowhere_WP'), { ok: false, code: 'bad_map' });
  const withMod = { ...server, settings_json: { mods: ['928102'] } };
  assert.equal(checkSwitch({ server: withMod, mapId: 'ModMap_WP', catalog, findMods }).addMod, false);
  const brokenSettings = { ...server, settings_json: '{ nope' };
  assert.equal(checkSwitch({ server: brokenSettings, mapId: 'ModMap_WP', catalog, findMods }).code, 'needs_mod');
});

test('the job holds the server and its install: nothing else for either runs in the middle of a switch', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'h', ?, ?)").run(T, T);
  db.prepare(
    "INSERT INTO installs (id, host_id, path, state, created_at, updated_at) VALUES (1, 1, 'C:/ASA', 'installed', ?, ?)",
  ).run(T, T);
  db.prepare(
    "INSERT INTO servers (id, host_id, install_id, name, map, session_name, game_port, created_at, updated_at) VALUES (1, 1, 1, 'One', 'A_WP', 's', 7777, ?, ?)",
  ).run(T, T);
  const log = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const jobs = createJobEngine({
    db,
    handlers: {
      'server.switch_map': async () => {
        log.push('switch start');
        await gate;
        log.push('switch end');
      },
      'server.backup': async () => void log.push('backup'),
      'server.restart': async () => void log.push('restart'),
      'install.auto_update': async () => void log.push('update'),
    },
  });
  t.after(() => jobs.stop({ abort: true }));
  jobs.start();
  jobs.enqueue('server.switch_map', { mapId: 'B_WP' }, { serverId: 1, installId: 1 });
  jobs.enqueue('server.backup', {}, { serverId: 1 });
  jobs.enqueue('server.restart', {}, { serverId: 1 });
  jobs.enqueue('install.auto_update', {}, { installId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(log, ['switch start']);
  release();
  for (let waited = 0; log.length < 5 && waited < 2000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(log[1], 'switch end');
  assert.deepEqual(log.slice(2).sort(), ['backup', 'restart', 'update']);
});

// Starts a switch that stops at `where` and never goes on, as if ARK Overseer had been closed there.
async function cutOff(w, where, params) {
  w.plan.hang = where;
  const pendingRun = run(w, params);
  pendingRun.catch(() => {});
  for (let waited = 0; !w.events.some((event) => event[0] === where) && waited < 2000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    w.events.some((event) => event[0] === where),
    `the switch reached ${where}`,
  );
  // The supervisor records that it was told to stop the server.
  w.db.prepare("UPDATE servers SET desired_state = 'stopped'").run();
}
const failMapUpdates = (w, map) =>
  w.db.exec(
    `CREATE TRIGGER fail_map BEFORE UPDATE OF map ON servers WHEN NEW.map = '${map}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
  );

test('the pending switch is written before the server is stopped, and removed once the switch is settled', async (t) => {
  const w = world(t);
  await run(w);
  const stop = w.events.find((event) => event[0] === 'stop');
  assert.deepEqual(stop[3], [
    {
      server_id: 1,
      job_id: 1,
      from_map: 'TheIsland_WP',
      from_mods_json: '[]',
      to_map: 'Ragnarok_WP',
      was_running: 1,
      created_at: T,
    },
  ]);
  assert.deepEqual(w.pending(), []);
  // A stopped server has its row removed by the same transaction that changes the map.
  const stopped = world(t, { running: false, settings: JSON.stringify({ mods: [55, '66'] }) });
  await run(stopped, { mapId: 'ModMap_WP', addMod: true });
  assert.deepEqual(stopped.pending(), []);
  // Mods already on the server are recorded as they are written.
  const mods = world(t, { settings: JSON.stringify({ mods: [55, '66'], disableBattlEye: true }) });
  await run(mods);
  assert.equal(mods.events.find((event) => event[0] === 'stop')[3][0].from_mods_json, '[55,"66"]');
  assert.deepEqual(mods.pending(), []);
});

test('a stop that fails fails the job before the backup, with the map as it was', async (t) => {
  const w = world(t);
  w.plan.stop.push(new Error('could not check whether the server is running'));
  await assert.rejects(run(w), {
    message:
      'The server could not be stopped, so the map was not changed. Could not check whether the server is running.',
  });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.backups(), []);
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.audits(), []);
  assert.ok(!w.events.some((event) => event[0] === 'start'));
});

test('a map change that cannot be saved starts a running server again on its old map', async (t) => {
  const w = world(t);
  failMapUpdates(w, 'Ragnarok_WP');
  await assert.rejects(run(w), {
    message: 'The map could not be changed, so the server stays on The Island. Disk full.',
  });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(
    w.steps().filter((step) => step !== 'sleep'),
    ['stop', 'start'],
  );
  assert.equal(w.events.find((event) => event[0] === 'start')[2], 'TheIsland_WP');
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.audits(), []);
  // A stopped server is left stopped, and one that cannot be started again says so.
  const stopped = world(t, { running: false });
  failMapUpdates(stopped, 'Ragnarok_WP');
  await assert.rejects(run(stopped), /stays on The Island/);
  assert.deepEqual(stopped.steps(), []);
  assert.deepEqual(stopped.pending(), []);
  const stuck = world(t);
  failMapUpdates(stuck, 'Ragnarok_WP');
  stuck.plan.start.push(new Error('launch failed'));
  await assert.rejects(run(stuck), (error) => error.message.endsWith(SWITCH_MESSAGES.restartFailed));
});

test('a rollback that cannot be saved fails the job, keeps the pending row, and the next start finishes it', async (t) => {
  const w = world(t, { settings: JSON.stringify({ mods: ['55'] }) });
  w.plan.start.push(new Error('launch failed'));
  failMapUpdates(w, 'TheIsland_WP');
  await assert.rejects(run(w, { mapId: 'ModMap_WP', addMod: true }), {
    message:
      'The server did not start on A mod map, and its map could not be set back to The Island. ARK Overseer will try again the next time it starts.',
  });
  // The map is still the new one, and the old server is not started on it a second time.
  assert.equal(w.server().map, 'ModMap_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json), { mods: ['55', '928102'] });
  assert.equal(w.events.filter((event) => event[0] === 'start').length, 1);
  assert.equal(w.pending().length, 1);
  // The next start of ARK Overseer puts the old map and mods back and lets the supervisor start it.
  w.db.exec('DROP TRIGGER fail_map');
  w.db.prepare("UPDATE servers SET desired_state = 'stopped'").run();
  assert.deepEqual(reconcilePendingSwitches({ db: w.db, now: () => NOW }), [
    { serverId: 1, wasRunning: true, changed: true },
  ]);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json), { mods: ['55'] });
  assert.equal(w.server().desired_state, 'running');
  assert.deepEqual(w.pending(), []);
});

test('a restart after the server was stopped puts a running server back on its old map', async (t) => {
  const w = world(t);
  await cutOff(w, 'stop');
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.equal(w.pending().length, 1);
  assert.deepEqual(reconcilePendingSwitches({ db: w.db, now: () => NOW }), [
    { serverId: 1, wasRunning: true, changed: false },
  ]);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.equal(w.server().desired_state, 'running');
  assert.deepEqual(w.pending(), []);
  assert.deepEqual(w.audits(), [
    {
      action: 'server.map.switch_rolled_back',
      from: 'Ragnarok_WP',
      to: 'TheIsland_WP',
      reason: 'interrupted',
      jobId: 1,
    },
  ]);
  const audit = w.db
    .prepare("SELECT actor, created_at FROM audit_events WHERE action = 'server.map.switch_rolled_back'")
    .get();
  assert.deepEqual({ ...audit }, { actor: 'system', created_at: T });
  // Nothing is left to do the second time.
  assert.deepEqual(reconcilePendingSwitches({ db: w.db }), []);
});

test('a restart after the map changed puts the old map and mods back, and starts only what was running', async (t) => {
  const w = world(t, { settings: JSON.stringify({ mods: [55], disableBattlEye: true }) });
  await cutOff(w, 'start', { mapId: 'ModMap_WP', addMod: true });
  assert.equal(w.server().map, 'ModMap_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json).mods, [55, '928102']);
  assert.deepEqual(reconcilePendingSwitches({ db: w.db, now: () => NOW }), [
    { serverId: 1, wasRunning: true, changed: true },
  ]);
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(JSON.parse(w.server().settings_json), { mods: [55], disableBattlEye: true });
  assert.equal(w.server().desired_state, 'running');
  assert.deepEqual(w.pending(), []);
  // A server that was stopped when the switch began is not told to run.
  const stopped = world(t, { running: false });
  stopped.plan.hang = null;
  stopped.db
    .prepare(
      "INSERT INTO pending_switches (server_id, job_id, from_map, from_mods_json, to_map, was_running, created_at) VALUES (1, 1, 'TheIsland_WP', '[]', 'Ragnarok_WP', 0, ?)",
    )
    .run(T);
  stopped.db.prepare("UPDATE servers SET map = 'Ragnarok_WP'").run();
  assert.deepEqual(reconcilePendingSwitches({ db: stopped.db }), [{ serverId: 1, wasRunning: false, changed: true }]);
  assert.equal(stopped.server().map, 'TheIsland_WP');
  assert.equal(stopped.server().desired_state, 'stopped');
});

test('a cancel that arrives before the map changes leaves it alone, even for a stopped server', async (t) => {
  const stopped = world(t, { running: false });
  stopped.plan.abortInBackup = true;
  await assert.rejects(run(stopped), /cancelled/);
  assert.equal(stopped.server().map, 'TheIsland_WP');
  assert.deepEqual(stopped.audits(), []);
  assert.deepEqual(stopped.pending(), []);
  assert.deepEqual(stopped.steps(), []);
  // A running server goes back up on the old map.
  const running = world(t);
  running.plan.abortInBackup = true;
  await assert.rejects(run(running), /cancelled/);
  assert.equal(running.server().map, 'TheIsland_WP');
  assert.equal(running.events.filter((event) => event[0] === 'start').at(-1)[2], 'TheIsland_WP');
  assert.deepEqual(running.pending(), []);
  assert.deepEqual(running.audits(), []);
});

test('a job cancelled while the world loads does not report success', async (t) => {
  // Cancelled and the wait ends in failure: the old map is put back, and the job fails with the cancel.
  const w = world(t);
  w.plan.ready.push(() => {
    w.plan.controller.abort(new Error('cancelled'));
    throw w.plan.controller.signal.reason;
  });
  await assert.rejects(run(w), { message: 'cancelled' });
  assert.equal(w.server().map, 'TheIsland_WP');
  assert.deepEqual(w.pending(), []);
  assert.equal(w.events.filter((event) => event[0] === 'ready').length, 1);
  // Cancelled in the moment the world finished loading: the map stays, and the job still does not succeed.
  const late = world(t);
  late.plan.ready.push(() => late.plan.controller.abort(new Error('cancelled')));
  await assert.rejects(run(late), { message: 'cancelled' });
  assert.equal(late.server().map, 'Ragnarok_WP');
  assert.deepEqual(late.pending(), []);
});

test('a start that leaves the old process running, or leaves nothing running, is not trusted', async (t) => {
  const already = world(t);
  already.plan.stopLeavesRunning = true;
  await assert.rejects(run(already), /Its map is set back to The Island/);
  assert.ok(!already.events.some((event) => event[0] === 'start'));
  assert.equal(already.server().map, 'TheIsland_WP');
  assert.ok(!already.events.some((event) => event[0] === 'ready'));
  const nothing = world(t);
  nothing.plan.startLeavesStopped = true;
  await assert.rejects(
    run(nothing),
    /did not start on Ragnarok: The server was not running after ARK Overseer started it\./,
  );
  assert.equal(nothing.events.filter((event) => event[0] === 'ready').length, 1);
});

test('the log is noted before the start so the ready check can tell the old run from the new one', async (t) => {
  const w = world(t);
  const logPath = serverPaths(w.installPath).logPath;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, 'the previous run');
  await run(w);
  const [options] = w.plan.readyOptions;
  assert.equal(options.marker.size, 'the previous run'.length);
  assert.equal(options.marker.ino, fs.statSync(logPath).ino);
  const none = world(t);
  await run(none);
  assert.equal(none.plan.readyOptions[0].marker, null);
});

test('rollback and audit times come from the clock the job was given, and an empty reason reads well', async (t) => {
  const w = world(t);
  w.plan.ready.push(new Error(''));
  await assert.rejects(run(w), { message: 'The server did not start on Ragnarok. It is back on The Island.' });
  const stamps = w.db.prepare("SELECT created_at FROM audit_events WHERE action LIKE 'server.map.%'").all();
  assert.deepEqual(
    stamps.map((row) => row.created_at),
    [T, T],
  );
  assert.equal(w.server().updated_at, T);
});
