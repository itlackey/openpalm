# core/assistant — OpenCode Runtime

Containerized [OpenCode](https://opencode.ai) instance that is the AI brain of OpenPalm. It has **no Docker socket access** — all stack operations are performed by calling the Admin API.

## Responsibilities

- Process messages forwarded by the guardian
- Call Admin API endpoints to inspect and manage the stack
- Maintain persistent memory via OpenMemory (backed by Qdrant)
- Execute user-defined skills, tools, and plugins

## Isolation model

The assistant is deliberately isolated:
- No Docker socket mount
- No host filesystem access beyond designated mounts (`DATA_HOME/assistant`, `CONFIG_HOME/opencode`, `OPENPALM_WORK_DIR`)
- Admin API calls are HMAC-authenticated and allowlisted

## Extensions

Extensions load from two locations (core takes precedence):

| Location | Mount | Purpose |
|---|---|---|
| `/opt/opencode/` | baked into image | Core extensions always loaded |
| `CONFIG_HOME/opencode/` | runtime mount | User extensions — no image rebuild needed |

Place custom tools in `CONFIG_HOME/opencode/tools/`, plugins in `…/plugins/`, and skills in `…/skills/`.

## Persona and operational guidelines

See [`AGENTS.md`](./AGENTS.md) for the assistant's persona, memory guidelines, and behavior rules.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OPENPALM_ADMIN_URL` | Admin API base URL |
| `OPENPALM_ADMIN_TOKEN` | Token for Admin API authentication |
| `OPENCODE_CONFIG_HOME` | OpenCode config directory (maps to `CONFIG_HOME/opencode`) |
