import test from 'node:test';
import assert from 'node:assert/strict';
import { listMarks, runningServers, shortcutAction, SHORTCUT_COUNTDOWN } from '../public/js/lib/shortcuts.js';
import { parseRoute } from '../public/js/lib/route.js';

const server = (observedState) => ({ status: { observedState } });

test('a shortcut link names one known action', () => {
  assert.equal(shortcutAction('#/servers?action=restart-all'), 'restart-all');
  assert.equal(shortcutAction('#/servers?action=backup-all'), 'backup-all');
  assert.equal(shortcutAction('#/servers?action=wipe'), null);
  assert.equal(shortcutAction('#/servers'), null);
  assert.equal(shortcutAction('#/clusters?action=restart-all'), null);
  assert.equal(shortcutAction(undefined), null);
});

test('a shortcut link still opens the Servers page', () => {
  assert.deepEqual(parseRoute('#/servers?action=restart-all'), { screen: 'servers' });
  assert.deepEqual(parseRoute('#/servers'), { screen: 'servers' });
  assert.deepEqual(parseRoute('#/servers/3/overview'), { screen: 'overview', id: 3 });
});

test('restart all covers only the servers that are running', () => {
  const list = [server('running'), server('starting'), server('stopped'), server('crashed'), server('running')];
  assert.equal(runningServers(list).length, 2);
  assert.equal(runningServers().length, 0);
});

test('the countdown marks read as a list', () => {
  assert.equal(listMarks(SHORTCUT_COUNTDOWN), '10, 5, and 1');
  assert.equal(listMarks([5, 1]), '5 and 1');
  assert.equal(listMarks([1]), '1');
});
