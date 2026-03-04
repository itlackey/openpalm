# OpenCode Configuration Integration

This document explains how OpenPalm integrates with
[OpenCode](https://opencode.ai) — the AI coding runtime that powers the
assistant service.

---

## Overview

OpenCode supports a layered configuration model. OpenPalm uses three layers:

1. **User config** — persisted on the host at
   `$OPENPALM_CONFIG_HOME/assistant/` and bind-mounted into the container at
   `~/.config/opencode/`. Users can add custom tools, plugins, or skills here.
   This is the lowest-precedence layer.
2. **System config** — persisted on the host at
   `$OPENPALM_DATA_HOME/assistant/` and bind-mounted into the container at
   `/etc/opencode/` via `OPENCODE_CONFIG_DIR`. Contains the model selection,
   plugin declarations, and persona (AGENTS.md). Overrides user config.
3. **Project config** — an `opencode.json` in the `/work` directory (if present).
   Highest precedence, overrides everything.

Plugins declared in the system config (`@openpalm/assistant-tools`,
`@itlackey/openkit`) are auto-installed by OpenCode at startup via `bun` —
no `npm install` in the Dockerfile.

---

## Build-Time: Image Contents

The `core/assistant/Dockerfile` installs OpenCode, Bun, and system tools.
It does **not** bake in plugins, config files, or persona — those are
mounted at runtime.

```dockerfile
FROM node:lts-trixie
RUN apt-get update && apt-get install -y tini curl git ca-certificates bash openssh-server python3 python3-pip
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash -s -- --no-modify-path
RUN mkdir -p /home/opencode /work && chown node:node /home/opencode /work
COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
```

---

## Startup: Entrypoint Script

When the container starts, `entrypoint.sh` runs via `tini`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

# 1. Optionally start SSH daemon (key-only, no root, no tunneling)
if [ "$ENABLE_SSH" = "1" ] || [ "$ENABLE_SSH" = "true" ]; then
  # ... SSH setup (authorized_keys, host keys, sshd) ...
fi

# 2. Start the OpenCode web server
cd /work
exec opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs
```

OpenCode discovers tools, plugins, and skills from both `OPENCODE_CONFIG_DIR`
and `~/.config/opencode/`. Plugins declared in the config are auto-installed
on first boot (cached at `~/.cache/opencode/node_modules/`).

---

## Runtime Environment

### Volume Mounts

Five non-overlapping mounts, each at a distinct container path:

| Host Path | Container Path | Purpose |
|---|---|---|
| `DATA_HOME/assistant` | `/etc/opencode` | System config (`OPENCODE_CONFIG_DIR`) — model, plugins, persona |
| `CONFIG_HOME/assistant` | `~/.config/opencode` | User extensions — custom tools, plugins, skills |
| `STATE_HOME/opencode` | `~/.local/state/opencode` | Logs and session state |
| `DATA_HOME/opencode` | `~/.local/share/opencode` | OpenCode data directory |
| `WORK_DIR` | `/work` | Project files |

### Environment Variables

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | System config directory (overrides user config) |
| `OPENCODE_PORT` | `4096` | Web-server listen port |
| `OPENCODE_AUTH` | `false` | Auth handled by Caddy / Admin — disabled in OpenCode |
| `OPENCODE_ENABLE_SSH` | `0` (default) | SSH server (disabled by default, toggleable) |
| `HOME` | `/home/opencode` | User home for dotfiles, caches, and user config |
| `OPENPALM_ADMIN_API_URL` | `http://admin:8100` | Admin API base URL (used by admin tools) |
| `OPENPALM_ADMIN_TOKEN` | *(from secrets.env)* | Bearer token for Admin API calls |
| `OPENMEMORY_API_URL` | `http://openmemory:8765` | OpenMemory service URL (used by memory tools and plugin) |
| `OPENMEMORY_USER_ID` | `default_user` | User identifier for memory operations |

LLM provider keys are passed through from the host:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI provider |
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `GROQ_API_KEY` | Groq provider |
| `MISTRAL_API_KEY` | Mistral provider |
| `GOOGLE_API_KEY` | Google AI provider |

---

## System Config (`DATA_HOME/assistant/`)

System config is managed by the admin control plane. Files are seeded by
`ensureOpenCodeSystemConfig()` (called on every install, update, and startup)
and overwritten when the bundled version changes (with backup).

### opencode.jsonc

Selects the default model and declares plugins for auto-install:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle",
  "plugin": ["@openpalm/assistant-tools", "@itlackey/openkit"]
}
```

### AGENTS.md

Persona definition for the OpenPalm assistant. Describes role, memory
guidelines, behavior rules, and available skills.

---

## Tools

Tools are TypeScript files provided by the `@openpalm/assistant-tools` plugin
(auto-installed at runtime). They fall into two groups:

### Admin Tools

These call the Admin API at `$OPENPALM_ADMIN_API_URL` using
`$OPENPALM_ADMIN_TOKEN` for authentication.

| Tool | Purpose |
|---|---|
| `admin-lifecycle` | Start, stop, and restart stack services |
| `admin-containers` | List running containers and their status |
| `admin-config` | Read and update the network access scope |
| `admin-artifacts` | Inspect generated compose/caddy/env artifacts |
| `admin-audit` | Query the admin audit log |
| `admin-channels` | List installed and available channels |

### Memory Tools

These call the OpenMemory MCP service at `$OPENMEMORY_API_URL`.

| Tool | Purpose |
|---|---|
| `memory-search` | Semantic search across stored memories |
| `memory-add` | Store a new memory |
| `memory-get` | Retrieve a specific memory by ID |
| `memory-list` | List memories with optional filters |
| `memory-update` | Update an existing memory |
| `memory-delete` | Delete a memory |
| `memory-stats` | Get memory store statistics |
| `memory-apps` | List applications that have stored memories |

### Utility Tools

| Tool | Purpose |
|---|---|
| `health-check` | Verify connectivity to stack services |

---

## Plugins

### memory-context.ts

The memory-context plugin provides "compound memory" — the assistant
accumulates knowledge over time and recalls it automatically. It hooks into two
OpenCode lifecycle events:

**`experimental.session.compacting`** — When the context window is compacted,
the plugin searches OpenMemory for relevant context (user preferences, project
decisions) and injects it into the compaction output so that memories survive
the context window reset.

**`shell.env`** — Injects `OPENMEMORY_API_URL` and `OPENMEMORY_USER_ID` into
the shell environment so that child processes and tools can resolve the memory
service.

---

## Skills

Skills are markdown reference documents that OpenCode surfaces on demand:

| Skill | File | Purpose |
|---|---|---|
| `openmemory` | `skills/openmemory/SKILL.md` | How to use compound memory with OpenMemory |
| `openpalm-admin` | `skills/openpalm-admin/SKILL.md` | Admin API reference for the assistant |

---

## User Extensions

Users can add their own tools, plugins, or skills without rebuilding the image.

**Host path:** `$OPENPALM_CONFIG_HOME/assistant/`
**Container path:** `/home/opencode/.config/opencode/`

This directory lives under CONFIG_HOME — the single user touchpoint for all
editable configuration. It is bind-mounted into the assistant container at the
standard OpenCode user config path.

This is created by `ensureXdgDirs()` during installation and persists across
container restarts. `ensureOpenCodeConfig()` (called on every install and
update) seeds a starter `opencode.json` (schema reference only) and creates
the `tools/`, `plugins/`, and `skills/` subdirectories if they are absent.
The config file is never overwritten once it exists, so user edits are safe.

OpenCode merges configuration from both `~/.config/opencode/` (user) and
`OPENCODE_CONFIG_DIR` (system), so user-added extensions complement the
system-managed set.

---

## Configuration Flow Summary

```
Install                              Runtime
───────                              ───────
ensureXdgDirs()                      Container starts
  creates DATA_HOME/assistant/         │
  creates CONFIG_HOME/assistant/       ├── OPENCODE_CONFIG_DIR=/etc/opencode
  creates STATE_HOME/opencode/         │     reads opencode.jsonc (model + plugins)
  creates DATA_HOME/opencode/          │     reads AGENTS.md (persona)
                                       │
ensureOpenCodeSystemConfig()           ├── ~/.config/opencode/ (user extensions)
  writes DATA_HOME/assistant/          │     merges tools/, plugins/, skills/
    opencode.jsonc                     │
    AGENTS.md                          ├── auto-installs plugins via bun
                                       │     → ~/.cache/opencode/node_modules/
ensureOpenCodeConfig()                 │
  writes CONFIG_HOME/assistant/        ├── logs → ~/.local/state/opencode/
    opencode.json (schema ref)         │     (STATE_HOME/opencode on host)
    tools/ plugins/ skills/            │
                                       ├── data → ~/.local/share/opencode/
docker compose up                      │     (DATA_HOME/opencode on host)
                                       │
                                       └── opencode web --port 4096 --print-logs
```
