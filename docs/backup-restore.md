# Backup & Restore

OpenPalm stores all persistent data on the host filesystem under a single home
directory (`~/.openpalm/` by default). This makes backup and restore
straightforward: archive the directory, restore it, and restart the stack.

---

## What to back up

| Directory | Default path | Contains | Back up? |
|-----------|-------------|----------|----------|
| **vault/** | `~/.openpalm/vault` | user.env (LLM keys), system.env (admin token, HMAC secrets) | Yes |
| **config/** | `~/.openpalm/config` | components, automations, assistant extensions | Yes |
| **data/** | `~/.openpalm/data` | memory (SQLite), assistant config, guardian data | Yes |
| **logs/** | `~/.openpalm/logs` | Audit and debug logs | Optional |

The simplest approach is to back up the entire `~/.openpalm/` directory.

---

## Stop the stack before backup

SQLite databases (memory service) can produce corrupt backups if written to
during archiving. Stop the stack first for a consistent snapshot:

```bash
docker compose down
```

If downtime is not acceptable, the memory SQLite database supports WAL mode
and a hot backup is unlikely to corrupt, but stopping is the only guarantee.

---

## Backup

Archive the OpenPalm home directory into a tarball:

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz ~/.openpalm
```

For a custom home path, substitute the actual directory:

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz "$OP_HOME"
```

Restart the stack after backup:

```bash
docker compose up -d
```

---

## Restore

### 1. Stop the stack

```bash
docker compose down
```

### 2. Extract the backup

```bash
tar xzf openpalm-backup-YYYYMMDD.tar.gz -C /
```

This restores files to their original absolute paths. If restoring to a
different user or machine, extract to a staging directory first and move
files to the correct locations.

### 3. Fix ownership

Container processes run as `OP_UID:OP_GID` (default 1000:1000).
After restoring from a backup taken on a different machine or by a different
user, fix file ownership:

```bash
sudo chown -R $(id -u):$(id -g) ~/.openpalm
```

### 4. Restart the stack

The admin's startup apply re-discovers components and automations from the
restored config:

```bash
docker compose up -d
```

Run `docker compose` from the directory containing the compose file, or
pass `-f` with the path to `~/.openpalm/data/docker-compose.yml`.

---

## Migration to a new machine

1. On the old machine, stop the stack and create a backup (see above).
2. Transfer the tarball to the new machine.
3. Install Docker on the new machine.
4. Download the installer without starting the stack:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh \
     -o setup.sh
   bash setup.sh --no-start
   ```

   Do not pipe directly to `bash` if you need to pass `--no-start`.

5. Extract the backup over the freshly seeded directories:

   ```bash
   tar xzf openpalm-backup-YYYYMMDD.tar.gz -C /
   ```

6. Fix ownership (see step 3 above).
7. Start the stack:

   ```bash
   docker compose up -d
   ```

The admin will detect the existing configuration and skip the setup wizard.

---

## Key files reference

| File | Location | Purpose |
|------|----------|---------|
| `vault/user.env` | OP_HOME | LLM provider API keys |
| `vault/system.env` | OP_HOME | Admin token, HMAC secrets, infrastructure config |
| `config/components/*/compose.yml` | OP_HOME | Installed component compose definitions |
| `config/components/*/.env` | OP_HOME | Component instance environment |
| `config/automations/*.yml` | OP_HOME | User-defined scheduled automations |
| `config/assistant/` | OP_HOME | User OpenCode extensions (tools, plugins, skills) |
| `config/connections/profiles.json` | OP_HOME | LLM connection profiles and role assignments |
| `data/memory/` | OP_HOME | Memory SQLite database and vector index |
| `data/assistant/` | OP_HOME | System-managed OpenCode config |
| `data/catalog/` | OP_HOME | Installed component catalog |
