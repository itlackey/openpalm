# Assistant Service

The `assistant` container runs the OpenCode agent runtime with OpenPalm's built-in extensions. It is the AI brain of the platform — it processes validated messages from the gateway, recalls and saves memories, and executes tools on behalf of users.

## What it does

- **Agent runtime** — Runs [OpenCode](https://opencode.ai/docs/) with OpenPalm's built-in extensions baked in
- **Memory integration** — Recalls and saves memories via the OpenMemory service
- **Tool execution** — Executes tools with user approval gates (`bash`, `edit`, `webfetch` are `ask` by default)
- **Channel intake validation** — Used by the gateway's `channel-intake` agent to validate and summarize input before full processing

## Extension architecture

Extensions are **baked into the container image** at build time from `core/assistant/extensions/`. Host config provides optional user overrides volume-mounted at runtime.

```
core/assistant/extensions/            (repository source)
        ↓ COPY in Dockerfile
/opt/opencode/                   (immutable core extensions in image)
        ↓ OpenCode loads via OPENCODE_CONFIG_DIR=/opt/opencode

${OPENPALM_DATA_HOME}/assistant/  (host-persisted user-global state)
        ↕ mounted as /home/opencode
```

OpenCode uses `OPENCODE_CONFIG_DIR=/opt/opencode` to load core extensions and `HOME=/home/opencode` for user-global state (plugins cache, auth tokens, user overrides).

## Source layout

```
core/assistant/extensions/
├── opencode.jsonc                          # Core agent configuration
├── AGENTS.md                               # Immutable safety rules
├── plugins/
│   ├── openmemory-http.ts                  # Memory recall/writeback pipeline
│   └── policy-and-telemetry.ts            # Secret detection + audit logging
├── lib/
│   └── openmemory-client.ts               # Shared OpenMemory REST client (internal)
├── skills/
│   └── memory/
│       └── SKILL.md                        # Memory policy + recall-first rules
├── tools/
│   ├── memory-query.ts                     # Search OpenMemory
│   ├── memory-save.ts                      # Save to OpenMemory
│   └── health-check.ts                     # Check service health
└── commands/
    ├── memory-recall.md                    # /memory-recall slash command
    ├── memory-save.md                      # /memory-save slash command
    └── health.md                           # /health slash command
```

## Built-in extensions

### Plugins

**`openmemory-http.ts`** — Three-phase memory pipeline:
- Phase A: Pre-turn recall injection — queries OpenMemory and injects matching memories into the system prompt as `<recalled_memories>` XML
- Phase B: Post-turn writeback — on `session.idle`, persists save-worthy content after secret detection
- Phase C: Compaction preservation — re-injects `must-keep` tagged memories during context compaction

| Variable | Default | Description |
|---|---|---|
| `OPENPALM_MEMORY_MODE` | `api` | Set to anything other than `api` to disable |
| `OPENMEMORY_BASE_URL` | `http://openmemory:8765` | OpenMemory REST endpoint |
| `OPENMEMORY_API_KEY` | (empty) | Bearer token for auth |
| `RECALL_LIMIT` | `5` | Max memories per turn (1–50) |
| `RECALL_MAX_CHARS` | `2000` | Character budget for recall block (100–20000) |
| `WRITEBACK_ENABLED` | `true` | Enable post-turn writeback |
| `TEMPORAL_ENABLED` | `false` | Enable temporal knowledge graph |

**`policy-and-telemetry.ts`** — Intercepts every tool call via `tool.execute.before`. Scans arguments for secret patterns and blocks execution if detected. Logs every tool call as structured JSON to stdout.

### Skills

**`memory/SKILL.md`** — Behavioral rules for memory-informed responses: recall-first behavior, explicit-save-only policy, secret redaction, memory ID citation.

### Tools

| Tool | Description |
|---|---|
| `memory-query.ts` | Search OpenMemory for stored facts |
| `memory-save.ts` | Persist content to OpenMemory |
| `health-check.ts` | Check health of core services |

### Commands

| Command | Description |
|---|---|
| `/memory-recall` | Search and present matching memories |
| `/memory-save` | Save content and confirm memory ID |
| `/health` | Show service status and latency |

## Core configuration (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } }
  },
  "permission": {
    "bash": "ask",
    "edit": "ask",
    "webfetch": "ask"
  },
  "plugin": [
    "plugins/openmemory-http.ts",
    "plugins/policy-and-telemetry.ts"
  ]
}
```

## Adding extensions

### Install an npm plugin (via admin UI or CLI)

```bash
openpalm extensions install --plugin @scope/plugin-name
```

This adds the plugin to `plugin[]` in the host's `opencode.json` and restarts the assistant.

### Stack management via admin API (no Docker socket in assistant)

When the CLI is available in the assistant container workspace, use:

```bash
openpalm service restart assistant
```

The command uses `OPENPALM_ADMIN_API_URL` + `OPENPALM_ADMIN_TOKEN` to call admin over HTTP. This keeps compose/socket access isolated to the admin container.

### Manual host override (no rebuild)

Place files in `${OPENPALM_DATA_HOME}/assistant/.config/opencode/`:

```bash
# Skills
mkdir -p ${OPENPALM_DATA_HOME}/assistant/.config/opencode/skills/my-skill/
# Tools
mkdir -p ${OPENPALM_DATA_HOME}/assistant/.config/opencode/tools/
# Agents
mkdir -p ${OPENPALM_DATA_HOME}/assistant/.config/opencode/agents/
```

Changes take effect after restarting `assistant`.

### Baked-in (requires image rebuild)

Add files under `core/assistant/extensions/` and rebuild the container image.

## SSH access (optional)

SSH into the assistant container is disabled by default.

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_ENABLE_SSH` | `0` | Set to `1` to enable SSH |
| `OPENPALM_ASSISTANT_SSH_PORT` | `2222` | Host port mapped to container SSH port 22 |
| `OPENPALM_ASSISTANT_SSH_BIND_ADDRESS` | `127.0.0.1` | Bind address (use `0.0.0.0` for LAN) |

To enable:
1. Set `OPENCODE_ENABLE_SSH=1`
2. Place your public key in `~/.config/openpalm/assistant/ssh/authorized_keys`
3. Restart `assistant`
4. Connect: `ssh -p ${OPENPALM_ASSISTANT_SSH_PORT} root@localhost`

## Related docs

- [Architecture](../dev/docs/architecture.md) — Container architecture and data flow
- [Security Guide](../docs/security.md) — Security model
