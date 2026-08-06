# config/

User-owned, non-secret configuration. Install and update seed missing defaults
but do not overwrite existing user files automatically.

| Directory | Runtime purpose |
|---|---|
| `assistant/` | Assistant OpenCode user global config, mounted at `/home/opencode/.config/opencode` |
| `guardian/` | Guardian OpenCode user global/model config, mounted under Guardian's home |
| `akm/` | AKM configuration mounted at `/etc/akm` in the assistant |
| `paperclip/opencode/` | Paperclip OpenCode user global config |
| `paperclip/akm/` | Paperclip-specific AKM configuration mounted at `/etc/akm` |
| `stack/` | Contains only the user-owned `custom.compose.yml` overlay |

Managed assistant, Guardian, and Paperclip OpenCode configuration lives
separately under `system/assistant/`, `system/guardian/`, and
`system/paperclip/`. Paperclip mounts its managed source read-only at
`/opt/openpalm/paperclip` and assembles a regenerable runtime copy at
`/etc/opencode`; the other managed trees mount directly at `/etc/opencode`.
Managed Compose files live under `system/stack/`.

`state/stack.env`, not `config/stack/`, is the sole Compose env file. Secrets
live in `private/secrets/`, except assistant-readable provider auth at
`knowledge/secrets/auth.json`.

Add custom services or overrides only to `config/stack/custom.compose.yml`.
See the
[Manual Compose Runbook](../../../docs/operations/manual-compose-runbook.md).
