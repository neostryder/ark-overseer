import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openDatabase, transaction } from '../src/db/index.js';
import { migrate, MIGRATIONS } from '../src/db/migrations.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function withDatabase(fn) {
  const db = openDatabase(':memory:');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function addHost(db, name = 'host') {
  return Number(
    db.prepare('INSERT INTO hosts (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, timestamp, timestamp)
      .lastInsertRowid,
  );
}

function addInstall(db, hostId, state = 'installed') {
  return Number(
    db
      .prepare('INSERT INTO installs (host_id, path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(hostId, `C:/servers/${hostId}`, state, timestamp, timestamp).lastInsertRowid,
  );
}

function addServer(db, hostId, installId, name = 'server', gamePort = 7777) {
  return Number(
    db
      .prepare(
        `
    INSERT INTO servers (host_id, install_id, name, map, session_name, game_port, created_at, updated_at)
    VALUES (?, ?, ?, 'TheIsland', ?, ?, ?, ?)
  `,
      )
      .run(hostId, installId, name, name, gamePort, timestamp, timestamp).lastInsertRowid,
  );
}

test('fresh database applies the initial migration once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const expected = [
      'hosts',
      'installs',
      'clusters',
      'servers',
      'jobs',
      'schedules',
      'backups',
      'users',
      'user_passkeys',
      'audit_events',
      'schema_migrations',
    ];
    assert.deepEqual(migrate(db), [1, 2, 3, 4]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .sort();
    assert.deepEqual(tables, expected.sort());
    assert.deepEqual(migrate(db), []);
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version),
      [1, 2, 3, 4],
    );
  } finally {
    db.close();
  }
});

test('migration 2 adds a checked install source and upgrades a version 1 database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MIGRATIONS[0].up);
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run('initial', timestamp);
    assert.deepEqual(migrate(db), [2, 3, 4]);
    const hostId = Number(
      db.prepare('INSERT INTO hosts (name, created_at, updated_at) VALUES (?, ?, ?)').run('h', timestamp, timestamp)
        .lastInsertRowid,
    );
    addInstall(db, hostId);
    assert.equal(db.prepare('SELECT source FROM installs').get().source, 'steamcmd');
    assert.throws(() => db.prepare("UPDATE installs SET source = 'other'").run(), /CHECK constraint failed/);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
  } finally {
    db.close();
  }
});

test('migration 3 adds auth columns and upgrades a version 2 database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MIGRATIONS[0].up);
    db.exec(MIGRATIONS[1].up);
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run('initial', timestamp);
    db.prepare('INSERT INTO schema_migrations VALUES (2, ?, ?)').run('install_source', timestamp);
    assert.deepEqual(migrate(db), [3, 4]);
    const userColumns = db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((row) => row.name);
    const passkey = db
      .prepare('PRAGMA table_info(user_passkeys)')
      .all()
      .find((row) => row.name === 'rp_id');
    assert.ok(userColumns.includes('session_secret'));
    assert.ok(userColumns.includes('webauthn_id'));
    assert.equal(passkey.notnull, 1);
    assert.equal(passkey.dflt_value, "''");
    assert.equal(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get().version, 4);
  } finally {
    db.close();
  }
});

test('migration 4 adds automation columns and indexes while keeping version 3 rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      MIGRATIONS.slice(0, 3)
        .map((migration) => migration.up)
        .join('\n'),
    );
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.slice(0, 3))
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, timestamp);
    const hostId = addHost(db);
    const installId = addInstall(db, hostId);
    const serverId = addServer(db, hostId, installId);
    db.prepare(
      "INSERT INTO schedules (server_id, kind, cron, created_at, updated_at) VALUES (?, 'backup', '0 2 * * *', ?, ?)",
    ).run(serverId, timestamp, timestamp);
    assert.deepEqual(migrate(db), [4]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schedules').get().count, 1);
    assert.equal(
      db.prepare('SELECT source, latest_build_id, update_checked_at FROM installs').get().source,
      'steamcmd',
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO schedules (server_id, kind, cron, created_at, updated_at) VALUES (?, 'backup', '* * * * *', ?, ?)",
          )
          .run(serverId, timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('foreign keys are enabled and reject missing hosts', () => {
  withDatabase((db) => {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.throws(() => addServer(db, 999, 999), /FOREIGN KEY constraint failed/);
  });
});

test('enum and port checks reject invalid values', () => {
  withDatabase((db) => {
    const hostId = addHost(db);
    const installId = addInstall(db, hostId);
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO jobs (kind, state, created_at, updated_at) VALUES ('update', 'bogus', ?, ?)")
          .run(timestamp, timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(() => addInstall(db, hostId, 'bogus'), /CHECK constraint failed/);
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO schedules (kind, cron, created_at, updated_at) VALUES ('bogus', '* * * * *', ?, ?)")
          .run(timestamp, timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        db.prepare("INSERT INTO backups (reason, path, created_at) VALUES ('bogus', 'backup.zip', ?)").run(timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO users (username, role, created_at, updated_at) VALUES ('bad-role', 'bogus', ?, ?)")
          .run(timestamp, timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO jobs (kind, params_json, created_at, updated_at) VALUES ('update', 'not json', ?, ?)")
          .run(timestamp, timestamp),
      /CHECK constraint failed/,
    );
    // 65535 is refused because its peer port, game_port + 1, would not exist.
    for (const port of [0, 65535, 70000]) {
      assert.throws(() => addServer(db, hostId, installId, `bad-${port}`, port), /CHECK constraint failed/);
    }
  });
});

test('game port is unique per host', () => {
  withDatabase((db) => {
    const firstHost = addHost(db, 'first');
    const firstInstall = addInstall(db, firstHost);
    addServer(db, firstHost, firstInstall, 'one', 7777);
    assert.throws(() => addServer(db, firstHost, firstInstall, 'two', 7777), /UNIQUE constraint failed/);

    const secondHost = addHost(db, 'second');
    const secondInstall = addInstall(db, secondHost);
    assert.doesNotThrow(() => addServer(db, secondHost, secondInstall, 'three', 7777));
  });
});

test('server deletion applies dependent row actions and host deletion is restricted', () => {
  withDatabase((db) => {
    const hostId = addHost(db);
    const installId = addInstall(db, hostId);
    const serverId = addServer(db, hostId, installId);
    const jobId = Number(
      db
        .prepare("INSERT INTO jobs (kind, server_id, created_at, updated_at) VALUES ('backup', ?, ?, ?)")
        .run(serverId, timestamp, timestamp).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO backups (server_id, job_id, reason, path, created_at) VALUES (?, ?, 'manual', 'backup.zip', ?)",
    ).run(serverId, jobId, timestamp);
    db.prepare(
      "INSERT INTO schedules (server_id, kind, cron, created_at, updated_at) VALUES (?, 'restart', '* * * * *', ?, ?)",
    ).run(serverId, timestamp, timestamp);

    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    assert.equal(db.prepare('SELECT server_id FROM jobs WHERE id = ?').get(jobId).server_id, null);
    assert.equal(db.prepare('SELECT server_id FROM backups').get().server_id, null);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schedules').get().count, 0);
    assert.throws(() => db.prepare('DELETE FROM hosts WHERE id = ?').run(hostId), /FOREIGN KEY constraint failed/);
  });
});

test('usernames are unique without regard to case', () => {
  withDatabase((db) => {
    db.prepare('INSERT INTO users (username, created_at, updated_at) VALUES (?, ?, ?)').run(
      'Aaron',
      timestamp,
      timestamp,
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO users (username, created_at, updated_at) VALUES (?, ?, ?)')
          .run('aaron', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
  });
});

test('transaction commits results and rolls back the same thrown error', () => {
  withDatabase((db) => {
    const result = transaction(db, () => {
      db.prepare('INSERT INTO hosts (name, created_at, updated_at) VALUES (?, ?, ?)').run(
        'committed',
        timestamp,
        timestamp,
      );
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(db.prepare('SELECT count(*) AS count FROM hosts').get().count, 1);

    const error = new Error('stop');
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('INSERT INTO hosts (name, created_at, updated_at) VALUES (?, ?, ?)').run(
            'rolled-back',
            timestamp,
            timestamp,
          );
          throw error;
        }),
      (caught) => caught === error,
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM hosts').get().count, 1);
  });
});

test('migration refuses a recorded schema version newer than this app', () => {
  withDatabase((db) => {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      5,
      'future',
      timestamp,
    );
    assert.throws(() => migrate(db), /version 5 is newer than supported version 4/);
  });
});

test('file database creates its parent and opens in WAL mode', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parent = path.join(directory, 'nested', 'db');
  const dbPath = path.join(parent, 'overseer.db');
  const db = openDatabase(dbPath);
  try {
    assert.equal(fs.existsSync(parent), true);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally {
    db.close();
  }
});

test('transaction refuses nesting and async callbacks without losing earlier work', () => {
  withDatabase((db) => {
    const insertHost = db.prepare('INSERT INTO hosts (name, created_at, updated_at) VALUES (?, ?, ?)');
    assert.throws(
      () =>
        transaction(db, () => {
          insertHost.run('outer', timestamp, timestamp);
          transaction(db, () => {});
        }),
      /cannot be nested/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS count FROM hosts').get().count, 0);

    assert.throws(
      () =>
        transaction(db, async () => {
          insertHost.run('async', timestamp, timestamp);
        }),
      TypeError,
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM hosts').get().count, 0);
  });
});

test('deleting a user deletes their passkeys', () => {
  withDatabase((db) => {
    const userId = Number(
      db
        .prepare('INSERT INTO users (username, created_at, updated_at) VALUES (?, ?, ?)')
        .run('admin', timestamp, timestamp).lastInsertRowid,
    );
    db.prepare('INSERT INTO user_passkeys (user_id, credential_id, public_key, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
      'cred-1',
      Buffer.from([1, 2, 3]),
      timestamp,
    );
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    assert.equal(db.prepare('SELECT count(*) AS count FROM user_passkeys').get().count, 0);
  });
});

test('several processes opening a new database file at once all succeed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-overseer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'overseer.db');
  const moduleUrl = new URL('../src/db/index.js', import.meta.url).href;
  const script = `import { openDatabase } from ${JSON.stringify(moduleUrl)}; openDatabase(${JSON.stringify(dbPath)}).close();`;

  const runs = Array.from(
    { length: 4 },
    () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
      }),
  );
  for (const result of await Promise.all(runs)) {
    assert.equal(result.code, 0, result.stderr);
  }

  const db = openDatabase(dbPath);
  try {
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => row.version),
      [1, 2, 3, 4],
    );
  } finally {
    db.close();
  }
});
