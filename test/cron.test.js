import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseCron, nextRun, describeCron } from '../src/scheduler/cron.js';

test('cron parses wildcards, numbers, ranges, lists and steps in all fields', () => {
  assert.deepEqual(parseCron('1,5-8/2 */6 1-3 2,4 0,7').minutes, [1, 5, 7]);
  assert.deepEqual(parseCron('1,5-8/2 */6 1-3 2,4 0,7').hours, [0, 6, 12, 18]);
  assert.deepEqual(parseCron('1,5-8/2 */6 1-3 2,4 0,7').weekdays, [0]);
  assert.equal(parseCron('* * * * *').dayOfMonthAny, true);
  for (const [expr, text] of [
    ['60 * * * *', /Minute must/],
    ['* 24 * * *', /Hour must/],
    ['* * 0 * *', /Day of month must/],
    ['* * * 13 *', /Month must/],
    ['* * * * 8', /Day of week must/],
  ])
    assert.throws(() => parseCron(expr), text);
});

test('nextRun finds daily, interval, weekly, month boundaries and cron either-day matches', () => {
  const start = Date.parse('2026-01-01T00:01:00');
  assert.equal(new Date(nextRun('0 2 * * *', start)).getHours(), 2);
  assert.equal(new Date(nextRun('0 */6 * * *', start)).getHours(), 6);
  assert.equal(new Date(nextRun('0 1 * * 5', start)).getDay(), 5);
  assert.equal(new Date(nextRun('0 0 1 * *', Date.parse('2026-01-31T23:59:00'))).getDate(), 1);
  assert.equal(new Date(nextRun('0 0 13 * 5', Date.parse('2026-01-13T00:01:00'))).getDate(), 16);
  assert.equal(new Date(nextRun('0 0 31 * *', Date.parse('2026-04-30T23:59:00'))).getMonth(), 4);
  assert.equal(new Date(nextRun('0 0 1 1 *', Date.parse('2026-12-31T23:59:00'))).getFullYear(), 2027);
  assert.equal(nextRun('0 0 31 2 *', start), null);
});

test('describeCron recognizes picker patterns only', () => {
  assert.deepEqual(describeCron('5 2 * * *'), { kind: 'daily', hour: 2, minute: 5 });
  assert.deepEqual(describeCron('5 */6 * * *'), { kind: 'everyHours', hours: 6, minute: 5 });
  assert.deepEqual(describeCron('5 2 * * 3'), { kind: 'weekly', weekday: 3, hour: 2, minute: 5 });
  assert.equal(describeCron('0 0 1 * *'), null);
  assert.equal(describeCron('nonsense'), null);
});

test('DST gaps are skipped and repeated hours run once in local time', () => {
  const moduleUrl = new URL('../src/scheduler/cron.js', import.meta.url).href;
  const script = `import { nextRun } from ${JSON.stringify(moduleUrl)}; const a = new Date(2026, 2, 8, 1, 0).getTime(); const b = new Date(2026, 10, 1, 0, 0).getTime(); console.log(JSON.stringify([new Date(nextRun('30 2 * * *', a)).toString(), new Date(nextRun('30 1 * * *', b)).toString(), new Date(nextRun('30 1 * * *', new Date(2026, 10, 1, 1, 30).getTime())).toString()]));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true,
    env: { ...process.env, TZ: 'America/New_York' },
    encoding: 'utf8',
  });
  const values = JSON.parse(output);
  assert.match(values[0], /Mar 09 2026 02:30/);
  assert.match(values[1], /Sun Nov 01 2026 01:30:00 GMT-0400/);
  assert.match(values[2], /Mon Nov 02 2026 01:30:00 GMT-0500/);
});

test('a step from a single number runs from that number to the end of the field', () => {
  assert.deepEqual(parseCron('5/15 * * * *').minutes, [5, 20, 35, 50]);
  assert.deepEqual(parseCron('0 3/8 * * *').hours, [3, 11, 19]);
  assert.throws(() => parseCron('*/0 * * * *'), /Minute must/);
});
