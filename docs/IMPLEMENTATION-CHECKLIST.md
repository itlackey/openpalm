# Implementation Checklist vs Root Guides

## 01-implementation-guide.md
- [x] OpenMemory private service wiring in compose
- [x] OpenCode runtime service and config
- [x] OpenMemory MCP referenced from OpenCode config
- [x] Gateway `/message` and `/health`
- [x] Tool firewall (allowlist, approval gates)
- [x] Observability/audit event logging
- [x] Rules + skills for recall-first + memory policy + action gating

## 02-docker-compose-hosting-and-extensibility.md
- [x] Single compose stack with Gateway + OpenCode + OpenMemory
- [x] Optional channel services as dumb adapters
- [x] MCP/custom-tool extension path documented
- [x] Safety hard rules implemented (egress allowlist, replay, auth)

## 03-admin-implementation-guide.md
- [x] Installer script with checks + bootstrap
- [x] Staged change manager endpoints (propose/validate/apply/rollback)
- [x] Config edit + safe write + restart flow
- [x] Container lifecycle management (controller replaces compose-control)
- [x] Step-up auth enforced for high-risk admin operations

## 04-admin-ui-extensions-install-enable.md
- [x] OpenCode `plugin[]` treated as canonical extension registry
- [x] API flow to request/install/disable plugin IDs
- [x] Preflight validation and risk tagging
- [x] API/CLI-first approval flow (not UI-manual)
- [x] Optional ops dashboard retained read-only

## Architecture update (container/app/channel refactor)
- [x] Caddy reverse proxy as front door with URL routing
- [x] Public channels: /chat, /voice routed to channel adapters
- [x] LAN-only: /admin, /opencode, /openmemory restricted by Caddy
- [x] Admin app extracted from gateway into separate container
- [x] Admin app provides API for all admin functions
- [x] Admin app can add/remove containers via controller
- [x] Controller replaces compose-control with up/down/restart capabilities
- [x] All channels processed through gateway (defense in depth)
- [x] Discord channel adapter added
- [x] Voice channel adapter added
- [x] Chat channel adapter (replaces webhook)
- [x] PostgreSQL added for structured storage
- [x] Qdrant added as dedicated vector store
- [x] Shared filesystem mount across containers (/shared)
- [x] Gateway stripped to defense-in-depth channel processing only
- [x] Architecture diagram created (docs/architecture.md)

## Admin UI gallery and setup wizard
- [x] Curated gallery registry with plugins, skills, and containers
- [x] Gallery item types with risk levels (low/medium/high/critical)
- [x] Gallery search by name, description, tags, and category filter
- [x] npm registry search for discovering non-curated plugins
- [x] Risk badge display with color coding and security notes
- [x] Setup wizard with 5-step first-boot flow (welcome, health check, security, channels, extensions)
- [x] Setup wizard state persistence (file-backed JSON)
- [x] Health check endpoint for gateway and OpenCode connectivity
- [x] Vanilla JS SPA admin UI (no framework dependency)
- [x] Dark theme UI with gallery, installed, services, and settings pages
- [x] Detail modal with security assessment and permissions per extension
- [x] Defense-in-depth information displayed contextually per extension type
- [x] Install/uninstall API endpoints with step-up auth
- [x] Gallery and setup API endpoints added to admin-app server
