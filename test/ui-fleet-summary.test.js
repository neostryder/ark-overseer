import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetSummary, ringFill, stateTone } from '../public/js/lib/fleet-summary.js';
import { tabFor } from '../public/js/lib/tabs.js';

const server = (observedState, extra = {}) => ({ status: { observedState, ...extra } });

test('a server reads as running, busy, bad or idle', () => {
  assert.equal(stateTone(server('running')), 'running');
  assert.equal(stateTone(server('starting')), 'busy');
  assert.equal(stateTone(server('stopping')), 'busy');
  assert.equal(stateTone(server('crashed')), 'bad');
  assert.equal(stateTone(server('stopped')), 'idle');
  assert.equal(stateTone(server('exited')), 'idle');
  assert.equal(stateTone({}), 'idle');
});

test('a running server held back by the crash guard counts as needing attention', () => {
  assert.equal(stateTone(server('stopped', { crashLoop: true })), 'bad');
  assert.equal(stateTone(server('running', { crashLoop: true })), 'bad');
});

test('the summary counts every server once', () => {
  const summary = fleetSummary([
    server('running'),
    server('running'),
    server('starting'),
    server('crashed'),
    server('stopped'),
    {},
  ]);
  assert.deepEqual(summary, { total: 6, running: 2, busy: 1, bad: 1, idle: 2 });
  assert.deepEqual(fleetSummary(), { total: 0, running: 0, busy: 0, bad: 0, idle: 0 });
});

test('the ring fill is a whole percent and empty for an empty fleet', () => {
  assert.equal(ringFill({ running: 4, total: 5 }), 80);
  assert.equal(ringFill({ running: 1, total: 3 }), 33);
  assert.equal(ringFill({ running: 0, total: 0 }), 0);
});

test('the phone tab bar marks the tab for the current page', () => {
  assert.equal(tabFor('#/'), 'servers');
  assert.equal(tabFor('#/servers/4/backups'), 'servers');
  assert.equal(tabFor('#/clusters/2'), 'clusters');
  assert.equal(tabFor('#/host'), 'host');
  assert.equal(tabFor('#/account'), 'account');
  assert.equal(tabFor('#/jobs'), null);
});
