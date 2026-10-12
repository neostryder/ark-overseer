import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createPush, EVENTS } from '../src/push/push.js';

const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const sub = (id) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: KEYS });

function setup(overrides = {}) {
  const db = openDatabase(':memory:');
  const sent = [];
  const fetchFn = async (url) => (sent.push(url), { ok: true, status: 201 });
  let clock = 1_000_000;
  const push = createPush({ db, fetchFn, now: () => clock, ...overrides });
  return { db, push, sent, tick: (ms) => (clock += ms) };
}

test('the key pair is made once and kept', () => {
  const { push, db } = setup();
  const first = push.publicKey();
  assert.equal(first.length, 87);
  assert.equal(setup({ db }).push.publicKey(), first);
});

test('a device subscribes, changes its alert types, and unsubscribes', () => {
  const { push } = setup();
  assert.equal(push.state(sub('a').endpoint), null);
  assert.deepEqual(push.subscribe(sub('a'), undefined, undefined), { events: EVENTS });
  assert.deepEqual(push.subscribe(sub('a'), ['build'], undefined), { events: ['build'] });
  assert.deepEqual(push.state(sub('a').endpoint), { events: ['build'] });
  assert.equal(push.unsubscribe(sub('a').endpoint), true);
  assert.equal(push.unsubscribe(sub('a').endpoint), false);
});

test('a subscription to anything but a browser push service is refused', () => {
  const { push } = setup();
  assert.throws(() => push.subscribe({ endpoint: 'https://evil.example/x', keys: KEYS }), /cannot use/);
  assert.throws(
    () => push.subscribe({ endpoint: sub('a').endpoint, keys: { p256dh: 'AAAA', auth: 'BB' } }),
    /cannot use/,
  );
  assert.throws(() => push.subscribe(sub('a'), ['nonsense']), /alert types/);
});

test('an alert goes only to the devices that asked for that type', async () => {
  const { push, sent } = setup();
  push.subscribe(sub('crashes'), ['crash']);
  push.subscribe(sub('builds'), ['build']);
  push.subscribe(sub('muted'), []);
  const result = await push.notifyBuilds([{ branch: 'public', buildId: '1' }]);
  assert.deepEqual(result, { devices: 1, delivered: 1 });
  assert.deepEqual(sent, [sub('builds').endpoint]);
});

test('a server that keeps crashing sends one alert in the quiet period', async () => {
  const { push, sent, tick } = setup();
  push.subscribe(sub('a'), ['crash']);
  await push.notifyCrash({ id: 1, name: 'Neo Olympus' }, 'exit');
  await push.notifyCrash({ id: 1, name: 'Neo Olympus' }, 'exit');
  assert.equal(sent.length, 1);
  await push.notifyCrash({ id: 2, name: 'Other' }, 'exit');
  assert.equal(sent.length, 2);
  tick(11 * 60 * 1000);
  await push.notifyCrash({ id: 1, name: 'Neo Olympus' }, 'crash loop');
  assert.equal(sent.length, 3);
});

test('a subscription the push service no longer knows is forgotten', async () => {
  const gone = async () => ({ ok: false, status: 410 });
  const { push } = setup({ fetchFn: gone });
  push.subscribe(sub('a'), ['crash']);
  const result = await push.notifyCrash({ id: 1, name: 'x' }, 'exit');
  assert.deepEqual(result, { devices: 1, delivered: 0 });
  assert.equal(push.state(sub('a').endpoint), null);
});

test('a failing push service is logged and does not stop the other devices', async () => {
  const logged = [];
  const fetchFn = async (url) => {
    if (url.endsWith('/bad')) throw new Error('network down');
    return { ok: true, status: 201 };
  };
  const { push } = setup({ fetchFn, log: (line) => logged.push(line) });
  push.subscribe(sub('bad'), ['crash']);
  push.subscribe(sub('good'), ['crash']);
  const result = await push.notifyCrash({ id: 1, name: 'x' }, 'exit');
  assert.deepEqual(result, { devices: 2, delivered: 1 });
  assert.match(logged.join('\n'), /network down/);
});

test('the test alert reaches a subscribed device and refuses an unknown one', async () => {
  const { push, sent } = setup();
  push.subscribe(sub('a'), []);
  assert.deepEqual(await push.test(sub('a').endpoint), { delivered: true });
  assert.equal(sent.length, 1);
  await assert.rejects(() => push.test(sub('zzz').endpoint), /not subscribed/);
});
