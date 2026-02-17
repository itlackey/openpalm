# OpenPalm — Container/App/Channel Assistant Platform

A safety-first AI assistant platform built on Bun/TypeScript with a layered container architecture. OpenPalm runs as a single Docker Compose stack with a reverse proxy, gateway, agent runtimes, memory backend, admin API, and optional channel adapters.

## Quick start

**Prerequisites:** Docker Desktop (or Docker Engine + Compose v2)

```bash
./install.sh
```

The installer checks prerequisites, resolves [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/) paths for persistent storage, generates secure defaults in `.env`, seeds agent configs, and boots the stack.

After startup:

| URL | Description |
|---|---|
| `http://localhost/admin` | Admin dashboard (LAN only) |
| `http://localhost/admin/openmemory` | Open Memory UI (LAN only) |
| `http://localhost/admin/opencode` | OpenCode UI (LAN only) |

To enable channel adapters (chat, Discord, voice, Telegram):

```bash
docker compose --profile channels up -d --build
```

## Architecture

OpenPalm uses a three-layer architecture where every component runs as a distinct Docker container:

```
┌─────────────────────────────────────────────────────────────┐
│                     CHANNELS (Layer 1)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Discord  │  │  Voice   │  │   Chat   │  │  Telegram  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       └──────────────┼──────────────┼─────────────┘         │
│                      ▼              ▼                        │
├─────────────────────────────────────────────────────────────┤
│                  APPLICATIONS (Layer 2)                      │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                │
│  │ Gateway  │   │ OpenCode │   │ OpenCode │                │
│  │ auth +   │──▶│ Channel  │──▶│  Core    │                │
│  │ routing  │   │ (intake) │   │ (agent)  │                │
│  └──────────┘   └──────────┘   └──────────┘                │
│                                     │                       │
│  ┌──────────┐   ┌──────────┐   ┌───┴──────┐                │
│  │  Admin   │──▶│Controller│   │  Open    │                │
│  │   App    │   │          │   │ Memory   │                │
│  └──────────┘   └──────────┘   └──────────┘                │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│               STORAGE + CONFIG (Layer 3)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐  │
│  │  PSQL    │  │  Qdrant  │  │ Shared FS                │  │
│  │(postgres)│  │ (vectors)│  │ (host XDG data mount)    │  │
│  └──────────┘  └──────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Caddy reverse proxy (front door):
  /channels/chat*, /channels/voice*       → channel adapters (LAN by default)
  /channels/discord*, /channels/telegram* → channel adapters (LAN by default)
  /admin/*                                → admin app (LAN only)
  /admin/opencode*                        → OpenCode Core UI (LAN only)
  /admin/openmemory*                      → Open Memory UI (LAN only)
```

All boxes represent a distinct container except Shared FS which is a shared mount point on the host. For a full Mermaid diagram and container inventory see [docs/architecture.md](docs/architecture.md).

### Data flow

**Channel inbound:**
```
User → Channel Adapter → [HMAC sign] → Gateway → OpenCode Channel (validate/summarize)
  → Gateway → OpenCode Core (full agent) → Open Memory → Response
```

**Admin operations:**
```
Admin (LAN) → Caddy (/admin/*) → Admin App → Controller → Docker Compose
```

## Services

### Core services

| Service | Role | Port |
|---|---|---|
| `caddy` | Reverse proxy, URL routing, LAN restriction | 80, 443 |
| `gateway` | Channel auth (HMAC), rate limiting, runtime routing, audit logging | 8080 (internal) |
| `opencode-core` | Primary agent runtime with approval gates, full skills | 4096 (internal) |
| `opencode-channel` | Isolated channel-intake runtime, deny-by-default permissions | 4097 (internal) |
| `openmemory` | Long-term memory backend (MCP over SSE) | 3000, 8765 (internal) |
| `admin-app` | Admin API: extensions, config, containers, channels, gallery | 8100 (internal) |
| `controller` | Container lifecycle (up/down/restart) via Docker socket | 8090 (internal) |

### Storage services

| Service | Role |
|---|---|
| `postgres` | Structured data storage |
| `qdrant` | Vector storage for embeddings |
| Shared FS | Shared mount point on host (`~/.local/share/openpalm/shared`) |

### Channel services (optional, `--profile channels`)

| Service | Role | Port |
|---|---|---|
| `channel-chat` | HTTP chat adapter | 8181 |
| `channel-discord` | Discord interactions/webhook adapter | 8184 |
| `channel-voice` | Voice/STT transcription adapter | 8183 |
| `channel-telegram` | Telegram webhook adapter | 8182 |

All channels are LAN-only by default. Use the Admin API to toggle individual channels to public access.

## Configuration

### Host directory layout (XDG Base Directory)

All persistent host directories follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

```
~/.local/share/openpalm/     (OPENPALM_DATA_HOME — databases, blobs)
  postgres/                   PostgreSQL data
  qdrant/                     Vector storage
  openmemory/                 Memory backend
  shared/                     Shared filesystem across services
  caddy/                      Caddy TLS certificates
  admin-app/                  Extension bundles, change states

~/.config/openpalm/           (OPENPALM_CONFIG_HOME — user-editable config)
  opencode-core/              Core agent config (opencode.jsonc, AGENTS.md, skills/)
  opencode-channel/           Channel intake agent config
  caddy/Caddyfile             Reverse proxy routing rules
  channels/                   Per-channel env files (channel-chat.env, etc.)

~/.local/state/openpalm/      (OPENPALM_STATE_HOME — runtime state, logs)
  opencode-core/              Core agent runtime state
  opencode-channel/           Channel agent runtime state
  gateway/                    Audit logs
  caddy/                      Caddy runtime config
  workspace/                  OpenCode working directory
```

Override any category by setting `OPENPALM_DATA_HOME`, `OPENPALM_CONFIG_HOME`, or `OPENPALM_STATE_HOME` in `.env`.

### Environment variables

Copy `.env.example` to `.env` (the installer does this automatically with generated secrets). Key variables:

| Variable | Purpose |
|---|---|
| `OPENPALM_DATA_HOME` / `CONFIG_HOME` / `STATE_HOME` | XDG directory overrides |
| `ADMIN_TOKEN` / `ADMIN_STEP_UP_TOKEN` | Admin API authentication |
| `CONTROLLER_TOKEN` | Admin-app to controller shared secret |
| `CHANNEL_*_SECRET` | Per-channel HMAC signing secrets |
| `POSTGRES_PASSWORD` | PostgreSQL credentials |
| `OPENCODE_TIMEOUT_MS` | Gateway timeout for OpenCode calls (default 15000ms) |

See `.env.example` for the full list.

## Security model

Security is enforced at multiple layers (defense in depth):

1. **Caddy** — Network-level access control. LAN-only restriction for admin and dashboard URLs. Channel ingress is LAN-only by default and can be toggled via the Admin API.
2. **Gateway** — HMAC signature verification for all channel payloads. Rate limiting (120 req/min/user). Audit logging with request/session/user correlation.
3. **OpenCode runtime isolation** — `opencode-channel` runs with deny-by-default permissions (bash, edit, webfetch all denied). `opencode-core` uses approval gates.
4. **OpenCode plugins** — The `policy-and-telemetry` plugin blocks tool calls containing secrets (API keys, tokens, passwords, private keys).
5. **Agent rules (AGENTS.md)** — Behavioral constraints: never store secrets, require confirmation for destructive actions, recall-first for user queries.
6. **Skills** — Standardized operating procedures: `ChannelIntake`, `RecallFirst`, `MemoryPolicy`, `ActionGating`.
7. **Admin step-up auth** — Dual-token model. Read operations require `x-admin-token`; destructive operations also require `x-admin-step-up`.
8. **Controller isolation** — Only the controller container has access to the Docker socket.

## Admin API

All admin operations are API/CLI-driven, accessed at `/admin/*` via Caddy (LAN only). See [docs/API.md](docs/API.md) for the full API reference.

### Key endpoint groups

- **Container management** — list, start, stop, restart services
- **Channel management** — list channels, toggle LAN/public access, configure channel env
- **Extension lifecycle** — request, list, apply, disable plugins
- **Config editor** — read/write `opencode.jsonc` with policy lint
- **Change manager** — propose, validate, apply, rollback config bundles
- **Gallery** — search curated extensions, search npm, install/uninstall
- **Setup wizard** — first-boot guided setup flow

### CLI for extension management

```bash
export ADMIN_APP_URL=http://localhost/admin
export ADMIN_TOKEN=...
export ADMIN_STEP_UP_TOKEN=...

bun run scripts/extensions-cli.ts request --plugin @scope/plugin
bun run scripts/extensions-cli.ts list
bun run scripts/extensions-cli.ts apply --request <request-id>
bun run scripts/extensions-cli.ts disable --plugin @scope/plugin
```

## Further documentation

| Document | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Full architecture diagram, container inventory, URL routing table, storage layout |
| [docs/API.md](docs/API.md) | Complete API reference for all services |
| [docs/implementation-guide.md](docs/implementation-guide.md) | Original implementation guide and design rationale |
| [docs/docker-compose-guide.md](docs/docker-compose-guide.md) | Docker Compose hosting and extensibility guide |
| [docs/admin-guide.md](docs/admin-guide.md) | Admin implementation details: installer, change manager, step-up auth |
| [docs/extensions-guide.md](docs/extensions-guide.md) | Extension/plugin system: installing, enabling, building plugins |
| [docs/IMPLEMENTATION-CHECKLIST.md](docs/IMPLEMENTATION-CHECKLIST.md) | Implementation status checklist |

## Development

```bash
# Run tests
bun test

# Type-check
bunx tsc -b

# Manage extensions via CLI
bun run scripts/extensions-cli.ts <command> [flags]
```

The project uses Bun workspaces. Service packages: `gateway`, `admin-app`, `controller`, `channels/chat`, `channels/discord`, `channels/voice`, `channels/telegram`.

## License

See [LICENSE](LICENSE).
