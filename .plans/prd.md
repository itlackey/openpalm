# OpenPalm PRD — Simplified MVP Control Plane (CLI + Admin API)

**Product:** OpenPalm  
**Version:** 0.2 (simplified MVP PRD)  
**Audience:** Engineering, DevOps, Docs  
**Primary objective:** Deliver a barebones OpenPalm MVP that preserves the core architectural principles:
- Generated artifacts (Compose/Caddy/env) from a declarative spec
- Gateway-only ingress with signed channel payloads + intake validation
- Admin as the only orchestrator (compose lifecycle)
- CLI for host operators; assistant requests admin operations via Admin API (no Docker socket in assistant)

Sources: current PRD, stack spec, compose/caddy, API reference, security and architecture docs. :contentReference[oaicite:1]{index=1}

---

## 1) Product Vision

OpenPalm is a local-first AI assistant platform that runs as an isolated Docker Compose stack. The platform remains a **thin wrapper around generated Docker Compose and Caddy artifacts**, while enforcing a strict control-plane boundary:

- **Admin** is the only component that can run allowlisted Compose operations.
- **Gateway** is the only ingress path for channels and enforces signature verification, rate limiting, and intake validation.
- **Assistant runtime** never receives Docker socket access; it can only request allowlisted admin operations via Admin’s internal API.

This is aligned with the repo’s current architecture contract (Admin owns lifecycle, Gateway validates ingress). :contentReference[oaicite:2]{index=2}

---

## 2) MVP Principles (Non-negotiables)

1. **Single orchestration path:** All stack lifecycle operations run through Admin (CLI/UI/assistant are clients). :contentReference[oaicite:3]{index=3}  
2. **Generated artifacts are inspectable:** Compose/Caddy/env outputs are rendered deterministically and written to the configured state paths. :contentReference[oaicite:4]{index=4}  
3. **Gateway-only ingress:** Channel adapters forward to Gateway only; Gateway validates HMAC signature + payload shape + rate limiting + intake validation before forwarding. :contentReference[oaicite:5]{index=5}  
4. **Assistant cannot orchestrate:** No Docker socket access for assistant runtime; Admin remains the orchestrator boundary. :contentReference[oaicite:6]{index=6}  
5. **LAN/host-first exposure:** Admin and dashboards are LAN-only by default; channels are LAN-only by default with explicit toggle to public. :contentReference[oaicite:7]{index=7}  

---

## 3) Scope

### 3.1 In scope (MVP)
- Host CLI for install / lifecycle / logs / status / updates / extensions management.
- Admin API as the canonical control plane for lifecycle and config changes.
- Gateway signature verification + intake validation workflow.
- One end-to-end channel enabled by default (repo currently supports chat/discord/voice/telegram; MVP can ship with **chat** enabled by default). :contentReference[oaicite:8]{index=8}

### 3.2 Out of scope (MVP)
- Setup wizard as a *required* path (may exist, but not required for MVP success criteria).
- User-defined automations UX (keep infrastructure if already present; don’t build new UI/flows).
- OrbStack as a required runtime (support may remain, but Docker is the official MVP runtime). :contentReference[oaicite:9]{index=9}

---

## 4) Users

- **Operator on the host:** uses CLI to install, render/apply, and debug.
- **Assistant runtime:** requests allowlisted admin actions through Admin API (never directly touches Docker). :contentReference[oaicite:10]{index=10}

---

## 5) System Overview (Concrete, from repo)

### 5.1 Containers (current stack inventory)
Core services included in the generated compose:
- `caddy` (reverse proxy, :80/:443)
- `postgres` (storage)
- `qdrant` (vector storage)
- `openmemory` + `openmemory-ui`
- `opencode-core` (assistant runtime)
- `gateway` (:8080)
- `admin` (:8100)
Optional channels (compose profile `"channels"`):
- `channel-chat` (:8181)
- `channel-discord` (:8184)
- `channel-voice` (:8183)
- `channel-telegram` (:8182)

These are documented and reflected in the checked-in compose + architecture doc. :contentReference[oaicite:11]{index=11}

### 5.2 Routing (Caddy)
- `/channels/*` routes to channel adapters (LAN-only by default; may be toggled to public)
- `/admin/*` umbrella (LAN-only) includes:
  - `/admin/api*` → Admin API
  - `/admin/opencode*` → OpenCode UI/API
  - `/admin/openmemory*` → OpenMemory UI

Concrete config exists in the repo Caddyfile. :contentReference[oaicite:12]{index=12}

---

## 6) Configuration Model (Filled in)

### 6.1 Source-of-truth spec
**Current implementation uses a JSON “Stack Spec”** (not YAML) with:
- `accessScope`: `"host"` | `"lan"`
- `channels`: `chat|discord|voice|telegram` each with `{ enabled, exposure: host|lan|public, config: {...} }`
- `automations`: array

See `stack-spec.ts` for the schema and defaults. :contentReference[oaicite:13]{index=13}

> **MVP decision:** Keep Stack Spec as the intent format for now (since generator/runtime already expects it). If you later want YAML, treat it as a presentation format that compiles to the same internal model.

### 6.2 Secrets + per-channel secret env files
- Channel HMAC secrets live in env files (e.g. `CHANNEL_DISCORD_SECRET`, etc.) and are used to sign inbound payloads. :contentReference[oaicite:14]{index=14}  
- Compose references:
  - gateway uses `${OPENPALM_CONFIG_HOME}/secrets/gateway/channels.env`
  - channels use `${OPENPALM_CONFIG_HOME}/secrets/channels/<name>.env`
  - core services also load `${OPENPALM_CONFIG_HOME}/secrets.env` :contentReference[oaicite:15]{index=15}  

### 6.3 XDG layout (explicit)
From architecture doc:
- Data: `~/.local/share/openpalm/` (`OPENPALM_DATA_HOME`)
- Config: `~/.config/openpalm/` (`OPENPALM_CONFIG_HOME`)
- State: `~/.local/state/openpalm/` (`OPENPALM_STATE_HOME`) :contentReference[oaicite:16]{index=16}  

From compose (mounts) — key examples:
- postgres data → `${OPENPALM_DATA_HOME}/postgres:/var/lib/postgresql/data`
- qdrant data → `${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage`
- opencode home → `${OPENPALM_DATA_HOME}/home:/home/opencode`
- gateway state → `${OPENPALM_STATE_HOME}/gateway:/app/data`
- admin uses config root + state workspace + docker socket mount (today) :contentReference[oaicite:17]{index=17}  

---

## 7) Roles and Responsibilities (the simplification)

### 7.1 Host CLI (human-operated)
The CLI exists for host operators to:
- install/uninstall/update
- start/stop/restart services
- view logs/status
- manage extensions

These commands exist today and are documented (install is staged; lifecycle commands exist). :contentReference[oaicite:18]{index=18}

### 7.2 Admin API (canonical control plane)
Admin API exists so:
- the CLI can invoke lifecycle actions reliably through one path
- the assistant runtime can request allowlisted admin operations without Docker socket access

Admin’s current API surface is defined in `docs/development/api-reference.md` (health, container ops, channels, config editor, setup endpoints, gallery install/uninstall, automations). :contentReference[oaicite:19]{index=19}

### 7.3 Assistant runtime (no Docker access)
Assistant runtime can:
- call Admin endpoints (internal/LAN-only)
- request lifecycle changes or config edits
But it cannot:
- access Docker socket
- execute arbitrary shell
- bypass Gateway for channel ingress

This is consistent with the repo’s security model. :contentReference[oaicite:20]{index=20}

---

## 8) MVP Hardening (recommended)
### 8.1 Docker socket exposure (tighten without complexity)
Today, the Admin container mounts the Docker socket path. :contentReference[oaicite:21]{index=21}

**MVP recommendation:** insert a deny-by-default Docker socket proxy between Admin and the real socket, and mount the real socket only into that proxy container. This reduces the reachable Docker API surface while keeping the architecture simple. (Reference implementation: `docker-socket-proxy`.) :contentReference[oaicite:22]{index=22}

---

## 9) Functional Requirements (Updated)

### 9.1 CLI Requirements (MVP)
- CLI SHALL provide: `install`, `uninstall`, `update`, `start`, `stop`, `restart`, `logs`, `status/ps`, `extensions`. :contentReference[oaicite:23]{index=23}
- CLI SHOULD prefer Admin API mode for lifecycle actions (keep “direct compose” as a fallback only if already implemented, but do not expand it).

### 9.2 Admin API Requirements (MVP)
- Admin SHALL expose:
  - `/health`
  - allowlisted lifecycle endpoints (`up/down/restart`, containers list)
  - channel access toggles and env config updates
  - opencode config read/write with policy lint (deny permission widening to `"allow"`)
  - gallery install/uninstall + installed status
  - automations endpoints (if retained)

These are already specified in the repo’s API reference. :contentReference[oaicite:24]{index=24}

### 9.3 Gateway Requirements (MVP)
- Gateway SHALL expose:
  - `GET /health`
  - `POST /channel/inbound` (HMAC signature required)
- Gateway SHALL enforce:
  - payload shape validation
  - HMAC verification
  - 120 req/min per user rate limiting
  - intake validation via `channel-intake` agent (all tools denied), forwarding validated summaries only :contentReference[oaicite:25]{index=25}

### 9.4 Caddy routing requirements (MVP)
- `/admin/*` must remain LAN-only (or host-only under `accessScope=host`)
- `/channels/*` default LAN-only, explicit toggle to public via Admin API
Concrete behavior exists in the Caddyfile and architecture docs. :contentReference[oaicite:26]{index=26}

---

## 10) MVP Acceptance Criteria
1. `openpalm install` brings up core stack and Admin/Gateway health endpoints report healthy. :contentReference[oaicite:27]{index=27}  
2. One channel (chat) works end-to-end: channel → gateway → intake validation → opencode-core response. :contentReference[oaicite:28]{index=28}  
3. Assistant runtime can call Admin API to request a safe action (e.g. restart a service) without Docker socket access. :contentReference[oaicite:29]{index=29}  
4. Channel access can be toggled LAN ↔ public using Admin API. :contentReference[oaicite:30]{index=30}  

---

## 11) Open Questions (UPDATED: filled or narrowed)

### 11.1 Minimum stack definition
**Resolved (current):** caddy, postgres, qdrant, openmemory, openmemory-ui, assistant (opencode-core), gateway, admin; channels optional via compose profile. :contentReference[oaicite:31]{index=31}

### 11.2 Intent schema (stack spec vs YAML)
**Resolved (current):** Stack Spec JSON (versioned) is the source-of-truth; channels/exposure/accessScope defined in `stack-spec.ts`. :contentReference[oaicite:32]{index=32}  
**Optional later:** allow YAML that compiles to the same internal shape.

### 11.3 Secrets model (partitioning + rotation)
**Partially resolved (current):**
- channel secrets are per-channel envs (`CHANNEL_*_SECRET`)
- gateway loads channel secrets env file
- core services load `secrets.env` :contentReference[oaicite:33]{index=33}  
**Still needs detail:** exact canonical filenames and rotation procedure (what changes require restarts and which services).
**Asnwer**: Every container has a dedicated directory inthe openpalm state directory with a .env file in it

### 11.4 Admin API auth and permissions
**Resolved (current):** `x-admin-token` required for protected endpoints; some endpoints are explicitly unauthenticated (health, setup, gallery browsing, UI assets). :contentReference[oaicite:34]{index=34}  
**Still needs detail:** whether assistant gets the same token or a reduced-scope token (recommended).
**Answer:** assistant gets the same token

### 11.5 Docker hardening approach
**Current:** Admin mounts socket. :contentReference[oaicite:35]{index=35}  
**Recommendation:** use a socket proxy allowlist for MVP hardening.   
**Still needs detail:** allowed Docker API endpoints set (define minimal capability list).
**Answer:** Update and restart
