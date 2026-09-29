import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DEFAULT_HOST, listen } from '../src/http/listen.js';

const get = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('the default address answers on IPv4 and IPv6 loopback', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.socket.remoteAddress);
    res.end('ok');
  });
  t.after(() => server.close());
  await listen(server, 0);
  const { port } = server.address();
  assert.equal(await get(`http://127.0.0.1:${port}/`), 200);
  assert.equal(await get(`http://[::1]:${port}/`), 200);
  assert.deepEqual(seen, ['::ffff:127.0.0.1', '::1']);
});

test('a computer without IPv6 falls back to every IPv4 address', async () => {
  const calls = [];
  const fake = new EventEmitter();
  fake.listen = (options) => {
    calls.push(options);
    queueMicrotask(() =>
      options.host === DEFAULT_HOST
        ? fake.emit('error', Object.assign(new Error('no IPv6'), { code: 'EAFNOSUPPORT' }))
        : fake.emit('listening'),
    );
  };
  await listen(fake, 3310);
  assert.deepEqual(calls, [
    { port: 3310, host: '::', ipv6Only: false },
    { port: 3310, host: '0.0.0.0' },
  ]);
});

test('a chosen address is used as given, and other errors are not hidden', async () => {
  const calls = [];
  const fake = new EventEmitter();
  fake.listen = (options) => {
    calls.push(options);
    queueMicrotask(() => fake.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })));
  };
  await assert.rejects(listen(fake, 3310, '192.168.2.100'), { code: 'EADDRINUSE' });
  await assert.rejects(listen(fake, 3310), { code: 'EADDRINUSE' });
  assert.deepEqual(calls, [
    { port: 3310, host: '192.168.2.100' },
    { port: 3310, host: '::', ipv6Only: false },
  ]);
});
