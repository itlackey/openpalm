# Upgrade Guide

How to upgrade OpenPalm to a new version.

## Before you upgrade

1. **Back up your data.** Follow the [Backup & Restore guide](backup-restore.md) to create a full backup before upgrading.

2. **Check the release notes** for any breaking changes or migration steps.

## Upgrade steps

### 1. Pull the latest images

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml pull
```

### 2. Restart services with the new images

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

Docker Compose will recreate only the containers whose images have changed.

### 3. Verify health

Check that all services started successfully:

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml ps
```

Confirm each service shows a healthy status. You can also open the admin dashboard at `http://localhost/admin` and check the service health panel.

### 4. Check logs for errors

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml logs --tail=50
```

Look for startup errors or deprecation warnings.

## Rollback

If something goes wrong after an upgrade:

1. Stop the stack: `docker compose -f ~/.local/state/openpalm/docker-compose.yml down`
2. Restore your backup following the [Backup & Restore guide](backup-restore.md).
3. Start the stack: `docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d`

## Automatic updates

The OpenPalm `controller` container includes a system cron job that periodically pulls image updates and restarts services. If automatic updates are enabled, upgrades happen without manual intervention. Check `~/.local/state/openpalm/observability/maintenance/` for update logs.
