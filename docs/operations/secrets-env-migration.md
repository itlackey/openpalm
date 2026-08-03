# Secrets and Env Layout Migration

Current OpenPalm releases migrate supported legacy `OP_HOME` layouts
automatically. Do not follow old manual instructions that moved stack config or
delegated credentials into `knowledge/`: that tree is mounted into the Assistant
at `/stash`.

## Current Layout

| Path | Contents |
|---|---|
| `state/stack.env` | The sole non-secret Compose `--env-file` |
| `private/secrets/` | Delegated UI, OpenCode-server, Guardian, API, portal, and bot credentials |
| `knowledge/secrets/auth.json` | Assistant-readable OpenCode provider auth only |
| `knowledge/env/user.env` | AKM `env/user` data loaded by scoped tools on demand |
| `system/stack/` | Release-managed Compose files |
| `config/stack/custom.compose.yml` | The one user-owned Compose overlay |

The Assistant entrypoint does not source `knowledge/env/user.env`. Raw Docker
Compose does not perform `OP_HOME` migrations.

## Supported Upgrade Path

1. Make a full external backup of `OP_HOME`, including `private/`,
   `knowledge/`, and service-owned `data/`. See [Backup and
   Restore](../backup-restore.md).
2. Install the current CLI, then run the normal lifecycle update:

   ```bash
   openpalm update
   ```

3. Verify the resulting layout and Compose secret grants:

   ```bash
   openpalm validate
   openpalm status
   ```

The current CLI invokes the versioned migration before normal lifecycle
reconciliation. It consolidates supported legacy stack env files into
`state/stack.env`, preserves the effective values and operator comments it can
carry forward, and relocates known delegated credentials from the
Assistant-readable secret directory into `private/secrets/`.

If the same delegated secret exists in both old and current locations with
different bytes, migration leaves both files in place and logs a warning rather
than choosing one. Resolve that conflict from the external backup: retain the
intended value under `private/secrets/` with mode `0600`, then remove the stale
Assistant-readable copy.

Do not bulk-move `knowledge/secrets/`: provider `auth.json` deliberately remains
there. Do not put `state/stack.env` or delegated service credentials under
`knowledge/`.
