import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/db/index.js';

test('list-install-folders prints install paths and prints nothing when empty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-folders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let db = openDatabase(path.join(root, 'overseer.db'));
  db.close();
  const run = () =>
    spawnSync(process.execPath, ['tools/list-install-folders.js', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(run().stdout, '');
  db = openDatabase(path.join(root, 'overseer.db'));
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (1, 'local', ?, ?)").run(stamp, stamp);
  const insert = db.prepare('INSERT INTO installs (host_id, path, created_at, updated_at) VALUES (1, ?, ?, ?)');
  insert.run('C:\\ARK\\One', stamp, stamp);
  insert.run('D:\\ARK\\Two', stamp, stamp);
  db.close();
  const result = run();
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['C:\\ARK\\One', 'D:\\ARK\\Two']);
});
