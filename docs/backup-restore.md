# Backup & Restore

OpenPalm keeps its installation under one home directory (`OP_HOME`, default
`~/.openpalm/`). A full archive of that directory includes configuration,
managed files, delegated private secrets, provider auth, service data, and
regenerable caches.

## What Matters

| Path | Contents |
|---|---|
| `config/` | User-owned configuration and `config/stack/custom.compose.yml` |
| `system/` | Managed Compose and OpenCode configuration |
| `state/` | `stack.env`, enabled addons, setup state, and app records |
| `private/` | Delegated UI, Guardian, API, portal, bot, and OpenCode-server secrets |
| `knowledge/` | AKM stash, tasks, user env, and provider `auth.json` |
| `data/` | Durable service state and lifecycle backups |
| `workspace/` | Shared assistant work area |
| `cache/` | Regenerable container caches; safe to omit |

## Stop the Stack

For the most consistent full backup, stop services first:

```bash
openpalm stop
```

If you manage Compose directly, use the same file list and active profiles as
normal. See the [Manual Compose Runbook](operations/manual-compose-runbook.md).

## Full Backup

This captures the complete home, including `private/` and `cache/`:

```bash
tar -czf "openpalm-backup-$(date +%Y%m%d).tar.gz" -C "$HOME" .openpalm
```

To omit only the regenerable top-level cache:

```bash
tar --exclude='.openpalm/cache' \
  -czf "openpalm-backup-$(date +%Y%m%d).tar.gz" \
  -C "$HOME" .openpalm
```

If `OP_HOME` points elsewhere, archive that directory instead. If
`OP_BACKUP_DIR` points outside `OP_HOME`, archive it separately if you also want
OpenPalm's lifecycle snapshots.

Treat every backup as sensitive: it contains `private/secrets/` and
`knowledge/secrets/auth.json`.

## Lifecycle Backups

OpenPalm creates safety snapshots before destructive lifecycle operations.
Those snapshots include top-level user, managed, state, knowledge, workspace,
and `private/` content. They exclude `data/` and `cache/` to avoid copying large
runtime state and regenerable caches.

Lifecycle snapshots are not a replacement for a full service-data backup.

## Restore

1. Stop any OpenPalm stack using the target project name.
2. Extract the archive into the same parent directory.
3. Repair ownership if the user or machine changed.
4. Start through OpenPalm or the same raw Compose profile set.

For an archive created with `-C "$HOME" .openpalm`:

```bash
tar -xzf openpalm-backup-YYYYMMDD.tar.gz -C "$HOME"
sudo chown -R "$(id -u):$(id -g)" "$HOME/.openpalm"
openpalm start
```

When moving to a different home path, update `OP_HOME` in
`state/stack.env` before starting. Review any other absolute bind paths as well.

## Raw Compose Restore

After extraction, use all three managed files, the user overlay, the sole env
file, and every active profile:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
OP_PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"
docker compose \
  --project-name "$OP_PROJECT_NAME" \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  up -d
```

Replace `addon.chat` with the profiles that were active for the backup. The
value of `OP_ENABLED_ADDONS` alone is not translated by raw Docker Compose.
If the restored `state/stack.env` records a non-default `OP_PROJECT_NAME`, set
the shell variable to that exact value as well; `--env-file` does not expand the
shell's earlier `--project-name` argument.

## Key Files

| File or directory | Purpose |
|---|---|
| `state/stack.env` | Sole non-secret Compose env file |
| `private/secrets/` | Delegated runtime credentials |
| `knowledge/secrets/auth.json` | Assistant-readable OpenCode provider auth |
| `knowledge/env/user.env` | AKM user env loaded on demand |
| `system/stack/` | Managed Compose files |
| `config/stack/custom.compose.yml` | User Compose overlay |
| `system/assistant/` and `system/guardian/` | Managed OpenCode config |
| `config/assistant/` and `config/guardian/` | User OpenCode config |
| `knowledge/tasks/` | AKM task files |

For a historical 0.10.x installation, follow the
[0.10.x to 0.11.0 upgrade guide](operations/upgrade-0.10-to-0.11.md) before
using the current restore layout.
