import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

export { transaction } from './transaction.js';

export function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  try {
    // busy_timeout comes first so the migrations wait out another process's lock.
    db.exec('PRAGMA busy_timeout = 5000');
    if (filePath !== ':memory:') enableWal(db);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, { dataDir: filePath === ':memory:' ? undefined : path.dirname(path.resolve(filePath)) });
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// SQLite does not apply busy_timeout to the journal mode switch, so two processes opening a new file
// at the same moment can see "database is locked" here. It is retried for up to five seconds.
function enableWal(db) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!/locked|busy/i.test(error.message) || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}
