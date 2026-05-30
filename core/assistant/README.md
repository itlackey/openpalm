# core/assistant — OpenCode Runtime

Containerized [OpenCode](https://opencode.ai) instance that is the AI brain of OpenPalm. It has **no Docker socket access** and no network path to the host admin process — it cannot perform stack operations. Stack management is handled by the host CLI and admin UI.

## Responsibilities

- Process messages forwarded by the guardian
- Maintain persistent memory via the akm stash (skills, lessons, memories)
- Execute user-defined skills, tools, and plugins

## Isolation model

The assistant is deliberately isolated:
- No Docker socket mount
- No network path to the host admin process — only the assistant API on its internal compose network is reachable from inside the container
- Host filesystem access is limited to the bind mounts declared in `.openpalm/config/stack/core.compose.yml`:
  - `${OP_HOME}/config/assistant` → `/etc/opencode` (OpenCode config)
  - `${OP_HOME}/config/auth.json` → `/home/opencode/.local/share/opencode/auth.json` (host-managed OpenCode auth copy)
  - `${OP_HOME}/config/akm` → `/etc/akm` (AKM config)
  - `${OP_HOME}/data/assistant` → `/home/opencode` (the assistant's home; survives recreates)
  - `${OP_HOME}/workspace` → `/work` (shared work area)
  - `${OP_HOME}/stash` → `/stash` (knowledge stash)
  - `${OP_HOME}/data/akm/cache` → `/opt/akm/cache` (AKM cache and task logs)
  - `${OP_HOME}/data/akm/data` → `/opt/akm/data` (AKM databases and durable data)
  - Named volume `assistant-persistent` → `/opt/persistent` (escape hatch for prefix-style global installs)

## Plugin Architecture

Core assistant extensions (tools, plugins, skills) ship as the [`@openpalm/assistant-tools`](../../packages/assistant-tools/) npm package, plus `akm-opencode` for the stash tools. OpenCode installs plugins listed in `opencode.jsonc` using Bun, caching them at `~/.cache/opencode/node_modules/`.

```
opencode.jsonc
  → "plugin": ["@openpalm/assistant-tools", "akm-opencode"]
  → OpenCode installs from npm on startup
  → Tools, plugins, skills registered via each plugin's entry point
```

Plugins are installed by Bun at container startup and cached under `/home/opencode/.cache/` (bind-mounted, so the cache survives recreates). The first container boot requires network access to npm; subsequent restarts reuse the cached modules.

### What lives where

Assistant config is **seeded from the repo and bind-mounted at runtime**. `OPENCODE_CONFIG_DIR=/etc/opencode` is the single source of truth inside the container.

| Repo location | OP_HOME location | Container mount | Purpose |
|---|---|---|---|
| `.openpalm/config/assistant/opencode.jsonc` | `config/assistant/opencode.jsonc` | `/etc/opencode/opencode.jsonc` | Project config — plugins, server settings, permissions |
| `.openpalm/config/assistant/openpalm.md` | `config/assistant/openpalm.md` | `/etc/opencode/openpalm.md` | Operational guidelines (loaded via `instructions:`) |
| `.openpalm/config/assistant/system.md` | `config/assistant/system.md` | `/etc/opencode/system.md` | System prompt (memory, tools, secrets, built-in skills) |
| `packages/assistant-tools/` | — | npm-installed at startup | Plugin source (tools, skills, AGENTS.md contributor pointer) |
| `${OP_HOME}/data/assistant/` | (the assistant's `$HOME`) | `/home/opencode` | Persistent home — bun cache, pipx tools, user state |
| `assistant-persistent` (named volume) | — | `/opt/persistent` | Escape hatch for prefix-style global installs |

### Updating tools

Change tools in `packages/assistant-tools/`, publish a new version to npm, and the assistant picks it up on next container restart — no Docker image rebuild required.

To change the assistant's behavior, persona, or operational rules, edit `.openpalm/config/assistant/openpalm.md` or `.openpalm/config/assistant/system.md` — both are bind-mounted, so changes take effect on the next OpenCode restart inside the container.

## Persona and operational guidelines

Authoritative source: `.openpalm/config/assistant/openpalm.md` and `.openpalm/config/assistant/system.md`. Contributor pointer (not loaded at runtime): [`packages/assistant-tools/AGENTS.md`](../../packages/assistant-tools/AGENTS.md).

## Key environment variables

| Variable | Purpose |
|---|---|
| `OP_ASSISTANT_TOKEN` | Assistant token (used by guardian for message authentication) |
| `OPENCODE_CONFIG_DIR` | Set to `/etc/opencode` — where OpenCode reads project + user config |
| `OPENCODE_AUTH` | `false` by default (LAN-internal); set to `true` and supply `OP_OPENCODE_PASSWORD` if exposing to LAN |
| `BUN_INSTALL` | `/home/opencode/.bun` — bun global installs persist via the home bind mount |
