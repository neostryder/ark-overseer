// A server with real settings files under a temp folder, the drift service on top of them, and a job engine that
// runs its handlers. Nothing here starts a server, SteamCMD or an RCON connection.
import fs from 'node:fs';
import path from 'node:path';
import { createDrift } from '../../src/settings/drift.js';
import { createJobEngine } from '../../src/jobs/engine.js';
import { hashFile } from '../../src/import/phase0.js';
import { restoreWorld, writeTree, NOW } from './restore-world.js';

export const GUS = [
  '[ServerSettings]',
  'XPMultiplier=1.0',
  'TamingSpeedMultiplier=1.0',
  'ServerPassword=secret1',
  'ServerAdminPassword=adminpw',
  'MyOddKey=abc',
  '; a comment',
  '',
  '[SessionSettings]',
  'SessionName=Base',
  'Port=7777',
  '',
].join('\r\n');
export const GAME = [
  '[/script/shootergame.shootergamemode]',
  'MatingIntervalMultiplier=1',
  'PreventBreedingForClassNames=A_C',
  'PreventBreedingForClassNames=B_C',
  '',
].join('\r\n');

export function driftWorld(
  t,
  { running = false, files = { 'GameUserSettings.ini': GUS, 'Game.ini': GAME }, keep = false, hookLimitMs } = {},
) {
  let drift;
  const w = restoreWorld(t, {
    running,
    maps: ['TheIsland_WP'],
    config: false,
    prefix: 'overseer-drift-',
    onSettingsWritten: (server, source) => drift.recordBaseline(server, source),
  });
  writeTree(w.layout.configDir, files);
  if (keep) w.db.prepare('UPDATE servers SET settings_json = \'{"keepSettingsAfterStop":true}\' WHERE id = 1').run();
  const clock = { now: NOW };
  const hashed = [];
  const logs = [];
  // Run inside every full hash, so a test can change the files, or hold a check, at the moment one is being read.
  const hooks = { onHash: null };
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    intervals: [],
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  };
  drift = createDrift({
    db: w.db,
    dataDir: w.dataDir,
    supervisor: w.supervisor,
    rcon: async () => {},
    getRconPassword: () => 'pw',
    now: () => clock.now,
    ops: w.ops,
    hash: async (file) => {
      hashed.push(file);
      if (hooks.onHash) await hooks.onHash(file);
      return hashFile(file);
    },
    log: (line) => logs.push(line),
    timers,
    ...(hookLimitMs === undefined ? {} : { hookLimitMs }),
  });
  const jobs = createJobEngine({ db: w.db, handlers: { ...drift.handlers, ...w.handlers } });
  drift.attach(jobs);
  w.db.prepare("UPDATE jobs SET state = 'succeeded'").run();
  jobs.start();
  t.after(() => jobs.stop({ abort: true }));

  let tick = 0;
  const live = (rel) => path.join(w.layout.configDir, ...rel.split('/'));
  // Writes a settings file and moves its change time on, so the cheap check sees it whatever the file system's
  // time resolution is.
  const write = (rel, text) => {
    writeTree(w.layout.configDir, { [rel]: text });
    const stamp = new Date(Date.parse('2026-02-01T00:00:00.000Z') + ++tick * 1000);
    fs.utimesSync(live(rel), stamp, stamp);
  };
  const read = (rel) => fs.readFileSync(live(rel), 'utf8');
  // Writes a file of the same size and puts its change time back, so only a full hash can tell it changed.
  const writeQuietly = (rel, text) => {
    const before = fs.statSync(live(rel));
    writeTree(w.layout.configDir, { [rel]: text });
    fs.utimesSync(live(rel), before.atime, before.mtime);
  };
  // Replaces text in a settings file.
  const edit = (rel, from, to) => {
    const text = read(rel);
    if (!text.includes(from)) throw new Error(`${from} is not in ${rel}`);
    write(rel, text.replace(from, to));
  };
  const server = () => w.server();
  const baselineRow = () => w.db.prepare('SELECT * FROM settings_baselines WHERE server_id = 1').get();
  const driftRow = () => w.db.prepare('SELECT * FROM settings_drift WHERE server_id = 1').get();
  const baselineFile = (rel) =>
    fs.readFileSync(
      path.join(w.dataDir, 'baselines', 'server-1', 'Config', 'WindowsServer', ...rel.split('/')),
      'utf8',
    );
  // Waits for a job to leave the queue and the running state.
  const finished = async (id) => {
    const deadline = Date.now() + 5000;
    while (['queued', 'running'].includes(jobs.get(id).state) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return jobs.get(id);
  };
  const settingsAudits = (like = 'server.settings.drift_%') => w.audits(like);
  return {
    w,
    drift,
    jobs,
    clock,
    hashed,
    hooks,
    logs,
    timers,
    live,
    write,
    read,
    writeQuietly,
    edit,
    server,
    baselineRow,
    driftRow,
    baselineFile,
    finished,
    settingsAudits,
    check: (options) => drift.checkDrift(server(), options),
    // Takes the baseline from the files as they are, the way a first read does.
    baseline: () => drift.recordBaseline(server(), 'test'),
  };
}
