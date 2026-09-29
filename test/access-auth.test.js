import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { openDatabase } from '../src/db/index.js';
import { createAuth } from '../src/auth/auth.js';

const NOW = 1_700_000_000_000;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'main', alg: 'RS256', use: 'sig' };
const jwks = { keys: [publicJwk] };

function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}
function req(token, cookie = '') {
  return {
    headers: { host: 'localhost:3310', cookie, ...(token === undefined ? {} : { 'cf-access-jwt-assertion': token }) },
    socket: { remoteAddress: '127.0.0.1' },
  };
}
async function fixture(t, factory = async () => createLocalJWKSet(jwks)) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO hosts (name, created_at, updated_at, access_team_domain, access_aud) VALUES ('local', 'x', 'x', 'rpgm.cloudflareaccess.com', ?)",
  ).run('a'.repeat(64));
  const auth = createAuth({
    db,
    now: () => NOW,
    accessKeySetFactory: factory,
    accessJwtVerify: jwtVerify,
  });
  const setupResponse = response();
  await auth.routes.setup({ req: req(), res: setupResponse, body: { password: 'correct horse battery' } });
  return {
    db,
    auth,
    cookie: setupResponse.headers['Set-Cookie'].split(';')[0],
  };
}
async function token({
  issuer = 'https://rpgm.cloudflareaccess.com',
  audience = 'a'.repeat(64),
  exp = NOW / 1000 + 300,
  key = privateKey,
} = {}) {
  return new SignJWT({ email: 'owner@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'main' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('subject-1')
    .setIssuedAt(Math.floor(NOW / 1000))
    .setExpirationTime(exp)
    .sign(key);
}
async function fallsBack(t, value) {
  const h = await fixture(t);
  const accessToken = typeof value === 'function' ? await value() : value;
  const request = accessToken === undefined ? req(undefined, h.cookie) : req(accessToken, h.cookie);
  assert.deepEqual(await h.auth.identify(request), h.db.prepare("SELECT * FROM users WHERE username = 'admin'").get());
}

test('a valid Access token signs in without a cookie as the local admin', async (t) => {
  const h = await fixture(t);
  const user = await h.auth.identify(req(await token()));
  assert.equal(user.username, 'admin');
});

test('an expired Access token falls through to the cookie', async (t) => {
  await fallsBack(t, () => token({ exp: NOW / 1000 - 1 }));
});

test('a wrong audience falls through to the cookie', async (t) => {
  await fallsBack(t, () => token({ audience: 'b'.repeat(64) }));
});

test('a wrong issuer falls through to the cookie', async (t) => {
  await fallsBack(t, () => token({ issuer: 'https://other.cloudflareaccess.com' }));
});

test('a token signed by a wrong key falls through to the cookie', async (t) => {
  const other = await generateKeyPair('RS256');
  await fallsBack(t, () => token({ key: other.privateKey }));
});

test('a malformed Access token falls through to the cookie', async (t) => {
  await fallsBack(t, 'not.a.jwt');
});

test('a missing Access token falls through to the cookie', async (t) => {
  await fallsBack(t, undefined);
});

test('Access is ignored while the feature is off', async (t) => {
  const h = await fixture(t);
  h.db.prepare("UPDATE hosts SET access_team_domain = NULL, access_aud = NULL WHERE name = 'local'").run();
  assert.equal(await h.auth.identify(req(await token())), null);
});

test('saving Access settings replaces the cached key set', async (t) => {
  let made = 0;
  const h = await fixture(t, async () => {
    made++;
    return createLocalJWKSet(jwks);
  });
  const jwt = await token();
  assert.ok(await h.auth.identify(req(jwt)));
  assert.equal(made, 1);
  await h.auth.saveAccessSettings('rpgm.cloudflareaccess.com', 'a'.repeat(64));
  assert.ok(await h.auth.identify(req(jwt)));
  assert.equal(made, 2);
});
