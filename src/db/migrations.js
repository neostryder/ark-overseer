import { transaction } from './transaction.js';
import path from 'node:path';

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
  {
    version: 6,
    name: 'maps',
    up: 'ALTER TABLE hosts ADD COLUMN show_map_art INTEGER NOT NULL DEFAULT 1 CHECK (show_map_art IN (0, 1));',
    // ASA keeps a server's settings and saves inside its install, so two servers on one install would
    // overwrite each other. A database that already holds such a pair keeps working without the index,
    // and the API check still refuses a new one.
    after(db) {
      if (!db.prepare('SELECT 1 FROM servers GROUP BY install_id HAVING count(*) > 1 LIMIT 1').get())
        db.exec('CREATE UNIQUE INDEX idx_servers_install ON servers(install_id)');
    },
  },
  {
    version: 7,
    name: 'map_switching',
    // SQLite cannot change a CHECK in place, so the table is rebuilt with the wider list and every row
    // and id is copied across. Nothing else refers to backups, and it has no index besides the one
    // its UNIQUE path creates.
    up: `
      CREATE TABLE backups_new (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        reason TEXT NOT NULL CHECK (reason IN ('manual', 'scheduled', 'pre_update', 'pre_restore', 'pre_import', 'pre_rollback', 'pre_switch')),
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT
      );
      INSERT INTO backups_new (id, created_at, server_id, job_id, reason, path, size_bytes, sha256)
        SELECT id, created_at, server_id, job_id, reason, path, size_bytes, sha256 FROM backups;
      DROP TABLE backups;
      ALTER TABLE backups_new RENAME TO backups;

      -- A map switch that has not finished. The row is written before the server is stopped and removed
      -- once the switch is settled, so a restart in between can put the old map back.
      CREATE TABLE pending_switches (
        server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        job_id INTEGER,
        from_map TEXT NOT NULL,
        from_mods_json TEXT NOT NULL,
        to_map TEXT NOT NULL,
        was_running INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );`,
  },
  {
    version: 8,
    name: 'restore',
    // A backup's map is filled in for new backups; an older row keeps NULL until the API reads the map
    // from the backup's manifest and writes it back, since SQL cannot open the file. Names of settings
    // snapshots ignore letter case, so "Base" and "base" cannot both exist for one server.
    up: `
      ALTER TABLE backups ADD COLUMN map TEXT;
      ALTER TABLE backups ADD COLUMN note TEXT;

      CREATE TABLE settings_snapshots (
        id INTEGER PRIMARY KEY,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 64),
        created_at TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER,
        sha256 TEXT
      );
      CREATE UNIQUE INDEX idx_settings_snapshots_name ON settings_snapshots(server_id, name);

      -- A restore that has not finished. The row is written before the server is stopped and removed once
      -- the restore is settled, so a restart in between can put the files back.
      CREATE TABLE pending_restores (
        server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        job_id INTEGER,
        backup_id INTEGER,
        scope TEXT NOT NULL,
        safety_backup_id INTEGER,
        was_running INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        stage TEXT NOT NULL
      );`,
  },
  {
    version: 9,
    name: 'settings_drift',
    // The baseline is what ARK Overseer last wrote or accepted in the settings files; the drift row says the
    // files no longer match it. Both go with their server. `pending_json` names what still has to be taken into
    // the baseline after a record failed, so the last good baseline is kept meanwhile.
    up: `
      CREATE TABLE settings_baselines (
        server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        source TEXT NOT NULL,
        pending_json TEXT CHECK (pending_json IS NULL OR json_valid(pending_json))
      );

      CREATE TABLE settings_drift (
        server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        detected_at TEXT NOT NULL,
        live_sha256 TEXT NOT NULL,
        seen_at TEXT,
        after_stop INTEGER NOT NULL DEFAULT 0 CHECK (after_stop IN (0, 1))
      );`,
  },
  {
    version: 10,
    name: 'clusters',
    up: `
      ALTER TABLE clusters ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json));
      ALTER TABLE clusters ADD COLUMN notes TEXT;
      ALTER TABLE servers ADD COLUMN cluster_overrides_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cluster_overrides_json));
      ALTER TABLE jobs ADD COLUMN targets_json TEXT NOT NULL DEFAULT '{"servers":[],"installs":[]}' CHECK (json_valid(targets_json));

      CREATE TABLE schedules_new (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        cluster_id INTEGER REFERENCES clusters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('restart', 'update_check', 'auto_update', 'backup', 'cluster_restart')),
        cron TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
        last_run_at TEXT,
        next_run_at TEXT,
        last_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        CHECK ((server_id IS NOT NULL AND cluster_id IS NULL AND kind != 'cluster_restart') OR
               (server_id IS NULL AND cluster_id IS NOT NULL AND kind = 'cluster_restart'))
      );
      INSERT INTO schedules_new (id, created_at, updated_at, server_id, kind, cron, enabled,
        options_json, last_run_at, next_run_at, last_job_id)
        SELECT id, created_at, updated_at, server_id, kind, cron, enabled,
          options_json, last_run_at, next_run_at, last_job_id FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules_new RENAME TO schedules;
      CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
      CREATE UNIQUE INDEX idx_schedules_server_kind ON schedules(server_id, kind);
      CREATE UNIQUE INDEX idx_schedules_cluster_kind ON schedules(cluster_id, kind);`,
    after(db, { dataDir }) {
      const folder = dataDir ?? path.win32.join(process.env.ProgramData || 'C:\\ProgramData', 'ARK Overseer');
      for (const row of db
        .prepare("SELECT id, cluster_key FROM clusters WHERE shared_dir IS NULL OR shared_dir = ''")
        .all())
        db.prepare('UPDATE clusters SET shared_dir = ? WHERE id = ?').run(
          path.win32.join(folder, 'clusters', row.cluster_key),
          row.id,
        );
    },
  },
  {
    version: 11,
    name: 'pending_transfers',
    up: `
      CREATE TABLE pending_moves (
        job_id INTEGER PRIMARY KEY,
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        was_running INTEGER NOT NULL CHECK (was_running IN (0, 1)),
        stage TEXT NOT NULL
      );
      CREATE TABLE pending_clones (
        job_id INTEGER PRIMARY KEY,
        install_id INTEGER NOT NULL,
        target_path TEXT NOT NULL,
        created_root INTEGER NOT NULL DEFAULT 0,
        server_id INTEGER
      );
      CREATE TABLE pending_clone_paths (
        job_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
        PRIMARY KEY (job_id, relative_path)
      );`,
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

export function migrate(db, options = {}) {
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
      // For a step SQL alone cannot express, such as an index that depends on the data already there.
      migration.after?.(db, options);
      insertVersion.run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    });
  }

  return applied;
}
