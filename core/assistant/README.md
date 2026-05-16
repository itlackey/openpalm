# core/assistant — OpenCode Runtime

Containerized [OpenCode](https://opencode.ai) instance that is the AI brain of OpenPalm. It has **no Docker socket access** and no network path to the host admin process — it cannot perform stack operations. Stack management is handled by the host CLI and admin UI.

## Responsibilities

- Process messages forwarded by the guardian
- Maintain persistent memory via the akm stash (skills, lessons, memories)
- Execute user-defined skills, tools, and plugins

## Isolation model

The assistant is deliberately isolated:
- No Docker socket mount
- No host filesystem access beyond designated mounts (`$OP_HOME/data/assistant`, `$OP_HOME/config/assistant`, `$OP_HOME/data/workspace`, `$OP_HOME/vault/user/`, `$OP_HOME/logs/opencode`)
- No network path to the host admin process (`127.0.0.1` loopback is unreachable from inside the container)

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
| `core/assistant/opencode/opencode.jsonc` | Git repo | System config (model + plugins) — seeded to `DATA_HOME/assistant/opencode.jsonc` |
| `core/assistant/opencode/AGENTS.md` | Git repo | Assistant persona — seeded to `DATA_HOME/assistant/AGENTS.md` |
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
| `OP_ASSISTANT_TOKEN` | Assistant token (used by guardian for message authentication) |
| `OPENCODE_CONFIG_DIR` | System config directory (maps to `DATA_HOME/assistant`, mounted at `/etc/opencode`) |
