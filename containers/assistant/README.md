# containers/assistant — OpenCode Runtime

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
  - `${OP_HOME}/knowledge/secrets/auth.json` → `/home/opencode/.local/share/opencode/auth.json` (host-managed OpenCode auth copy)
  - `${OP_HOME}/config/akm` → `/etc/akm` (AKM config)
  - `${OP_HOME}/data/assistant` → `/home/opencode` (the assistant's home; survives recreates)
  - `${OP_HOME}/workspace` → `/work` (shared work area)
  - `${OP_HOME}/knowledge` → `/stash` (knowledge stash)
  - `${OP_HOME}/data/akm/cache` → `/opt/akm/cache` (AKM cache and task logs)
  - `${OP_HOME}/data/akm/data` → `/opt/akm/data` (AKM databases and durable data)
  - Named volume `assistant-persistent` → `/opt/persistent` (escape hatch for prefix-style global installs)

## Plugin Architecture

Assistant extensions ship via the `akm-opencode` plugin (stash tools, memory, skills) and any additional plugins listed in `opencode.jsonc`. OpenCode installs plugins on startup using Bun and caches them under `/home/opencode/.cache/` (bind-mounted so the cache survives recreates). The first container boot requires network access to npm; subsequent restarts reuse the cached modules.

```
opencode.jsonc
  → "plugin": ["akm-opencode", ...]
  → OpenCode installs from npm on startup
  → Tools, plugins, skills registered via each plugin's entry point
```

Secrets are accessed via `akm secret` — the akm secret store backed by `knowledge/secrets/` and granted to the container via Compose `secrets:` entries. User env is available via `akm env path env:user`, resolved and sourced ON DEMAND by the agent's own `load_vault` tool call (never by the entrypoint into the server's own process — see docs/public-seams-review.md §G1).

### What lives where

Assistant config is **seeded from the repo and bind-mounted at runtime**. `OPENCODE_CONFIG_DIR=/etc/opencode` carries the *managed* config, but it is **not** the single source of truth — OpenCode merges roughly eight config sources additively, and `/etc/opencode` is merged **twice** (once as `OPENCODE_CONFIG_DIR`, once as the Linux `systemManagedConfigDir`). The user's own global config at `~/.config/opencode` (from `OP_HOME/config/assistant`) is merged as well, and `instructions` entries are set-unioned across all sources.

| Repo location | OP_HOME location | Container mount | Purpose |
|---|---|---|---|
| `.openpalm/config/assistant/opencode.jsonc` | `config/assistant/opencode.jsonc` | `/etc/opencode/opencode.jsonc` | Project config — plugins, server settings, permissions |
| `.openpalm/config/assistant/openpalm.md` | `config/assistant/openpalm.md` | `/etc/opencode/openpalm.md` | Operational guidelines (loaded via `instructions:`) |
| `.openpalm/config/assistant/system.md` | `config/assistant/system.md` | `/etc/opencode/system.md` | System prompt (memory, tools, secrets, built-in skills) |
| `${OP_HOME}/knowledge/secrets/auth.json` | `knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | OpenCode provider credentials |
| `${OP_HOME}/data/assistant/` | (the assistant's `$HOME`) | `/home/opencode` | Persistent home — bun cache, tools, user state |
| `assistant-persistent` (named volume) | — | `/opt/persistent` | Escape hatch for prefix-style global installs |

### Updating tools and skills

To add or update skills, edit the AKM stash assets in `knowledge/` (skills, tasks, agents). To add a new OpenCode plugin, add it to `.openpalm/config/assistant/opencode.jsonc` — the assistant picks it up on the next OpenCode restart inside the container, no image rebuild required.

To change the assistant's behavior, persona, or operational rules, edit `.openpalm/config/assistant/openpalm.md` or `.openpalm/config/assistant/system.md` — both are bind-mounted, so changes take effect on the next OpenCode restart inside the container.

## Persona and operational guidelines

Authoritative source: `.openpalm/config/assistant/openpalm.md` and `.openpalm/config/assistant/system.md`.

## Key environment variables

| Variable | Purpose |
|---|---|
| `OPENCODE_CONFIG_DIR` | Set to `/etc/opencode` — where OpenCode reads project + user config |
| `OPENCODE_AUTH` | `false` by default (LAN-internal); set to `true` if exposing the assistant port to untrusted networks |
| `BUN_INSTALL` | `/home/opencode/.bun` — bun global installs persist via the home bind mount |
