import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUpdatePoller, updateChecklist } from '../public/js/lib/update.js';

const nowAt = Date.parse('2026-09-29T12:00:00Z');
const before = { startedAt: '2026-09-29T11:59:00Z' };
const progress = (stage, message = 'Copying the new version', step = 'Copy node') => ({
  startedAt: new Date(nowAt).toISOString(),
  at: new Date(nowAt).toISOString(),
  stage,
  message,
  step,
  source: 'checkout',
});

function poller(t, responses, { clock = () => nowAt } = {}) {
  let callback;
  const events = [];
  const instance = createUpdatePoller({
    before,
    startedAt: nowAt,
    fetchVersion: async () => responses.shift(),
    onState: (state) => events.push(state),
    onNoStart: () => events.push({ kind: 'no-start' }),
    onFinish: (after, current) => events.push({ kind: 'finish', after, progress: current }),
    now: clock,
    setIntervalFn: (fn, ms) => {
      assert.equal(ms, 2000);
      callback = fn;
      return 7;
    },
    clearIntervalFn: (id) => assert.equal(id, 7),
  });
  t.after(() => instance.stop());
  return { events, tick: async () => callback() };
}

test('update polling shows live progress and the restart wait after a dropped connection', async (t) => {
  const run = poller(t, [{ progress: progress('installing') }, null]);
  await run.tick();
  await run.tick();
  assert.equal(run.events[0].kind, 'progress');
  assert.equal(run.events[0].progress.message, 'Copying the new version');
  assert.equal(run.events[1].kind, 'restart');
});

test('update polling returns the final success result', async (t) => {
  const after = {
    startedAt: '2026-09-29T12:01:00Z',
    version: '1.2.3',
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    lastUpdate: { ok: true },
  };
  const run = poller(t, [{ ...after, progress: progress('done', 'Update complete') }]);
  await run.tick();
  assert.equal(run.events.at(-1).kind, 'finish');
  assert.equal(run.events.at(-1).after.version, '1.2.3');
});

test('update polling returns a final failure message', async (t) => {
  const after = {
    progress: progress('failed', 'The update request could not be read.'),
    lastUpdate: { ok: false, message: 'The update request could not be read.' },
  };
  const run = poller(t, [after]);
  await run.tick();
  assert.equal(run.events.at(-1).kind, 'finish');
  assert.equal(run.events.at(-1).after.lastUpdate.message, 'The update request could not be read.');
});

test('update polling reports no start after sixty seconds without progress', async (t) => {
  let time = nowAt + 60000;
  const run = poller(t, [], { clock: () => time });
  await run.tick();
  assert.deepEqual(run.events, [{ kind: 'no-start' }]);
  assert.match(
    readFileSync(new URL('../public/js/components/ao-host-settings.js', import.meta.url), 'utf8'),
    /s\.updateNoStart/,
  );
  time += 1;
});

test('update checklist marks the current stage and the page provides retry and waiting text', () => {
  const rows = updateChecklist(progress('installing'));
  assert.equal(rows.filter((row) => row.current).length, 1);
  assert.equal(rows.find((row) => row.current).stage, 'installing');
  const page = readFileSync(new URL('../public/js/components/ao-host-settings.js', import.meta.url), 'utf8');
  assert.match(page, /item\.setAttribute\('aria-current', 'step'\)/);
  assert.match(page, /s\.updateApprovalWaiting/);
  assert.match(page, /s\.updateRestartWaiting/);
  assert.match(page, /s\.tryAgain/);
});
