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
| `~/.openpalm/config/stack/` | `stack.env`, `secrets/`, live compose files and helper scripts | Yes |
| `~/.openpalm/stash/vaults/` | `user.env` (optional user-managed secrets) | Yes |
| `~/.openpalm/config/` | assistant config, enabled automations, `stack.yml` capabilities | Yes |
| `~/.openpalm/state/registry/` | available addon and automation catalog | Yes |
| `~/.openpalm/state/` | durable service data | Yes |
| `~/.openpalm/stash/` | AKM stash (memory, skills, vaults) | Yes |
| `~/.openpalm/workspace/` | shared workspace | Yes |
| `~/.openpalm/logs/` | logs and audit files | Optional |

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
  -f addons/chat/compose.yml \
  --env-file stack.env \
  down
```

See the [Manual Compose Runbook](operations/manual-compose-runbook.md) for the full command reference.

---

## Backup

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz ~/.openpalm
```

If `OP_HOME` points elsewhere, archive that directory instead.

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
  -f addons/chat/compose.yml \
  --env-file stack.env \
  up -d
```

Use the same addon file set you used before the backup.

---

## Migration to a new machine

1. Back up the old machine's `~/.openpalm/`.
2. Install Docker on the new machine.
3. Restore the backup into the new user's home directory.
4. Fix ownership.
5. Start the stack from `~/.openpalm/config/stack/` with the same compose file set.

There is no separate staging/artifacts/config-components reconstruction step in
the current model.

---

## Key files reference

| File or directory | Purpose |
|---|---|
| `~/.openpalm/stash/vaults/user.env` | AKM vault backing file for user-managed secrets |
| `~/.openpalm/config/stack/stack.env` | Non-secret ports, paths, image tags, profiles |
| `~/.openpalm/config/stack/secrets/` | System-managed service secret files |
| `~/.openpalm/state/registry/addons/<name>/` | Available addon catalog entries |
| `~/.openpalm/state/registry/automations/` | Available automation catalog entries |
| `~/.openpalm/config/stack/core.compose.yml` | Base stack definition |
| `~/.openpalm/config/stack/addons/<name>/compose.yml` | Addon overlays |
| `~/.openpalm/config/assistant/` | User OpenCode config |
| `~/.openpalm/stash/tasks/` | Active AKM automation task files (markdown) |
| `~/.openpalm/config/stack.yml` | Capabilities only |
| `~/.openpalm/stash/` | Shared akm stash (assistant + admin memory and knowledge) |
| `~/.openpalm/workspace/` | Shared workspace |
| `~/.openpalm/logs/` | Logs and audit files |
