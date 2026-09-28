import crypto from 'node:crypto';
import os from 'node:os';
import { transaction } from '../db/transaction.js';

export const AUTH_MESSAGES = {
  wrong: "That isn't the ARK Overseer password. Try again, or reset it on the computer that runs ARK Overseer.",
  ratelimit: 'Five wrong passwords in a row. Wait five minutes before the next try.',
  short: 'Use at least 10 characters.',
  remote: 'Set the first password on the computer that runs ARK Overseer.',
  signedOut: 'Signed out. Sign in again to continue.',
  crossSite: 'This request came from another site, so it was blocked. Reload ARK Overseer and try again.',
  passkeyFailed: "The passkey didn't verify. Try again, or sign in with the password.",
  alreadySetUp: 'A password is already set. Sign in with it.',
  wrongCurrent: "That isn't the current password.",
  unknownHost: "ARK Overseer doesn't answer on this address. Open it by this computer's name or IP address.",
};
const DAY = 86400000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const COOKIE = 'overseer_session';
const LIMITER_MAX = 10000;
const b64 = (value) => Buffer.from(value).toString('base64url');
const from64 = (value) => Buffer.from(value, 'base64url');
const scrypt = (password, salt, length, options) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, length, { ...options, maxmem: 128 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    !/^\d+$/.test(parts[1]) ||
    !/^\d+$/.test(parts[2]) ||
    !/^\d+$/.test(parts[3])
  )
    return false;
  try {
    const expected = Buffer.from(parts[5], 'base64');
    if (!expected.length || expected.length > 128) return false;
    const key = await scrypt(password, Buffer.from(parts[4], 'base64'), expected.length, {
      N: +parts[1],
      r: +parts[2],
      p: +parts[3],
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
export function signSession(secret, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot),
    mac = token.slice(dot + 1);
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest(),
      given = from64(mac);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(from64(body).toString('utf8'));
    return payload && Number.isFinite(payload.exp) && payload.exp > now && Number.isFinite(payload.uid)
      ? payload
      : null;
  } catch {
    return null;
  }
}
export function originAllowed({ origin, secFetchSite, host }) {
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return !secFetchSite || secFetchSite === 'same-origin';
}
// An IPv6 Host header is always bracketed ("[::1]:3310"), so the port is only stripped outside brackets.
function hostnameOf(host) {
  const value = String(host ?? '').toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']') === -1 ? undefined : value.indexOf(']'));
  return value.replace(/:\d+$/, '');
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// The Host header must name this machine. A web page that points its own domain at 127.0.0.1 (DNS
// rebinding) sends its own name here, and that request would otherwise reach the API from loopback.
export function hostAllowed(host, extra = []) {
  const name = hostnameOf(host);
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name) || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true;
  const machine = os.hostname().toLowerCase();
  return name === machine || name === `${machine}.local` || extra.map((h) => h.toLowerCase()).includes(name);
}
export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(hostnameOf(host));

export function isLoopbackSocket(req) {
  return new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']).has(req.socket?.remoteAddress);
}
// A cookie with a broken % escape is skipped. Throwing here would fail every request that browser
// makes until the cookie is cleared by hand.
export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .flatMap((part) => {
        const i = part.indexOf('=');
        if (i < 1) return [];
        try {
          return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]];
        } catch {
          return [];
        }
      }),
  );
}
function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
export function createAuth({ db, now = () => Date.now(), loopback = isLoopbackSocket }) {
  const limiter = new Map(),
    challenges = new Map();
  const user = () => db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  const hasPassword = () => Boolean(user()?.password_hash);
  function cookie(req, res, payload, row) {
    const parts = [`${COOKIE}=${signSession(row.session_secret, payload)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    // Measured from the payload's own issue time, so a clock tick between the two reads cannot
    // shorten it.
    if (payload.rem) parts.push(`Max-Age=${Math.floor((payload.exp - payload.iat) / 1000)}`);
    if (req.socket?.encrypted) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  function clear(req, res) {
    const secure = req.socket?.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  }
  function rateKey(req) {
    return req.socket?.remoteAddress || 'unknown';
  }
  function limited(key) {
    const entry = limiter.get(key);
    if (!entry) return false;
    if (now() - entry.first >= 300000) {
      limiter.delete(key);
      return false;
    }
    return entry.count >= 5;
  }
  // Expired entries are swept on every failure, and the map is capped, so clients that fail once
  // and never return cannot grow it without end.
  function fail(key) {
    for (const [other, entry] of limiter) if (now() - entry.first >= 300000) limiter.delete(other);
    if (!limiter.has(key) && limiter.size >= LIMITER_MAX) limiter.delete(limiter.keys().next().value);
    const entry = limiter.get(key);
    if (!entry) limiter.set(key, { first: now(), count: 1 });
    else entry.count++;
  }
  async function identify(req, res) {
    const row = user();
    if (!row?.password_hash || !row.session_secret) return null;
    const payload = verifySession(row.session_secret, parseCookies(req.headers.cookie)[COOKIE], now());
    if (!payload || payload.uid !== row.id || row.disabled) return null;
    if (res && payload.rem && now() - payload.iat > DAY)
      cookie(req, res, { uid: row.id, iat: now(), exp: now() + 90 * DAY, rem: true }, row);
    return row;
  }
  async function rp(req) {
    const host = req.headers.host || 'localhost';
    return {
      rpID: host.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''),
      origin: `${req.socket?.encrypted ? 'https' : 'http'}://${host}`,
    };
  }
  const routes = {
    state: async ({ req, res }) => {
      const signed = await identify(req, res);
      const { rpID } = await rp(req);
      return {
        signedIn: !!signed,
        needsSetup: !hasPassword(),
        passkeysAvailable: Boolean(
          db.prepare('SELECT 1 FROM user_passkeys WHERE user_id = ? AND rp_id = ?').get(user()?.id ?? -1, rpID),
        ),
      };
    },
    setup: async ({ req, res, body = {} }) => {
      if (hasPassword()) throw statusError(409, AUTH_MESSAGES.alreadySetUp);
      // Both the socket and the address typed into the browser must be this computer.
      if (!loopback(req) || !isLoopbackHost(req.headers.host)) throw statusError(403, AUTH_MESSAGES.remote);
      if (typeof body.password !== 'string' || body.password.length < 10) throw statusError(400, AUTH_MESSAGES.short);
      const stamp = new Date(now()).toISOString(),
        id = crypto.randomBytes(16).toString('base64url'),
        secret = crypto.randomBytes(32);
      const password_hash = await hashPassword(body.password);
      // Hashing takes a moment, so the check runs again inside the write lock: of two setups sent at
      // once, only the first sets the password.
      const row = transaction(db, () => {
        if (hasPassword()) throw statusError(409, AUTH_MESSAGES.alreadySetUp);
        return writeAccount();
      });
      cookie(req, res, { uid: row.id, iat: now(), exp: now() + 90 * DAY, rem: true }, row);
      return { ok: true };
      function writeAccount() {
        let row = user();
        if (!row) {
          const result = db
            .prepare(
              "INSERT INTO users (created_at, updated_at, username, password_hash, session_secret, webauthn_id) VALUES (?, ?, 'admin', ?, ?, ?)",
            )
            .run(stamp, stamp, password_hash, secret, id);
          row = { id: Number(result.lastInsertRowid), session_secret: secret };
        } else
          (db
            .prepare(
              'UPDATE users SET password_hash = ?, session_secret = ?, webauthn_id = ?, updated_at = ? WHERE id = ?',
            )
            .run(password_hash, secret, id, stamp, row.id),
            (row = { ...row, session_secret: secret }));
        return row;
      }
    },
    login: async ({ req, res, body = {} }) => {
      const key = rateKey(req);
      if (limited(key)) throw statusError(429, AUTH_MESSAGES.ratelimit);
      const row = user();
      if (!row?.password_hash) throw Object.assign(statusError(409, AUTH_MESSAGES.remote), { code: 'NEEDS_SETUP' });
      if (!(await verifyPassword(body.password, row.password_hash))) {
        fail(key);
        if (limited(key)) throw statusError(429, AUTH_MESSAGES.ratelimit);
        throw statusError(401, AUTH_MESSAGES.wrong);
      }
      limiter.delete(key);
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(now()).toISOString(), row.id);
      const remember = Boolean(body.remember);
      cookie(
        req,
        res,
        { uid: row.id, iat: now(), exp: now() + (remember ? 90 * DAY : 12 * 60 * 60 * 1000), rem: remember },
        row,
      );
      return { ok: true };
    },
    logout: async ({ req, res }) => {
      clear(req, res);
      return { ok: true };
    },
    password: async ({ req, res, body = {} }) => {
      const row = await identify(req);
      if (!row) throw statusError(401, AUTH_MESSAGES.signedOut);
      const key = rateKey(req);
      if (limited(key)) throw statusError(429, AUTH_MESSAGES.ratelimit);
      if (!(await verifyPassword(body.current, row.password_hash))) {
        fail(key);
        throw statusError(401, AUTH_MESSAGES.wrongCurrent);
      }
      if (typeof body.password !== 'string' || body.password.length < 10) throw statusError(400, AUTH_MESSAGES.short);
      // A new secret signs every other device out; this one gets a fresh cookie signed with it.
      const secret = crypto.randomBytes(32);
      db.prepare('UPDATE users SET password_hash = ?, session_secret = ?, updated_at = ? WHERE id = ?').run(
        await hashPassword(body.password),
        secret,
        new Date(now()).toISOString(),
        row.id,
      );
      cookie(
        req,
        res,
        { uid: row.id, iat: now(), exp: now() + 90 * DAY, rem: true },
        { ...row, session_secret: secret },
      );
      return { ok: true };
    },
  };
  for (const mode of ['register', 'login']) {
    routes[`passkey_${mode}_options`] = async ({ req, user: signed }) => {
      if (mode === 'register' && !signed) throw statusError(401, AUTH_MESSAGES.signedOut);
      for (const [id, entry] of challenges) if (entry.expires < now()) challenges.delete(id);
      const lib = await import('@simplewebauthn/server'),
        { rpID } = await rp(req),
        row = user();
      const options =
        mode === 'register'
          ? await lib.generateRegistrationOptions({
              rpName: 'ARK Overseer',
              rpID,
              userName: 'admin',
              userID: Buffer.from(row.webauthn_id || 'admin'),
              attestationType: 'none',
              excludeCredentials: db
                .prepare('SELECT credential_id, transports_json FROM user_passkeys WHERE user_id = ? AND rp_id = ?')
                .all(row.id, rpID)
                .map((k) => ({ id: k.credential_id, transports: JSON.parse(k.transports_json) })),
              authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
            })
          : await lib.generateAuthenticationOptions({
              rpID,
              allowCredentials: db
                .prepare('SELECT credential_id, transports_json FROM user_passkeys WHERE user_id = ? AND rp_id = ?')
                .all(row?.id ?? -1, rpID)
                .map((k) => ({ id: k.credential_id, transports: JSON.parse(k.transports_json) })),
              userVerification: 'preferred',
            });
      const challengeId = b64(crypto.randomBytes(16));
      challenges.set(challengeId, { challenge: options.challenge, kind: mode, expires: now() + 300000 });
      return { challengeId, options };
    };
    routes[`passkey_${mode}_verify`] = async ({ req, body = {}, user: signed, res }) => {
      if (mode === 'register' && !signed) throw statusError(401, AUTH_MESSAGES.signedOut);
      const key = rateKey(req);
      if (mode === 'login' && limited(key)) throw statusError(429, AUTH_MESSAGES.ratelimit);
      const saved = challenges.get(body.challengeId);
      challenges.delete(body.challengeId);
      const { rpID, origin } = await rp(req),
        row = user();
      // A reset account (no password) takes no passkey sign-in until setup runs again.
      if (!saved || saved.kind !== mode || saved.expires < now() || !row?.password_hash) {
        if (mode === 'login') fail(key);
        throw statusError(400, AUTH_MESSAGES.passkeyFailed);
      }
      try {
        const lib = await import('@simplewebauthn/server');
        if (mode === 'register') {
          const result = await lib.verifyRegistrationResponse({
            response: body.response,
            expectedChallenge: saved.challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: false,
          });
          if (!result.verified) throw new Error('not verified');
          const c = result.registrationInfo.credential;
          db.prepare(
            'INSERT INTO user_passkeys (created_at, user_id, credential_id, public_key, sign_count, transports_json, rp_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            new Date(now()).toISOString(),
            row.id,
            c.id,
            c.publicKey,
            c.counter,
            JSON.stringify(c.transports || []),
            rpID,
          );
          return { ok: true };
        }
        const passkey = db
          .prepare('SELECT * FROM user_passkeys WHERE user_id = ? AND rp_id = ? AND credential_id = ?')
          .get(row?.id ?? -1, rpID, body.response?.id);
        if (!passkey) throw new Error('unknown passkey');
        const result = await lib.verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: saved.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: passkey.credential_id,
            publicKey: passkey.public_key,
            counter: passkey.sign_count,
            transports: JSON.parse(passkey.transports_json),
          },
          requireUserVerification: false,
        });
        if (!result.verified) throw new Error('not verified');
        db.prepare('UPDATE user_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(
          result.authenticationInfo.newCounter,
          new Date(now()).toISOString(),
          passkey.id,
        );
        db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(now()).toISOString(), row.id);
        limiter.delete(key);
        cookie(req, res, { uid: row.id, iat: now(), exp: now() + 90 * DAY, rem: true }, row);
        return { ok: true };
      } catch {
        if (mode === 'login') fail(key);
        throw statusError(400, AUTH_MESSAGES.passkeyFailed);
      }
    };
  }
  // The owner's own list, so a lost device's passkey can be removed without a full reset.
  routes.passkeys = async ({ user: signed }) => {
    if (!signed) throw statusError(401, AUTH_MESSAGES.signedOut);
    return db
      .prepare('SELECT id, created_at, rp_id, label, last_used_at FROM user_passkeys WHERE user_id = ? ORDER BY id')
      .all(signed.id);
  };
  routes.passkey_remove = async ({ user: signed, body = {} }) => {
    if (!signed) throw statusError(401, AUTH_MESSAGES.signedOut);
    const removed = db
      .prepare('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?')
      .run(body.id, signed.id).changes;
    return { removed: removed > 0 };
  };
  return { identify, routes };
}
