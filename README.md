# OpenPalm — Container/App/Channel Assistant Platform

A safety-first AI assistant platform built on Bun/TypeScript with a layered container architecture.

## Architecture overview

OpenPalm uses a three-layer architecture where every component runs as a distinct container:

```
┌─────────────────────────────────────────────────────────┐
│                    CHANNELS (Layer 1)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Discord  │  │  Voice   │  │   Chat   │  │Telegram│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       └──────────────┼──────────────┼───────────┘       │
│                      ▼              ▼                    │
├─────────────────────────────────────────────────────────┤
│                 APPLICATIONS (Layer 2)                   │
│                                                         │
│  Admin UI    Open Memory    Open Code                   │
│     │            │              │                        │
│  ┌──┴───┐   ┌───┴────┐   ┌────┴─────┐   ┌──────────┐  │
│  │Admin │   │  Open   │   │  Open    │   │          │  │
│  │ App  │   │ Memory  │   │  Code    │   │ Gateway  │◄─┤── all channel inbound
│  └──┬───┘   └────────┘   └──────────┘   └──────────┘  │
│     │                                                   │
│  ┌──┴────────┐                                          │
│  │Controller │  (can up/down containers)                │
│  └───────────┘                                          │
├─────────────────────────────────────────────────────────┤
│               STORAGE + CONFIG (Layer 3)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │  PSQL    │  │  Qdrant  │  │ Shared FS            │  │
│  │(postgres)│  │ (vectors)│  │ (host mount at /shared│) │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────┘

Caddy reverse proxy (front door):
  host/chat, host/voice     → optional public channels
  host/admin                → LAN only
  host/opencode             → LAN only
  host/openmemory           → LAN only
```

All boxes represent a distinct container except Shared FS which is a shared mount point on the host.

## Key design principles

- **Admin app can add/remove containers** via the controller
- **Admin app can edit Caddy** to map sub-urls to containers
- **Admin app provides API** for all admin functions
- **All channels are processed through the gateway** as defense in depth
- **Admin + dashboards are restricted** to host or LAN via Caddy

## Services

### Core services
| Service | Role | Port |
|---|---|---|
| `caddy` | Reverse proxy, URL routing, LAN restriction | 80, 443 |
| `gateway` | Defense-in-depth channel processing, tool firewall, memory, audit | 8080 (internal) |
| `opencode` | Agent runtime and LLM orchestration | 4096 (internal) |
| `openmemory` | Long-term memory backend (MCP) | 3000, 8765 (internal) |
| `admin-app` | Admin API: extensions, config, container management | 8100 (internal) |
| `controller` | Container lifecycle (up/down/restart) via Docker socket | 8090 (internal) |

### Storage services
| Service | Role |
|---|---|
| `postgres` | Structured data storage |
| `qdrant` | Vector storage for embeddings |
| Shared FS | Shared mount point on host (`data/shared`) |

### Channel services (optional, `--profile channels`)
| Service | Role | Port |
|---|---|---|
| `channel-chat` | HTTP chat adapter | 8181 |
| `channel-discord` | Discord interactions/webhook adapter | 8184 |
| `channel-voice` | Voice/STT transcription adapter | 8183 |
| `channel-telegram` | Telegram webhook adapter | 8182 |

## Installation

1. Install Docker Desktop (or Docker Engine + Compose v2)
2. Run:
   ```bash
   ./install.sh
   ```
3. Access:
   - Health check: `http://localhost/health`
   - Admin dashboard (LAN): `http://localhost/admin`
   - Open Memory UI (LAN): `http://localhost/openmemory`

To enable channel adapters:
```bash
docker compose --profile channels up -d --build
```

## Safety defaults

- Tool firewall with explicit risk tiers (`safe`, `medium`, `high`)
- Approval required for medium/high risk tools
- Network egress allowlist for `safe_fetch`
- Secret detection blocks memory writes and suspicious tool args
- Recall-first response behavior with memory IDs and rationale
- Audit log with request/session/user correlation
- Replay protection and signature verification for all channel ingress
- Rate limiting at gateway message ingress
- Admin + dashboards restricted to LAN via Caddy

## Admin API (served by admin-app)

All admin operations are API/CLI-driven, accessed at `/admin/*` via Caddy (LAN only).

### Container management
- `GET /admin/containers/list` — list running containers
- `POST /admin/containers/up` — start a service (step-up required)
- `POST /admin/containers/down` — stop a service (step-up required)
- `POST /admin/containers/restart` — restart a service (step-up required)

### Extension lifecycle
- `POST /admin/extensions/request` — queue a plugin for install
- `GET /admin/extensions/list` — review extension queue
- `POST /admin/extensions/apply` — apply extension (step-up required)
- `POST /admin/extensions/disable` — disable extension (step-up required)

### Config editor
- `GET /admin/config` — read OpenCode config
- `POST /admin/config` — write config (step-up required, policy lint enforced)

### Change manager
- `POST /admin/change/propose` — register a change bundle
- `POST /admin/change/validate` — validate bundle
- `POST /admin/change/apply` — apply bundle (step-up required)
- `POST /admin/change/rollback` — rollback config (step-up required)

## CLI for extension approvals

```bash
export ADMIN_APP_URL=http://localhost/admin
export ADMIN_TOKEN=...
export ADMIN_STEP_UP_TOKEN=...

bun run scripts/extensions-cli.ts request --plugin @scope/plugin
bun run scripts/extensions-cli.ts list
bun run scripts/extensions-cli.ts apply --request <request-id>
bun run scripts/extensions-cli.ts disable --plugin @scope/plugin
```

## Notes

- Core stack runs with `docker compose up -d --build`
- Channel adapters are opt-in via `--profile channels`
- Caddy handles TLS termination and URL routing
- Admin and dashboard UIs are restricted to LAN by Caddy's IP-based access control
- All external channel traffic flows through the gateway for defense in depth
