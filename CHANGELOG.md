# Changelog

All notable platform changes are documented in this file.

## [0.3.0] - 2026-02-23

### Platform-wide
- Reorganized core services under `core/` and updated references across docs/build paths.
- Completed YAML-first stack configuration migration and removed JSON bridge compatibility layers.
- Moved runtime artifacts to state-rooted fallback assets with safer compose/caddy fallback behavior.

### Core services
- **admin**
  - Reorganized admin library modules for clearer `src` ownership.
  - Improved setup completion flow to start core services reliably.
  - Hardened compose runner runtime-env/path handling and healthcheck URL alignment.
- **gateway**
  - Updated paths and integration behavior after core directory migration.
  - Kept channel intake + routing aligned with v0.3 config/runtime layout.
- **assistant**
  - Updated core pathing and packaging references as part of core migration.

### Channels
- Updated credential management endpoints for chat, discord, telegram, voice, and webhook adapters.
- Updated channel build/runtime references to align with v0.3 directory and stack changes.

### Packages
- **lib/cli/ui**
  - Migrated root assets into embedded `lib`/`cli` resources.
  - Removed stale stack-spec bridge code and resolved schema validation regressions.
  - Fixed UI/server shared library pathing mismatches introduced during migration.

### Reliability and quality
- Addressed brittle build/test paths after rebase and stack migration.
- Fixed container healthchecks and integration URL expectations.

### Reference commits
- `aea78d1`, `77a084e`, `8584f52`, `3caf604`, `6220e11`, `3fc50d0`, `2ec9074`, `200a61b`, `7893c9c`, `8e52038`, `2cf1cae`, `de34672`, `d5902df`, `fe2b7ff`
