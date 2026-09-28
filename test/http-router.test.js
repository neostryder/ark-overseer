import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/http/router.js';
import { serveStatic } from '../src/http/static.js';

async function listen(t, callback) {
  const server = http.createServer(callback);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('router passes numeric params and query values to handlers', async (t) => {
  const router = createRouter();
  router.add('GET', '/api/servers/:id', ({ params, query }) => ({ id: params.id, q: query.q }));
  const url = await listen(t, (req, res) => router.handle(req, res));
  const response = await fetch(`${url}/api/servers/17?q=world`);
  assert.deepEqual(await response.json(), { id: 17, q: 'world' });
});

test('router copies error status and extra response fields', async (t) => {
  const router = createRouter();
  router.add('POST', '/api/change', () => {
    throw Object.assign(new Error('conflict'), { status: 409, code: 'changed', conflicts: [{ port: 7 }] });
  });
  const url = await listen(t, (req, res) => router.handle(req, res));
  const response = await fetch(`${url}/api/change`, json({}));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'conflict', code: 'changed', conflicts: [{ port: 7 }] });
});

test('router hides a server error and logs its redacted stack', async (t) => {
  const lines = [],
    router = createRouter({ log: (line) => lines.push(line) });
  router.add('GET', '/api/fail', () => {
    throw new Error('ServerAdminPassword=secret');
  });
  const url = await listen(t, (req, res) => router.handle(req, res));
  const response = await fetch(`${url}/api/fail`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'Something went wrong in ARK Overseer. The details are in its log.',
  });
  assert.match(lines[0], /ServerAdminPassword=\*\*\*\*\*\*\*\*/);
  assert.doesNotMatch(lines[0], /secret/);
});

test('router refuses non JSON and bodies above one megabyte', async (t) => {
  const router = createRouter();
  router.add('POST', '/api/body', ({ body }) => body);
  const url = await listen(t, (req, res) => router.handle(req, res));
  const unsupported = await fetch(`${url}/api/body`, { method: 'POST', body: 'x' });
  assert.equal(unsupported.status, 415);
  assert.deepEqual(await unsupported.json(), { error: 'The request body must be JSON.', code: 'badJson' });
  const large = await fetch(`${url}/api/body`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: 'The request is too large.', code: 'tooLarge' });
});

test('static serving applies content types, security headers and refuses traversal or missing files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-http-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>home</h1>');
  await fs.writeFile(path.join(dir, 'app.mjs'), 'export {};');
  const server = http.createServer(async (req, res) => {
    if (!(await serveStatic(dir, req, res))) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(base);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(
    home.headers.get('content-security-policy'),
    "default-src 'self'; img-src 'self' data: https://*.steamstatic.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  );
  assert.equal((await fetch(`${base}/app.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%5c..%5cpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const etag = home.headers.get('etag');
  assert.ok(etag);
  const unchanged = await fetch(base, { headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>home, updated</h1>');
  const changed = await fetch(base, { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), '<h1>home, updated</h1>');
});
