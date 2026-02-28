# OpenCode Configuration Integration

This document explains how OpenPalm integrates with
[OpenCode](https://opencode.ai) — the AI coding runtime that powers the
assistant service.

---

## Overview

OpenCode supports a layered configuration model. OpenPalm uses two layers:

1. **Built-in config** — bundled into the Docker image at `/opt/opencode/` and
   loaded via the `OPENCODE_CONFIG_DIR` environment variable.  This layer is
   immutable at runtime.
2. **User extensions** — persisted on the host at
   `$OPENPALM_CONFIG_HOME/opencode/` and bind-mounted into the container at
   `/home/opencode/.config/opencode/` as an overlay.  Users can drop additional
   tools, plugins, or skills here without rebuilding the image.

---

## Build-Time: Image Contents

The `core/assistant/Dockerfile` copies the `core/assistant/` directory into the image and
installs the entrypoint script:

```dockerfile
COPY --chown=node:node core/assistant/ /opt/opencode/
COPY core/assistant/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
```

After the build, `/opt/opencode/` inside the image contains:

```
/opt/opencode/
├── opencode.jsonc        # Model selection
├── package.json          # Runtime dependency (zod v4)
├── entrypoint.sh         # Container startup script
├── tools/                # Custom tool definitions
│   ├── admin-artifacts.ts
│   ├── admin-audit.ts
│   ├── admin-channels.ts
│   ├── admin-config.ts
│   ├── admin-containers.ts
│   ├── admin-lifecycle.ts
│   ├── health-check.ts
│   ├── memory-add.ts
│   ├── memory-apps.ts
│   ├── memory-delete.ts
│   ├── memory-get.ts
│   ├── memory-list.ts
│   ├── memory-search.ts
│   ├── memory-stats.ts
│   └── memory-update.ts
├── plugins/
│   └── memory-context.ts  # Compound-memory plugin
└── skills/
    ├── openmemory/SKILL.md
    └── openpalm-admin/SKILL.md
```

### opencode.jsonc

Minimal config that selects the default model:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle"
}
```

### package.json

Minimal package marker. Zod is provided by OpenCode's runtime, so no explicit
dependency declaration is needed:

```json
{
  "private": true
}
```

---

## Startup: Entrypoint Script

When the container starts, `entrypoint.sh` (installed at
`/usr/local/bin/opencode-entrypoint.sh`) runs via `tini`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCODE_PORT:-4096}"
ENABLE_SSH="${OPENCODE_ENABLE_SSH:-0}"

# 1. Optionally start SSH daemon (key-only, no root, no tunneling)
if [ "$ENABLE_SSH" = "1" ] || [ "$ENABLE_SSH" = "true" ]; then
  # ... SSH setup (authorized_keys, host keys, sshd) ...
fi

# 2. Start the OpenCode web server as the node user
cd /work
exec su -s /bin/bash node -c "opencode web --hostname 0.0.0.0 --port ${PORT} --print-logs"
```

The container starts as `root` (to allow optional SSH daemon setup), then
drops to the `node` user via `su` for the OpenCode process. OpenCode discovers
tools, plugins, and skills from `OPENCODE_CONFIG_DIR`.

---

## Runtime Environment

The compose file sets these environment variables on the assistant service:

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/opt/opencode` | Root for built-in config, tools, plugins, skills |
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

## Tools

Tools are TypeScript files in `/opt/opencode/tools/`. OpenCode auto-discovers
them. They fall into two groups:

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

**Host path:** `$OPENPALM_CONFIG_HOME/opencode/`
**Container path:** `/home/opencode/.config/opencode/`

This directory lives under CONFIG_HOME — the single user touchpoint for all
editable configuration. It is mounted as an overlay into the assistant
container, sitting on top of the assistant's home directory at the standard
OpenCode user config path.

This is created by `ensureXdgDirs()` during installation and persists across
container restarts. `ensureOpenCodeConfig()` (called on every install and
update) seeds a starter `opencode.json` (schema reference only) and creates
the `tools/`, `plugins/`, and `skills/` subdirectories if they are absent.
The config file is never overwritten once it exists, so user edits are safe.

OpenCode merges configuration from both `OPENCODE_CONFIG_DIR` (built-in) and
`$HOME/.config/opencode/` (user), so user-added extensions complement the
built-in set.

---

## Configuration Flow Summary

```
Build Time                    Install Time                  Runtime
──────────                    ────────────                  ───────
core/assistant/  ──COPY──►  /opt/opencode/          OPENCODE_CONFIG_DIR=/opt/opencode
                              │                             │
                              │                    opencode discovers tools/,
                              │                    plugins/, skills/
                              │
                        ensureXdgDirs() creates    User drops files into
                        host dirs                  $CONFIG_HOME/opencode/
                               │                             │
                        ensureOpenCodeConfig()       Merged at runtime by OpenCode
                        seeds opencode.json,                 │
                        tools/, plugins/, skills/
                               │
                        stageCompose()
                        sets env vars, mounts               │
                              │                             │
                       docker compose up ──────►  entrypoint.sh
                                                    ├── optional SSH setup
                                                    └── su node → opencode web --port 4096
```
