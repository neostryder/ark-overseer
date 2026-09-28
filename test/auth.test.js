import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import { openDatabase } from '../src/db/index.js';
import {
  AUTH_MESSAGES,
  createAuth,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  originAllowed,
  isLoopbackSocket,
  hostAllowed,
} from '../src/auth/auth.js';

const DAY = 86400000;
const PASSWORD = 'correct horse battery';

function request(cookie = '', { host = 'localhost:3310', address = '127.0.0.1' } = {}) {
  return { headers: { cookie, host }, socket: { remoteAddress: address } };
}
function response() {
  return {
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
  };
}
const cookieOf = (res) => res.headers['Set-Cookie'].split(';')[0];

function harness(t, start = 1_000_000) {
  const clock = { now: start };
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth({ db, now: () => clock.now });
  return { db, auth, clock };
}
async function setUp(h) {
  const res = response();
  await h.auth.routes.setup({ req: request(), res, body: { password: PASSWORD } });
  return cookieOf(res);
}
const signIn = async (h, body, req = request()) => {
  const res = response();
  await h.auth.routes.login({ req, res, body });
  return res;
};

test('a stored hash verifies the right password only', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.equal(stored.split('$').slice(0, 4).join('$'), 'scrypt$32768$8$1');
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
  for (const bad of ['not$a$scrypt$hash', 'scrypt$x$8$1$aa$bb', '', null])
    assert.equal(await verifyPassword(PASSWORD, bad), false);
});

test('a signed session fails after expiry, after tampering and under another secret', () => {
  const secret = crypto.randomBytes(32);
  const payload = { uid: 1, iat: 100, exp: 200, rem: true };
  const token = signSession(secret, payload);
  assert.deepEqual(verifySession(secret, token, 150), payload);
  assert.equal(verifySession(secret, token, 200), null);
  assert.equal(verifySession(secret, `${token}x`, 150), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, uid: 2 })).toString('base64url');
  assert.equal(verifySession(secret, `${forged}.${mac}`, 150), null);
  assert.equal(verifySession(secret, body, 150), null);
  assert.equal(verifySession(crypto.randomBytes(32), token, 150), null);
});

test('a remembered session is renewed once it is a day old', async (t) => {
  const h = harness(t);
  const cookie = await setUp(h);
  const early = response();
  assert.ok(await h.auth.identify(request(cookie), early));
  assert.equal(early.headers['Set-Cookie'], undefined);
  h.clock.now += DAY + 1;
  const later = response();
  assert.ok(await h.auth.identify(request(cookie), later));
  assert.match(later.headers['Set-Cookie'], /Max-Age=7776000/);
});

test('a session without "remember" lasts 12 hours and is not renewed', async (t) => {
  const h = harness(t);
  await setUp(h);
  const res = await signIn(h, { password: PASSWORD, remember: false });
  assert.doesNotMatch(res.headers['Set-Cookie'], /Max-Age/);
  h.clock.now += 11 * 60 * 60 * 1000;
  const mid = response();
  assert.ok(await h.auth.identify(request(cookieOf(res)), mid));
  assert.equal(mid.headers['Set-Cookie'], undefined);
  h.clock.now += 2 * 60 * 60 * 1000;
  assert.equal(await h.auth.identify(request(cookieOf(res))), null);
});

test('the Origin check allows the same host and refuses another site', () => {
  assert.equal(originAllowed({ origin: 'http://localhost:3310', host: 'localhost:3310' }), true);
  assert.equal(originAllowed({ origin: 'https://elsewhere.test', host: 'localhost:3310' }), false);
  assert.equal(originAllowed({ origin: 'http://localhost:9999', host: 'localhost:3310' }), false);
  assert.equal(originAllowed({ origin: 'not a url', host: 'localhost:3310' }), false);
  assert.equal(originAllowed({ secFetchSite: 'same-origin', host: 'localhost' }), true);
  assert.equal(originAllowed({ secFetchSite: 'cross-site', host: 'localhost' }), false);
  // A client that is not a browser sends neither header.
  assert.equal(originAllowed({ host: 'localhost' }), true);
});

test('only loopback socket addresses count as this computer', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    assert.equal(isLoopbackSocket({ socket: { remoteAddress: address } }), true);
  for (const address of ['192.0.2.1', '::ffff:192.0.2.1', undefined])
    assert.equal(isLoopbackSocket({ socket: { remoteAddress: address } }), false);
});

test('the Host header must name this computer, an IP address or a configured name', () => {
  for (const host of [
    'localhost:3310',
    '127.0.0.1:3310',
    '[::1]:3310',
    '192.168.2.10:3310',
    `${os.hostname()}:3310`,
    os.hostname().toUpperCase(),
  ])
    assert.equal(hostAllowed(host), true, host);
  for (const host of ['evil.test:3310', 'localhost.evil.test', '', undefined])
    assert.equal(hostAllowed(host), false, String(host));
  assert.equal(hostAllowed('ark.rpgm.tools', ['ark.rpgm.tools']), true);
});

test('first-time setup creates the account and signs in for 90 days', async (t) => {
  const h = harness(t);
  const res = response();
  assert.deepEqual(await h.auth.routes.setup({ req: request(), res, body: { password: PASSWORD } }), { ok: true });
  const row = h.db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  assert.equal(await verifyPassword(PASSWORD, row.password_hash), true);
  assert.equal(row.session_secret.length, 32);
  assert.ok(row.webauthn_id);
  assert.match(
    res.headers['Set-Cookie'],
    /^overseer_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/,
  );
  assert.ok(await h.auth.identify(request(cookieOf(res))));
});

test('setup is refused from another machine and through an address that is not loopback', async (t) => {
  const h = harness(t);
  const body = { password: PASSWORD };
  await assert.rejects(h.auth.routes.setup({ req: request('', { address: '192.0.2.5' }), res: response(), body }), {
    status: 403,
    message: AUTH_MESSAGES.remote,
  });
  // A page that points its own domain at 127.0.0.1 reaches loopback but sends its own Host.
  await assert.rejects(h.auth.routes.setup({ req: request('', { host: 'evil.test:3310' }), res: response(), body }), {
    status: 403,
  });
  await assert.rejects(
    h.auth.routes.setup({ req: request('', { host: '192.168.2.10:3310' }), res: response(), body }),
    {
      status: 403,
    },
  );
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});

test('setup is refused once a password exists, and a short password is refused', async (t) => {
  const h = harness(t);
  await assert.rejects(h.auth.routes.setup({ req: request(), res: response(), body: { password: 'short' } }), {
    status: 400,
    message: AUTH_MESSAGES.short,
  });
  await setUp(h);
  await assert.rejects(
    h.auth.routes.setup({ req: request(), res: response(), body: { password: 'another password' } }),
    {
      status: 409,
      message: AUTH_MESSAGES.alreadySetUp,
    },
  );
});

test('of two setups sent at once, exactly one sets the password and the other is refused', async (t) => {
  const h = harness(t);
  const passwords = ['first password here', 'second password here'];
  const results = await Promise.allSettled(
    passwords.map((password) => h.auth.routes.setup({ req: request(), res: response(), body: { password } })),
  );
  // Whichever finished hashing first wins; the point is that the other is refused, not that it
  // silently replaces the first.
  const won = results.findIndex((r) => r.status === 'fulfilled');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results[1 - won].reason.status, 409);
  const stored = h.db.prepare('SELECT password_hash FROM users').get().password_hash;
  assert.equal(await verifyPassword(passwords[won], stored), true);
  assert.equal(await verifyPassword(passwords[1 - won], stored), false);
});

test('setup and sign-in without a body are refused as bad input, not a crash', async (t) => {
  const h = harness(t);
  await assert.rejects(h.auth.routes.setup({ req: request(), res: response() }), { status: 400 });
  await assert.rejects(h.auth.routes.login({ req: request(), res: response() }), { status: 409, code: 'NEEDS_SETUP' });
});

test('sign-in records the time and a wrong password is refused', async (t) => {
  const h = harness(t);
  await setUp(h);
  await assert.rejects(signIn(h, { password: 'wrong password' }), { status: 401, message: AUTH_MESSAGES.wrong });
  const res = await signIn(h, { password: PASSWORD, remember: true });
  assert.match(res.headers['Set-Cookie'], /Max-Age=7776000/);
  assert.equal(
    h.db.prepare('SELECT last_login_at FROM users').get().last_login_at,
    new Date(h.clock.now).toISOString(),
  );
});

test('five wrong passwords lock that client for five minutes, and other clients are not locked', async (t) => {
  const h = harness(t);
  await setUp(h);
  for (let i = 0; i < 5; i++)
    await assert.rejects(signIn(h, { password: 'wrong' }), (e) => e.status === (i === 4 ? 429 : 401));
  await assert.rejects(signIn(h, { password: PASSWORD }), { status: 429, message: AUTH_MESSAGES.ratelimit });
  assert.ok(await signIn(h, { password: PASSWORD }, request('', { address: '192.0.2.9' })));
  h.clock.now += 300001;
  assert.match((await signIn(h, { password: PASSWORD })).headers['Set-Cookie'], /overseer_session=/);
});

test('a password change signs out other devices and keeps this one signed in', async (t) => {
  const h = harness(t);
  const other = await setUp(h);
  const mine = cookieOf(await signIn(h, { password: PASSWORD, remember: true }));
  const res = response();
  await h.auth.routes.password({
    req: request(mine),
    res,
    body: { current: PASSWORD, password: 'a new secure password' },
  });
  assert.equal(await h.auth.identify(request(other)), null);
  assert.equal(await h.auth.identify(request(mine)), null);
  assert.ok(await h.auth.identify(request(cookieOf(res))));
  const stored = h.db.prepare('SELECT password_hash FROM users').get().password_hash;
  assert.equal(await verifyPassword('a new secure password', stored), true);
});

test('a password change needs the current password and counts wrong guesses toward the lockout', async (t) => {
  const h = harness(t);
  const cookie = await setUp(h);
  const change = (current) =>
    h.auth.routes.password({
      req: request(cookie),
      res: response(),
      body: { current, password: 'a new secure password' },
    });
  for (let i = 0; i < 5; i++)
    await assert.rejects(change('wrong'), { status: 401, message: AUTH_MESSAGES.wrongCurrent });
  await assert.rejects(change(PASSWORD), { status: 429 });
  await assert.rejects(
    h.auth.routes.password({
      req: request(''),
      res: response(),
      body: { current: PASSWORD, password: 'x'.repeat(12) },
    }),
    { status: 401, message: AUTH_MESSAGES.signedOut },
  );
});

test('a passkey challenge works once and only for its own kind', async (t) => {
  const h = harness(t);
  const cookie = await setUp(h);
  const user = await h.auth.identify(request(cookie));
  const { challengeId } = await h.auth.routes.passkey_login_options({ req: request(), res: response() });
  const verify = (id) =>
    h.auth.routes.passkey_login_verify({
      req: request(),
      res: response(),
      body: { challengeId: id, response: { id: 'x' } },
    });
  await assert.rejects(verify(challengeId), { status: 400, message: AUTH_MESSAGES.passkeyFailed });
  await assert.rejects(verify(challengeId), { status: 400 });
  const register = await h.auth.routes.passkey_register_options({ req: request(cookie), res: response(), user });
  await assert.rejects(verify(register.challengeId), { status: 400 });
  await assert.rejects(h.auth.routes.passkey_register_options({ req: request(), res: response(), user: null }), {
    status: 401,
  });
});

test('failed passkey sign-ins count toward the lockout', async (t) => {
  const h = harness(t);
  await setUp(h);
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      h.auth.routes.passkey_login_verify({ req: request(), res: response(), body: { challengeId: 'nope' } }),
      { status: 400 },
    );
  await assert.rejects(signIn(h, { password: PASSWORD }), { status: 429 });
});
