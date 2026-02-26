
# OpenPalm Admin API Spec (MVP) — Consolidated Reference

This document turns the repo’s API reference into a more “spec-like” contract (endpoints, auth, schemas, errors), while staying compatible with the current documented routes.

Primary source: `docs/development/api-reference.md` :contentReference[oaicite:37]{index=37}

---

## 1) Conventions

### 1.1 Base routing
- **LAN route via Caddy:** `/admin*` (LAN-only)
- **API namespace via Caddy:** `/admin/api*` (rewritten to Admin app routes) :contentReference[oaicite:38]{index=38}

### 1.2 Authentication
Header for protected endpoints:
- `x-admin-token: <token>`

Unauthenticated exceptions (per repo doc):
- `/health`
- `/admin/setup/*`
- `/admin/gallery/search`, `/admin/gallery/categories`, `/admin/gallery/item/:id`, `/admin/gallery/npm-search`, `/admin/gallery/community`
- static UI assets (`/`, `/index.html`) :contentReference[oaicite:39]{index=39}

### 1.3 Error shape (recommended)
The repo describes error codes in prose for Gateway; Admin errors are not fully normalized. For MVP, standardize:
```json
{
  "error": "string_code",
  "message": "human readable",
  "details": {}
}
````

(Implementation note: do not leak secrets in `details`.)

---

## 2) Health

### GET /health

Returns service health for the admin app.

* Auth: none ([GitHub][2])

---

## 3) Container Lifecycle (allowlisted)

> There are two sets of “container management” routes described:
>
> 1. `/admin/containers/*` (UI-facing style)
> 2. “Admin lifecycle API” endpoints (`/containers`, `/up/:service`, etc.)
>
> MVP recommendation: implement (or keep) *one* canonical set internally, but accept both if they already exist.

### GET /admin/containers/list

Lists running containers.

* Auth: required ([GitHub][2])

### POST /admin/containers/up

Body:

```json
{ "service": "channel-discord" }
```

* Auth: required ([GitHub][2])

### POST /admin/containers/down

Body:

```json
{ "service": "channel-discord" }
```

* Auth: required ([GitHub][2])

### POST /admin/containers/restart

Body:

```json
{ "service": "opencode-core" }
```

* Auth: required ([GitHub][2])

#### Allowlisted services (documented)

`opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy` ([GitHub][2])

---

## 4) Channel Management

### GET /admin/channels

Returns:

* channel services
* current access mode
* editable config keys ([GitHub][2])

### POST /admin/channels/access

Sets ingress access for channel routes.
Body:

```json
{ "channel": "chat" | "voice" | "discord" | "telegram", "access": "lan" | "public" }
```

Effect:

* updates Caddy routing restrictions for that channel (LAN abort matcher removed for public) ([GitHub][2])

### GET /admin/channels/config?service=channel-chat

Reads channel-specific env overrides. ([GitHub][2])

### POST /admin/channels/config

Updates channel env overrides and optionally restarts.
Body:

```json
{
  "service": "channel-discord",
  "config": { "DISCORD_BOT_TOKEN": "..." },
  "restart": true
}
```

([GitHub][2])

---

## 5) OpenCode Config Editor

### GET /admin/config

Returns the `opencode.jsonc` as `text/plain`. ([GitHub][2])

### POST /admin/config

Writes `opencode.jsonc` and optionally restarts `opencode-core`.
Body:

```json
{ "config": "jsonc text", "restart": true }
```

Policy lint requirement (documented):

* If any permission value in the submitted config is `"allow"`, reject with 400.
* Only `"ask"` and `"deny"` are permitted in this flow. ([GitHub][2])

---

## 6) Setup Wizard (optional for simplified MVP, but endpoints exist)

### GET /admin/setup/status

Returns:

* setup wizard state (completed steps, first-boot flag, etc.)
* OpenMemory provider configuration status ([GitHub][2])

### POST /admin/setup/step

Body:

```json
{ "step": "welcome" | "accessScope" | "serviceInstances" | "healthCheck" | "security" | "channels" | "extensions" }
```

([GitHub][2])

### POST /admin/setup/access-scope

Body:

```json
{ "scope": "host" | "lan" }
```

Effect:

* updates Caddy matchers
* updates compose bind addresses to localhost when `host` ([GitHub][2])

### POST /admin/setup/service-instances

Body:

```json
{
  "openmemory": "...",
  "psql": "...",
  "qdrant": "...",
  "openaiBaseUrl": "...",
  "openaiApiKey": "..."
}
```

([GitHub][2])

### POST /admin/setup/complete

Marks setup complete. ([GitHub][2])

### GET /admin/setup/health-check

Returns:

```json
{ "gateway": true, "opencode": true }
```

([GitHub][2])

---

## 7) Extension Gallery + Install/Uninstall

### GET /admin/gallery/search?q=&category=

Search curated gallery registry.
Categories include `plugin`, `skill`, `command`, `agent`, `tool`, `channel`, `service`. ([GitHub][2])

### GET /admin/gallery/categories

Returns categories with counts. ([GitHub][2])

### GET /admin/gallery/item/:id

Returns detail for one item (includes risk badge). ([GitHub][2])

### GET /admin/gallery/npm-search?q=

Search npm for OpenCode plugins. ([GitHub][2])

### GET /admin/gallery/community?q=&category=

Fetch/search community registry (cached). ([GitHub][2])

### POST /admin/gallery/community/refresh

Forces refresh. Auth required. ([GitHub][2])

### POST /admin/gallery/install

Body (gallery item):

```json
{ "galleryId": "plugin-policy-telemetry" }
```

Body (npm plugin):

```json
{ "pluginId": "@scope/plugin-name" }
```

([GitHub][2])

### POST /admin/gallery/uninstall

Body:

```json
{ "galleryId": "plugin-policy-telemetry" }
```

([GitHub][2])

### GET /admin/installed

Returns installed extensions + active services. ([GitHub][2])

---

## 8) Automations (if retained)

Base path: `/admin/automations` ([GitHub][2])

* `GET /admin/automations`
* `POST /admin/automations` create `{ name, schedule, prompt }`
* `POST /admin/automations/update` update fields
* `POST /admin/automations/delete` `{ id }`
* `POST /admin/automations/trigger` `{ id }`

---

## 9) Recommended Simplification (non-breaking path)

The API above is already “feature-broad.” For a simplified MVP that still preserves your “assistant can request admin ops” model:

**Keep and treat as canonical:**

* `/health`
* `/admin/containers/*` (or the `/up/:service` set)
* `/admin/channels/access`
* `/admin/config` (with lint)
* `/admin/installed` + `/admin/gallery/install` + `/admin/gallery/uninstall`

**Defer in “MVP required” sense:**

* Setup wizard endpoints (optional)
* Automations endpoints (optional)

No matter what: ensure assistant only has access to the minimum set of protected endpoints required for safe operation (see PRD notes). ([GitHub][2])

````

---

```md
# OpenPalm Minimal Compose Topology (MVP) + Recommended Socket Proxy Variant

This document describes the current compose topology in the repo and a minimal variant that preserves the architecture while simplifying “who can do what,” plus an optional hardening improvement: Docker socket proxy.

Primary sources:
- Generated compose (`assets/state/docker-compose.yml`)
- Caddyfile (`assets/state/caddy/Caddyfile`)
- Architecture doc and API reference
- Security guide
- Docker socket proxy reference implementation :contentReference[oaicite:69]{index=69}

---

## 1) Current topology (as implemented)

### 1.1 Network
- Single docker network: `assistant_net` :contentReference[oaicite:70]{index=70}

### 1.2 Core services (always on)
- `caddy` (ports 80/443 bound, reverse proxy)
- `postgres`
- `qdrant`
- `openmemory` (+ `openmemory-ui`)
- `opencode-core`
- `gateway`
- `admin` :contentReference[oaicite:71]{index=71}

### 1.3 Optional channels (profile `"channels"`)
- `channel-chat`
- `channel-discord`
- `channel-voice`
- `channel-telegram` :contentReference[oaicite:72]{index=72}

---

## 2) Minimal routing rules (Caddy)

- `/channels/*` → channel adapters (LAN-only by default; public toggle via Admin API)
- `/admin/api*` → Admin API
- `/admin/opencode*` → OpenCode UI/API
- `/admin/openmemory*` → OpenMemory UI
- `/admin*` → Admin UI (LAN-only)

This is codified in the Caddyfile and architecture routing table. :contentReference[oaicite:73]{index=73}

---

## 3) Minimal storage + XDG mounts (current)

From compose:
- postgres data: `${OPENPALM_DATA_HOME}/postgres:/var/lib/postgresql/data`
- qdrant data: `${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage`
- openmemory data: `${OPENPALM_DATA_HOME}/openmemory:/data`
- opencode home: `${OPENPALM_DATA_HOME}/home:/home/opencode`
- gateway state: `${OPENPALM_STATE_HOME}/gateway:/app/data`
- admin uses:
  - `${OPENPALM_CONFIG_HOME}:/app/config-root`
  - `${OPENPALM_STATE_HOME}:/workspace`
  - docker socket mount (today) :contentReference[oaicite:74]{index=74}

---

## 4) “Barebones MVP” compose (recommended baseline)

If you want the smallest stack that still proves the core architecture contract:

**Always-on:**
- `gateway`
- `opencode-core`
- `admin`
- `caddy` (recommended to keep LAN restrictions and path routing)
- (optional) `openmemory` + `qdrant` if memory is part of your MVP promise

**Optional:**
- channels (start with `channel-chat` only)

The repo currently includes memory as a first-class feature; removing it would diverge from current docs/expectations. :contentReference[oaicite:75]{index=75}

---

## 5) Docker socket proxy hardening variant (recommended)

### 5.1 Why
Right now the admin container mounts the Docker socket path directly. :contentReference[oaicite:76]{index=76}

To reduce blast radius without changing your architecture, insert a **socket proxy** between admin and the real socket:
- The proxy mounts the real socket
- Admin talks to proxy over HTTP on the internal network
- Proxy exposes only allowlisted Docker API surfaces (deny-by-default)

A common implementation is `tecnativa/docker-socket-proxy`. 

### 5.2 Minimal compose snippet (illustrative)
```yaml
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    restart: unless-stopped
    environment:
      # deny by default; enable only what admin needs
      CONTAINERS: "1"
      IMAGES: "1"
      NETWORKS: "1"
      SERVICES: "1"
      # keep POST=0 unless you explicitly need it (varies by proxy config)
      # (exact flags depend on chosen proxy version)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [assistant_net]

  admin:
    environment:
      - OPENPALM_CONTAINER_SOCKET_URI=tcp://docker-socket-proxy:2375
    depends_on: [docker-socket-proxy]
    networks: [assistant_net]
````

**NOTE (needs final detail):**

* Determine the minimum Docker APIs Admin truly requires based on the exact compose operations you allow (`ps`, `stop`, `restart`, etc.). The proxy flags should match that minimal need-set. ([GitHub][2])

---

## 6) Assistant → Admin control path (what matters)

* Assistant runtime calls Admin API on the internal network (or via LAN-only Caddy routes).
* Admin API validates `x-admin-token` and allowlists action + service name.
* Admin performs compose lifecycle actions using its configured compose runtime and socket URI. ([GitHub][2])

This is the simplification: no Docker socket in assistant, no “controller” elsewhere, one place runs compose.

```

---

If you want, I can also produce a **fourth** doc that’s purely “MVP Cuts Checklist” (what to delete/ignore in the existing PRD + repo docs so you stop re-litigating scope every time).
::contentReference[oaicite:80]{index=80}
```

[1]: https://raw.githubusercontent.com/itlackey/openpalm/refs/heads/main/assets/state/docker-compose.yml "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/itlackey/openpalm/refs/heads/main/docs/development/api-reference.md "raw.githubusercontent.com"
