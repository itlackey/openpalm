# config/

User-editable, non-secret configuration. Files here are safe to inspect,
version-control, and share. The CLI and admin seed defaults but never
overwrite existing user files.

## Files

| File | Purpose |
|------|---------|
| `stack/stack.yml` | Install marker. Contains `version: 2` only; LLM/embedding config lives in `config/akm/config.json`. |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assistant/` | OpenCode project/user config. Mounted into the assistant container at `/etc/openpalm/assistant`. |
| `stack/` | Compose runtime files: non-secret `stack.env`, file secrets in `secrets/`, core compose, and enabled addon overlays. |
| `akm/` | AKM config directory shared with the assistant container. |
| `guardian/` | Guardian-specific configuration. |

## stack.yml

Install marker only. Contains `{ version: 2 }`. LLM/embedding config lives in
`config/akm/config.json` (managed by the akm CLI).

Select addons by enabling their overlay under `config/stack/addons/` and adding
that compose file as a `-f` flag to `docker compose`.
See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md)
for the full command reference.
