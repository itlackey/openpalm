# OpenPalm Admin API Spec (Current Implementation)

This document describes the Admin API routes currently implemented in
`packages/ui/src/routes/**/+server.ts`.

## Conventions

- Base URL: `http://localhost:3880`
- Protected endpoints require the `op_session` cookie (HttpOnly, SameSite=Strict).
  The browser obtains the cookie via `POST /admin/auth/login` (password in body).
  The legacy `x-admin-token` / `Authorization: Bearer` header fallbacks were
  removed in Phase 2 of `docs/technical/auth-and-proxy-refactor-plan.md`.
  `OP_UI_LOGIN_PASSWORD` is supplied to the admin process from
  `knowledge/secrets/op_ui_login_password`.
- Optional caller attribution: `x-requested-by: assistant|cli|ui|system|test`
- Optional correlation: `x-request-id: <uuid>`

### Error shape

Most protected routes return structured errors via:

```json
{
  "error": "string_code",
  "message": "human readable",
  "details": {},
  "requestId": "uuid"
}
```

## Public Endpoints

### `GET /health`

Returns admin health:

```json
{ "status": "ok", "service": "admin" }
```

### `GET /guardian/health`

Proxy for guardian health. Returns the guardian service status based on
in-memory container state (not a direct proxy to the guardian process).

```json
{ "status": "ok", "service": "guardian" }
```

When the guardian is not running:

```json
{ "status": "unavailable", "service": "guardian" }
```

Status code is `200` when running, `503` when unavailable.

### `GET /guardian/stats`

Returns guardian runtime statistics: uptime, rate limiter state, nonce cache
size, active session counts, and per-channel/per-status request counters.
This endpoint is served directly by the guardian process (not proxied through admin).

Auth: Protected by the `op_session` cookie when an admin password is
configured. When no admin password is configured (dev/LAN), the endpoint is
open. (Guardian's own port still serves this — it is not proxied through
the SvelteKit admin process.)

Response:

```json
{
  "uptime_seconds": 3600,
  "rate_limits": {
    "user_window_ms": 60000,
    "user_max_requests": 120,
    "channel_window_ms": 60000,
    "channel_max_requests": 200,
    "active_user_limiters": 5,
    "active_channel_limiters": 2
  },
  "nonce_cache": { "size": 42, "max_size": 50000, "window_ms": 300000 },
  "sessions": { "active": 3, "max_size": 10000, "ttl_ms": 900000 },
  "requests": {
    "total": 150,
    "by_status": { "ok": 140, "rate_limited": 10 },
    "by_channel": { "chat": 100, "api": 50 }
  }
}
```

## Lifecycle Endpoints

Policy for this section:

- `config/` is the user-owned persistent source of truth.
- `POST /admin/install`, `POST /admin/update`, and startup auto-apply are
  automatic lifecycle operations: non-destructive for existing user config files
  in `config/`; they only seed missing defaults.
- Explicit mutation endpoints (`POST /admin/addons`, `POST /admin/addons/:name`,
  `POST /api/setup/complete`, `PATCH /admin/akm`) are the allowed write path
  for requested config changes.

### `POST /admin/install`

- Ensures directories + OpenCode starter config + starter user secrets.
- Seeds only missing defaults in `config/`; never overwrites existing user files.
- Writes configuration files to their final locations.
- Runs `docker compose up -d` using `config/stack/core.compose.yml`, installed addon overlays, non-secret `stack.env`, and file-based Compose secret grants.

Response:

```json
{
  "ok": true,
  "started": ["assistant", "guardian", "chat"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

### `POST /admin/update`

- Non-destructive for existing user config; seeds missing defaults only.
- Writes configuration files to their final locations.
- Re-applies compose with addon overlays.

Response:

```json
{ "ok": true, "restarted": ["guardian"], "dockerAvailable": true }
```

### `POST /admin/uninstall`

- Runs compose down.
- Does not delete or rewrite existing user config in `config/`.
- Marks in-memory services stopped.

Response:

```json
{ "ok": true, "stopped": ["assistant"], "dockerAvailable": true }
```

### `POST /admin/upgrade`

Full upgrade sequence: fetches the latest image tag, downloads fresh stack
files from GitHub, backs up changed files, writes updated configuration, pulls
images, and recreates all containers. After responding, the host admin process exits cleanly so the HTTP response is flushed first.

Response:

```json
{
  "ok": true,
  "imageTag": "0.9.0",
  "backupDir": "/home/user/.openpalm/data/backups/2025-01-01T00-00-00",
  "assetsUpdated": ["core.compose.yml"],
  "restarted": ["guardian"],
  "adminRecreateScheduled": true
}
```

Error responses:

- `502 image_tag_update_failed` — Failed to resolve latest image tag.
- `502 asset_download_failed` — Failed to download fresh stack files from GitHub.
- `503 docker_unavailable` — Docker is not reachable.
- `502 pull_failed` — `docker compose pull` failed.
- `502 up_failed` — Images pulled but container recreation failed.

## Container Operations

### `GET /admin/containers/list`

Returns in-memory service state synced with live Docker container data when
Docker is available.

Response:

```json
{
  "containers": { "assistant": "running", "guardian": "stopped" },
  "dockerContainers": [],
  "dockerAvailable": true
}
```

### `POST /admin/containers/pull`

- Pulls the latest images for all services in the current compose file list.
- After a successful pull, recreates containers with the updated images via `compose up`.

Response:

```json
{ "ok": true, "pulled": "...", "started": ["assistant", "guardian"] }
```

Note: `started` is an array of managed service names.

Error responses:

- `503 docker_unavailable` — Docker is not reachable.
- `502 pull_failed` — `docker compose pull` failed.
- `502 up_failed` — Images pulled but container recreation failed.

### `POST /admin/containers/up`
### `POST /admin/containers/down`
### `POST /admin/containers/restart`

Body:

```json
{ "service": "chat" }
```

Rules:

- Allowed core services:
  `assistant`, `guardian`, `admin`
- Allowed addon services: installed addon service names such as `chat`, `api`,
  `voice`, `discord`, or `slack` when a matching overlay exists in `stack/addons/`.

Success response:

```json
{ "ok": true, "service": "chat", "status": "running" }
```

### `GET /admin/containers/stats`

Returns live Docker container resource usage (CPU, memory, network I/O) for managed services.
Each entry is one JSON object from `docker compose stats --format json --no-stream`.

Auth: `requireAuth`

Response:

```json
{
  "stats": [
    { "Name": "openpalm-assistant-1", "CPUPerc": "0.50%", "MemUsage": "120MiB / 8GiB", "NetIO": "1kB / 2kB" }
  ]
}
```

Error responses:

- `503 docker_unavailable` -- Docker is not reachable.
- `500 docker_error` -- `docker compose stats` failed.
- `500 parse_error` -- Failed to parse stats output.

### `GET /admin/containers/events`

Returns recent Docker engine events (container start/stop/restart/die) filtered to managed services.

Query parameters:

- `since` (optional, default `"1h"`) -- Docker `--since` time filter.

Auth: `requireAuth`

Response:

```json
{
  "events": [
    { "status": "start", "id": "abc123", "Type": "container", "Actor": { "Attributes": { "name": "openpalm-assistant-1" } } }
  ]
}
```

Error responses:

- `503 docker_unavailable` -- Docker is not reachable.
- `500 docker_error` -- `docker events` failed.
- `500 parse_error` -- Failed to parse events output.

### `GET /admin/network/check`

Checks inter-container connectivity by probing each core service health endpoint from the host admin process.

Auth: `requireAuth`

Response:

```json
{
  "results": {
    "guardian": { "status": "reachable", "latencyMs": 12 },
    "assistant": { "status": "unreachable", "latencyMs": 0, "error": "fetch failed" }
  }
}
```

---

## Addon Management

### `GET /admin/addons`

Returns all available addons with enabled status.

Response:

```json
{
  "addons": [
    { "name": "chat", "enabled": true, "available": true },
    { "name": "discord", "enabled": false, "available": true },
    { "name": "admin", "enabled": true, "available": true }
  ]
}
```

### `POST /admin/addons`

Enable or disable an addon.

Body:

```json
{ "name": "chat", "enabled": true }
```

- `name` (required) -- Built-in addon/profile name.
- `enabled` (optional) -- Set to `true` or `false` to enable/disable.

Response:

```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

Error responses:

- `400 bad_request` -- `name` is missing.
- `404 not_found` -- Addon name is not a built-in optional service.
- `500 internal_error` -- Failed to update addon state on disk.

### `GET /admin/addons/:name`

Returns detail for a single addon.

Response:

```json
{
  "name": "chat",
  "enabled": true,
  "config": {
    "schemaPath": "",
    "userEnvPath": "knowledge/env/stack.env",
    "envSchema": ""
  }
}
```

Error responses:

- `404 not_found` -- Addon name is not a built-in optional service.

### `POST /admin/addons/:name`

Enable or disable a specific addon.

Body:

```json
{ "enabled": true }
```

- `enabled` (optional) -- Set to `true` or `false`.

When disabling, runs compose down for affected services.
When enabling a channel addon, generates an HMAC secret.

Response:

```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

Error responses:

- `404 not_found` -- Addon name is not a built-in optional service.
- `500 internal_error` -- Failed to update addon state on disk.

## Automations

Automation task files live under `~/.openpalm/knowledge/tasks/` and are owned by AKM.

### `GET /admin/automations/catalog`

Lists available automation tasks from `~/.openpalm/knowledge/tasks/`. Channel addons
are managed via `/admin/addons` and Compose profiles.

Response:

```json
{
  "automations": [
    { "name": "health-check", "type": "automation", "installed": true, "description": "...", "schedule": "0 */5 * * *" }
  ],
  "source": "registry"
}
```

`source` is `"remote"` when loaded from a cloned registry repo, `"bundled"`
when using build-time bundled stack assets.

### `POST /admin/automations/catalog/install`

Install a registry automation. Channel addons are managed via
`POST /admin/addons/:name`.

Body:

```json
{ "name": "daily-summary", "type": "automation" }
```

- `name` (required) -- Must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- `type` (required) -- Must be `"automation"`. Passing `"channel"` returns 400.

Copies the `.md` into `~/.openpalm/knowledge/tasks/`.
The assistant container picks up the new file within 60 s via its background `akm tasks sync` loop.

Response:

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

Error responses:

- `400 invalid_input` -- Invalid name, type is not `"automation"`, item not
  found in registry, or item already installed.

### `POST /admin/automations/catalog/refresh`

Refreshes the registry index from the configured registry source.

Response:

```json
{ "ok": true, "updated": true }
```

Error responses:

- `500 registry_sync_error` — Refresh failed.

### `POST /admin/automations/catalog/uninstall`

Uninstall a registry automation. Channel addons are managed via
`POST /admin/addons/:name`.

Body:

```json
{ "name": "daily-summary", "type": "automation" }
```

- `name` (required) -- Automation name.
- `type` (required) -- Must be `"automation"`. Passing `"channel"` returns 400.

Removes the `.md` from `~/.openpalm/knowledge/tasks/`.
The assistant container drops the cron entry within 60 s via its background `akm tasks sync` loop.

Response:

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

## Automations

### `GET /admin/automations`

Lists all automation configs from `~/.openpalm/knowledge/tasks/`.

Response:

```json
{
  "automations": [
    {
      "name": "daily-summary",
      "description": "Generate a daily summary",
      "schedule": "0 9 * * *",
      "timezone": "UTC",
      "enabled": true,
      "action": {
        "type": "http",
        "method": "POST",
        "path": "/admin/...",
        "url": null,
        "content": null,
        "agent": null
      },
      "on_failure": "log",
      "fileName": "daily-summary.yml"
    }
  ]
}
```

### `POST /admin/automations/:name/run`

Manually trigger an automation. The admin spawns `akm tasks run <name>` directly;
execution logs are written to `${OP_HOME}/data/akm/cache/tasks/logs/<name>/` and history
to akm's `state.db`.

- `:name` -- Automation name. Must match `^[a-z0-9][a-z0-9-]{0,62}$`.

Response (202 Accepted):

```json
{ "ok": true, "name": "daily-summary", "status": "started" }
```

Error responses:

- `400 invalid_input` -- Name does not match the allowed pattern.
- `404 not_found` -- Automation is not installed in `knowledge/tasks/`.
- `500 internal_error` -- `akm tasks run` exited non-zero.

### `GET /admin/automations/:name/log`

Returns recent execution log lines from `${OP_HOME}/data/akm/cache/tasks/logs/<name>/` (newest first).

- `:name` -- Same name validation as `/run`.
- `?limit=<n>` -- Cap entries returned (default 50, max 500).

Response:

```json
{
  "name": "daily-summary",
  "lines": [
    "2026-05-14T18:00:00Z task daily-summary finished ok",
    "2026-05-14T18:00:00Z output: {\"ok\":true}"
  ]
}
```

## Configuration Endpoints

### `GET /admin/config/validate`

Run the in-house key-presence and secret-audit checks against non-secret
`knowledge/env/stack.env`, resolved Compose config, and `knowledge/secrets/`.
The validator confirms secret-like values use file grants and that required
secret files are present — no varlock binary, no schema file. Always
returns 200; validation failures are non-fatal and are logged to the audit
trail.

**Authentication:** Required (`op_session` cookie)

**Response:**

```json
{ "ok": true, "errors": [], "warnings": [] }
```

When validation finds issues:

```json
{
  "ok": false,
  "errors": ["ERROR: required secret OP_UI_LOGIN_PASSWORD is missing or empty in knowledge/secrets/op_ui_login_password"],
  "warnings": ["WARN: OPENAI_BASE_URL is not a valid URL"]
}
```

**Error responses:**

- `401 unauthorized` — Missing or invalid `op_session` cookie.

**Notes:**

- `ok: true` means all required variables are present and valid.
- `ok: false` is non-fatal — services continue running.
- Failures are logged to the audit trail under action `config.validate`.
- This endpoint is called periodically by the `validate-config` core automation.

## Artifact and Audit APIs

### `GET /admin/artifacts`

```json
{ "artifacts": [{ "name": "compose", "sha256": "...", "generatedAt": "...", "bytes": 1234 }] }
```

### `GET /admin/artifacts/manifest`

```json
{ "manifest": [{ "name": "compose", "sha256": "...", "generatedAt": "...", "bytes": 1234 }] }
```

### `GET /admin/artifacts/:name`

- Allowed names: `compose`.
- Returns `text/plain` and may include `x-artifact-sha256` header.

### `GET /admin/audit?limit=<n>&source=<source>`

Query parameters:

- `limit` (optional) -- Maximum entries to return (capped at 1000).
- `source` (optional, default `"admin"`) -- `"admin"` returns admin audit entries,
  `"guardian"` returns guardian audit entries, `"all"` merges both sources sorted
  by timestamp descending. Each merged entry includes a `_source` field indicating
  its origin.

```json
{ "audit": [{ "at": "...", "action": "install", "ok": true }] }
```

## Installed Services

### `GET /admin/installed`

```json
{
  "installed": ["chat"],
  "activeServices": { "assistant": "running" }
}
```

## UI Distribution

The UI (`@openpalm/ui`) is independently versioned and distributed via npm, not
as a GitHub release asset. These endpoints let the operator browser and CLI
discover available UI versions and install a specific one.

### `GET /admin/versions/ui`

Lists published `@openpalm/ui` npm versions for the admin UI build picker.
Returns newest-first (by npm publish time); a 404 from the registry (package not
yet published) returns an empty list rather than an error.

Auth: `requireAdmin`

Response:

```json
{
  "versions": [
    {
      "version": "0.11.0-rc.2",
      "prerelease": true,
      "publishedAt": "2026-06-01T12:00:00.000Z",
      "distTag": "next"
    },
    {
      "version": "0.10.2",
      "prerelease": false,
      "publishedAt": "2026-05-15T09:00:00.000Z",
      "distTag": "latest"
    }
  ],
  "distTags": { "latest": "0.10.2", "next": "0.11.0-rc.2" }
}
```

On registry error (non-404):

```json
{ "versions": [], "distTags": {}, "error": "npm registry 503" }
```

Fields:

- `version` — npm version string (e.g. `"0.11.0-rc.2"`).
- `prerelease` — `true` when the version string contains a `-` prerelease segment.
- `publishedAt` — ISO 8601 publish time from the registry, or `null` if absent.
- `distTag` — The dist-tag pointing at this version (`"latest"` or `"next"`), or
  `null` if no dist-tag points here.
- `distTags` — Full dist-tag map from the packument.

Up to 20 versions are returned.

### `GET /admin/versions/releases`

Lists GitHub platform release tags (newest first). Used to display the platform
release history in the admin UI. UI build information is **not** included — UI
builds are sourced from npm, not GitHub release assets.

Auth: `requireAdmin`

Response:

```json
{
  "releases": [
    { "tag": "0.11.0", "prerelease": false, "publishedAt": "2026-06-01T12:00:00.000Z" },
    { "tag": "0.11.0-rc.2", "prerelease": true, "publishedAt": "2026-05-28T10:00:00.000Z" }
  ]
}
```

On error:

```json
{ "releases": [], "error": "GitHub API 403" }
```

Note: The `hasUiBuild` field that previously appeared on each release entry has
been removed; UI builds are now sourced independently from the `@openpalm/ui`
npm package via `GET /admin/versions/ui`.

### `POST /admin/ui-version`

Seeds a specific `@openpalm/ui` npm version (or dist-tag) into `data/ui/`. The
build is downloaded from the npm registry, integrity-verified (sha512, fail-
closed), and extracted atomically — a failed download never leaves `data/ui/`
empty.

Auth: `requireAdmin`

Body:

```json
{ "tag": "0.11.0-rc.2" }
```

- `tag` (required) — An `@openpalm/ui` npm version (e.g. `"0.11.0-rc.2"`) or
  dist-tag (e.g. `"latest"`, `"next"`). **This is no longer a GitHub platform
  release tag**; use `GET /admin/versions/ui` to list installable versions.
  Must match `^[a-zA-Z0-9._\-]+$`.

Response:

```json
{ "ok": true, "tag": "0.11.0-rc.2" }
```

Error responses:

- `400 tag_required` — `tag` field missing or empty.
- `400 invalid_tag` — `tag` contains characters outside `[a-zA-Z0-9._-]`.
- `400 invalid_json` — Request body is not valid JSON.
- `502 download_failed` — npm download or integrity verification failed
  (message from the underlying error is included).

## Local Provider Detection

### `GET /admin/providers/local`

Probes well-known local LLM provider endpoints to detect which are running.
Requires admin auth.

Probed providers:

| Provider | Probe URLs |
|----------|-----------|
| `model-runner` | `model-runner.docker.internal/engines/v1/models`, `:12434` variants, `localhost:12434` |
| `ollama` | `host.docker.internal:11434/api/tags`, `localhost:11434` |
| `lmstudio` | `host.docker.internal:1234/v1/models`, `localhost:1234` |

Response:

```json
{
  "providers": [
    { "provider": "model-runner", "url": "http://model-runner.docker.internal/engines", "available": true },
    { "provider": "ollama", "url": "", "available": false },
    { "provider": "lmstudio", "url": "", "available": false }
  ]
}
```

## Secrets Management

Manage secrets via the detected secret backend (env-file or pass-based).

### `GET /admin/secrets`

Lists secret entry names (values are never returned in full).

Query parameters:

- `prefix` (optional, default `"openpalm/"`) -- Filter entries by prefix.

Auth: `requireAdmin`

Response:

```json
{
  "provider": "env-file",
  "capabilities": { "generate": true },
  "entries": [
    { "key": "openpalm/OPENAI_API_KEY", "scope": "user", "kind": "api-key" }
  ]
}
```

### `POST /admin/secrets`

Set or update a secret value.

Auth: `requireAdmin`

Body:

```json
{ "key": "openpalm/OPENAI_API_KEY", "value": "sk-..." }
```

- `key` (required) -- Secret entry name. Must pass `validatePassEntryName`.
- `value` (required) -- Secret value (must be non-empty; use DELETE to remove).

Response:

```json
{ "ok": true, "provider": "env-file", "entry": { "key": "openpalm/OPENAI_API_KEY", "scope": "user", "kind": "api-key" } }
```

Error responses:

- `400 bad_request` -- `key` or `value` missing/empty.
- `400 invalid_key` -- Key fails `validatePassEntryName` validation.
- `500 internal_error` -- Failed to write secret.

### `DELETE /admin/secrets`

Delete a secret entry.

Auth: `requireAdmin`

Query parameters:

- `key` (required) -- Secret entry name to delete.

Response:

```json
{ "ok": true, "key": "openpalm/OPENAI_API_KEY", "provider": "env-file" }
```

Error responses:

- `400 bad_request` -- `key` query parameter missing.
- `500 internal_error` -- Failed to remove secret.

### `POST /admin/secrets/generate`

Generate a random secret and store it under the given key.

Auth: `requireAdmin`

Body:

```json
{ "key": "openpalm/HMAC_SECRET", "length": 32 }
```

- `key` (required) -- Secret entry name.
- `length` (optional, default `32`) -- Length of generated secret (16--4096).

Response:

```json
{ "ok": true, "provider": "env-file", "entry": { "key": "openpalm/HMAC_SECRET", "scope": "system", "kind": "generated" } }
```

Error responses:

- `400 bad_request` -- `key` missing or `length` out of range.
- `400 invalid_key` -- Key fails validation.
- `400 unsupported_operation` -- Backend does not support generation.
- `500 internal_error` -- Failed to generate secret.

## OpenCode Management

### `GET /admin/opencode/status`

Returns whether the OpenCode process is reachable.

Auth: `requireAdmin`

Response:

```json
{ "status": "ready", "url": "http://localhost:4096/" }
```

When unreachable:

```json
{ "status": "unavailable", "url": "http://localhost:4096/" }
```

### `GET /admin/opencode/model`

Returns the current model from OpenCode's live config.

Auth: `requireAdmin`

Response:

```json
{ "model": "anthropic/claude-sonnet-4" }
```

Error responses:

- `503 opencode_unavailable` -- OpenCode is not reachable.

### `POST /admin/opencode/model`

Update the active model. Persists to `stack.yml` and attempts live-apply
via OpenCode's config API. If live-apply fails, the model is still persisted
and a container restart will pick it up.

Auth: `requireAdmin`

Body:

```json
{ "model": "anthropic/claude-sonnet-4" }
```

Response (live-applied):

```json
{ "ok": true, "liveApplied": true, "restartRequired": false, "message": "Model updated successfully" }
```

Response (persisted only):

```json
{ "ok": true, "liveApplied": false, "restartRequired": true, "message": "Model saved. Restart the assistant container to apply." }
```

Error responses:

- `400 bad_request` -- `model` is missing or empty.
- `500 internal_error` -- `stack.yml` not found or write failed.

### `GET /admin/opencode/providers`

Lists all OpenCode providers with auth status and available models.

Auth: `requireAdmin`

Response:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "env": ["ANTHROPIC_API_KEY"],
      "connected": true,
      "modelCount": 5,
      "models": [{ "id": "claude-sonnet-4", "name": "Claude Sonnet 4" }],
      "authMethods": [{ "type": "api_key" }]
    }
  ]
}
```

### `GET /admin/opencode/providers/:id/auth`

Poll an OAuth authorization session for a provider.

Auth: `requireAdmin`

Query parameters:

- `pollToken` (required) -- Token returned by the POST auth endpoint.

Response:

```json
{ "status": "complete", "message": "Authorization successful" }
```

Other statuses: `"pending"` (still waiting), `"error"` (session expired).

Error responses:

- `400 bad_request` -- `pollToken` missing or provider ID mismatch.
- `404 not_found` -- Poll session not found or expired.

### `POST /admin/opencode/providers/:id/auth`

Start an auth flow for a provider (API key or OAuth).

Auth: `requireAdmin`

Body (API key mode):

```json
{ "mode": "api_key", "apiKey": "sk-..." }
```

Body (OAuth mode):

```json
{ "mode": "oauth", "methodIndex": 0 }
```

Response (API key):

```json
{ "ok": true, "mode": "api_key" }
```

Response (OAuth):

```json
{
  "ok": true,
  "mode": "oauth",
  "pollToken": "uuid",
  "url": "https://...",
  "method": "browser",
  "instructions": "Open the URL in your browser..."
}
```

Error responses:

- `400 bad_request` -- Invalid mode, missing `apiKey`, invalid API key format,
  unsupported provider, or invalid `methodIndex`.
- `500 internal_error` -- Failed to write API key to the user env.

### `GET /admin/opencode/providers/:id/models`

Lists available models for a specific provider.

Auth: `requireAdmin`

Response:

```json
{ "models": [{ "id": "claude-sonnet-4", "name": "Claude Sonnet 4" }] }
```

Error responses:

- `404 not_found` -- Provider not found.

## Setup Wizard API

These endpoints are used exclusively by the setup wizard (`/setup`). They are
public (no admin token required) because setup runs before any admin token is
configured. The wizard is served at `http://localhost:<OP_HOST_UI_PORT>/setup`
(default port `3880`) by `openpalm`, which is spawned automatically
by `openpalm install`.

### `GET /api/setup/status`

Returns whether first-time setup has been completed.

Auth: None (public)

Response:

```json
{ "ok": true, "setupComplete": false }
```

### `GET /api/setup/detect-providers`

Detects locally running model providers (Ollama, LM Studio, Docker Model Runner,
etc.) by probing well-known ports.

Auth: None (public)

Response:

```json
{
  "ok": true,
  "providers": [{ "id": "ollama", "name": "Ollama", "baseUrl": "http://localhost:11434", "verified": true }]
}
```

Error responses:

- `500 detection_failed` -- Detection threw an unexpected error.

### `POST /api/setup/models/:provider`

Fetches available models for a provider given optional API credentials.

Auth: None (public)

Body:

```json
{ "apiKey": "sk-...", "baseUrl": "https://..." }
```

Response:

```json
{ "ok": true, "models": [{ "id": "gpt-4o", "name": "GPT-4o" }] }
```

Error responses:

- `400 invalid_json` -- Body is not valid JSON.
- `502` -- Provider returned an error or timed out.

### `POST /api/setup/complete`

Runs first-time setup from a `SetupSpec` payload, writes managed config files,
sets the session cookie, and kicks off a background Docker deploy.

Auth: None (public — runs before admin token exists)

Body: A `SetupSpec` v2 object (see `packages/lib/src/control-plane/types.ts`).

Response:

```json
{ "ok": true, "dockerAvailable": true }
```

Sets `op_session` cookie on success. The cookie value is the new admin token so
the browser is immediately authenticated for subsequent admin requests.

Error responses:

- `400 invalid_json` -- Body is not valid JSON.
- `400` -- `performSetup` validation failure (missing required fields, etc.).
- `500 setup_failed` -- Unexpected error during setup.

### `GET /api/setup/deploy-status`

Polls the in-progress Docker deploy started by `/api/setup/complete`.

Auth: None (public)

Response:

```json
{
  "ok": true,
  "setupComplete": true,
  "deploying": false,
  "deployStatus": [{ "service": "assistant", "status": "running", "label": "Running" }],
  "deployError": null
}
```

### `GET /api/setup/opencode/status`

Checks whether the OpenCode binary is available on the host (used to decide
whether to show the full OpenCode provider list or the built-in fallback).

Auth: None (public)

Response:

```json
{ "ok": true, "available": true }
```

### `GET /api/setup/opencode/providers`

Returns the full OpenCode provider catalog and per-provider auth methods when
the OpenCode binary is available. Falls back to `{ available: false, providers: [] }`
when OpenCode is not running.

Auth: None (public)

Response:

```json
{
  "ok": true,
  "available": true,
  "providers": [{ "id": "anthropic", "name": "Anthropic", ... }],
  "auth": { "anthropic": [{ "type": "api_key" }] }
}
```

### `PUT /api/setup/opencode/auth/:provider`

Sets an API key for a provider in the running OpenCode instance.

Auth: None (public — during setup flow)

Body:

```json
{ "type": "api_key", "key": "sk-..." }
```

Response:

```json
{ "ok": true, "type": "api_key" }
```

Error responses:

- `400` -- Invalid key or unsupported provider.
- `503` -- OpenCode is not available.

### `POST /api/setup/opencode/provider/:provider/oauth/authorize`

Initiates OAuth for a provider through the OpenCode OAuth flow.

Auth: None (public)

Body:

```json
{ "method": 0 }
```

Response:

```json
{ "ok": true, "url": "https://...", "method": "browser", "instructions": "..." }
```

Error responses:

- `400` -- Invalid method or provider.
- `503` -- OpenCode is not available.

### `POST /api/setup/opencode/provider/:provider/oauth/callback`

Completes an OAuth flow by submitting the authorization code returned by the
provider.

Auth: None (public)

Body:

```json
{ "method": 0, "code": "auth-code-from-provider" }
```

Response:

```json
{ "ok": true, "complete": true }
```

Error responses:

- `400` -- Invalid code or method.
- `503` -- OpenCode is not available.

---

## Logs

### `GET /admin/logs`

Retrieves Docker Compose service logs via `docker compose logs`.

Auth: `requireAuth`

Query parameters:

- `service` (optional) -- Comma-separated service names. When omitted, returns
  logs for all managed services.
- `tail` (optional, default `100`) -- Number of log lines (1--10000).
- `since` (optional) -- Docker `--since` time filter (e.g. `"1h"`, `"2025-01-01T00:00:00"`).

Response:

```json
{ "ok": true, "logs": "assistant  | 2025-01-01 Starting...\nguardian   | 2025-01-01 Ready" }
```

Error responses:

- `400 invalid_parameter` -- `tail` out of range or `since` contains invalid characters.
- `400 invalid_service` -- Unknown service name(s).
- `503 docker_unavailable` -- Docker is not available.
