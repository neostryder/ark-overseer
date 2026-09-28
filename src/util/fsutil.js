// File helpers shared by the dashboard, ark-cli.js and the relay.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Write to a temp file in the same folder, flush it, then rename it over the target. A crash or a
// full disk mid-write leaves the old file intact instead of a truncated one. On Windows the rename
// can fail briefly with EPERM or EBUSY while another process (an editor, antivirus, the game
// reading its ini) has the target open, so it is retried a few times before giving up.
export function writeFileAtomic(target, data) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  // The replacement keeps the target's permission bits, since GameUserSettings.ini holds the admin
  // password and may have been locked down.
  let mode = 0o666;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* new file */
  }
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  fs.closeSync(fd);
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    /* already gone */
  }
  throw lastErr;
}
