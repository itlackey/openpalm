## API Status

Lifecycle operations are exposed via Admin endpoints with allowlisted operations and service validation.

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

**Exceptions (no auth required):** `/health`, `/admin/setup/*` (before setup completes), `/admin/meta`, static UI assets (`/`, `/index.html`, `/setup-ui.js`, `/logo.png`).

### GET /health
Health status for the admin app.

### Standard admin error shape
All admin endpoints should return errors in the shape:

```json
{
  "error": "machine_readable_error_code",
  "details": "optional human-readable or structured details",
  "code": "optional stable subcode"
}
```

This keeps the UI implementation simple and predictable for non-technical users by avoiding endpoint-specific parsing rules.

### Secrets + connection contract (canonical)
The secret manager is the source of truth for both raw secret keys and connection mappings.

- `GET /admin/secrets` — list available secret keys and where each key is used.
- `POST /admin/secrets` — create or update a secret key/value `{ "name": "OPENAI_API_KEY_MAIN", "value": "..." }`.
- `POST /admin/secrets/delete` — delete a secret key if not referenced `{ "name": "OPENAI_API_KEY_MAIN" }`.
- `GET /admin/secrets/map` — read stack-level channel secret mappings.
- `POST /admin/secrets/mappings/channel` — map channel gateway/channel secret refs `{ "channel": "chat", "target": "gateway" | "channel", "secretName": "CHANNEL_CHAT_SECRET" }`.

Connection lifecycle:
- `GET /admin/connections` — list saved connection definitions.
- `POST /admin/connections/validate` — validate a connection payload against current secret inventory without saving.
- `POST /admin/connections` — create/update a saved connection definition.
- `GET /admin/compose/capabilities` — returns allowed service names, log tail constraints, and explicit reload semantics per service.
- `POST /admin/connections/delete` — remove a saved connection definition.

The UI must always derive secret dropdown options from live `GET /admin/secrets` output.

### Common connection env-var conventions
- OpenAI-compatible providers: `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`
- Anthropic: `ANTHROPIC_API_KEY`
- GitHub: `GITHUB_TOKEN`
- Generic webhook/API auth: `API_KEY` or `BEARER_TOKEN`

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
- `GET /admin/setup/status` — returns current setup wizard state (completed steps, channels, first-boot flag), current service-instance overrides, provider setup, and small model config
- `GET /admin/system/state` — capability-focused consolidated system snapshot for setup + stack + secret inventory, intended for configuration-editor UX flows
- `POST /admin/setup/step` — mark a step complete `{ "step": "welcome" | "accessScope" | "serviceInstances" | "healthCheck" | "security" | "channels" }`
- `POST /admin/setup/access-scope` — set setup access scope `{ "scope": "host" | "lan" }` (updates Caddy matchers and compose bind addresses)
- `POST /admin/setup/service-instances` — update service instance overrides, OpenMemory provider, Anthropic key, and small model settings `{ "openmemory": "...", "psql": "...", "qdrant": "...", "openaiBaseUrl": "...", "openaiApiKey": "...", "anthropicApiKey": "...", "smallModelEndpoint": "...", "smallModelApiKey": "...", "smallModelId": "..." }`
- `POST /admin/setup/channels` — save enabled channel selection `{ "channels": ["channel-chat", "channel-discord"] }`
- `POST /admin/setup/complete` — finalize setup wizard (marks `setupComplete: true`)
- `GET /admin/setup/health-check` — run health checks against gateway, OpenCode, and OpenMemory; returns `{ services: { gateway, opencodeCore, openmemory, admin } }`

### Gallery (extension marketplace)
- `GET /admin/gallery/search?q=&category=` — search curated gallery registry
  - `q` — free-text search (matches name, description, tags, id)
  - `category` — filter by `plugin`, `skill`, `command`, `agent`, `tool`, `channel`, or `service`.
- `GET /admin/gallery/categories` — list gallery categories with counts
- `GET /admin/gallery/item/:id` — get full detail for a single gallery item including risk badge
- `GET /admin/gallery/npm-search?q=` — search npm registry for non-curated OpenCode plugins
- `GET /admin/gallery/community?q=&category=` — search the public community registry fetched from GitHub at runtime (no auth required; 10-minute cache)
  - `q` — optional free-text search
  - `category` — optional filter by `plugin`, `skill`, `command`, `agent`, `tool`, `channel`, or `service`
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
  Delegates to atomic config update  depending on `installAction` type.
- `POST /admin/gallery/uninstall` — uninstall a gallery item or plugin
  ```json
  { "galleryId": "plugin-policy-telemetry" }
  ```
### Plugin management
- `POST /admin/plugins/install` — install an npm plugin by adding it to `opencode.json` `plugin[]` array `{ "pluginId": "@scope/plugin-name" }` (restarts opencode-core)
- `POST /admin/plugins/uninstall` — uninstall a plugin by removing it from `opencode.json` `plugin[]` array `{ "pluginId": "@scope/plugin-name" }` (restarts opencode-core)

### Installed status
- `GET /admin/installed` — returns currently installed plugins and setup state

### Meta
- `GET /admin/meta` — returns service display names, channel field definitions, and required core secrets (no auth required)

### Stack spec
- `GET /admin/stack/spec` — returns the current stack spec (auth required)
- `POST /admin/stack/spec` — validate and save a custom stack spec `{ "spec": {...} }` (auth required)
- `GET /admin/stack/render` — returns generated Caddyfile, compose file, and env artifacts from the current spec (auth required)
- `POST /admin/stack/apply` — apply the current stack spec (generates artifacts, validates secrets, optionally runs compose operations) `{ "apply": true }` (auth required)
- `GET /admin/stack/impact` — preview what a stack apply would change without applying (auth required)
- `GET /admin/compose/capabilities` — preview compose operations available (auth required)

### Secret management
- `GET /admin/secrets` — list all secrets with usage info, configured status, and constraint metadata (auth required)
- `POST /admin/secrets` — create or update a secret `{ "name": "MY_SECRET", "value": "..." }` (auth required)
- `POST /admin/secrets/delete` — delete a secret `{ "name": "MY_SECRET" }` (auth required; fails with `secret_in_use` if referenced by a channel or connection)
- `GET /admin/secrets/map` — list channel secret mappings from the stack spec (auth required)
- `POST /admin/secrets/mappings/channel` — map a secret to a channel `{ "channel": "chat", "target": "gateway" | "channel", "secretName": "MY_SECRET" }` (auth required)
- `POST /admin/channels/shared-secret` — set the shared HMAC secret for a channel `{ "channel": "chat", "secret": "..." }` (auth required; minimum 32 characters)

### Connections
- `GET /admin/connections` — list all connections (auth required)
- `POST /admin/connections` — create or update a connection `{ "id": "openai-primary", "name": "OpenAI Primary", "type": "ai_provider" | "platform" | "api_service", "env": { "OPENAI_API_KEY": "OPENAI_API_KEY_MAIN" } }` (auth required; env values are secret key references, not raw values)
- `POST /admin/connections/delete` — delete a connection `{ "id": "openai-primary" }` (auth required)

### Providers
- `GET /admin/providers` — list all providers with masked API keys (auth required)
- `POST /admin/providers` — create a provider `{ "name": "...", "url": "...", "apiKey": "..." }` (auth required)
- `POST /admin/providers/update` — update a provider `{ "id": "...", "name?": "...", "url?": "...", "apiKey?": "..." }` (auth required)
- `POST /admin/providers/delete` — delete a provider `{ "id": "..." }` (auth required; restarts affected services)
- `POST /admin/providers/models` — fetch available models from a provider `{ "providerId": "..." }` (auth required)
- `POST /admin/providers/assign` — assign a model to a role `{ "role": "small" | "openmemory", "providerId": "...", "modelId": "..." }` (auth required)

### Automations
Automations are scheduled prompts managed as cron jobs in the admin container. Each automation has an ID (UUID), Name, Script (prompt text), Schedule, and Status. The API routes use `/admin/automations`.

- `GET /admin/automations` — list all automations with last run info (auth required)
- `POST /admin/automations` — create a new automation `{ "name": "...", "schedule": "*/30 * * * *", "script": "..." }` (auth required). Returns `201` with the created automation. Validates cron expression syntax. Syncs crontab in admin container (no opencode-core restart required).
- `POST /admin/automations/update` — update an automation `{ "id": "...", "name?": "...", "schedule?": "...", "script?": "...", "enabled?": true }` (auth required). Validates cron expression if provided. Syncs crontab.
- `POST /admin/automations/delete` — delete an automation `{ "id": "..." }` (auth required). Syncs crontab.
- `POST /admin/automations/trigger` — "Run Now": immediately trigger an automation `{ "id": "..." }` (auth required). Fires the automation's script without waiting for the schedule.
- `GET /admin/automations/history?id=&limit=` — get execution history for an automation (auth required). Returns up to `limit` (default 20, max 100) recent runs.

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

## Channel Adapter APIs

All channel adapters are LAN-only by default. Access can be toggled to public via the Admin API (`POST /admin/channels/access`).

### Channel Environment Variables

Channel-specific configuration is managed through the Stack Spec and rendered into scoped env files under `${OPENPALM_STATE_HOME}/rendered/env/`. The admin service manages channel config values through the stack manager API.

Each channel adapter reads the following environment variables at startup:

| Channel | Port | Env Var: `PORT` | Env Var: `GATEWAY_URL` | Env Var: Shared Secret | Env Var: Additional |
|---------|------|----------------|----------------------|----------------------|---------------------|
| chat | 8181 | `PORT` (default `8181`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_CHAT_SECRET` | `CHAT_INBOUND_TOKEN` — optional bearer token for inbound requests |
| discord | 8184 | `PORT` (default `8184`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_DISCORD_SECRET` | `DISCORD_BOT_TOKEN` — Discord bot token |
| voice | 8183 | `PORT` (default `8183`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_VOICE_SECRET` | — |
| telegram | 8182 | `PORT` (default `8182`) | `GATEWAY_URL` (default `http://gateway:8080`) | `CHANNEL_TELEGRAM_SECRET` | `TELEGRAM_WEBHOOK_SECRET` — Telegram webhook verification secret |

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
