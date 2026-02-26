# Maintenance Guide

Backup, restore, upgrade, and rollback procedures for OpenPalm.

---

## Backup

### What to back up

| Component | Default location | Contains |
|---|---|---|
| PostgreSQL data | `~/.local/share/openpalm/postgres/` | Relational data used by OpenMemory |
| Qdrant data | `~/.local/share/openpalm/qdrant/` | Vector embeddings for memory search |
| OpenMemory data | `~/.local/share/openpalm/openmemory/` | OpenMemory application state |
| Configuration | `~/.config/openpalm/` | Agent config, channel settings, Caddy config |
| Secrets | `~/.config/openpalm/secrets.env` | API keys and credentials |

### Backup procedure

**1. Stop services** (recommended for consistency)

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml stop
```

**2. Dump PostgreSQL**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml \
  exec -T postgres pg_dump -U openpalm openpalm > openpalm-pg-backup.sql
```

**3. Copy data volumes**

```bash
tar czf openpalm-data-backup.tar.gz \
  ~/.local/share/openpalm/qdrant \
  ~/.local/share/openpalm/openmemory
```

**4. Copy configuration and secrets**

```bash
tar czf openpalm-config-backup.tar.gz ~/.config/openpalm/
```

**5. Restart services**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

> **Tip:** The `secrets.env` file contains sensitive credentials — encrypt backups or restrict access. Automate backups with a host cron job and store them off-host. Test your restore procedure periodically.

---

## Restore

**1. Stop services**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml down
```

**2. Restore configuration**

```bash
tar xzf openpalm-config-backup.tar.gz -C /
```

**3. Restore data volumes**

```bash
tar xzf openpalm-data-backup.tar.gz -C /
```

**4. Restore PostgreSQL**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d postgres
# Wait for PostgreSQL to be ready
docker compose -f ~/.local/state/openpalm/docker-compose.yml \
  exec postgres pg_isready -U openpalm --timeout=30
docker compose -f ~/.local/state/openpalm/docker-compose.yml \
  exec -T postgres psql -U openpalm openpalm < openpalm-pg-backup.sql
```

**5. Start all services**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

**6. Verify**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml ps
```

---

## Upgrade

### Before you upgrade

1. **Back up your data** using the backup procedure above.
2. **Check the release notes** for breaking changes or required manual steps.

### Upgrade steps

**1. Pull the latest images**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml pull
```

**2. Restart services with new images**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

Docker Compose recreates only containers whose images have changed.

**3. Verify health**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml ps
```

Confirm each service shows a healthy status. You can also check the admin dashboard at `http://localhost`.

**4. Check logs for errors**

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml logs --tail=50
```

### Rollback

If something goes wrong after an upgrade:

1. Stop the stack: `docker compose -f ~/.local/state/openpalm/docker-compose.yml down`
2. Restore your backup using the restore procedure above.
3. Start the stack: `docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d`

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/uninstall.sh | bash
```

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/uninstall.ps1 -OutFile $env:TEMP/openpalm-uninstall.ps1; & $env:TEMP/openpalm-uninstall.ps1"
```

Use `--remove-all` to delete all config/state/data directories and `--remove-images` to remove container images.
PowerShell: `& $env:TEMP/openpalm-uninstall.ps1 -RemoveAll -RemoveImages`.
