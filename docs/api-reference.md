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
1. Gateway verifies HMAC and payload shape (payload validation).
2. Rate limiting: 120 requests per minute per user.
3. Gateway sends a dedicated intake command to `opencode-core` using the `channel-intake` agent (all tools denied) — intake validation.
4. Gateway parses intake JSON (`valid`, `summary`, `reason`).
5. If valid, gateway forwards only the summary to `opencode-core` (default agent).

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

**Exceptions (no auth required):** `/health`, `/admin/setup/*`, `/admin/gallery/search`, `/admin/gallery/categories`, `/admin/gallery/item/:id`, `/admin/gallery/npm-search`, `/admin/gallery/community`, static UI assets (`/`, `/index.html`).

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

**Policy lint rule:** The config editor parses the submitted JSONC and inspects the `permission` object. If any permission value is set to `"allow"`, the request is rejected with `400 policy lint failed: permission widening blocked`. Only `"ask"` and `"deny"` are permitted permission values. This prevents operators from accidentally removing approval gates on sensitive tool operations.

### Setup wizard
- `GET /admin/setup/status` — returns current setup wizard state (completed steps, channels, extensions, first-boot flag), current service-instance overrides, and OpenMemory provider setup (`openmemoryProvider.openaiBaseUrl`, `openmemoryProvider.openaiApiKeyConfigured`)
- `POST /admin/setup/step` — mark a step complete `{ "step": "welcome" | "accessScope" | "serviceInstances" | "healthCheck" | "security" | "channels" | "extensions" }`
- `POST /admin/setup/access-scope` — set setup access scope `{ "scope": "host" | "lan" }` (updates Caddy matchers and compose bind addresses)
- `POST /admin/setup/service-instances` — update service instance overrides and OpenMemory OpenAI-compatible provider settings `{ "openmemory": "...", "psql": "...", "qdrant": "...", "openaiBaseUrl": "...", "openaiApiKey": "..." }` (`openaiApiKey` is optional; leave empty to keep current key)
- `POST /admin/setup/complete` — finalize setup wizard (marks `setupComplete: true`)
- `GET /admin/setup/health-check` — run health checks against gateway and OpenCode; returns `{ gateway: boolean, opencode: boolean }`

### Gallery (extension marketplace)
- `GET /admin/gallery/search?q=&category=` — search curated gallery registry
  - `q` — free-text search (matches name, description, tags, id)
  - `category` — filter by `plugin`, `skill`, `command`, `agent`, or `tool`. Note: `container` is not an extension type — channel management has its own dedicated endpoints (see Channel management above). If `container` appears in legacy registry entries it maps to the Channels concept.
- `GET /admin/gallery/categories` — list gallery categories with counts
- `GET /admin/gallery/item/:id` — get full detail for a single gallery item including risk badge
- `GET /admin/gallery/npm-search?q=` — search npm registry for non-curated OpenCode plugins
- `GET /admin/gallery/community?q=&category=` — search the public community registry fetched from GitHub at runtime (no auth required; 10-minute cache)
  - `q` — optional free-text search
  - `category` — optional filter by `plugin`, `skill`, `command`, `agent`, or `tool`
  - Returns `{ items, total, source: "community-registry" }`
- `POST /admin/gallery/community/refresh` — force a cache refresh of the community registry (auth required)

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
- `GET /admin/installed` — returns currently installed extensions (including skills, commands, agents, tools, and plugins) and active services

### Automations
Automations are scheduled prompts. Each automation has an ID (UUID), Name, Prompt, Schedule, and Status. The API routes use `/admin/automations`.

- `GET /admin/automations` — list all automations (auth required)
- `POST /admin/automations` — create a new automation `{ "name": "...", "schedule": "*/30 * * * *", "prompt": "..." }` (auth required). Returns `201` with the created automation. Validates cron expression syntax. Triggers an `opencode-core` restart.
- `POST /admin/automations/update` — update an automation `{ "id": "...", "name?": "...", "schedule?": "...", "prompt?": "...", "enabled?": true }` (auth required). Validates cron expression if provided. Triggers an `opencode-core` restart.
- `POST /admin/automations/delete` — delete an automation `{ "id": "..." }` (auth required). Triggers an `opencode-core` restart.
- `POST /admin/automations/trigger` — "Run Now": immediately trigger an automation `{ "id": "..." }` (auth required). Fires the automation's prompt against `opencode-core` without waiting for the schedule.

---

## LAN Web UIs and service endpoints

These are available on the internal Docker network for service-to-service API/MCP use, and are also exposed via Caddy as LAN-only web routes under `/admin/*`:

- OpenCode Core UI/API:
  - Internal service URL: `http://opencode-core:4096`
  - LAN routes via Caddy: `/admin/opencode*`
- OpenMemory UI/API/MCP:
  - Internal service URL: `http://openmemory:8765` (API/MCP)
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
- `POST /down/:service` — stop a service (Note: despite the endpoint name, this runs `docker compose stop`, not `docker compose down`. The container is halted but not removed, which preserves container state and is safer for single-service operations.)

Allowed services: `opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `channel-webhook`, `caddy`

---

## Channel Adapter APIs

All channel adapters are LAN-only by default. Access can be toggled to public via the Admin API (`POST /admin/channels/access`).

### Channel Environment Variables

Channel-specific env override files follow the naming convention `channels/<channel>.env` (e.g., `channels/discord.env`, `channels/chat.env`). These files live under the `assets/config/channels/` directory and are mounted into each channel adapter container.

Each channel adapter reads the following environment variables at startup:

| Channel | Port | Env Var: `PORT` | Env Var: `GATEWAY_URL` | Env Var: Shared Secret | Env Var: Additional |
|---------|------|----------------|----------------------|----------------------|---------------------|
| chat | 8181 | `PORT` (default `8181`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_CHAT_SECRET` | `CHAT_INBOUND_TOKEN` — optional bearer token for inbound requests |
| discord | 8184 | `PORT` (default `8184`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_DISCORD_SECRET` | `DISCORD_BOT_TOKEN` — Discord bot token |
| voice | 8183 | `PORT` (default `8183`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_VOICE_SECRET` | — |
| telegram | 8182 | `PORT` (default `8182`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_TELEGRAM_SECRET` | `TELEGRAM_WEBHOOK_SECRET` — Telegram webhook verification secret |
| webhook | 8181 | `PORT` (default `8181`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_WEBHOOK_SECRET` | `WEBHOOK_INBOUND_TOKEN` — optional bearer token for inbound requests |

All adapters default `GATEWAY_URL` to `http://gateway:8080` (the gateway's internal Docker network address).

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
