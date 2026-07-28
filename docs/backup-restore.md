# Backup & Restore

OpenPalm keeps its persistent state under one home directory,
`~/.openpalm/` by default. That makes backup simple: preserve that directory,
restore it, and then start the same compose stack again.

---

## What to back up

Backing up the entire `~/.openpalm/` tree is the safest option.

If you use the optional `pass` backend for secrets, also back up the host GPG
material it depends on, typically `${GNUPGHOME:-~/.gnupg}`.

| Path | Contains | Back up? |
|---|---|---|
| `~/.openpalm/config/stack/` | live compose files (compose assembly only) | Yes |
| `~/.openpalm/knowledge/env/` | `stack.env` (system, non-secret) + `user.env` (user-managed) | Yes |
| `~/.openpalm/config/` | assistant config and enabled automations | Yes |
| `~/.openpalm/data/` | durable service data | Yes, minus caches (see below) |
| `~/.openpalm/knowledge/` | AKM stash (memory, skills, env, secrets) | Yes |
| `~/.openpalm/workspace/` | shared workspace | Yes |
| `~/.openpalm/data/logs/` | logs and audit files | Optional |
| `~/.openpalm/data/backups/` | lifecycle backup snapshots | Optional |

---

## Stop the stack first

For the most consistent backup, stop the running stack first using the same file
set you normally use.

Example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  -f core.compose.yml \
  -f portals.compose.yml \
  --profile addon.chat \
  --env-file ../../state/stack.env \
  down
```

See the [Manual Compose Runbook](operations/manual-compose-runbook.md) for the full command reference.

---

## Backup

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz \
  --exclude='.cache' --exclude='data/akm/cache' \
  ~/.openpalm
```

The excluded paths are package-manager and model caches. They are regenerable
— containers rebuild them on the next start — and can add several GB to an
archive for nothing. Drop the `--exclude` flags if you want a byte-exact copy.

Two other trees under `data/` are dead weight on any install from 0.13.0 on:
`data/assistant/tools/` and `data/guardian/tools/`. Tool packages are baked
into the images now, so nothing reads them. They are left alone rather than
deleted for you — remove them by hand if you want the space back.

If `OP_HOME` points elsewhere, archive that directory instead. If you have set
`OP_BACKUP_DIR` to keep lifecycle snapshots outside `OP_HOME`, archive that
location too — it is not under the tree above.

---

## Restore

### 1. Stop any running stack

Use the same compose file set you normally run (see the [runbook](operations/manual-compose-runbook.md)).

### 2. Extract the backup

```bash
tar xzf openpalm-backup-YYYYMMDD.tar.gz -C /
```

### 3. Fix ownership if needed

```bash
sudo chown -R $(id -u):$(id -g) ~/.openpalm
```

This is especially important when moving between machines or users.

### 4. Start the stack again

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  -f core.compose.yml \
  -f portals.compose.yml \
  --profile addon.chat \
  --env-file ../../state/stack.env \
  up -d
```

Use the same addon profiles you used before the backup.

---

## Migration to a new machine

1. Back up the old machine's `~/.openpalm/`.
2. Install Docker on the new machine.
3. Restore the backup into the new user's home directory.
4. Fix ownership.
5. Start the stack with `openpalm start` (or, for a manual run, the compose
   file set under `~/.openpalm/system/stack/`).

There is no separate staging/artifacts/config-components reconstruction step in
the current model.

> This is a same-version, host-to-host copy. To move from **0.10.x to 0.11.0**
> (which relocates env files and secrets), follow the
> [0.10.x → 0.11.0 upgrade guide](operations/upgrade-0.10-to-0.11.md) instead.

---

## Key files reference

| File or directory | Purpose |
|---|---|
| `~/.openpalm/knowledge/env/user.env` | AKM env backing file for user-managed secrets |
| `~/.openpalm/state/stack.env` | Non-secret ports, paths, image tags, hardware profile selections |
| `~/.openpalm/knowledge/secrets/` | System-managed service secret files |
| `~/.openpalm/config/stack/core.compose.yml` | Base stack definition |
| `~/.openpalm/config/stack/services.compose.yml` | First-party optional services |
| `~/.openpalm/config/stack/portals.compose.yml` | First-party optional portals and guardian |
| `~/.openpalm/config/stack/custom.compose.yml` | Custom services and overlays |
| `~/.openpalm/config/assistant/` | User OpenCode config |
| `~/.openpalm/knowledge/tasks/` | Active AKM automation task files (YAML, `*.yml`) |
| `~/.openpalm/knowledge/` | Shared akm stash (assistant + admin memory and knowledge) |
| `~/.openpalm/workspace/` | Shared workspace |
| `~/.openpalm/data/logs/` | Logs and audit files |
