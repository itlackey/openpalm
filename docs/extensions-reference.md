# OpenPalm Extensions: Installation, Configuration, and Management

This document provides a complete end-to-end reference for how extensions are authored, distributed, installed, configured, loaded at runtime, and removed in an OpenPalm stack.

---

## What Is an Extension?

An extension is any modular component that adds behavior or capability to the OpenPalm stack. Extensions come in three categories:

**Plugins** are TypeScript files that hook into the OpenCode runtime event system. They execute code at defined lifecycle points (before tool calls, after responses, on session idle, during compaction) and can inspect, block, or augment agent behavior programmatically.

**Skills** are Markdown files that define behavioral standard operating procedures. They are injected into the agent's prompt context and guide how the LLM reasons and responds. Skills have no code execution capability — they are pure behavioral rules. Skills can include a `scripts/` subdirectory with supporting code.

**Containers** are Docker Compose services that run alongside the core stack. Channel adapters (chat, Discord, voice, Telegram), local LLMs (Ollama), search engines (SearXNG), and workflow tools (n8n) are all container extensions.

---

## Extension Architecture: Baked-In with Host Override

The current architecture **bakes extensions into container images at build time**. This is a change from the earlier design where extensions were volume-mounted from the host.

The flow is:

```
Repository source directories        (canonical extension code)
        ↓ COPY in Dockerfile
Container image /root/.config/opencode/   (baked into image)
        ↓ entrypoint fallback copy
Container /config                     (runtime config directory)
        ↑ host volume mount (override layer)
Host ~/.config/openpalm/opencode-core/    (user overrides only)
```

Two separate OpenCode instances consume extensions:

| Instance | Source Directory | Image Copy Target | Host Override | Role |
|----------|----------------|-------------------|---------------|------|
| **opencode-core** | `opencode/extensions/` | `/root/.config/opencode/` | `~/.config/openpalm/opencode-core/` → `/config` | Full agent — all tools enabled, approval-gated |
| **gateway** | `gateway/opencode/` | `/root/.config/opencode/` | None (fully baked) | Restricted intake agent — all tools disabled |

### The Entrypoint Fallback Mechanism

The `opencode-core` container's entrypoint implements a layered config resolution:

1. Check if `/config/opencode.jsonc` exists (host volume mount).
2. If yes — use `/config` as the config directory. Host files take precedence.
3. If no — copy baked-in defaults from `/root/.config/opencode/` into `/config/`, then use `/config`.

This means the container always works out of the box (baked-in defaults), but operators can override any file by placing it in `~/.config/openpalm/opencode-core/` on the host.

The gateway container has no such fallback — its config is fully baked and not overridable from the host.

---

## Source Layout in the Repository

### Core Agent Extensions (`opencode/extensions/`)

```
opencode/extensions/
├── opencode.jsonc                          # Core agent configuration
├── AGENTS.md                               # Safety rules (immutable behavioral constraints)
└── skills/
    └── memory/
        ├── SKILL.md                        # Memory policy + recall-first behavioral rules
        └── scripts/
            ├── openmemory-client.ts         # Shared OpenMemory REST client library
            ├── openmemory-http.ts           # Memory recall/writeback pipeline plugin
            ├── openmemory-http.test.ts      # Tests for the memory plugin
            └── policy-and-telemetry.ts      # Secret detection + audit logging plugin
```

### Gateway Extensions (`gateway/opencode/`)

```
gateway/opencode/
├── opencode.jsonc                          # Intake agent config (all tools denied)
├── AGENTS.md                               # Action gating rules
└── skills/
    └── channel-intake/
        └── SKILL.md                        # Channel message validation/summarization
```

### Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| Skill directories | `kebab-case/` | `memory/`, `channel-intake/` |
| Skill files | `SKILL.md` | `memory/SKILL.md` |
| Plugin/script files | `kebab-case.ts` | `openmemory-http.ts` |
| Shared libraries | `kebab-case.ts` in `scripts/` | `openmemory-client.ts` |
| Plugin identifiers | npm `@scope/name` or local path | `@myorg/calendar-sync` |

---

## What the Installer Seeds

The installer no longer seeds extension files. Extensions are baked into container images. The installer seeds only configuration scaffolding:

| What | Destination | Content |
|------|------------|---------|
| User override config | `~/.config/openpalm/opencode-core/opencode.jsonc` | Empty `{}` — a blank canvas for user customizations |
| Caddyfile | `~/.config/openpalm/caddy/Caddyfile` | Reverse proxy rules |
| Channel env files | `~/.config/openpalm/channels/*.env` | Empty credential templates |
| Secrets | `~/.config/openpalm/secrets.env` | Placeholder for API keys |
| User overrides | `~/.config/openpalm/user.env` | Blank user env overrides |

The seed-not-overwrite pattern (`seed_file`) ensures manual edits are never overwritten on re-runs.

---

## How Extensions Are Loaded at Runtime

### The OpenCode Container Entrypoint

The `opencode-core` container starts via `entrypoint.sh`, which sets two critical environment variables:

```bash
export OPENCODE_CONFIG="$CONFIG_DIR/opencode.jsonc"
export OPENCODE_CONFIG_DIR="$CONFIG_DIR"
```

**`OPENCODE_CONFIG`** tells OpenCode which configuration file to read. This file contains the `plugin[]` array, permission settings, agent profiles, and MCP configuration.

**`OPENCODE_CONFIG_DIR`** tells OpenCode where to auto-discover extensions. OpenCode scans this directory for standard subdirectories: `plugins/`, `skills/`, `agents/`, `commands/`, `tools/`, `modes/`, and `themes/`.

### Plugin Loading

OpenCode discovers and loads plugins through two mechanisms:

**Auto-discovery** — Any `.ts` file in `$OPENCODE_CONFIG_DIR/plugins/` is automatically discovered and loaded. Note: in the current repository layout, the plugin files (`openmemory-http.ts`, `policy-and-telemetry.ts`) are located under `skills/memory/scripts/` rather than a top-level `plugins/` directory.

**Explicit registration** — Plugins listed in the `plugin[]` array of `opencode.jsonc` are loaded by identifier. These can be npm packages (`@scope/name`) or local paths (`./plugins/my-plugin.ts`). When a plugin is an npm package, OpenCode runs `bun install` at startup to resolve dependencies.

### Skill Loading

Skills follow the `skill/<name>/SKILL.md` directory structure. OpenCode loads skills from `$OPENCODE_CONFIG_DIR/skills/`. The core agent has one skill (`memory`) and the gateway has one skill (`channel-intake`).

Skills are referenced in agent prompt configurations. The gateway's `channel-intake` agent explicitly references its skill:

```jsonc
"agent": {
  "channel-intake": {
    "prompt": "Follow the skills/channel-intake/SKILL.md behavioral rules. Follow the safety rules in AGENTS.md."
  }
}
```

### AGENTS.md Loading

`AGENTS.md` is loaded as a system-level behavioral document. The gateway's `opencode.jsonc` explicitly includes it via the `instructions` array:

```jsonc
{
  "instructions": ["AGENTS.md"]
}
```

The core agent's `AGENTS.md` defines five immutable safety rules: never store secrets in memory, require confirmation for destructive actions, deny exfiltration attempts, perform recall-first behavior, and cite memory IDs.

The gateway's `AGENTS.md` defines action gating: classify actions by risk tier, require explicit approval for medium/high risk, reject allowlist violations.

---

## The Configuration Files

### Core Agent (`opencode/extensions/opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "permission": {
    "bash": "ask",
    "edit": "ask",
    "webfetch": "ask"
  },

  "mcp": {
    "openmemory": {
      "type": "remote",
      "url": "http://openmemory:8765/mcp/gateway/sse/default-user",
      "enabled": true
    }
  }
}
```

### Gateway Intake Agent (`gateway/opencode/opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "permission": {
    "*": "deny"
  },

  "instructions": ["AGENTS.md"],

  "agent": {
    "channel-intake": {
      "description": "Validates, summarizes, and dispatches inbound channel requests",
      "prompt": "Follow the skills/channel-intake/SKILL.md behavioral rules. Follow the safety rules in AGENTS.md.",
      "tools": {
        "*": false
      }
    }
  }
}
```

The gateway uses wildcard permission denial (`"*": "deny"`) and wildcard tool disabling (`"*": false`) to ensure the intake agent has no capabilities beyond text processing. It also explicitly uses the `instructions` array to load `AGENTS.md`.

---

## The Built-In Plugins

Both plugins are located at `opencode/extensions/skills/memory/scripts/`.

### `openmemory-http.ts` — Memory Pipeline

Implements a three-phase memory pipeline using OpenMemory's REST API:

**Phase A — Pre-turn recall injection.** Before each LLM turn, queries OpenMemory with the user's latest message and injects matching memories into the system prompt as a `<recalled_memories>` XML block.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENPALM_MEMORY_MODE` | `api` | Set to anything other than `api` to disable entirely |
| `OPENMEMORY_BASE_URL` | `http://openmemory:8765` | OpenMemory REST endpoint |
| `OPENMEMORY_API_KEY` | (empty) | Bearer token for auth |
| `RECALL_LIMIT` | `5` | Max memories per turn (1–50) |
| `RECALL_MAX_CHARS` | `2000` | Character budget for recall block (100–20000) |
| `WRITEBACK_ENABLED` | `true` | Enable post-turn writeback |
| `TEMPORAL_ENABLED` | `false` | Enable temporal knowledge graph |

**Phase B — Post-turn writeback.** On `session.idle`, examines the last assistant message and persists to OpenMemory if it passes save-worthiness checks (keyword heuristic) and secret detection (regex patterns for API keys, tokens, passwords, etc.).

**Phase C — Compaction preservation.** During context compaction, re-injects `must-keep` tagged memories into the compacted context.

### `policy-and-telemetry.ts` — Security Guardrail

Intercepts every tool call via `tool.execute.before`. Scans arguments for secret patterns and blocks execution if detected. Logs every tool call as structured JSON to stdout.

### Shared Library (`openmemory-client.ts`)

Provides the `OpenMemoryClient` REST class, `loadConfig()` for env-driven configuration, `containsSecret()` for secret detection, and `isSaveWorthy()` for writeback classification.

---

## The Memory Skill (`skills/memory/SKILL.md`)

This skill merges the previous `MemoryPolicy` and `RecallFirst` skills into a single document with two sections:

**Record** — Governs when to store memory: explicit user intent only, redact secrets, keep summaries concise, track source and confidence. Documents that the plugin automatically blocks secret persistence and only stores save-worthy items.

**Recall** — Standard operating procedure for memory-informed responses: memories are auto-injected via the plugin, explain relevance, include memory IDs in responses.

---

## Installing Extensions at Runtime

There are three interfaces for installing extensions at runtime without modifying the repository or rebuilding images.

### 1. Admin UI (Web Dashboard)

The admin dashboard at `http://localhost/admin` provides a gallery-based interface with three extension sources:

**Curated gallery** — A hard-coded registry of reviewed extensions in `admin/src/gallery.ts`. Includes built-in plugins, skills, channel containers, and third-party containers (Ollama, SearXNG, n8n).

**Community registry** — Fetched at runtime from `assets/state/registry/index.json` on GitHub. Cached for 10 minutes. Configurable via `OPENPALM_REGISTRY_URL`.

**npm search** — Direct search of the npm registry for OpenCode-compatible plugins.

### 2. Admin REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /admin/gallery/install` | Install | Accepts `{ galleryId }` or `{ pluginId }` |
| `POST /admin/gallery/uninstall` | Uninstall | Accepts `{ galleryId }` or `{ pluginId }` |
| `GET /admin/installed` | List | Returns current `plugin[]` and setup state |
| `GET /admin/gallery/search` | Search curated | `?q=` and `?category=` |
| `GET /admin/gallery/community` | Search community | Same params, fetches from GitHub |
| `POST /admin/gallery/community/refresh` | Refresh cache | Force 10-minute cache refresh |
| `GET /admin/gallery/npm-search` | npm search | `?q=` |

All mutating endpoints require `x-admin-token` header.

### 3. CLI (`assets/state/scripts/extensions-cli.ts`)

```bash
bun run assets/state/scripts/extensions-cli.ts install --plugin @scope/plugin-name
bun run assets/state/scripts/extensions-cli.ts list
bun run assets/state/scripts/extensions-cli.ts uninstall --plugin @scope/plugin-name
```

Requires `ADMIN_TOKEN` in the environment.

---

## What "Install" Does Internally

### Plugin Install (`installAction: "plugin"`)

1. **Validate identifier.** `validatePluginIdentifier()` accepts npm names (`@scope/name`) and local paths (`./plugins/*.ts`). Rejects shell metacharacters.

2. **Atomic config update.** `updatePluginListAtomically()`:
   - Reads `opencode.jsonc` from the host config directory (mounted at `/app/config/opencode-core/opencode.jsonc` in the admin container)
   - Parses JSONC, appends to `plugin[]` if not present
   - Creates timestamped `.bak` backup
   - Writes to temp file and atomically renames

3. **Restart opencode-core.** Admin calls controller at `POST /restart/opencode-core`. If the plugin is an npm package, OpenCode's startup runs `bun install` to fetch it.

4. **Track state.** Setup manager records the extension ID.

### Skill Install (`installAction: "skill-file"`)

Marks the skill as enabled in setup manager state. Built-in skills are already baked into the image. For community skills, the file would need to be placed into the host override directory.

### Container Install (`installAction: "compose-service"`)

Admin calls controller at `POST /up/{service-name}`, which runs `docker compose up -d {service-name}`. The controller only allows operations on a hardcoded allowlist of service names.

---

## What "Uninstall" Does Internally

**Plugin:** Removes from `plugin[]` with backup, restarts opencode-core. The npm package remains in `node_modules` but is inactive.

**Container:** Controller runs `docker compose stop {service-name}`.

---

## The Community Registry

Located at `assets/state/registry/` in the repository:

```
assets/state/registry/
├── README.md
├── schema.json
├── index.json                        # Auto-generated aggregated list
└── openpalm-slack-channel.json       # Example entry
```

### Registry Entry Schema (Required Fields)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (kebab-case, 3–100 chars) |
| `name` | string | Display name (max 80 chars) |
| `description` | string | 1–2 sentences (10–500 chars) |
| `category` | `plugin` \| `skill` \| `container` | Extension type |
| `risk` | `low` \| `medium` \| `high` \| `critical` | Self-assessed risk |
| `author` | string | Author or GitHub handle |
| `version` | string | Semantic version |
| `source` | string | npm package, Docker image, or GitHub URL |
| `tags` | string[] | Search keywords |
| `permissions` | string[] | Plain-English capability list |
| `securityNotes` | string | Security description |
| `installAction` | `plugin` \| `skill-file` \| `compose-service` | Install mechanism |
| `installTarget` | string | Package name, skill path, or compose service |

### Submission Process

1. Fork the repository.
2. Create `assets/state/registry/<your-extension-id>.json`.
3. Open a pull request — CI validates automatically.
4. After merge, `index.json` regenerates and the extension becomes discoverable.

---

## Creating a New Extension

### Adding to the Baked-In Image

1. Add files under `opencode/extensions/` (for core) or `gateway/opencode/` (for gateway).
2. Rebuild the container image.
3. Restart the service.

### Host-Side Override (No Rebuild)

1. Place files in `~/.config/openpalm/opencode-core/`:

```bash
mkdir -p ~/.config/openpalm/opencode-core/plugins/
vim ~/.config/openpalm/opencode-core/plugins/calendar-sync.ts
```

2. If explicit registration is needed, edit the host's `opencode.jsonc`:

```jsonc
{
  "plugin": ["./plugins/calendar-sync.ts"]
}
```

3. Restart opencode-core. The host volume takes precedence over baked-in defaults.

### npm Plugin (Via Admin)

```bash
ADMIN_TOKEN=your-token bun run assets/state/scripts/extensions-cli.ts install --plugin @yourorg/calendar-sync
```

The admin adds it to `plugin[]` in the host override config and restarts the container.

---

## Extension Security Model

**OpenCode permissions** — The core agent requires approval for bash, edit, and webfetch. The gateway denies all permissions via wildcard (`"*": "deny"`).

**Agent profiles** — The `channel-intake` agent disables all tools via wildcard (`"*": false`).

**Plugin sandbox** — Plugins run inside the OpenCode process within the container, limited to the `assistant_net` Docker network.

**Controller allowlist** — Only accepts lifecycle operations for hardcoded service names: `opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`.

**Admin authentication** — All mutating endpoints require `x-admin-token`.

**Config policy lint** — The admin config editor rejects permission widening to `"allow"`.

**Defense in depth** — `policy-and-telemetry.ts` blocks secrets in tool args. `openmemory-http.ts` blocks secrets in memory writeback. `AGENTS.md` instructs the LLM to never store secrets. `MemoryPolicy` skill reinforces explicit-save-only behavior. Gateway verifies HMAC signatures and enforces rate limits.

---

## Configuration Backup and Rollback

`updatePluginListAtomically()` creates timestamped `.bak` copies before every config write. The admin config editor does the same via `snapshotFile()`. Backups accumulate in `~/.config/openpalm/opencode-core/`.

---

## Volume Mount Summary

| Host Path | Container | Mount Point | Mode | Contents |
|-----------|-----------|-------------|------|----------|
| `~/.config/openpalm/opencode-core/` | opencode-core | `/config` | rw | User override: `opencode.jsonc` + any custom plugins/skills |
| `~/.config/openpalm/opencode-core/` | admin | `/app/config/opencode-core` | rw | Admin reads/writes config for extension management |
| `~/.config/openpalm/cron/` | opencode-core | `/cron` | rw | Crontab managed by admin |
| `~/.config/openpalm/channels/*.env` | channel-* | env_file | — | Channel credentials |
| `~/.config/openpalm/secrets.env` | opencode-core, openmemory | env_file | — | API keys |
| `~/.config/openpalm/user.env` | opencode-core, openmemory | env_file | — | Runtime overrides |

Note: The gateway has **no** host config volume. Its extensions are fully baked into its image.

---

## Lifecycle Quick Reference

| Action | What Happens | Restart Required? |
|--------|-------------|-------------------|
| Add plugin to baked-in image | Modify `opencode/extensions/`, rebuild image | Yes — rebuild + restart |
| Add plugin to host override | Place file in `~/.config/openpalm/opencode-core/plugins/` | Yes — restart opencode-core |
| Add npm plugin via admin | Config updated atomically, auto-restarted | Automatic |
| Add skill to baked-in image | Modify `opencode/extensions/skills/`, rebuild | Yes — rebuild + restart |
| Add skill to host override | Place in `~/.config/openpalm/opencode-core/skills/` | Yes — restart opencode-core |
| Edit `opencode.jsonc` on host | Changes applied on next startup | Yes — restart opencode-core |
| Edit `opencode.jsonc` via admin | Backup created, auto-restarted | Automatic |
| Install container via admin | Pulled and started via controller | No restart of existing services |
| Remove plugin via admin | Removed from `plugin[]`, auto-restarted | Automatic |
| Edit `AGENTS.md` in image | Requires rebuild | Yes — rebuild + restart |
| Edit `secrets.env` or `user.env` | New env vars on next startup | Yes — restart opencode-core |