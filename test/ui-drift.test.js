import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS } from '../public/js/strings.js';
import {
  choiceKey,
  groupDifferences,
  bannerText,
  foundText,
  describeDifference,
  setChoice,
  setAllChoices,
  keepChoices,
  choicesLeft,
  allChosen,
  choiceList,
  choiceSummary,
  actionStates,
  runningNote,
  findResolveJob,
  isBusy,
} from '../public/js/lib/drift.js';
import { DRIFT_MESSAGES } from '../src/settings/drift.js';
import { API_MESSAGES } from '../src/app.js';

const diff = (file, section, key, kind = 'changed', baseline = '1', live = '2', secret = false) => ({
  file,
  section,
  key,
  kind,
  baseline,
  live,
  secret,
});
const LIST = [
  diff('Game.ini', 'Mode', 'Mating', 'changed'),
  diff('GameUserSettings.ini', 'ServerSettings', 'XP', 'changed'),
  diff('GameUserSettings.ini', 'ServerSettings', 'New', 'added', null, '5'),
  diff('GameUserSettings.ini', 'SessionSettings', 'SessionName', 'changed', 'A', 'B'),
  diff('Extra.ini', '', '', 'file_added', null, null),
  diff('gameusersettings.INI', 'serversettings', 'Taming', 'removed', '1', null),
];

test('differences are grouped by file, then section, keeping the order they came in and joining letter cases', () => {
  const groups = groupDifferences(LIST);
  assert.deepEqual(
    groups.map((group) => [
      group.file,
      group.whole?.kind ?? null,
      group.sections.map((s) => [s.name, s.items.map((i) => i.key)]),
    ]),
    [
      ['Game.ini', null, [['Mode', ['Mating']]]],
      [
        'GameUserSettings.ini',
        null,
        [
          ['ServerSettings', ['XP', 'New', 'Taming']],
          ['SessionSettings', ['SessionName']],
        ],
      ],
      ['Extra.ini', 'file_added', []],
    ],
  );
  assert.deepEqual(groupDifferences([]), []);
  assert.deepEqual(groupDifferences(undefined), []);
});

test('the banner counts the settings and says when they were found, and when the server last shut down', () => {
  assert.equal(bannerText(1), '1 setting changed outside ARK Overseer.');
  assert.equal(bannerText(4), '4 settings changed outside ARK Overseer.');
  const iso = '2026-09-28T10:30:00.000Z';
  const time = new Date(iso).toLocaleString();
  assert.equal(foundText(iso, false), `Found ${time}.`);
  assert.equal(foundText(iso, true), `Found ${time}, when the server last shut down.`);
});

test('a difference shows both values, "Not set" for a missing one, and a password only as changed', () => {
  assert.deepEqual(describeDifference(diff('a.ini', 's', 'k')), {
    kind: 'Changed',
    secret: false,
    note: null,
    baseline: '1',
    current: '2',
    baselineMissing: false,
    currentMissing: false,
  });
  const added = describeDifference(diff('a.ini', 's', 'k', 'added', null, '5'));
  assert.deepEqual(
    [added.kind, added.baseline, added.current, added.baselineMissing],
    ['Added outside ARK Overseer', 'Not set', '5', true],
  );
  const removed = describeDifference(diff('a.ini', 's', 'k', 'removed', '1', null));
  assert.deepEqual(
    [removed.kind, removed.current, removed.currentMissing],
    ['Removed outside ARK Overseer', 'Not set', true],
  );
  const secret = describeDifference(diff('a.ini', 's', 'ServerPassword', 'changed', null, null, true));
  assert.deepEqual(secret, {
    kind: 'Changed',
    secret: true,
    note: STRINGS.drift.secretChanged,
    baseline: null,
    current: null,
  });
  const whole = describeDifference(LIST[4]);
  assert.deepEqual([whole.kind, whole.baseline, whole.current], [STRINGS.drift.kinds.file_added, null, null]);
});

test('choices are tracked per setting, whatever the letter case of its file, section or key', () => {
  assert.equal(choiceKey(LIST[5]), 'gameusersettings.ini|serversettings|taming');
  assert.equal(choiceKey(LIST[1]), 'gameusersettings.ini|serversettings|xp');
  let choices = {};
  assert.equal(choicesLeft(LIST, choices), 6);
  choices = setChoice(choices, LIST[0], 'baseline');
  choices = setChoice(choices, LIST[1], 'live');
  assert.equal(choicesLeft(LIST, choices), 4);
  assert.equal(allChosen(LIST, choices), false);
  // Changing a choice replaces it, and does not change the object it started from.
  const before = choices;
  choices = setChoice(choices, LIST[0], 'live');
  assert.equal(before[choiceKey(LIST[0])], 'baseline');
  assert.equal(choices[choiceKey(LIST[0])], 'live');
  const all = setAllChoices(LIST, 'baseline');
  assert.equal(Object.keys(all).length, 6);
  assert.equal(allChosen(LIST, all), true);
  assert.equal(allChosen([], {}), false);
  assert.equal(choicesLeft(undefined, undefined), 0);
});

test('a choice for a setting that no longer differs is dropped, the rest are kept', () => {
  const all = setAllChoices(LIST, 'live');
  const kept = keepChoices(LIST.slice(0, 3), all);
  assert.deepEqual(Object.keys(kept), LIST.slice(0, 3).map(choiceKey));
  assert.deepEqual(keepChoices([], all), {});
  assert.deepEqual(keepChoices(LIST, undefined), {});
});

test('the choices go to the server as a list with the file, section and key of each setting', () => {
  const choices = setChoice(setChoice({}, LIST[0], 'baseline'), LIST[4], 'live');
  assert.deepEqual(choiceList(LIST.slice(0, 1).concat(LIST[4]), choices), [
    { file: 'Game.ini', section: 'Mode', key: 'Mating', choice: 'baseline' },
    { file: 'Extra.ini', section: '', key: '', choice: 'live' },
  ]);
});

test('Apply my choices is enabled only once every setting has a choice, and nothing is while busy or blocked', () => {
  assert.deepEqual(actionStates({ differences: LIST, choices: {}, busy: false, blocked: false }), {
    adopt: true,
    revert: true,
    merge: false,
  });
  const partial = setChoice({}, LIST[0], 'live');
  assert.equal(actionStates({ differences: LIST, choices: partial, busy: false, blocked: false }).merge, false);
  const all = setAllChoices(LIST, 'live');
  assert.equal(actionStates({ differences: LIST, choices: all, busy: false, blocked: false }).merge, true);
  const off = { adopt: false, revert: false, merge: false };
  assert.deepEqual(actionStates({ differences: LIST, choices: all, busy: true, blocked: false }), off);
  assert.deepEqual(actionStates({ differences: LIST, choices: all, busy: false, blocked: true }), off);
  assert.deepEqual(actionStates({ differences: [], choices: {}, busy: false, blocked: false }), off);
  assert.equal(choiceSummary(LIST, partial), '5 still need a choice.');
  assert.equal(choiceSummary(LIST, all), STRINGS.drift.choicesDone);
  assert.equal(choiceSummary([LIST[0]], {}), '1 still needs a choice.');
});

test('a running server gets the note about restarts and ASA writing its values back', () => {
  assert.equal(runningNote(true), STRINGS.drift.runningNote);
  assert.equal(runningNote(false), '');
  assert.match(STRINGS.drift.runningNote, /keeps its current settings until it restarts/);
  assert.match(STRINGS.drift.runningNote, /safest while the server is stopped/);
  assert.match(DRIFT_MESSAGES.serverRunning, /keeps its current settings until it restarts/);
});

test('every string a person reads about changed settings is plain ASCII, with no dash characters', () => {
  const seen = [];
  const walk = (value, where) => {
    if (typeof value === 'string') seen.push([where, value]);
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  walk(STRINGS.drift, 'STRINGS.drift');
  walk(STRINGS.fleet, 'STRINGS.fleet');
  walk(DRIFT_MESSAGES, 'DRIFT_MESSAGES');
  assert.ok(seen.length > 50);
  for (const [where, text] of seen) assert.match(text, /^[\x20-\x7e]*$/, `${where}: ${text}`);
  assert.ok(API_MESSAGES.jobRunning);
});

test('the drift component keeps every visible word in strings.js', () => {
  for (const file of ['components/ao-settings-drift.js', 'lib/drift.js']) {
    const source = fs.readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
    // Text handed to a node or to the dialog is a STRINGS property or a value derived from one, never a quoted sentence.
    assert.doesNotMatch(source, /el\('[a-z0-9]+', '[A-Za-z]/, file);
    assert.doesNotMatch(source, /textContent = '[A-Za-z]/, file);
  }
});

test('only a put-back job is followed on the Settings page, not a backup or a map switch', () => {
  const job = (id, kind, state) => ({ id, kind, state });
  const jobs = [
    job(1, 'server.backup', 'running'),
    job(2, 'server.switch_map', 'queued'),
    job(3, 'server.settings_resolve', 'succeeded'),
    job(4, 'server.settings_resolve', 'running'),
  ];
  assert.equal(findResolveJob(jobs).id, 4);
  assert.equal(findResolveJob(jobs.slice(0, 3)), null);
  assert.equal(findResolveJob([]), null);
  assert.equal(findResolveJob(undefined), null);
});

test('the buttons wait while this page follows a job or the server says another job owns the files', () => {
  assert.equal(isBusy({ following: false, state: { busy: false } }), false);
  assert.equal(isBusy({ following: true, state: {} }), true);
  assert.equal(isBusy({ following: false, state: { busy: true } }), true);
  assert.equal(isBusy({ following: false, state: null }), false);
  // They are switched off, not taken away: the states are all there, all false.
  const all = setAllChoices(LIST, 'live');
  assert.deepEqual(
    actionStates({
      differences: LIST,
      choices: all,
      busy: isBusy({ following: false, state: { busy: true } }),
      blocked: false,
    }),
    { adopt: false, revert: false, merge: false },
  );
});

test('the drift component follows only put-back jobs and reads the state again while another job runs', () => {
  const source = fs.readFileSync(new URL('../public/js/components/ao-settings-drift.js', import.meta.url), 'utf8');
  assert.match(source, /findResolveJob\(/);
  assert.doesNotMatch(source, /jobs\.find\(\(job\) => LIVE/);
  assert.match(source, /isBusy\(\{/);
  assert.match(source, /watchBusy\(\)/);
  assert.match(source, /clearTimeout\(this\.busyTimer\)/);
});
