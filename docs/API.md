# API Reference

## Gateway API (internal; channel adapters call gateway directly on the Docker network)

### GET /health
Health status for the gateway (internal).

### POST /channel/inbound
Signed channel payload from adapters (internal). Gateway verifies a shared-secret HMAC and forwards to the OpenCode Core runtime for intake validation.

Headers:
- `x-channel-signature` (HMAC-SHA256)

Body:
```json
{
  "userId": "discord:123",
  "channel": "discord",
  "text": "hello",
  "metadata": {},
  "nonce": "uuid",
  "timestamp": 1730000000000
}
```

Supported channels: `chat`, `discord`, `voice`, `telegram`

Processing behavior:
1. Gateway verifies HMAC and payload shape.
2. Gateway sends a dedicated intake command to `opencode-core` using the `channel-intake` agent (all tools denied).
3. Gateway parses intake JSON (`valid`, `summary`, `reason`).
4. If valid, gateway forwards only the summary to `opencode-core` (default agent).

Possible errors:
- `400 invalid_payload` when payload fails shape validation (missing fields, invalid channel, text too long).
- `403 channel_not_configured` when the channel has no shared secret configured.
- `403 invalid_signature` when HMAC verification fails.
- `429 rate_limited` when user exceeds 120 requests per minute.
- `422 invalid_channel_request` when channel intake rejects the request.
- `502 channel_intake_unavailable` when intake runtime response is invalid/unavailable.
- `502 core_runtime_unavailable` when core runtime fails.

Gateway runtime knobs:
- `OPENCODE_TIMEOUT_MS` (default `15000`)

Notes:
- All inbound user traffic is routed through `/channel/inbound` only.
- Gateway uses the `channel-intake` agent on `opencode-core` to validate + summarize, then forwards valid summaries to `opencode-core` (default agent).

---

## Admin App API (routed via Caddy at /admin/*, LAN only)

Headers for all protected admin endpoints:
- `x-admin-token` (required — the admin password set during install)

**Exceptions (no auth required):** `/health`, `/admin/setup/*`, `/admin/gallery/search`, `/admin/gallery/categories`, `/admin/gallery/item/:id`, `/admin/gallery/npm-search`, static UI assets (`/`, `/index.html`).

### GET /health
Health status for the admin app.

### Container management
- `GET /admin/containers/list` — list running containers
- `POST /admin/containers/up` — start a service `{ "service": "channel-discord" }`
- `POST /admin/containers/down` — stop a service `{ "service": "channel-discord" }`
- `POST /admin/containers/restart` — restart a service `{ "service": "opencode-core" }`

### Channel management
- `GET /admin/channels` — list channel services, network access mode, and editable config keys
- `POST /admin/channels/access` — set network access for channel ingress `{ "channel": "chat" | "voice" | "discord" | "telegram", "access": "lan" | "public" }`
- `GET /admin/channels/config?service=channel-chat` — read channel-specific env overrides
- `POST /admin/channels/config` — update channel env overrides `{ "service": "channel-discord", "config": { "DISCORD_BOT_TOKEN": "..." }, "restart": true }`

### Config editor
- `GET /admin/config` — read `opencode.jsonc` (returns text/plain)
- `POST /admin/config` — write config `{ "config": "...", "restart": true }` (denies permission widening to `allow`)

### Setup wizard
- `GET /admin/setup/status` — returns current setup wizard state (completed steps, channels, extensions, first-boot flag)
- `POST /admin/setup/step` — mark a step complete `{ "step": "welcome" | "accessScope" | "healthCheck" | "security" | "channels" | "extensions" }`
- `POST /admin/setup/access-scope` — set setup access scope `{ "scope": "host" | "lan" }` (updates Caddy matchers and compose bind addresses)
- `POST /admin/setup/complete` — finalize setup wizard (marks `setupComplete: true`)
- `GET /admin/setup/health-check` — run health checks against gateway and OpenCode; returns `{ gateway: boolean, opencode: boolean }`

### Gallery (extension marketplace)
- `GET /admin/gallery/search?q=&category=` — search curated gallery registry
  - `q` — free-text search (matches name, description, tags, id)
  - `category` — filter by `plugin`, `skill`, or `container`
- `GET /admin/gallery/categories` — list gallery categories with counts
- `GET /admin/gallery/item/:id` — get full detail for a single gallery item including risk badge
- `GET /admin/gallery/npm-search?q=` — search npm registry for non-curated OpenCode plugins

### Install / uninstall
- `POST /admin/gallery/install` — install a gallery item or npm plugin
  ```json
  { "galleryId": "plugin-policy-telemetry" }
  ```
  or install an npm plugin directly:
  ```json
  { "pluginId": "@scope/plugin-name" }
  ```
  Delegates to atomic config update or controller depending on `installAction` type.
- `POST /admin/gallery/uninstall` — uninstall a gallery item or plugin
  ```json
  { "galleryId": "plugin-policy-telemetry" }
  ```

### Installed status
- `GET /admin/installed` — returns currently installed extensions, active services, and loaded skills

---

## LAN Web UIs and service endpoints

These are available on the internal Docker network for service-to-service API/MCP use, and are also exposed via Caddy as LAN-only web routes under `/admin/*`:

- OpenCode Core UI/API:
  - Internal service URL: `http://opencode-core:4096`
  - LAN routes via Caddy: `/admin/opencode*`
- OpenMemory UI/API/MCP:
  - Internal service URLs: `http://openmemory:3000` (UI/API), `http://openmemory:8765` (MCP SSE)
  - LAN routes via Caddy: `/admin/openmemory*`
- Admin UI/API:
  - LAN route via Caddy: `/admin*`
  - API namespace: `/admin/api*`

---

## Controller API (internal only, not exposed via Caddy)

Header: `x-controller-token` (required)

Runtime behavior:
- Uses configured compose command from `OPENPALM_COMPOSE_BIN` + `OPENPALM_COMPOSE_SUBCOMMAND`
- Uses configured container socket URI from `OPENPALM_CONTAINER_SOCKET_URI`
- Runtime selection persisted by installer (`OPENPALM_CONTAINER_PLATFORM`)

- `GET /health` — health check
- `GET /containers` — list running containers (via configured compose runtime `ps`)
- `POST /restart/:service` — restart a service
- `POST /up/:service` — start a service
- `POST /down/:service` — stop a service

Allowed services: `opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`

---

## Channel Adapter APIs

All channel adapters are LAN-only by default. Access can be toggled to public via the Admin API (`POST /admin/channels/access`).

### Chat (channel-chat, :8181)
- Caddy ingress route: `/channels/chat*` (rewrites to `/chat`)
- `GET /health`
- `POST /chat` — `{ "userId": "...", "text": "...", "metadata": {} }`
  - Header: `x-chat-token` (required if `CHAT_INBOUND_TOKEN` is set)

### Discord (channel-discord, :8184)
- Caddy ingress route: `/channels/discord*` (rewrites to `/discord/webhook`)
- `GET /health`
- `POST /discord/interactions` — Discord interactions endpoint (slash commands, type 1/2). Note: not routed through Caddy in the default config.
- `POST /discord/webhook` — simple webhook `{ "userId": "...", "text": "...", "channelId": "...", "guildId": "..." }`

### Voice (channel-voice, :8183)
- Caddy ingress route: `/channels/voice*` (rewrites to `/voice/transcription`)
- `GET /health`
- `POST /voice/transcription` — `{ "userId": "...", "text": "...", "audioRef": "...", "language": "en" }`
- `GET /voice/stream` — returns 501; WebSocket-based real-time streaming is not yet implemented

### Telegram (channel-telegram, :8182)
- Caddy ingress route: `/channels/telegram*` (rewrites to `/telegram/webhook`)
- `GET /health`
- `POST /telegram/webhook` — Telegram bot update JSON (non-text messages are silently skipped)
  - Header: `x-telegram-bot-api-secret-token` (required if `TELEGRAM_WEBHOOK_SECRET` is set)
