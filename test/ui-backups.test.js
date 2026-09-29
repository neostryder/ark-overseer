import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../public/js/strings.js';
import {
  isSafety,
  canDelete,
  dayKey,
  groupByDay,
  availableScopes,
  firstScope,
  filterPlayers,
  limitRows,
  PICKER_LIMIT,
  confirmLabel,
  includesWorld,
  describeMarks,
  countdownMarks,
  restoreNotes,
  countDifferences,
  SCOPES,
  DEFAULT_MARKS,
} from '../public/js/lib/backups.js';
import { RESTORE_MESSAGES } from '../src/backups/restore.js';
import { SNAPSHOT_MESSAGES } from '../src/backups/settings-snapshots.js';
import { API_MESSAGES } from '../src/backups/api.js';
import { MESSAGES as READ_MESSAGES } from '../src/backups/read.js';
import { MESSAGES as SWAP_MESSAGES } from '../src/backups/swap.js';
import { PLAYER_MESSAGES } from '../src/scheduler/handlers.js';

// A time on a given local day, so the grouping does not depend on the time zone the tests run in.
const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test('only the backups ARK Overseer takes before it replaces files are safety backups, and only two kinds can be deleted', () => {
  assert.deepEqual(
    ['manual', 'scheduled', 'pre_update', 'pre_restore', 'pre_import', 'pre_rollback', 'pre_switch'].map(isSafety),
    [false, false, false, true, false, false, true],
  );
  assert.deepEqual(
    ['manual', 'scheduled', 'pre_update', 'pre_restore', 'pre_import', 'pre_rollback', 'pre_switch'].map(canDelete),
    [true, true, false, false, false, false, false],
  );
});

test('backups are grouped by local day, newest day first and newest backup first within a day', () => {
  const backups = [
    { id: 1, created_at: local(2026, 3, 1, 8) },
    { id: 2, created_at: local(2026, 3, 2, 9) },
    { id: 3, created_at: local(2026, 3, 2, 23, 30) },
    { id: 4, created_at: local(2026, 3, 1, 8) },
    { id: 5, created_at: local(2026, 2, 28, 22) },
  ];
  const groups = groupByDay(backups);
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.map((item) => item.id)]),
    [
      ['2026-03-02', [3, 2]],
      ['2026-03-01', [4, 1]],
      ['2026-02-28', [5]],
    ],
  );
  assert.ok(groups[0].date instanceof Date);
  assert.equal(dayKey(local(2026, 1, 5, 0, 5)), '2026-01-05');
  assert.deepEqual(groupByDay([]), []);
  // The list given is not reordered.
  assert.deepEqual(
    backups.map((item) => item.id),
    [1, 2, 3, 4, 5],
  );
});

test('the scopes a backup can serve follow what it holds', () => {
  const both = { worldFiles: 6, settingsFiles: 2, profiles: [{ id: '1' }], tribes: [] };
  assert.deepEqual(availableScopes(both), { everything: true, world: true, settings: true, players: true });
  assert.deepEqual(availableScopes({ ...both, profiles: [], tribes: [] }), {
    everything: true,
    world: true,
    settings: true,
    players: false,
  });
  const settingsOnly = { worldFiles: 0, settingsFiles: 2, profiles: [], tribes: [] };
  assert.deepEqual(availableScopes(settingsOnly), { everything: true, world: false, settings: true, players: false });
  assert.deepEqual(availableScopes({ worldFiles: 0, settingsFiles: 0, profiles: [], tribes: [] }), {
    everything: false,
    world: false,
    settings: false,
    players: false,
  });
  assert.deepEqual(availableScopes(null), { everything: false, world: false, settings: false, players: false });
  assert.equal(firstScope(availableScopes(both)), 'everything');
  assert.equal(firstScope({ everything: false, world: false, settings: true, players: false }), 'settings');
  assert.equal(firstScope({ everything: false, world: false, settings: false, players: false }), 'everything');
  assert.deepEqual(SCOPES, ['everything', 'world', 'settings', 'players']);
});

test('the player filter matches part of an id without regard to letter case', () => {
  const list = [{ id: '0002AB' }, { id: '0003cd' }, { id: '99' }];
  assert.deepEqual(filterPlayers(list, 'ab'), [{ id: '0002AB' }]);
  assert.deepEqual(filterPlayers(list, ' 00 '), [{ id: '0002AB' }, { id: '0003cd' }]);
  assert.deepEqual(filterPlayers(list, ''), list);
  assert.deepEqual(filterPlayers(list, undefined), list);
  assert.deepEqual(filterPlayers(list, 'zz'), []);
});

test('the confirm button names the action, and the countdown reads as minutes', () => {
  assert.deepEqual(SCOPES.map(confirmLabel), [
    'Restore everything',
    'Restore the world',
    'Restore the settings',
    'Restore the chosen files',
  ]);
  assert.equal(confirmLabel('nonsense'), 'Restore everything');
  assert.equal(describeMarks([5, 1]), '5 and 1 minutes');
  assert.equal(describeMarks([10, 5, 1]), '10, 5 and 1 minutes');
  assert.equal(describeMarks([1]), '1 minute');
  assert.equal(describeMarks([15]), '15 minutes');
  assert.equal(describeMarks([]), '5 and 1 minutes');
  assert.equal(describeMarks(undefined), '5 and 1 minutes');
  assert.deepEqual(
    countdownMarks([
      { kind: 'backup', options: {} },
      { kind: 'restart', options: { countdownMinutes: [15, 3] } },
    ]),
    [15, 3],
  );
  assert.deepEqual(countdownMarks([{ kind: 'restart', options: {} }]), DEFAULT_MARKS);
  assert.deepEqual(countdownMarks([]), DEFAULT_MARKS);
  assert.deepEqual(countdownMarks(undefined), DEFAULT_MARKS);
  assert.deepEqual([includesWorld('world'), includesWorld('players'), includesWorld('settings')], [true, true, false]);
});

test('the dialog says what is replaced, that a safety backup comes first, and what happens to the server', () => {
  const base = {
    backupMap: 'TheIsland_WP',
    currentMap: 'TheIsland_WP',
    mapLabel: 'The Island',
    currentLabel: 'The Island',
  };
  const running = restoreNotes({ ...base, scope: 'world', running: true, marks: [5, 1] });
  assert.deepEqual(running, [
    'Restoring replaces the world save for The Island with the one in this backup.',
    'A safety backup of what it replaces is taken first, so this can be undone.',
    'The server is running. Players get a warning 5 and 1 minutes before it stops, and it starts again on the restored files.',
    'If the server does not start on the restored files, the earlier files are put back.',
  ]);
  const stopped = restoreNotes({ ...base, scope: 'settings', running: false, marks: [5, 1] });
  assert.equal(stopped[0], "Restoring replaces the server's settings files with the ones in this backup.");
  assert.equal(stopped[2], 'The server is stopped and stays stopped.');
  assert.equal(stopped.length, 3);
  assert.match(
    restoreNotes({ ...base, scope: 'everything', running: false, marks: [] })[0],
    /world save for The Island and the server's settings files/,
  );
  assert.match(
    restoreNotes({ ...base, scope: 'players', running: false, marks: [] })[0],
    /chosen player and tribe files/,
  );
});

test('a backup of another map says the server keeps its own, but only when the world is restored', () => {
  const other = {
    backupMap: 'Ragnarok_WP',
    currentMap: 'TheIsland_WP',
    mapLabel: 'Ragnarok',
    currentLabel: 'The Island',
    running: false,
    marks: [],
  };
  const note =
    'This backup is of Ragnarok, and the server launches The Island. The restored world is used the next time the server runs Ragnarok.';
  for (const scope of ['everything', 'world', 'players'])
    assert.equal(restoreNotes({ ...other, scope }).at(-1), note, scope);
  assert.ok(!restoreNotes({ ...other, scope: 'settings' }).includes(note));
  // The same map in another letter case is the same map.
  assert.ok(!restoreNotes({ ...other, scope: 'world', currentMap: 'ragnarok_wp' }).includes(note));
  assert.ok(!restoreNotes({ ...other, scope: 'world', backupMap: null }).includes(note));
});

test('a comparison counts one difference per key, and one per file that differs as a whole', () => {
  assert.equal(countDifferences({ files: [] }), 0);
  assert.equal(countDifferences(undefined), 0);
  assert.equal(
    countDifferences({
      files: [
        {
          file: 'Game.ini',
          sections: [
            { added: [1], removed: [1, 2], changed: [1] },
            { added: [], removed: [], changed: [1] },
          ],
        },
        { file: 'notes.txt', sections: [] },
      ],
    }),
    6,
  );
});

test('every string a person reads on this page or in these jobs is plain ASCII, with no dash characters', () => {
  const seen = [];
  const walk = (value, where) => {
    if (typeof value === 'string') seen.push([where, value]);
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  walk(STRINGS.backups, 'STRINGS.backups');
  walk(STRINGS.automation, 'STRINGS.automation');
  walk(RESTORE_MESSAGES, 'RESTORE_MESSAGES');
  walk(SNAPSHOT_MESSAGES, 'SNAPSHOT_MESSAGES');
  walk(API_MESSAGES, 'API_MESSAGES');
  walk(READ_MESSAGES, 'READ_MESSAGES');
  walk(SWAP_MESSAGES, 'SWAP_MESSAGES');
  for (const key of ['restore', 'restoring', 'restoreCancelled'])
    seen.push([
      `PLAYER_MESSAGES.${key}`,
      typeof PLAYER_MESSAGES[key] === 'function' ? PLAYER_MESSAGES[key](2, 'world') : PLAYER_MESSAGES[key],
    ]);
  assert.ok(seen.length > 100);
  for (const [where, text] of seen) assert.match(text, /^[\x20-\x7e]*$/, `${where}: ${text}`);
});

test('a player column draws at most 200 matching rows and says how many match', () => {
  const list = Array.from({ length: 450 }, (_, index) => ({ id: String(1000 + index) }));
  assert.equal(PICKER_LIMIT, 200);
  const all = limitRows(filterPlayers(list, ''));
  assert.deepEqual([all.rows.length, all.total], [200, 450]);
  assert.deepEqual(all.rows[0], { id: '1000' });
  assert.deepEqual(all.rows[199], { id: '1199' });
  // Narrowing the filter brings the ones beyond the first 200 into view, and only then is nothing left out.
  const narrow = limitRows(filterPlayers(list, '14'));
  assert.deepEqual([narrow.rows.length, narrow.total], [64, 64]);
  assert.equal(filterPlayers(list, '14').length, 64);
  assert.deepEqual(limitRows([]), { rows: [], total: 0 });
  assert.equal(limitRows(list, 3).rows.length, 3);
  assert.match(
    STRINGS.backups.moreMatches,
    /^Showing the first {shown} of {total}. Type in the filter to narrow the list.$/,
  );
});
