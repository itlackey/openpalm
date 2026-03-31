# backups/

Snapshot backups created during stack upgrades and configuration changes.

When the CLI or admin performs an upgrade, it snapshots the current state
of critical files (compose overlays, env schemas, stack.yml) before
applying changes. If something goes wrong, the snapshot can be used to
restore the previous working state.

## Structure

Each backup is stored in a timestamped subdirectory:

```
backups/
  2026-03-20T15-30-00-000Z/
    stack/core.compose.yml
    vault/user/user.env.schema
    vault/stack/stack.env.schema
    ...
```

## Usage

Backups are managed automatically. To restore manually:

```bash
# List available backups
ls ~/.openpalm/backups/

# Restore a specific backup (stop services first, then restart)
# See docs/operations/manual-compose-runbook.md for the full compose command
docker compose --project-name openpalm -f ~/.openpalm/stack/core.compose.yml down
cp -r ~/.openpalm/backups/<timestamp>/* ~/.openpalm/
docker compose --project-name openpalm -f ~/.openpalm/stack/core.compose.yml up -d
```

This directory is excluded from version control. Only this README is tracked.
