# core/assistant — OpenCode Runtime

Containerized [OpenCode](https://opencode.ai) instance that is the AI brain of OpenPalm. It has **no Docker socket access** — all stack operations are performed by calling the Admin API.

## Responsibilities

- Process messages forwarded by the guardian
- Call Admin API endpoints to inspect and manage the stack
- Maintain persistent memory via the memory service (SQLite + `sqlite-vec`)
- Execute user-defined skills, tools, and plugins

## Isolation model

The assistant is deliberately isolated:
- No Docker socket mount
- No host filesystem access beyond designated mounts (`DATA_HOME/assistant`, `CONFIG_HOME/assistant`, `DATA_HOME/opencode`, `STATE_HOME/opencode`, `OPENPALM_WORK_DIR`)
- Admin API calls are HMAC-authenticated and allowlisted

## Plugin Architecture

Core assistant extensions (tools, plugins, skills) are published as the [`@openpalm/assistant-tools`](../../packages/assistant-tools/) npm package. OpenCode installs plugins from the `"plugin"` array in `opencode.jsonc` using Bun, caching them at `~/.cache/opencode/node_modules/`.

```
opencode.jsonc
  → "plugin": ["@openpalm/assistant-tools", "akm-opencode"]
  → OpenCode installs from npm on startup
  → Tools, plugins, skills registered via the plugin entry point
```

Plugins are installed by Bun at container startup and cached ephemerally. The first container boot (and any time the container is recreated, e.g. via `docker compose up`) requires network access to npm; only in-place restarts of the same container (e.g. `docker restart`) can reuse the cached modules.

### What lives where

| Location | Source | Purpose |
|---|---|---|
| `packages/assistant-tools/` | Git repo | Plugin source: tools, plugins, skills, AGENTS.md |
| `assets/opencode.jsonc` | Git repo | System config (model + plugins) — seeded to DATA_HOME/assistant/ |
| `assets/AGENTS.md` | Git repo | Assistant persona — seeded to DATA_HOME/assistant/ |
| `DATA_HOME/assistant/` | Runtime mount | System config mounted at `/etc/opencode` |
| `CONFIG_HOME/assistant/` | Runtime mount | User extensions mounted at `~/.config/opencode` |
| `~/.cache/opencode/node_modules/` | Container ephemeral | Plugins auto-installed from config on startup |

### Updating tools

Change tools in `packages/assistant-tools/`, publish a new version to npm, and the assistant picks it up on next startup — no Docker image rebuild required.

## Persona and operational guidelines

See [`packages/assistant-tools/AGENTS.md`](../../packages/assistant-tools/AGENTS.md) for the assistant's persona, memory guidelines, and behavior rules.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OPENPALM_ADMIN_URL` | Admin API base URL |
| `OPENPALM_ADMIN_TOKEN` | Token for Admin API authentication |
| `OPENCODE_CONFIG_DIR` | System config directory (maps to `DATA_HOME/assistant`, mounted at `/etc/opencode`) |
