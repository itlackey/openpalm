# OpenCode Configuration Integration

This document explains how OpenPalm integrates with
[OpenCode](https://opencode.ai) — the AI coding runtime that powers the
assistant service.

---

## Overview

`CONFIG_HOME` is the user-owned persistent source of truth for all OpenCode
user extensions. See [core-principles.md](./core-principles.md) for the
full allowed-writers policy and filesystem contract.

OpenCode supports a layered configuration model. OpenPalm uses three layers:

1. **User config** — persisted on the host at
   `$OP_CONFIG_HOME/assistant/` and bind-mounted into the container at
   `~/.config/opencode/`. Users can add custom tools, plugins, or skills here.
   This is the lowest-precedence layer.
2. **System config** — persisted on the host at
   `$OP_DATA_HOME/assistant/` and bind-mounted into the container at
   `/etc/opencode/` via `OPENCODE_CONFIG_DIR`. Contains plugin declarations
   and persona (AGENTS.md). Overrides user config for keys it sets.
3. **Project config** — an `opencode.json` in the `/work` directory (if present).
   Highest precedence, overrides everything.

Plugins declared in the system config (`@openpalm/assistant-tools`,
`akm-opencode`) are auto-installed by OpenCode at startup via `bun` —
no `npm install` in the Dockerfile.

---

## Build-Time: Image Contents

The `core/assistant/Dockerfile` installs OpenCode, Bun, and system tools.
Core config files (`opencode.jsonc`, `AGENTS.md`) live in `core/assistant/`
in the repo and are baked into the image at build time. The image also
includes the entrypoint script and varlock shell wrapper.

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
| `OPENCODE_AUTH` | `false` | Disabled — host-only binding (127.0.0.1) provides the security boundary |
| `OPENCODE_ENABLE_SSH` | `0` (default) | SSH server (disabled by default, toggleable) |
| `HOME` | `/home/opencode` | User home for dotfiles, caches, and user config |
| `OP_ADMIN_API_URL` | `http://admin:8100` | Admin API base URL (used by admin tools) |
| `OP_ADMIN_TOKEN` | *(from vault/stack/stack.env)* | Bearer token for Admin API calls |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL (used by memory tools and plugin) |
| `MEMORY_USER_ID` | `default_user` | User identifier for memory operations |

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

Declares plugins for auto-install and security rules. The model is not
set here; it comes from the user's connection setup (see below):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openpalm/assistant-tools", "akm-opencode"],
  "permission": {
    "read": {
      "/home/opencode/.local/share/opencode/auth.json": "deny",
      "/home/opencode/.local/share/opencode/mcp-auth.json": "deny"
    }
  }
}
```

The `permission.read` deny rules prevent the assistant from reading
credential files that contain session tokens. This is part of the
context window protection strategy (see below).

The model is **not** set in the system config. It is determined by the
user's connection setup: the setup wizard or admin UI writes the selected
model to `CONFIG_HOME/assistant/opencode.json`, which OpenCode picks up
as the user config layer.

### AGENTS.md

Persona definition for the OpenPalm assistant. Describes role, memory
guidelines, behavior rules, and available skills.

---

## Tools

Tools are TypeScript files provided by the `@openpalm/assistant-tools` plugin
(auto-installed at runtime). They fall into two groups:

### Admin Tools

These call the Admin API at `$OP_ADMIN_API_URL` using
`$OP_ADMIN_TOKEN` for authentication.

| Tool | Purpose |
|---|---|
| `admin-lifecycle` | Start, stop, and restart stack services |
| `admin-containers` | List running containers and their status |
| `admin-config` | Read and update the network access scope |
| `admin-artifacts` | Inspect generated compose/env artifacts |
| `admin-audit` | Query the admin audit log |
| `admin-channels` | List installed and available channels |

### Memory Tools

These call the Memory API service at `$MEMORY_API_URL`.

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

The memory-context plugin provides "compound memory" - the assistant
accumulates knowledge over time and recalls it automatically. The current
implementation hooks into the full session lifecycle, not just compaction:

- **`session.created`** - retrieves scoped memories in parallel and injects a
  session context block. Retrieval includes personal semantic and procedural
  memory, project-scoped context, stack procedural guidance (`user_id=openpalm`),
  optional global procedures (`user_id=global`), and recent episodic notes.
- **`command.executed`** - extracts stable preference signals from user commands
  and stores them as personal semantic memory when novel.
- **`session.idle`** - periodically consolidates tracked tool outcomes into
  procedural learnings.
- **`tool.execute.before`** - injects scoped procedural guidance before admin
  and project/code tools, then records which memories were injected so outcome
  feedback can be applied afterward.
- **`tool.execute.after`** - reinforces or downranks injected memories based on
  tool success or failure.
- **`session.deleted`** - stores episodic summaries and cleans up per-session
  tracking state.
- **`experimental.session.compacting`** - injects only high-signal semantic and
  procedural memories plus compact session state so useful context survives
  window resets.
- **`shell.env`** - injects `MEMORY_API_URL` and `MEMORY_USER_ID` into the
  shell environment so child processes and tools can resolve the memory service.

Memory retrieval is intentionally scope-aware rather than hard-isolated by
default. Writes include explicit identity (`user_id`, `agent_id`, `app_id`,
optional `run_id`), while retrieval defaults to broader `user_id` scope unless
more specific filters are provided.

---

## Skills

Skills are markdown reference documents that OpenCode surfaces on demand:

| Skill | File | Purpose |
|---|---|---|
| `memory` | `skills/memory/SKILL.md` | How to use compound memory with Memory |
| `openpalm-admin` | `skills/openpalm-admin/SKILL.md` | Admin API reference for the assistant |

---

## User Extensions

Users can add their own tools, plugins, or skills without rebuilding the image.

**Host path:** `$OP_CONFIG_HOME/assistant/`
**Container path:** `/home/opencode/.config/opencode/`

This directory lives under CONFIG_HOME — the user-owned persistent source of truth for all
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

## Context Window Protection

The assistant has access to API keys and tokens at runtime (they are in
its process environment). When those credentials appear in tool output
(error messages, debug traces, env dumps), they enter the LLM context
window. Five layers prevent this:

### Layer 1: Shell Wrapper (varlock-shell)

OpenCode resolves its bash tool shell via the `$SHELL` environment
variable. The entrypoint sets `SHELL=/usr/local/bin/varlock-shell`, a
wrapper script that runs all bash tool commands through `varlock run`.
Varlock reads the redaction schema (`.env.schema` at
`/usr/local/etc/varlock/`) to identify sensitive variable names and
redacts their values from command output before OpenCode passes the
output to the LLM.

**Graceful fallback:** If `varlock` is not installed or the schema file
is missing (e.g. older image, custom builds), `varlock-shell` falls back
to plain `/bin/bash` with no redaction.

**Files:**
- `core/assistant/varlock-shell.sh` -- the wrapper script
- `core/assistant/entrypoint.sh` -- sets `SHELL` before starting OpenCode

### Layer 2: Provider Key Isolation

The entrypoint's `maybe_unset_unused_provider_keys()` function removes
LLM provider API keys that are not needed for the configured provider.
Only the active provider's key remains in the environment, limiting the
blast radius if the assistant process is compromised.

### Layer 3: Permission Deny on Credential Files

The system config (`opencode.jsonc`) includes `permission.read` deny
rules that block the assistant from reading OpenCode's own credential
stores:

- `/home/opencode/.local/share/opencode/auth.json` -- session tokens
- `/home/opencode/.local/share/opencode/mcp-auth.json` -- MCP auth tokens

These files contain tokens that the assistant never needs to read
directly. The deny rules ensure they cannot enter the context window
through OpenCode's file read tool.

### Layer 4: Varlock Runtime Redaction

When varlock is available, the entrypoint wraps the OpenCode process
with `varlock run`, which applies runtime redaction to stdout/stderr
based on the `.env.schema` at `/usr/local/etc/varlock/`.

### Layer 5: MCP Server Wrapping (planned)

Future layer — wrap MCP server communication for additional redaction.

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
