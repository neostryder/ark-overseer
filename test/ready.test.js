import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForReady, readLogMarker, READY_LINE, READY_MESSAGES } from '../src/supervisor/ready.js';

const SINCE = 1_800_000_000_000;

function logFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ShooterGame.log');
}
const write = (file, text, atMs) => {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, atMs / 1000, atMs / 1000);
};

// A clock that only moves when the wait sleeps, so no test waits in real time. `each` runs at every poll.
function clock({ each } = {}) {
  const state = { time: SINCE, polls: [] };
  return {
    state,
    now: () => state.time,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      state.polls.push(ms);
      state.time += ms;
      await each?.(state);
    },
  };
}

test('the ready line in a log written after the start resolves the wait', async (t) => {
  const logPath = logFolder(t);
  write(logPath, `[boot]\n${READY_LINE}\n`, SINCE + 1000);
  const { now, sleep, state } = clock();
  const result = await waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep, now });
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(state.polls, []);
});

test('the line is found on a later poll, once the server has written it', async (t) => {
  const logPath = logFolder(t);
  write(logPath, 'Loading the world\n', SINCE + 100);
  const { now, sleep, state } = clock({
    each: (s) => {
      if (s.polls.length === 3) write(logPath, `Loading the world\n${READY_LINE}\n`, s.time);
    },
  });
  await waitForReady({ logPath, since: SINCE, pollMs: 5000, isAlive: () => true, sleep, now });
  assert.deepEqual(state.polls, [5000, 5000, 5000]);
});

test('a line left in an earlier log does not count, and a log that does not exist yet is waited for', async (t) => {
  const logPath = logFolder(t);
  write(logPath, `${READY_LINE}\n`, SINCE - 60_000);
  const { now, sleep, state } = clock({
    each: (s) => {
      // The new run replaces the log with one that has no ready line yet, then adds it.
      if (s.polls.length === 2) write(logPath, 'Loading\n', s.time);
      if (s.polls.length === 4) write(logPath, `Loading\n${READY_LINE}\n`, s.time);
    },
  });
  await waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep, now });
  assert.equal(state.polls.length, 4);
  // A log that is not there yet is not an error.
  const missing = logFolder(t);
  const second = clock({ each: (s) => s.polls.length === 1 && write(missing, READY_LINE, s.time) });
  await waitForReady({ logPath: missing, since: SINCE, isAlive: () => true, sleep: second.sleep, now: second.now });
  assert.equal(second.state.polls.length, 1);
});

test('a server that is no longer alive fails the wait, and the check comes before the log is read', async (t) => {
  const logPath = logFolder(t);
  write(logPath, 'Loading\n', SINCE + 1);
  const answers = [true, true, false];
  const { now, sleep, state } = clock();
  await assert.rejects(waitForReady({ logPath, since: SINCE, isAlive: () => answers.shift(), sleep, now }), {
    message: READY_MESSAGES.stopped,
  });
  assert.equal(state.polls.length, 2);
  assert.equal(READY_MESSAGES.stopped, 'The server closed before the world finished loading.');
});

test('the wait ends with the timeout message once the time is up, without sleeping past it', async (t) => {
  const logPath = logFolder(t);
  write(logPath, 'Loading\n', SINCE + 1);
  const { now, sleep, state } = clock();
  await assert.rejects(
    waitForReady({ logPath, since: SINCE, timeoutMs: 120_000, pollMs: 50_000, isAlive: () => true, sleep, now }),
    { message: 'The world was still loading after 2 minutes, so ARK Overseer stopped waiting.' },
  );
  assert.deepEqual(state.polls, [50_000, 50_000, 20_000]);
  const long = clock();
  await assert.rejects(waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep: long.sleep, now: long.now }), {
    message: 'The world was still loading after 20 minutes, so ARK Overseer stopped waiting.',
  });
  assert.equal(
    long.state.polls.reduce((a, b) => a + b, 0),
    20 * 60000,
  );
});

test('an abort ends the wait with the abort reason, before or during a sleep', async (t) => {
  const logPath = logFolder(t);
  write(logPath, 'Loading\n', SINCE + 1);
  const reason = new Error('the job was cancelled');
  const before = new AbortController();
  before.abort(reason);
  const { now, sleep } = clock();
  await assert.rejects(
    waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep, now, signal: before.signal }),
    {
      message: 'the job was cancelled',
    },
  );
  const during = new AbortController();
  const late = clock({ each: (s) => s.polls.length === 2 && during.abort(reason) });
  await assert.rejects(
    waitForReady({
      logPath,
      since: SINCE,
      isAlive: () => true,
      sleep: late.sleep,
      now: late.now,
      signal: during.signal,
    }),
    (caught) => caught === reason,
  );
  assert.equal(late.state.polls.length, 2);
});

test('only the last megabyte of a large log is read, and a line near its end is found', async (t) => {
  const logPath = logFolder(t);
  const filler = `${'x'.repeat(99)}\n`.repeat(15_000);
  assert.ok(filler.length > 1024 * 1024);
  write(logPath, `${filler}${READY_LINE}\n${'y'.repeat(100)}\n`, SINCE + 1);
  const reads = [];
  const real = fs.promises;
  const spy = {
    stat: (file) => real.stat(file),
    open: async (file, mode) => {
      const handle = await real.open(file, mode);
      return {
        read: async (buffer, offset, length, position) => {
          reads.push([length, position]);
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  };
  const { now, sleep } = clock();
  await waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep, now, fs: spy });
  assert.equal(reads.length, 1);
  assert.equal(reads[0][0], 1024 * 1024 + READY_LINE.length);
  assert.equal(reads[0][1], fs.statSync(logPath).size - 1024 * 1024 - READY_LINE.length);
  // The same line further back than a megabyte from the end is out of reach.
  write(logPath, `${READY_LINE}\n${filler}`, SINCE + 1);
  const late = clock();
  await assert.rejects(
    waitForReady({ logPath, since: SINCE, timeoutMs: 10_000, isAlive: () => true, sleep: late.sleep, now: late.now }),
    /still loading/,
  );
});

test('a log that cannot be read leaves the wait going, and the file system can be replaced', async () => {
  let calls = 0;
  const fake = {
    stat: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return { size: READY_LINE.length + 1, mtimeMs: SINCE + 5 };
    },
    open: async () => ({
      read: async (buffer) => ({
        bytesRead: Buffer.from(
          `${READY_LINE}
`,
        ).copy(buffer),
      }),
      close: async () => {},
    }),
  };
  const { now, sleep, state } = clock();
  await waitForReady({ logPath: 'nowhere.log', since: SINCE, isAlive: () => true, sleep, now, fs: fake });
  assert.equal(state.polls.length, 1);
});

test('a log that only had the old ready line appended to does not count until a new one is written after it', async (t) => {
  const logPath = logFolder(t);
  write(logPath, `[previous run]\n${READY_LINE}\n`, SINCE - 60_000);
  const marker = await readLogMarker(logPath);
  assert.equal(marker.size, fs.statSync(logPath).size);
  // The server keeps writing to the same file. The old line is still in it, and its time is now recent.
  const { now, sleep, state } = clock({
    each: (s) => {
      if (s.polls.length === 1) write(logPath, `[previous run]\n${READY_LINE}\nLoading the world\n`, s.time);
      if (s.polls.length === 3)
        write(logPath, `[previous run]\n${READY_LINE}\nLoading the world\n${READY_LINE}\n`, s.time);
    },
  });
  await waitForReady({ logPath, since: SINCE, marker, isAlive: () => true, sleep, now });
  assert.equal(state.polls.length, 3);
  // Without the marker the old line would have counted at once.
  const unmarked = clock();
  write(logPath, `[previous run]\n${READY_LINE}\nLoading the world\n`, SINCE + 5);
  await waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep: unmarked.sleep, now: unmarked.now });
  assert.equal(unmarked.state.polls.length, 0);
});

test('a log that was replaced is read from the start of its tail, by identity or by being shorter', async () => {
  const body = Buffer.from(`Loading
${READY_LINE}
`);
  // A file of the given size that holds the body at its end.
  const filesystem = (info) => {
    const content = Buffer.concat([Buffer.alloc(info.size - body.length, 0x78), body]);
    return {
      stat: async () => ({ mtimeMs: SINCE + 10, ...info }),
      open: async () => ({
        read: async (buffer, offset, length, position) => ({
          bytesRead: content.copy(buffer, offset, position, position + length),
        }),
        close: async () => {},
      }),
    };
  };
  const marker = { size: 5000, birthtimeMs: 111, ino: 7 };
  const cases = {
    'another file id': { size: 6000, birthtimeMs: 111, ino: 8 },
    'another creation time': { size: 6000, birthtimeMs: 222, ino: 7 },
    'a shorter file': { size: 100, birthtimeMs: 111, ino: 7 },
  };
  for (const [name, info] of Object.entries(cases)) {
    const { now, sleep, state } = clock();
    await waitForReady({
      logPath: 'x.log',
      since: SINCE,
      marker,
      isAlive: () => true,
      sleep,
      now,
      fs: filesystem(info),
    });
    assert.equal(state.polls.length, 0, name);
  }
  // The same file with the line before the marker has nothing new in it, and one that grew past it does.
  const same = clock();
  await assert.rejects(
    waitForReady({
      logPath: 'x.log',
      since: SINCE,
      marker,
      timeoutMs: 10_000,
      isAlive: () => true,
      sleep: same.sleep,
      now: same.now,
      fs: filesystem({ size: 5000, birthtimeMs: 111, ino: 7 }),
    }),
    /still loading/,
  );
  const grown = clock();
  await waitForReady({
    logPath: 'x.log',
    since: SINCE,
    marker: { ...marker, size: 5000 - body.length - 1 },
    isAlive: () => true,
    sleep: grown.sleep,
    now: grown.now,
    fs: filesystem({ size: 5000, birthtimeMs: 111, ino: 7 }),
  });
  assert.equal(grown.state.polls.length, 0);
});

test('a ready line that straddles the last-megabyte boundary is still found', async (t) => {
  const logPath = logFolder(t);
  const megabyte = 1024 * 1024;
  // The line starts 10 bytes before the boundary, so a read of exactly the last megabyte would cut it.
  const before = 'x'.repeat(700_000);
  const tail = 'y'.repeat(megabyte + 10 - READY_LINE.length - 1);
  write(logPath, `${before}${READY_LINE}\n${tail}`, SINCE + 1);
  const size = fs.statSync(logPath).size;
  assert.equal(size - before.length, megabyte + 10);
  const { now, sleep } = clock();
  assert.deepEqual(await waitForReady({ logPath, since: SINCE, isAlive: () => true, sleep, now }), { ready: true });
  // A line that starts more than a line's length before the boundary is out of reach.
  write(
    logPath,
    `${'x'.repeat(700_000)}${READY_LINE}\n${'y'.repeat(megabyte + 100 - READY_LINE.length - 1)}`,
    SINCE + 1,
  );
  const far = clock();
  await assert.rejects(
    waitForReady({ logPath, since: SINCE, timeoutMs: 10_000, isAlive: () => true, sleep: far.sleep, now: far.now }),
    /still loading/,
  );
});

test('the log marker holds the size and identity, and is null when there is no log', async (t) => {
  const logPath = logFolder(t);
  assert.equal(await readLogMarker(logPath), null);
  write(logPath, 'twelve bytes', SINCE);
  const marker = await readLogMarker(logPath);
  assert.equal(marker.size, 12);
  assert.equal(typeof marker.birthtimeMs, 'number');
  assert.equal(marker.ino, fs.statSync(logPath).ino);
});
