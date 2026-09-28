import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';
import { streamJobEvents } from '../src/jobs/sse.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(t, handlers = {}) {
  const db = openDatabase(':memory:');
  const engine = createJobEngine({ db, handlers });
  engine.start();
  const server = http.createServer((req, res) => streamJobEvents(engine, req, res, { heartbeatMs: 5000 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.stop({ abort: true });
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const address = server.address();
  return { db, engine, server, url: `http://127.0.0.1:${address.port}` };
}

function readerStream(response) {
  const reader = response.body.getReader();
  let pending = '';
  return {
    async nextEvent() {
      while (true) {
        const boundary = pending.indexOf('\n\n');
        if (boundary >= 0) {
          const value = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          return value;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream closed');
        pending += new TextDecoder().decode(value);
      }
    },
    reader,
  };
}

test('response headers and initial snapshot contain only active jobs', async (t) => {
  const { db, engine, url } = await setup(t);
  const stamp = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO jobs (created_at, updated_at, kind, state, params_json) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(stamp, stamp, 'queued-kind', 'queued', '{}');
  insert.run(stamp, stamp, 'running-kind', 'running', '{}');
  insert.run(stamp, stamp, 'done-kind', 'succeeded', '{}');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('connection'), 'keep-alive');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const stream = readerStream(response);
  const snapshot = await stream.nextEvent();
  assert.match(snapshot, /^event: snapshot\n/);
  assert.deepEqual(
    JSON.parse(
      snapshot
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6),
    ).jobs.map((job) => job.state),
    ['running', 'queued'],
  );
  await stream.reader.cancel();
});

test('lifecycle events arrive with increasing ids and single line JSON data', async (t) => {
  const gate = deferred();
  const { engine, url } = await setup(t, {
    work: async ({ progress }) => {
      progress(0.5, 'half');
      await gate.promise;
    },
  });
  const response = await fetch(url);
  const stream = readerStream(response);
  await stream.nextEvent();
  const job = engine.enqueue('work');
  const events = [];
  for (const type of ['queued', 'started', 'progress']) {
    const value = await stream.nextEvent();
    events.push(value);
    assert.match(value, new RegExp(`^id: \\d+\\nevent: ${type}\\n`));
    assert.equal(value.split('\n').filter((line) => line.startsWith('data: ')).length, 1);
    JSON.parse(
      value
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6),
    );
  }
  const done = new Promise((resolve) =>
    engine.subscribe((event) => {
      if (event.type === 'succeeded' && event.job.id === job.id) resolve();
    }),
  );
  gate.resolve();
  await done;
  const succeeded = await stream.nextEvent();
  assert.match(succeeded, /^id: \d+\nevent: succeeded\n/);
  const ids = [...events, succeeded].map((event) => Number(event.match(/^id: (\d+)/)[1]));
  // One engine emitting to one stream: each id is exactly one more than the last.
  assert.deepEqual(
    ids,
    ids.map((_, i) => ids[0] + i),
  );
  await stream.reader.cancel();
});

test('filter limits snapshot and live events to one server', async (t) => {
  const db = openDatabase(':memory:');
  const engine = createJobEngine({ db, handlers: { x: async () => undefined } });
  engine.start();
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, 'host')").run(stamp, stamp);
  db.prepare("INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, 1, 'path')").run(stamp, stamp);
  db.prepare(
    "INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port) VALUES (?, ?, 1, 1, 'one', 'map', 'one', 7777)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port) VALUES (?, ?, 1, 1, 'two', 'map', 'two', 7778)",
  ).run(stamp, stamp);
  const add = db.prepare(
    "INSERT INTO jobs (created_at, updated_at, kind, server_id, state, params_json) VALUES (?, ?, 'x', ?, 'queued', '{}')",
  );
  add.run(stamp, stamp, 1);
  add.run(stamp, stamp, 2);
  const server = http.createServer((req, res) =>
    streamJobEvents(engine, req, res, { filter: (job) => job.serverId === 1 }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  const stream = readerStream(response);
  const snapshot = JSON.parse(
    (await stream.nextEvent())
      .split('\n')
      .find((line) => line.startsWith('data: '))
      .slice(6),
  );
  assert.deepEqual(
    snapshot.jobs.map((job) => job.serverId),
    [1],
  );
  engine.enqueue('x');
  engine.enqueue('x', {}, { serverId: 1 });
  const live = await stream.nextEvent();
  assert.equal(
    JSON.parse(
      live
        .split('\n')
        .find((line) => line.startsWith('data: '))
        .slice(6),
    ).serverId,
    1,
  );
  await stream.reader.cancel();
});

test('closing the client unsubscribes its stream listener', async (t) => {
  const { engine, url } = await setup(t);
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const stream = readerStream(response);
  await stream.nextEvent();
  assert.equal(engine.listenerCount(), 1);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.listenerCount(), 0);
});

test('heartbeat comments arrive at the configured interval', async (t) => {
  const db = openDatabase(':memory:');
  const engine = createJobEngine({ db, handlers: {} });
  const server = http.createServer((req, res) => streamJobEvents(engine, req, res, { heartbeatMs: 50 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  const stream = readerStream(response);
  await stream.nextEvent();
  assert.equal(await stream.nextEvent(), ': ping');
  await stream.reader.cancel();
});

// A response stand-in whose socket is backed up until the test emits 'drain'.
function backedUpResponse() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableNeedDrain = true;
  res.writeHead = () => {};
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return false;
  };
  return res;
}

function fakeEngine() {
  let listener;
  return {
    listCalls: [],
    list(options) {
      this.listCalls.push(options);
      return [];
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    emit: (event) => listener?.(event),
  };
}

test('a backed-up client gets only the newest progress per job, and lifecycle events always', () => {
  const engine = fakeEngine();
  const res = backedUpResponse();
  const cleanup = streamJobEvents(engine, new EventEmitter(), res, { heartbeatMs: 60000 });
  const writesBefore = res.chunks.length;
  for (let i = 1; i <= 100; i++) engine.emit({ seq: i, type: 'progress', job: { id: 7, progress: i / 100 } });
  assert.equal(res.chunks.length, writesBefore);
  engine.emit({ seq: 101, type: 'progress', job: { id: 8, progress: 0.3 } });
  engine.emit({ seq: 102, type: 'succeeded', job: { id: 8, progress: 1 } });
  assert.equal(res.chunks.length, writesBefore + 1);
  assert.match(res.chunks.at(-1), /^id: 102\nevent: succeeded\n/);
  res.emit('drain');
  const flushed = res.chunks.slice(writesBefore + 1);
  assert.equal(flushed.length, 1);
  assert.match(flushed[0], /^id: 100\nevent: progress\ndata: \{"id":7,"progress":1\}/);
  cleanup();
});

test('the snapshot asks for every active job, with no row limit', () => {
  const engine = fakeEngine();
  const cleanup = streamJobEvents(engine, new EventEmitter(), backedUpResponse(), { heartbeatMs: 60000 });
  assert.deepEqual(engine.listCalls, [{ state: ['queued', 'running'], limit: null }]);
  cleanup();
});
