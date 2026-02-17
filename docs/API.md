# API Reference

## Gateway API (internal; channel adapters call gateway directly on the Docker network)

### GET /health
Health status for the gateway (internal).

### POST /channel/inbound
Signed channel payload from adapters (internal). Gateway verifies a shared-secret HMAC and forwards to the isolated channel OpenCode runtime.

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
2. Gateway sends a dedicated intake command to `opencode-channel` (`agent: channel-intake`).
3. Gateway parses intake JSON (`valid`, `summary`, `reason`).
4. If valid, gateway forwards only the summary to `opencode-core`.

Possible errors:
- `422 invalid_channel_request` when channel intake rejects the request.
- `502 channel_intake_unavailable` when intake runtime response is invalid/unavailable.
- `502 core_runtime_unavailable` when core runtime fails.

Gateway runtime knobs:
- `OPENCODE_TIMEOUT_MS` (default `15000`)

Notes:
- All inbound user traffic is routed through `/channel/inbound` only.
- Gateway first calls `opencode-channel` to validate + summarize, then forwards valid summaries to `opencode-core`.

---

## Admin App API (routed via Caddy at /admin/*, LAN only)

Headers for all admin endpoints:
- `x-admin-token` (required)
- `x-admin-step-up` (required for destructive operations)

### GET /admin/health
Health status for the admin app.

### Container management
- `GET /admin/containers/list` — list running containers
- `POST /admin/containers/up` — start a service `{ "service": "channel-discord" }` (step-up required)
- `POST /admin/containers/down` — stop a service `{ "service": "channel-discord" }` (step-up required)
- `POST /admin/containers/restart` — restart a service `{ "service": "opencode-core" }` (step-up required)

### Channel management
- `GET /admin/channels` — list channel services, network access mode, and editable config keys
- `POST /admin/channels/access` — set network access for channel ingress `{ "channel": "chat" | "voice" | "discord" | "telegram", "access": "lan" | "public" }` (step-up required)
- `GET /admin/channels/config?service=channel-chat` — read channel-specific env overrides
- `POST /admin/channels/config` — update channel env overrides `{ "service": "channel-discord", "config": { "DISCORD_BOT_TOKEN": "..." }, "restart": true }` (step-up required)

### Extension lifecycle
- `POST /admin/extensions/request` — queue a plugin `{ "pluginId": "@scope/plugin" }`
- `GET /admin/extensions/list` — list all extension requests
- `POST /admin/extensions/apply` — apply extension `{ "requestId": "uuid" }` (step-up required)
- `POST /admin/extensions/disable` — disable extension `{ "pluginId": "@scope/plugin" }` (step-up required)

### Config editor
- `GET /admin/config` — read `opencode.jsonc` (returns text/plain)
- `POST /admin/config` — write config `{ "config": "...", "restart": true }` (step-up required, denies permission widening to `allow`)

### Change manager
- `POST /admin/change/propose` — register a change bundle `{ "bundleId": "my-bundle" }`
- `POST /admin/change/validate` — validate bundle `{ "bundleId": "my-bundle" }`
- `POST /admin/change/apply` — apply bundle `{ "bundleId": "my-bundle", "applyPlugins": [], "restart": true }` (step-up required)
- `POST /admin/change/rollback` — rollback config `{ "backupPath": "...", "restart": true }` (step-up required)

### Setup wizard
- `GET /admin/setup/status` — returns current setup wizard state (completed steps, channels, extensions, first-boot flag)
- `POST /admin/setup/step` — mark a step complete `{ "step": "welcome" | "healthCheck" | "security" | "channels" | "extensions" }`
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
- `POST /admin/gallery/install` — install a gallery item (step-up required)
  ```json
  { "itemId": "plugin-policy-telemetry" }
  ```
  Delegates to extension lifecycle or controller depending on `installAction` type.
- `POST /admin/gallery/uninstall` — uninstall a gallery item (step-up required)
  ```json
  { "itemId": "plugin-policy-telemetry" }
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

- `GET /health` — health check
- `GET /containers` — list running containers (via `docker compose ps`)
- `POST /restart/:service` — restart a service
- `POST /up/:service` — start a service
- `POST /down/:service` — stop a service

Allowed services: `opencode-core`, `opencode-channel`, `gateway`, `openmemory`, `admin-app`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`

---

## Channel Adapter APIs

### Chat (channel-chat, :8181)
- Public/LAN ingress route via Caddy: `/channels/chat*`
- `GET /health`
- `POST /chat` — `{ "userId": "...", "text": "...", "metadata": {} }`
  - Header: `x-chat-token` (if configured)

### Discord (channel-discord, :8184)
- LAN ingress route via Caddy: `/channels/discord*`
- `GET /health`
- `POST /discord/interactions` — Discord interactions endpoint (slash commands, type 1/2)
- `POST /discord/webhook` — simple webhook `{ "userId": "...", "text": "...", "channelId": "...", "guildId": "..." }`

### Voice (channel-voice, :8183)
- Public/LAN ingress route via Caddy: `/channels/voice*`
- `GET /health`
- `POST /voice/transcription` — `{ "userId": "...", "text": "...", "audioRef": "...", "language": "en" }`
- `GET /voice/stream` — placeholder for WebSocket-based real-time streaming (not yet implemented)

### Telegram (channel-telegram, :8182)
- LAN ingress route via Caddy: `/channels/telegram*`
- `GET /health`
- `POST /telegram/webhook` — Telegram bot update JSON
  - Header: `x-telegram-bot-api-secret-token`
