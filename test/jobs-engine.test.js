import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createJobEngine } from '../src/jobs/engine.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(t, handlers = {}, options = {}) {
  const db = openDatabase(':memory:');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, ?)').run(stamp, stamp, 'test-host');
  for (let index = 1; index <= 3; index += 1) {
    db.prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, 1, ?)').run(
      stamp,
      stamp,
      `install-${index}`,
    );
    db.prepare(
      'INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
    ).run(stamp, stamp, index, `server-${index}`, 'TheIsland', `Server ${index}`, 7777 + index);
  }
  const engine = createJobEngine({ db, handlers, ...options });
  t.after(async () => {
    await engine.stop({ abort: true, timeoutMs: 1000 });
    db.close();
  });
  engine.start();
  return { db, engine };
}

function eventWait(engine, type, predicate = () => true) {
  return new Promise((resolve) => {
    const off = engine.subscribe((event) => {
      if (event.type === type && predicate(event.job)) {
        off();
        resolve(event);
      }
    });
  });
}

test('enqueueing an unknown kind throws and inserts nothing', (t) => {
  const { db, engine } = setup(t);
  assert.throws(() => engine.enqueue('missing'), /missing/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
});

test('a job runs with parsed params and stores its successful result', async (t) => {
  let received;
  const { engine } = setup(t, {
    work: async (ctx) => {
      received = ctx;
      ctx.progress(0.4);
      return { ok: true };
    },
  });
  const done = eventWait(engine, 'succeeded');
  const job = engine.enqueue('work', { value: 3 });
  const event = await done;
  assert.equal(received.params.value, 3);
  assert.equal(received.job.id, job.id);
  assert.deepEqual(event.job.result, { ok: true });
  assert.equal(event.job.progress, 1);
  assert.equal(event.job.attempts, 1);
  assert.ok(event.job.startedAt);
  assert.ok(event.job.finishedAt);
});

test('a rejected handler stores a failed and redacted error', async (t) => {
  const { engine } = setup(t, {
    work: async () => {
      throw new Error('ServerAdminPassword=secret');
    },
  });
  const done = eventWait(engine, 'failed');
  const job = engine.enqueue('work');
  const event = await done;
  assert.equal(event.job.id, job.id);
  assert.equal(event.job.error, 'ServerAdminPassword=********');
});

test('a synchronously throwing handler ends failed', async (t) => {
  const { engine } = setup(t, {
    work: () => {
      throw new Error('broken');
    },
  });
  const done = eventWait(engine, 'failed');
  engine.enqueue('work');
  assert.equal((await done).job.error, 'broken');
});

test('concurrency limits the number of running jobs', async (t) => {
  const gates = [deferred(), deferred(), deferred()];
  let index = 0;
  const { engine } = setup(t, { work: async () => gates[index++].promise }, { concurrency: 2 });
  engine.enqueue('work');
  engine.enqueue('work');
  engine.enqueue('work');
  await eventWait(engine, 'started', (job) => job.id === 2);
  assert.equal(engine.list({ state: 'running' }).length, 2);
  assert.equal(engine.list({ state: 'queued' }).length, 1);
  gates[0].resolve();
  gates[1].resolve();
  await eventWait(engine, 'started', (job) => job.id === 3);
  gates[2].resolve();
});

test('same server jobs serialize while another server runs alongside', async (t) => {
  const gates = [deferred(), deferred()];
  let index = 0;
  const { engine } = setup(t, { work: async () => gates[index++].promise }, { concurrency: 3 });
  engine.enqueue('work', {}, { serverId: 1 });
  engine.enqueue('work', {}, { serverId: 1 });
  engine.enqueue('work', {}, { serverId: 2 });
  await eventWait(engine, 'started', (job) => job.id === 3);
  assert.equal(engine.get(2).state, 'queued');
  gates[0].resolve();
  await eventWait(engine, 'started', (job) => job.id === 2);
  gates[1].resolve();
});

test('same install jobs never overlap', async (t) => {
  const gate = deferred();
  const { engine } = setup(t, { work: async () => gate.promise });
  engine.enqueue('work', {}, { installId: 1 });
  engine.enqueue('work', {}, { installId: 1 });
  await eventWait(engine, 'started');
  assert.equal(engine.get(2).state, 'queued');
  gate.resolve();
  await eventWait(engine, 'started', (job) => job.id === 2);
});

test('future runAfter jobs start on their own', async (t) => {
  const { engine } = setup(t, { work: async () => undefined });
  const started = eventWait(engine, 'started');
  engine.enqueue('work', {}, { runAfter: new Date(Date.now() + 100).toISOString() });
  assert.equal((await started).job.state, 'running');
});

test('cancelling a queued job prevents its handler from running', async (t) => {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const { engine } = setup(
    t,
    {
      work: async () => {
        calls += 1;
        entered.resolve();
        return gate.promise;
      },
    },
    { concurrency: 1 },
  );
  engine.enqueue('work');
  await eventWait(engine, 'started');
  const queued = engine.enqueue('work');
  assert.equal(engine.cancel(queued.id), true);
  assert.equal(engine.get(queued.id).state, 'cancelled');
  await entered.promise;
  gate.resolve();
  assert.equal(calls, 1);
});

test('cancelling a running job aborts its signal and ends cancelled on rejection', async (t) => {
  let signal;
  const { engine } = setup(t, {
    work: ({ signal: value }) => {
      signal = value;
      return new Promise((resolve, reject) => value.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  const cancelled = eventWait(engine, 'cancelled');
  const job = engine.enqueue('work');
  await eventWait(engine, 'started');
  assert.equal(engine.cancel(job.id), true);
  assert.equal(signal.aborted, true);
  assert.equal((await cancelled).job.state, 'cancelled');
});

test('a cancelled handler that resolves ends succeeded', async (t) => {
  const gate = deferred();
  const { engine } = setup(t, { work: async () => gate.promise });
  const done = eventWait(engine, 'succeeded');
  const job = engine.enqueue('work');
  await eventWait(engine, 'started');
  engine.cancel(job.id);
  gate.resolve('finished');
  assert.equal((await done).job.state, 'succeeded');
});

test('cancel returns false for a finished job', async (t) => {
  const { engine } = setup(t, { work: async () => undefined });
  const done = eventWait(engine, 'succeeded');
  const job = engine.enqueue('work');
  await done;
  assert.equal(engine.cancel(job.id), false);
});

test('start recovers running rows and runs queued rows', async (t) => {
  const db = openDatabase(':memory:');
  const engine = createJobEngine({ db, handlers: { work: async () => 'done' } });
  t.after(async () => {
    await engine.stop({ abort: true });
    db.close();
  });
  const stamp = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO jobs (created_at, updated_at, kind, state, params_json) VALUES (?, ?, 'work', ?, '{}')",
  );
  insert.run(stamp, stamp, 'running');
  insert.run(stamp, stamp, 'queued');
  const succeeded = eventWait(engine, 'succeeded', (job) => job.id === 2);
  assert.equal(engine.start(), 1);
  await succeeded;
  assert.equal(engine.get(1).state, 'interrupted');
  assert.equal(engine.get(1).error, 'The manager stopped while this job was running.');
  assert.equal(engine.get(2).state, 'succeeded');
  assert.equal(engine.start(), 0);
});

test('stop with abort interrupts running jobs and leaves queued jobs queued', async (t) => {
  let signal;
  const { engine } = setup(
    t,
    {
      work: ({ signal: value }) => {
        signal = value;
        return new Promise((resolve, reject) => value.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    },
    { concurrency: 1 },
  );
  engine.enqueue('work');
  const running = eventWait(engine, 'started');
  await running;
  engine.enqueue('work');
  await engine.stop({ abort: true });
  assert.equal(signal.aborted, true);
  assert.equal(engine.get(1).state, 'interrupted');
  assert.equal(engine.get(2).state, 'queued');
});

test('stop without abort waits for a running handler to finish', async (t) => {
  const gate = deferred();
  const { engine } = setup(t, { work: async () => gate.promise });
  const job = engine.enqueue('work');
  await eventWait(engine, 'started');
  let stopped = false;
  const stopping = engine.stop().then(() => {
    stopped = true;
  });
  gate.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(engine.get(job.id).state, 'succeeded');
});

test('progress emits each call while throttling database writes', async (t) => {
  const db = openDatabase(':memory:');
  let progressWrites = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith('UPDATE jobs SET progress = ?, message = ?')) return statement;
    return {
      run: (...args) => {
        progressWrites += 1;
        return statement.run(...args);
      },
    };
  };
  const gate = deferred();
  let report;
  const engine = createJobEngine({
    db,
    handlers: {
      work: ({ progress }) => {
        report = progress;
        return gate.promise;
      },
    },
    progressWriteMs: 60000,
  });
  t.after(async () => {
    await engine.stop({ abort: true });
    db.close();
  });
  engine.start();
  const events = [];
  engine.subscribe((event) => {
    if (event.type === 'progress') events.push(event);
  });
  const started = eventWait(engine, 'started');
  engine.enqueue('work');
  await started;
  for (let index = 0; index < 100; index += 1) report(index / 100, `step ${index}`);
  assert.equal(events.length, 100);
  assert.equal(events.at(-1).job.message, 'step 99');
  // The first call writes; the other 99 fall inside the window and share one pending write.
  assert.equal(progressWrites, 1);
  gate.resolve();
});

test('progress clamps fractions, rejects invalid types, and redacts messages', async (t) => {
  let report;
  const gate = deferred();
  const { engine } = setup(t, {
    work: ({ progress }) => {
      report = progress;
      return gate.promise;
    },
  });
  const observed = [];
  engine.subscribe((event) => {
    if (event.type === 'progress') observed.push(event.job);
  });
  const done = eventWait(engine, 'succeeded');
  engine.enqueue('work');
  await eventWait(engine, 'started');
  report(-1, 'ServerPassword=secret');
  assert.throws(() => report('bad'), TypeError);
  report(2);
  assert.equal(observed[0].progress, 0);
  assert.equal(observed[0].message, 'ServerPassword=********');
  assert.equal(observed[1].progress, 1);
  gate.resolve();
  await done;
});

test('events increase sequence and throwing listeners do not affect others', async (t) => {
  const { engine } = setup(t, { work: async () => undefined });
  const sequences = [];
  engine.subscribe(() => {
    throw new Error('listener');
  });
  engine.subscribe((event) => sequences.push(event.seq));
  const done = eventWait(engine, 'succeeded');
  engine.enqueue('work');
  await done;
  assert.ok(sequences.length >= 3);
  assert.deepEqual(
    sequences,
    sequences.map((_, i) => sequences[0] + i),
  );
});

test('list filters states and server and sorts newest first', (t) => {
  const { engine } = setup(t, { work: async () => undefined });
  const a = engine.enqueue('work', {}, { serverId: 1 });
  const b = engine.enqueue('work', {}, { serverId: 2 });
  const c = engine.enqueue('work', {}, { serverId: 1 });
  assert.deepEqual(
    engine.list({ state: 'queued' }).map((job) => job.id),
    [c.id, b.id, a.id],
  );
  assert.deepEqual(
    engine.list({ state: ['queued', 'running'], serverId: 1 }).map((job) => job.id),
    [c.id, a.id],
  );
});

test('a result that cannot be saved ends the job failed instead of leaving it running', async (t) => {
  const circular = {};
  circular.self = circular;
  const { engine } = setup(t, { work: async () => circular });
  const failed = eventWait(engine, 'failed');
  const job = engine.enqueue('work');
  const event = await failed;
  assert.equal(event.job.id, job.id);
  assert.match(event.job.error, /could not be saved/);
  assert.equal(engine.get(job.id).state, 'failed');
});

test('a job scheduled weeks ahead waits quietly instead of spinning the timer', async (t) => {
  const db = openDatabase(':memory:');
  let timerQueries = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes('MIN(run_after)')) return statement;
    return {
      get: (...args) => {
        timerQueries += 1;
        return statement.get(...args);
      },
    };
  };
  const engine = createJobEngine({ db, handlers: { work: async () => 'done' } });
  t.after(async () => {
    await engine.stop({ abort: true });
    db.close();
  });
  engine.start();
  const sixtyDays = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  engine.enqueue('work', {}, { runAfter: sixtyDays });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A timer that overflowed would fire every millisecond and query about 200 times here.
  assert.ok(timerQueries < 5, `timer queried ${timerQueries} times`);
  assert.equal(engine.list()[0].state, 'queued');
});

test('the last progress value reaches the database after a burst goes quiet', async (t) => {
  const gate = deferred();
  const { db, engine } = setup(
    t,
    {
      work: async (ctx) => {
        for (let i = 1; i <= 50; i++) ctx.progress(i / 100, `step ${i}`);
        return gate.promise;
      },
    },
    { progressWriteMs: 50 },
  );
  const started = eventWait(engine, 'started');
  const job = engine.enqueue('work');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const row = db.prepare('SELECT progress, message FROM jobs WHERE id = ?').get(job.id);
  assert.equal(row.progress, 0.5);
  assert.equal(row.message, 'step 50');
  gate.resolve();
});

test('a job whose final write fails keeps its server busy and raises no unhandled rejection', async (t) => {
  const db = openDatabase(':memory:');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO hosts (created_at, updated_at, name) VALUES (?, ?, ?)').run(stamp, stamp, 'host');
  for (const [index, port] of [7777, 7787].entries()) {
    db.prepare('INSERT INTO installs (created_at, updated_at, host_id, path) VALUES (?, ?, 1, ?)').run(
      stamp,
      stamp,
      `install-${index}`,
    );
    db.prepare(
      'INSERT INTO servers (created_at, updated_at, host_id, install_id, name, map, session_name, game_port) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
    ).run(stamp, stamp, index + 1, `s${port}`, 'TheIsland', `s${port}`, port);
  }
  let failWrites = true;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith('UPDATE jobs SET state = ?, progress = ?')) return statement;
    return {
      run: (...args) => {
        if (failWrites) throw new Error('disk full');
        return statement.run(...args);
      },
    };
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const engine = createJobEngine({
    db,
    handlers: {
      work: async () => {
        throw new Error('boom');
      },
      wait: () => new Promise(() => {}),
    },
    concurrency: 5,
  });
  t.after(async () => {
    process.off('unhandledRejection', onUnhandled);
    await engine.stop({ abort: true, timeoutMs: 50 });
    db.close();
  });
  engine.start();
  const first = engine.enqueue('work', {}, { serverId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  failWrites = false;
  const sameServer = engine.enqueue('work', {}, { serverId: 1 });
  const started = eventWait(engine, 'started');
  const otherServer = engine.enqueue('wait', {}, { serverId: 2 });
  assert.equal((await started).job.id, otherServer.id);
  assert.equal(engine.get(first.id).state, 'running');
  assert.equal(engine.get(sameServer.id).state, 'queued');
  assert.deepEqual(unhandled, []);
});

test('runAfter must be a valid date and is stored in the canonical format', (t) => {
  const { engine } = setup(t, { work: async () => {} });
  assert.throws(() => engine.enqueue('work', {}, { runAfter: 'next tuesday' }), TypeError);
  const fromOffset = engine.enqueue('work', {}, { runAfter: '2099-01-01T02:00:00+02:00' });
  assert.equal(fromOffset.runAfter, '2099-01-01T00:00:00.000Z');
  const fromDate = engine.enqueue('work', {}, { runAfter: new Date(Date.UTC(2099, 0, 2)) });
  assert.equal(fromDate.runAfter, '2099-01-02T00:00:00.000Z');
});

test('stop gives up waiting after timeoutMs when a handler ignores its signal', async (t) => {
  const { engine } = setup(t, { stuck: () => new Promise(() => {}) });
  const started = eventWait(engine, 'started');
  engine.enqueue('stuck');
  await started;
  const began = Date.now();
  await engine.stop({ abort: true, timeoutMs: 50 });
  assert.ok(Date.now() - began < 1000);
});

test('an engine started again after stop resumes queued work', async (t) => {
  const { engine } = setup(t, { work: async () => 'done' });
  await engine.stop();
  const job = engine.enqueue('work');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.get(job.id).state, 'queued');
  const succeeded = eventWait(engine, 'succeeded');
  assert.equal(engine.start(), 0);
  assert.equal((await succeeded).job.id, job.id);
});
