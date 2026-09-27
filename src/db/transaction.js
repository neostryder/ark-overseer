// Runs fn inside BEGIN IMMEDIATE so a second writer waits on busy_timeout instead of failing halfway
// through. If ROLLBACK itself fails (SQLite may already have rolled back after an I/O or constraint
// error), the original error is the one worth reporting, so it is rethrown instead.
//
// fn must be synchronous: node:sqlite is synchronous, and an awaited step would let COMMIT run before
// the work finished. Nesting is refused up front, because a failed inner BEGIN would otherwise roll
// back the outer transaction's work.
export function transaction(db, fn) {
  if (db.isTransaction) throw new Error('transaction() cannot be nested');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (typeof result?.then === 'function') {
      throw new TypeError('transaction() needs a synchronous callback');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
    }
    throw error;
  }
}
