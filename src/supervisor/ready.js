import fsPromises from 'node:fs/promises';
import { defaultSleep } from '../scheduler/countdown.js';

// ASA writes this line to its log once the world is loaded and players can join.
export const READY_LINE = 'Server has completed startup and is now advertising for join';
export const READY_MESSAGES = {
  stopped: 'The server closed before the world finished loading.',
  timeout: 'The world was still loading after {minutes} minutes, so ARK Overseer stopped waiting.',
};
// A log grows for as long as the server runs, and the line is written once, early on.
const TAIL_BYTES = 1024 * 1024;

// What identifies the log a server is about to replace or add to: taken before the start, so a ready line
// that is already in the file is never mistaken for the new one. Null when there is no log yet.
export async function readLogMarker(logPath, fs = fsPromises) {
  try {
    const info = await fs.stat(logPath);
    return { size: info.size, birthtimeMs: info.birthtimeMs, ino: info.ino };
  } catch {
    return null;
  }
}

// The same file, grown or unchanged. A file that was replaced has another identity, and one that was cut
// down is shorter than the marker.
const sameLog = (marker, info) =>
  marker.birthtimeMs === info.birthtimeMs && marker.ino === info.ino && info.size >= marker.size;

// True when the log was written at or after `since` and the ready line is in what counts as new: the whole
// tail of a replaced log, or only what follows the marker in the log that was already there. The tail
// reaches back a line's length past the last megabyte, so the line is never cut in two. A log that is
// missing or cannot be read yet counts as not ready; the next poll looks again.
async function logIsReady(fs, logPath, since, marker) {
  let handle;
  try {
    const info = await fs.stat(logPath);
    if (info.mtimeMs < since) return false;
    const tailStart = Math.max(0, info.size - TAIL_BYTES - READY_LINE.length);
    const start = marker && sameLog(marker, info) ? Math.max(marker.size, tailStart) : tailStart;
    const length = info.size - start;
    if (length <= 0) return false;
    handle = await fs.open(logPath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).includes(READY_LINE);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Resolves once the server's log says it finished starting. `since` is a time in milliseconds taken
// just before the start, and `marker` (from readLogMarker, also taken before the start) says which log
// was there, so the line left by the previous run never counts.
export async function waitForReady({
  logPath,
  since,
  marker = null,
  timeoutMs = 20 * 60000,
  pollMs = 5000,
  isAlive,
  signal,
  sleep = defaultSleep,
  now = () => Date.now(),
  fs = fsPromises,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    if (!(await isAlive())) throw new Error(READY_MESSAGES.stopped);
    if (await logIsReady(fs, logPath, since, marker)) return { ready: true };
    const left = deadline - now();
    if (left <= 0) throw new Error(READY_MESSAGES.timeout.replace('{minutes}', () => Math.round(timeoutMs / 60000)));
    await sleep(Math.min(pollMs, left), signal);
  }
}
