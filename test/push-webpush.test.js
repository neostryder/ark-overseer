import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  checkEndpoint,
  checkKeys,
  encryptPayload,
  fromB64u,
  generateVapidKeys,
  sendPush,
  vapidHeader,
} from '../src/push/webpush.js';

// The worked example in RFC 8291, appendix A.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

test('the payload encryption matches the RFC 8291 worked example', () => {
  const body = encryptPayload(
    fromB64u(RFC.plaintext),
    { uaPublic: fromB64u(RFC.uaPublic), authSecret: fromB64u(RFC.auth) },
    { senderPrivate: fromB64u(RFC.senderPrivate), salt: fromB64u(RFC.salt) },
  );
  // The 86 byte header is not a multiple of three, so the two halves are joined as bytes, not as text.
  assert.deepEqual(body, Buffer.concat([fromB64u(RFC.header), fromB64u(RFC.ciphertext)]));
});

test('a random-key message can be read back by the receiver', () => {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const body = encryptPayload(Buffer.from('hello'), { uaPublic: receiver.getPublicKey(), authSecret });
  const salt = body.subarray(0, 16),
    senderPublic = body.subarray(21, 86);
  const secret = receiver.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, info, 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(86);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.toString(), 'hello\u0002');
});

test('the VAPID header carries a token the public key verifies', () => {
  const keys = generateVapidKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  const header = vapidHeader(endpoint, { ...keys, subject: 'https://ark.example' }, 1_000_000_000_000);
  const [, token, key] = header.match(/^vapid t=(\S+), k=(\S+)$/);
  assert.equal(key, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(fromB64u(claims)), {
    aud: 'https://fcm.googleapis.com',
    exp: 1_000_000_000 + 43200,
    sub: 'https://ark.example',
  });
  const spki = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    fromB64u(keys.publicKey),
  ]);
  const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(
    crypto.verify(
      'sha256',
      Buffer.from(`${head}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      fromB64u(signature),
    ),
  );
});

test('only the browser push services are ever sent a message', () => {
  for (const good of [
    'https://fcm.googleapis.com/fcm/send/x',
    'https://web.push.apple.com/Qx',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])
    assert.equal(checkEndpoint(good), good);
  for (const bad of [
    'http://fcm.googleapis.com/x',
    'https://evil.example/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])
    assert.throws(() => checkEndpoint(bad), /not one of the browser push services/);
});

test('subscription keys must be a P-256 point and a 16 byte secret', () => {
  assert.throws(() => checkKeys({ p256dh: 'AAAA', auth: RFC.auth }), /not valid/);
  assert.throws(() => checkKeys({ p256dh: RFC.uaPublic, auth: 'AAAA' }), /not valid/);
  assert.equal(checkKeys({ p256dh: RFC.uaPublic, auth: RFC.auth }).uaPublic.length, 65);
});

test('sending posts an encrypted body with the headers a push service needs and reports a gone subscription', async () => {
  const seen = [];
  const keys = generateVapidKeys();
  const fetchFn = async (url, options) => (seen.push({ url, options }), { ok: false, status: 410 });
  const result = await sendPush(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: RFC.uaPublic, auth: RFC.auth },
    { title: 'x' },
    { vapid: { ...keys, subject: 'https://ark.example' }, fetchFn },
  );
  assert.deepEqual(result, { ok: false, status: 410, gone: true });
  assert.equal(seen[0].options.headers['Content-Encoding'], 'aes128gcm');
  assert.match(seen[0].options.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(seen[0].options.redirect, 'error');
  assert.ok(Buffer.isBuffer(seen[0].options.body));
});
