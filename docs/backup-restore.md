# Backup & Restore

How to back up and restore your OpenPalm instance.

## What to back up

| Component | Default location | Contains |
|---|---|---|
| PostgreSQL data | `~/.local/share/openpalm/postgres/` | Relational data used by OpenMemory |
| Qdrant data | `~/.local/share/openpalm/qdrant/` | Vector embeddings for memory search |
| OpenMemory data | `~/.local/share/openpalm/openmemory/` | OpenMemory application state |
| Configuration | `~/.config/openpalm/` | Agent config, channel settings, cron jobs, Caddyfile |
| Secrets | `~/.config/openpalm/secrets.env` | API keys and credentials |

## Backup procedure

### 1. Stop services (recommended for consistency)

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml stop
```

If you cannot tolerate downtime, you can back up while running, but database dumps are safer with services stopped.

### 2. Dump PostgreSQL

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml \
  exec -T postgres pg_dump -U openpalm openpalm > openpalm-pg-backup.sql
```

### 3. Copy data volumes

```bash
tar czf openpalm-data-backup.tar.gz \
  ~/.local/share/openpalm/qdrant \
  ~/.local/share/openpalm/openmemory
```

### 4. Copy configuration and secrets

```bash
tar czf openpalm-config-backup.tar.gz ~/.config/openpalm/
```

### 5. Restart services

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

## Restore procedure

### 1. Stop services

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml down
```

### 2. Restore configuration

```bash
tar xzf openpalm-config-backup.tar.gz -C /
```

### 3. Restore data volumes

```bash
tar xzf openpalm-data-backup.tar.gz -C /
```

### 4. Restore PostgreSQL

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d postgres
docker compose -f ~/.local/state/openpalm/docker-compose.yml \
  exec -T postgres psql -U openpalm openpalm < openpalm-pg-backup.sql
```

### 5. Start all services

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml up -d
```

### 6. Verify

Check that all services are healthy:

```bash
docker compose -f ~/.local/state/openpalm/docker-compose.yml ps
```

## Tips

- Automate backups with a cron job on the host and store them off-host.
- Test your restore procedure periodically.
- The `secrets.env` file contains sensitive credentials -- encrypt backups or restrict access.
