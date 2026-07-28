# config/

User-owned, non-secret configuration. Install and update seed missing defaults
but do not overwrite existing user files automatically.

| Directory | Runtime purpose |
|---|---|
| `assistant/` | Assistant OpenCode user global config, mounted at `/home/opencode/.config/opencode` |
| `guardian/` | Guardian OpenCode user global/model config, mounted under Guardian's home |
| `akm/` | AKM configuration mounted at `/etc/akm` in the assistant |
| `stack/` | Contains only the user-owned `custom.compose.yml` overlay |

Managed assistant and Guardian OpenCode configuration lives separately under
`system/assistant/` and `system/guardian/`, each mounted at `/etc/opencode`.
Managed Compose files live under `system/stack/`.

`state/stack.env`, not `config/stack/`, is the sole Compose env file. Secrets
live in `private/secrets/`, except assistant-readable provider auth at
`knowledge/secrets/auth.json`.

Add custom services or overrides only to `config/stack/custom.compose.yml`.
See the
[Manual Compose Runbook](../../../docs/operations/manual-compose-runbook.md).
