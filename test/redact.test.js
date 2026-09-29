import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, MASK } from '../src/util/redact.js';

test('redact masks passwords in an ASA launch line', () => {
  const line =
    'Commandline: Astraeos_WP?listen?SessionName=Neo Olympus?ServerPassword=hunter2?ServerAdminPassword=s3cret -port=7777';
  const out = redact(line);
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('s3cret'));
  assert.ok(out.includes(`ServerPassword=${MASK}`));
  assert.ok(out.includes('-port=7777'));
  assert.ok(out.includes('SessionName=Neo Olympus'));
});

test('redact masks ini-style and header-style secrets', () => {
  assert.strictEqual(redact('SpectatorPassword=abc'), `SpectatorPassword=${MASK}`);
  assert.ok(!redact('x-api-key: abcdef123').includes('abcdef123'));
  assert.ok(!redact('Authorization: Basic eDpzZWNyZXQ=').includes('eDpzZWNyZXQ='));
  assert.ok(!redact('Cf-Access-Jwt-Assertion: eyJ.abc.def').includes('eyJ.abc.def'));
});

test('a request log line never exposes a Cloudflare Access assertion', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature';
  const line = `Request headers: Cf-Access-Jwt-Assertion: ${token} Host: ark.example.test`;
  const masked = redact(line);
  assert.ok(masked.includes(`Cf-Access-Jwt-Assertion: ${MASK}`));
  assert.ok(!masked.includes(token));
});

test('redact leaves ordinary lines unchanged', () => {
  const line = '[2026.09.27-18.00.00:000][  0]LogInit: Server ready, 12 players, map Astraeos_WP';
  assert.strictEqual(redact(line), line);
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(undefined), undefined);
});

test('redact masks passwords inside JSON', () => {
  const out = redact('{"ServerAdminPassword":"hunter2","MaxPlayers":20,"serverPassword" : "abc"}');
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('"abc"'));
  assert.ok(out.includes('"MaxPlayers":20'));
});
