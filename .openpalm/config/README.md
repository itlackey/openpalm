# config/

User-editable, non-secret configuration. Files here are safe to inspect,
version-control, and share. The CLI and admin seed defaults but never
overwrite existing user files.

## Files

| File | Purpose |
|------|---------|
| `stack.yml` | Install marker. Contains `version: 2` only; LLM/embedding config lives in `config/akm/config.json`. |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `assistant/` | OpenCode user config (`opencode.json`), plugins, skills, and tools. Mounted into the assistant container at `/home/opencode/.config/opencode`. |
| `automations/` | Scheduler automation definitions (YAML). Core automations (cleanup, validation) are seeded at install; optional ones can be added from the catalog or written by hand. |
| `guardian/` | Guardian-specific configuration. |

## stack.yml

Install marker only. Contains `{ version: 2 }`. LLM/embedding config lives in
`config/akm/config.json` (managed by the akm CLI).

Select addons by adding their compose files as `-f` flags to `docker compose`.
See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md)
for the full command reference.
