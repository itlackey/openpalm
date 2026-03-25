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
| `~/.openpalm/vault/` | `vault/stack/stack.env`, `vault/stack/guardian.env`, `vault/user/user.env`, schemas | Yes |
| `~/.openpalm/config/` | assistant config, automations, optional `stack.yml` | Yes |
| `~/.openpalm/stack/` | live compose files and helper scripts | Yes |
| `~/.openpalm/data/` | durable service data, workspace, stash | Yes |
| `~/.openpalm/logs/` | logs and audit files | Optional |

---

## Stop the stack first

For the most consistent backup, stop the running stack first using the same file
set you normally use.

Example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/stack/guardian.env \
  --env-file ../vault/user/user.env \
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
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/stack/guardian.env \
  --env-file ../vault/user/user.env \
  up -d
```

Use the same addon file set you used before the backup.

---

## Migration to a new machine

1. Back up the old machine's `~/.openpalm/`.
2. Install Docker on the new machine.
3. Restore the backup into the new user's home directory.
4. Fix ownership.
5. Start the stack from `~/.openpalm/stack/` with the same compose file set.

There is no separate staging/artifacts/config-components reconstruction step in
the current model.

---

## Key files reference

| File or directory | Purpose |
|---|---|
| `~/.openpalm/vault/user/user.env` | Optional user extension env |
| `~/.openpalm/vault/stack/stack.env` | Stack tokens, ports, paths, image tags |
| `~/.openpalm/vault/stack/guardian.env` | Channel HMAC secrets for guardian/channel verification |
| `~/.openpalm/stack/core.compose.yml` | Base stack definition |
| `~/.openpalm/stack/addons/<name>/compose.yml` | Addon overlays |
| `~/.openpalm/config/assistant/` | User OpenCode config |
| `~/.openpalm/config/automations/` | Scheduled automation files |
| `~/.openpalm/config/stack.yml` | Optional tooling metadata |
| `~/.openpalm/data/memory/` | Memory database |
| `~/.openpalm/data/workspace/` | Shared workspace |
| `~/.openpalm/logs/` | Logs and audit files |
