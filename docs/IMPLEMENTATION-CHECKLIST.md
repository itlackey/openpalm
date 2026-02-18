# Implementation Checklist

## Implementation guide (docs/implementation-guide.md)
- [x] OpenMemory private service wiring in compose
- [x] OpenCode runtime service and config
- [x] OpenMemory MCP referenced from OpenCode config
- [x] Gateway `/channel/inbound` and `/health`
- [x] Tool firewall (allowlist, approval gates)
- [x] Observability/audit event logging
- [x] Rules + skills for recall-first + memory policy + action gating

## Docker Compose guide (docs/docker-compose-guide.md)
- [x] Single compose stack with Gateway + OpenCode + OpenMemory
- [x] Optional channel services as dumb adapters
- [x] MCP/custom-tool extension path documented
- [x] Safety hard rules implemented (egress allowlist, replay, auth)

## Admin guide (docs/admin-guide.md)
- [x] Installer script with checks + bootstrap
- [x] Config edit + safe write + restart flow
- [x] Container lifecycle management (controller)
- [x] Admin password authentication for all admin operations

## Extensions guide (docs/extensions-guide.md)
- [x] OpenCode `plugin[]` treated as canonical extension registry
- [x] Direct install/uninstall via gallery, API, and CLI
- [x] Atomic config updates with backup on every change

## Architecture (container/app/channel refactor)
- [x] Caddy reverse proxy as front door with URL routing
- [x] Channels routed under `/channels/*` (LAN by default, toggleable to public via Admin API)
- [x] LAN-only: `/admin/*`, `/admin/opencode*`, `/admin/openmemory*` restricted by Caddy
- [x] Admin app extracted from gateway into separate container
- [x] Admin app provides API for all admin functions
- [x] Admin app can add/remove containers via controller
- [x] Controller provides up/down/restart capabilities
- [x] All channels processed through gateway (defense in depth)
- [x] Discord channel adapter added
- [x] Voice channel adapter added
- [x] Chat channel adapter (replaces webhook)
- [x] PostgreSQL added for structured storage
- [x] Qdrant added as dedicated vector store
- [x] Shared filesystem mount across containers (/shared)
- [x] Gateway stripped to minimal auth + routing (security delegated to isolated OpenCode runtimes)
- [x] Architecture diagram created (docs/architecture.md)

## Admin UI gallery and setup wizard
- [x] Curated gallery registry with plugins, skills, and containers
- [x] Gallery search by name, description, tags, and category filter
- [x] npm registry search for discovering non-curated plugins
- [x] Setup wizard with first-boot flow including early access scope selection (host-only or LAN)
- [x] Setup wizard state persistence (file-backed JSON)
- [x] Health check endpoint for gateway and OpenCode core connectivity
- [x] Vanilla JS SPA admin UI (no framework dependency)
- [x] Dark theme UI with gallery, installed, services, and settings pages
- [x] Detail modal with security notes and permissions per extension
- [x] Defense-in-depth information displayed contextually per extension type
- [x] Install/uninstall API endpoints with admin auth
- [x] Gallery and setup API endpoints added to admin server

## Runtime isolation
- [x] Added separate `opencode-channel` runtime to isolate channel traffic from `opencode-core`

## XDG Base Directory compliance
- [x] All volume mounts use OPENPALM_DATA_HOME / OPENPALM_CONFIG_HOME / OPENPALM_STATE_HOME
- [x] install.sh resolves XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_STATE_HOME with standard fallbacks
- [x] install.sh seeds default configs from repo into XDG config home (preserving existing edits)
- [x] assets/system.env documents the three XDG path variables
- [x] All services, channels, and apps conform to the data/config/state separation pattern
