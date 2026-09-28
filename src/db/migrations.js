import { transaction } from './transaction.js';

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE hosts (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local', 'remote')),
        address TEXT,
        gaming_mode INTEGER NOT NULL DEFAULT 0 CHECK (gaming_mode IN (0, 1))
      );

      CREATE TABLE installs (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        path TEXT NOT NULL,
        app_id INTEGER NOT NULL DEFAULT 2430930,
        build_id TEXT,
        branch TEXT NOT NULL DEFAULT 'public',
        state TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('missing', 'installing', 'installed', 'updating', 'validating', 'broken')),
        UNIQUE (host_id, path)
      );

      CREATE TABLE clusters (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        cluster_key TEXT NOT NULL UNIQUE,
        shared_dir TEXT
      );

      CREATE TABLE servers (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
        install_id INTEGER NOT NULL REFERENCES installs(id) ON DELETE RESTRICT,
        cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
        name TEXT NOT NULL UNIQUE,
        map TEXT NOT NULL,
        session_name TEXT NOT NULL,
        game_port INTEGER NOT NULL CHECK (game_port BETWEEN 1 AND 65534),
        query_port INTEGER CHECK (query_port IS NULL OR query_port BETWEEN 1 AND 65535),
        rcon_port INTEGER CHECK (rcon_port IS NULL OR rcon_port BETWEEN 1 AND 65535),
        max_players INTEGER NOT NULL DEFAULT 70,
        desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('stopped', 'running')),
        observed_state TEXT NOT NULL DEFAULT 'stopped' CHECK (observed_state IN ('stopped', 'starting', 'running', 'unknown', 'stopping', 'crashed')),
        state_changed_at TEXT,
        pid INTEGER,
        pid_started_at TEXT,
        settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
        UNIQUE (host_id, game_port)
      );

      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
        install_id INTEGER REFERENCES installs(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
        progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
        message TEXT,
        params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        run_after TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX idx_jobs_queue ON jobs(state, run_after);
      CREATE INDEX idx_jobs_server ON jobs(server_id, created_at);

      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('restart', 'update_check', 'auto_update', 'backup')),
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);

      CREATE TABLE backups (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        reason TEXT NOT NULL CHECK (reason IN ('manual', 'scheduled', 'pre_update', 'pre_restore', 'pre_import', 'pre_rollback')),
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        last_login_at TEXT
      );

      CREATE TABLE user_passkeys (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
        transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
        label TEXT,
        last_used_at TEXT
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_kind TEXT,
        target_id INTEGER,
        detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
      );
      CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
    `,
  },
  {
    version: 2,
    name: 'install_source',
    up: "ALTER TABLE installs ADD COLUMN source TEXT NOT NULL DEFAULT 'steamcmd' CHECK (source IN ('steamcmd', 'steam-client'));",
  },
  {
    version: 3,
    name: 'auth',
    up: `ALTER TABLE users ADD COLUMN session_secret BLOB;
      ALTER TABLE users ADD COLUMN webauthn_id TEXT;
      ALTER TABLE user_passkeys ADD COLUMN rp_id TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 4,
    name: 'automation',
    up: `ALTER TABLE installs ADD COLUMN latest_build_id TEXT;
      ALTER TABLE installs ADD COLUMN update_checked_at TEXT;
      ALTER TABLE schedules ADD COLUMN last_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_schedules_server_kind ON schedules(server_id, kind);`,
  },
  {
    version: 5,
    name: 'gaming_mode',
    up: `ALTER TABLE hosts ADD COLUMN gaming_priority TEXT NOT NULL DEFAULT 'BelowNormal' CHECK (gaming_priority IN ('Idle', 'BelowNormal'));
      ALTER TABLE hosts ADD COLUMN gaming_game_cores INTEGER;
      ALTER TABLE hosts ADD COLUMN gaming_games_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(gaming_games_json));
      ALTER TABLE hosts ADD COLUMN gaming_ignore_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(gaming_ignore_json));
      ALTER TABLE hosts ADD COLUMN gaming_applied_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(gaming_applied_json));`,
  },
];

// Versions start at 1 with no gaps, so a typo in a version number fails at startup rather than
// recording a schema no other install can reproduce.
function validateMigrations() {
  MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `MIGRATIONS versions must start at 1 with no gaps; entry ${index} has version ${migration.version}`,
      );
    }
  });
}

export function migrate(db) {
  validateMigrations();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const highestKnown = MIGRATIONS.length;
  const highestRecorded = db.prepare('SELECT MAX(version) AS version FROM schema_migrations');
  const hasVersion = db.prepare('SELECT 1 AS found FROM schema_migrations WHERE version = ?');
  const insertVersion = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const applied = [];

  for (const migration of MIGRATIONS) {
    // Every check runs inside the write lock. Two processes opening a new file at once would
    // otherwise both see version 1 missing, and the second would fail on CREATE TABLE.
    transaction(db, () => {
      const recorded = highestRecorded.get().version ?? 0;
      if (recorded > highestKnown) {
        throw new Error(`Database schema version ${recorded} is newer than supported version ${highestKnown}`);
      }
      if (hasVersion.get(migration.version)) return;
      db.exec(migration.up);
      insertVersion.run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    });
  }

  return applied;
}
