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
    // busy_timeout comes first so the WAL switch and the migrations wait out another process's lock.
    db.exec('PRAGMA busy_timeout = 5000');
    if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}
