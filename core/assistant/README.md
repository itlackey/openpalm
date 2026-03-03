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

## Plugin Architecture

Core assistant extensions (tools, plugins, skills) are published as the [`@openpalm/assistant-tools`](../../packages/assistant-tools/) npm package. OpenCode installs plugins from the `"plugin"` array in `opencode.jsonc` using Bun, caching them at `~/.cache/opencode/node_modules/`.

```
opencode.jsonc
  → "plugin": ["@itlackey/openkit", "@openpalm/assistant-tools"]
  → OpenCode installs from npm on startup
  → Tools, plugins, skills registered via the plugin entry point
```

The Dockerfile pre-installs the package at `/opt/opencode/node_modules/` as an offline fallback, so the container works without network access to npm.

### What lives where

| Location | Source | Purpose |
|---|---|---|
| `packages/assistant-tools/` | Git repo | Plugin source: tools, plugins, skills, AGENTS.md |
| `/opt/opencode/node_modules/@openpalm/assistant-tools/` | Docker image | Offline fallback for npm install |
| `/opt/opencode/AGENTS.md` | Docker COPY | Assistant persona (always present) |
| `/opt/opencode/opencode.jsonc` | Docker COPY | OpenCode config with plugin list |
| `~/.cache/opencode/node_modules/` | Runtime (DATA_HOME volume) | OpenCode's npm cache — plugins auto-installed here |
| `CONFIG_HOME/opencode/` | Runtime mount | User extensions — no image rebuild needed |

### Updating tools

Change tools in `packages/assistant-tools/`, publish a new version to npm, and the assistant picks it up on next startup — no Docker image rebuild required.

## Persona and operational guidelines

See [`packages/assistant-tools/AGENTS.md`](../../packages/assistant-tools/AGENTS.md) for the assistant's persona, memory guidelines, and behavior rules.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OPENPALM_ADMIN_URL` | Admin API base URL |
| `OPENPALM_ADMIN_TOKEN` | Token for Admin API authentication |
| `OPENCODE_CONFIG_HOME` | OpenCode config directory (maps to `CONFIG_HOME/opencode`) |
