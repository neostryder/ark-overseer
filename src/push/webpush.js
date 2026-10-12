import crypto from 'node:crypto';

// Web Push without a library: VAPID (RFC 8292) names the sender and aes128gcm (RFC 8291) hides the message from
// the push service that carries it.
const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
export const fromB64u = (text) => Buffer.from(String(text), 'base64url');

// A push service is the browser maker's own server. Only these hosts are ever sent a message, so a
// subscription cannot point the server at anything else.
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.apple.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

export const PUSH_MESSAGES = {
  badEndpoint: 'The push address is not one of the browser push services.',
  badKeys: 'The subscription keys are not valid.',
};

export function checkEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(PUSH_MESSAGES.badEndpoint);
  }
  const allowed = PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) {
    throw new Error(PUSH_MESSAGES.badEndpoint);
  }
  return url.href;
}

export function checkKeys(keys) {
  const uaPublic = fromB64u(keys?.p256dh ?? ''),
    authSecret = fromB64u(keys?.auth ?? '');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error(PUSH_MESSAGES.badKeys);
  return { uaPublic, authSecret };
}

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)),
    privateKey: b64u(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

// The message body of RFC 8291 section 4. The sender keys and salt are chosen at random unless a test fixes them.
export function encryptPayload(
  plaintext,
  { uaPublic, authSecret },
  { senderPrivate, salt = crypto.randomBytes(16) } = {},
) {
  const sender = crypto.createECDH('prime256v1');
  if (senderPrivate) sender.setPrivateKey(senderPrivate);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const secret = sender.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, sealed]);
}

export function vapidHeader(endpoint, { publicKey, privateKey, subject }, nowMs = Date.now()) {
  const part = (value) => b64u(JSON.stringify(value));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const key = crypto.createPrivateKey({ key: fromB64u(privateKey), format: 'der', type: 'pkcs8' });
  const signature = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${publicKey}`;
}

// Sends one message. gone is true when the push service says the subscription no longer exists.
export async function sendPush(subscription, message, { vapid, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const endpoint = checkEndpoint(subscription.endpoint);
  const body = encryptPayload(Buffer.from(JSON.stringify(message)), checkKeys(subscription));
  const response = await fetchFn(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: vapidHeader(endpoint, vapid, now()),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}
