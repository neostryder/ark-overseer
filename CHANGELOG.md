# Changelog

All notable changes to ARK Overseer are listed here.

## [Unreleased]

### Added

- [Internal] [Data] **SQLite database with versioned migrations.** It stores hosts, installs, servers, clusters, jobs, schedules, backups, users with their passkeys, and the audit log. It refuses to open a database written by a newer version.
- [Internal] [Settings] **Settings engine for GameUserSettings.ini and Game.ini.** It covers all 346 documented server options, changes only the keys a save names, and keeps each file's encoding, byte order mark and line endings. A key missing from the file reads as unset, never as zero. `npm run check` confirms every documented option is either a field or listed as editable only in the raw INI.
- [Internal] [Security] **Settings validation refuses line breaks, number fields holding anything but a plain number, and changes to locked fields.** A request can no longer slip its own keys into an INI file.
- [Internal] [Settings] **Local semantic search over the settings catalog.** A failed model download is retried on the next search instead of failing until restart.
