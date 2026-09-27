# Changelog

All notable changes to ARK Overseer are listed here.

## [Unreleased]

### Added

- [Internal] [Data] **SQLite database with versioned migrations.** It stores hosts, installs, servers, clusters, jobs, schedules, backups, users with their passkeys, and the audit log. It refuses to open a database written by a newer version.
