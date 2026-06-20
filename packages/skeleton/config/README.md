# config/

User-editable, non-secret configuration. Files here are safe to inspect,
version-control, and share. The CLI and admin seed defaults but never
overwrite existing user files.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assistant/` | OpenCode project/user config. Mounted into the assistant container at `/etc/opencode`. |
| `stack/` | Compose runtime files: non-secret `stack.env`, fixed compose files, and user custom compose. |
| `akm/` | AKM config directory shared with the assistant container. |
| `guardian/` | Guardian-specific configuration. |

Select built-in optional services with Compose profiles such as `addon.chat`.
Add custom containers or overlays directly in `config/stack/custom.compose.yml`.
See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md)
for the full command reference.
