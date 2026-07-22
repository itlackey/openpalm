# OpenPalm Admin API Spec (Current Implementation)

This document describes the Admin API routes currently implemented in
`packages/ui/src/routes/**/+server.ts`.

## Conventions

- Base URL: `http://localhost:3880`
- Namespaces: privileged host
  endpoints live under `/api/host/*` (requireAdmin + a server-side
  `requireCapability('host:…')` guard — 403 `capability_not_available` in
  modes without host capabilities), assistant-owned settings under
  `/api/assistant/*` (`assistant-settings:*` capabilities), session lifecycle
  under `/api/auth/*`, connections under `/api/connections/*`. The legacy
  `/admin/*` namespace is a router 404 since Phase 4 (no alias).
- Protected endpoints require the `op_session` cookie (HttpOnly, SameSite=Strict).
  The browser obtains the cookie via `POST /api/auth/login` (password in body).
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

### `GET /api/runtime-config`

Returns the credential-free connection seed for the current UI process with
`Cache-Control: no-store`. A `404` means the browser should consult the
assistant container's static `/runtime-config.json` fallback. Malformed or
unsafe process configuration fails closed with `500 invalid_runtime_config`.

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

### `GET /stats`

Returns guardian runtime statistics: uptime, rate limiter state, event/session
ownership counters, and per-status request counters.
This endpoint is served directly by the guardian process on its internal port
(not proxied through the SvelteKit admin process).

Auth: guardian-admin **Bearer** token — the same `GUARDIAN_ADMIN_TOKEN_FILE`
secret the guardian admin listener enforces (`Authorization: Bearer <token>`).
It is NOT gated by the host `op_session` cookie. An unconfigured/empty admin
token fails closed (401), so the roster/counters are never served open.

Response:

```json
{
  "uptime_seconds": 3600,
  "rate_limits": {
    "user_window_ms": 60000,
    "user_max_requests": 120,
    "portal_window_ms": 60000,
    "portal_max_requests": 200,
    "active_user_limiters": 5,
    "active_portal_limiters": 2
  },
  "oc_proxy": {
    "enabled": true,
    "session_owners": 3,
    "permission_owners": 1,
    "event_subscribers": 2
  },
  "requests": {
    "total": 150,
    "by_status": { "ok": 140, "rate_limited": 10 }
  }
}
```

## Lifecycle Endpoints

Policy for this section:

- `config/` is the user-owned persistent source of truth.
- `POST /api/host/install`, `POST /api/host/update`, and startup auto-apply are
  automatic lifecycle operations: non-destructive for existing user config files
  in `config/`; they only seed missing defaults.
- Explicit mutation endpoints (`POST /api/host/addons`, `POST /api/host/addons/:name`,
  `POST /api/setup/complete`, `PATCH /api/assistant/akm`) are the allowed write path
  for requested config changes.

### `POST /api/host/install`

- Ensures directories + OpenCode starter config + starter user secrets.
- Seeds only missing defaults in `config/`; never overwrites existing user files.
- Writes configuration files to their final locations.
- Runs `docker compose up -d` using managed compose files from `system/stack/`,
  the user overlay from `config/stack/custom.compose.yml`, non-secret env files,
  and file-based Compose secret grants.

Response:

```json
{
  "ok": true,
  "started": ["assistant", "guardian"],
  "failed": [],
  "dockerAvailable": true,
  "overallSuccess": true
}
```

### `POST /api/host/update`

- The body is a JSON object containing only an optional Compose `service` name.
  Unknown fields, empty service names, and non-string service names return `400`
  before mutation.
- The operation holds the admin lifecycle lock and verifies Docker availability.
- With `service`, the route validates the name against `docker compose config
  --services`, then calls the shared Compose driver for that exact service with
  `pull: "always"`.
- Without `service`, the route calls the shared `performUpgrade` operation, which
  refreshes managed files and applies the configured Compose stack with
  `pull: "always"` under the same lock.
- The route does not accept version targets, component aliases, downgrade flags,
  or rollback options. Configured image tags are managed separately through
  `PATCH /api/host/versions`.

Service request:

```json
{ "service": "voice-cuda" }
```

The full-stack request body is `{}`.

Success response:

```json
{ "ok": true }
```

Operational failure response:

```json
{
  "error": "docker_unavailable",
  "message": "Docker is unavailable",
  "details": {},
  "requestId": "req-123"
}
```

### `GET /api/host/versions`

Returns the four configured image tags and the UI update channel. Container state
comes from `GET /api/host/containers/list`; this route does not duplicate it or
make update-availability claims.

```json
{
  "configured": {
    "OP_ASSISTANT_VERSION": "latest",
    "OP_GUARDIAN_VERSION": "latest",
    "OP_PORTAL_VERSION": "0.13.0-beta.5",
    "OP_VOICE_VERSION": "latest"
  },
  "channel": "next"
}
```

The response does not query a registry and does not include `updateAvailable`,
component rollups, applied version state, or an up-to-date claim.

### `PATCH /api/host/versions`

Writes configured image tags through `writeVersions` and the channel through
`writeChannelPreference`; each helper performs an atomic file replacement. The
route validates the complete request before writing. These small config writes do
not acquire the lifecycle lock.

```json
{
  "versions": {
    "OP_ASSISTANT_VERSION": "0.13.0-beta.6",
    "OP_GUARDIAN_VERSION": "latest"
  },
  "channel": "next"
}
```

Only the four `SERVICE_VERSION_KEYS` are accepted in `versions`; `channel` is
`"latest"` or `"next"`. Either field may be omitted, but at least one change must
be supplied. Success returns `{ "ok": true }`.

### `POST /api/host/uninstall`

- Runs compose down.
- Does not delete or rewrite existing user config in `config/`.
- Marks in-memory services stopped.

Response:

```json
{ "ok": true, "stopped": ["assistant"], "dockerAvailable": true }
```

> The former `POST /api/host/upgrade` endpoint was removed in 0.12.36. The admin
> update path is now the direct `performUpgrade` operation documented
> above. Image tags are configured independently and are never derived from
> `PLATFORM_VERSION`.

## Container Operations

### `GET /api/host/containers/list`

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

### `POST /api/host/containers/pull`

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

### `POST /api/host/containers/up`
### `POST /api/host/containers/down`
### `POST /api/host/containers/restart`

Body:

```json
{ "service": "chat" }
```

Rules:

- Allowed core services:
  `assistant`, `guardian`, `admin`
- Allowed addon services: installed addon service names such as `chat`, `api`,
  `voice`, `discord`, or `slack` when enabled through the fixed compose set and
  active addon/profile selection.

Success response:

```json
{ "ok": true, "service": "chat", "status": "running" }
```

### `GET /api/host/containers/stats`

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

### `GET /api/host/containers/events`

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

---

## Addon Management

### `GET /voice/:path` / `POST /voice/:path`

Transparent same-origin pass-through to the local voice container's
OpenAI-compatible surface — the transport behind the chat client's
"OpenPalm Voice" provider (advertised as `voice.url = '/voice'` in the
runtime handshake). Method, path, query, body, and content-type forward 1:1;
no provider configuration lives here.

Auth: session cookie (`requireAdmin` — an ordinary logged-in session; no
`host:*` capability, using voice is not a privileged host operation).

Allowed paths: `v1/audio/speech`, `v1/audio/transcriptions`, `v1/models`,
`health`. Anything else is `404 not_found`.

Error responses:

- `503 voice_unavailable` -- The process has no local voice service (not an
  admin-capable process, or the voice addon is disabled).
- `502 voice_unreachable` -- The container did not respond (still starting).

### `GET /api/host/addons`

Returns all available addons with enabled status, plus the voice addon's
hardware profiles, current selection, and any in-flight bring-up job.

Response:

```json
{
  "addons": [
    { "name": "chat", "enabled": true, "available": true },
    { "name": "discord", "enabled": false, "available": true },
    { "name": "voice", "enabled": true, "available": true }
  ],
  "voice": {
    "profiles": [
      { "id": "addon.voice.cpu", "services": ["voice"], "label": "CPU", "default": true, "available": true }
    ],
    "selectedProfile": "addon.voice.cpu",
    "activeJob": { "state": "pulling", "steps": [], "startedAt": 0 }
  }
}
```

`voice.activeJob` is present only while a background pull/start is in flight
or shortly after it finished (`state`: `pulling | starting | healthy | error`).

### `POST /api/host/addons`

Enable or disable an addon.

Body:

```json
{ "name": "chat", "enabled": true, "profile": "addon.voice.cuda" }
```

- `name` (required) -- Built-in addon/profile name.
- `enabled` (optional) -- Set to `true` or `false` to enable/disable.
- `profile` (optional, voice only) -- Canonical hardware-profile id
  (`addon.voice.cpu|cuda|rocm`).

Voice is special-cased: an enable (or a profile change while enabled) runs the
full container bring-up — port pre-flight, image inspect, CDI/rootless overlay
selection, compose up + health wait. A first-time pull of the multi-GB image
forks to a background job and replies `202`; the UI polls `GET /api/host/addons`
for the `voice.activeJob`. A profile change while the addon is disabled only
records the selection. Disables use the generic stop + toggle path.

Response:

```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

Voice enables additionally carry a `voiceAddon` block
(`{ steps, status?, warming?, message?, error? }`) on `200`/`202`/`502`.

Error responses:

- `400 bad_request` -- `name` is missing.
- `400 invalid_profile` -- Unknown voice hardware-profile id.
- `404 not_found` -- Addon name is not a built-in optional service.
- `500 internal_error` -- Failed to update addon state on disk.
- `502` -- Voice bring-up failed (details in `voiceAddon.error`).

### `GET /api/host/addons/:name`

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

For `voice`, the response additionally carries the same `voice` block as
`GET /api/host/addons` (profiles, selected profile, active job).

Error responses:

- `404 not_found` -- Addon name is not a built-in optional service.

### `POST /api/host/addons/:name`

Enable or disable a specific addon. Same semantics as `POST /api/host/addons`
(including the voice bring-up special case and optional `profile`), with the
name in the path.

Body:

```json
{ "enabled": true }
```

- `enabled` (optional) -- Set to `true` or `false`.

When disabling, runs compose down for affected services.
When enabling a portal-style addon, ensures the required principal secret files exist.

Response:

```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

Error responses:

- `404 not_found` -- Addon name is not a built-in optional service.
- `500 internal_error` -- Failed to update addon state on disk.

## Automations

Automation task files live under `~/.openpalm/knowledge/tasks/` and are owned by AKM.
Portal addons (Discord/Slack/etc.) are managed via `/api/host/addons`, not this
section.

### `GET /api/host/automations`

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
        "path": "/api/host/...",
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

### `POST /api/host/automations/:name/run`

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

### `GET /api/host/automations/:name/log`

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

### `GET /api/host/config/validate`

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

## UI Distribution

The UI (`@openpalm/ui`) is independently versioned and distributed via npm, not
as a GitHub release asset. These endpoints let the operator browser and CLI
discover available UI versions and install a specific one.

### `GET /api/host/versions/ui`

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

### `GET /api/host/versions/releases`

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
npm package via `GET /api/host/versions/ui`.

### `POST /api/host/ui-version`

Checks the active UI channel for a newer `@openpalm/ui` build and installs it
into `data/ui/`. The build is downloaded from the npm registry,
integrity-verified (sha512, fail-closed), and extracted atomically after moving
the current build to a backup. A failed update restores that backup.

Auth: `requireAdmin`

Body:

```json
{}
```

No request fields are accepted. The updater uses the configured
`OP_UI_CHANNEL`; when unset, the platform release stream selects `latest` for a
stable build or `next` for a prerelease build.

Response:

```json
{
  "ok": true,
  "updated": true,
  "latestVersion": "0.13.0-beta.9",
  "restarting": false,
  "pendingRestart": true,
  "redownloadRequired": false
}
```

When a newer UI requires a native harness contract newer than the running
Electron harness, no build is installed and the response includes
`"redownloadRequired": true` and `requiredHarnessContract`. The operator must
download a newer application build instead of self-updating the UI.

Error responses:

- `400 invalid_json` — Request body is not valid JSON.
- `400 unknown_update_key` — The body contains any request field.
- `409 install_in_progress` — Another lifecycle or container mutation holds the
  shared install lock.
- `500 invalid_harness_contract` — Electron did not provide a valid
  `OP_HARNESS_CONTRACT_VERSION`; the update fails closed.
- `502 update_failed` — npm resolution, download, integrity verification, or
  extraction failed (the previous build is restored).

## Host OpenCode Detection & Import

Local-LLM-provider port probing (Ollama/LM Studio/Docker Model Runner) is a
**setup-time** concern — see `GET /api/setup/detect-providers` below. This
section covers importing credentials from an *existing host OpenCode
installation* into OP_HOME, which is a distinct feature.

### `GET /api/host/providers/host-status`

Detects whether the host has an existing OpenCode installation (`~/.local/share/opencode`
or platform equivalent) and returns provider + credential counts for the
import-host confirmation modal. Never returns credential values.

Auth: `requireAdmin`

Response:

```json
{
  "detected": true,
  "providerCount": 2,
  "credentialCount": 2,
  "configPath": "/home/user/.local/share/opencode/opencode.json",
  "authPath": "/home/user/.local/share/opencode/auth.json"
}
```

### `POST /api/host/providers/import-host`

Copies the host's `opencode.json` (stripped of plugin/mcp/permission keys,
merged with the existing OP_HOME config) and `auth.json` (byte-copied,
chmod 0600) into OP_HOME, then best-effort pushes each imported credential to
the running OpenCode server via `PUT /auth/{id}` so providers appear
connected without a restart. The assistant container is restarted afterward
so `opencode.json` provider blocks are re-read.

Auth: `requireAdmin`

Body (optional):

```json
{ "overwriteConflicts": false }
```

## Secrets Management

The secrets API is a plain per-file editor over `OP_HOME/knowledge/secrets/`
(mode 0600 on write) — there is no key/value store abstraction, prefix
filter, or generate-a-random-value affordance. `GET /api/host/secrets` lists
filenames + byte sizes; the file's contents are only ever read/written/deleted
through `/api/host/secrets/<name>`, one file at a time.

### `GET /api/host/secrets`

Lists the files in the secrets directory. Values are never included.

Auth: `requireAdmin`

Response:

```json
{ "files": [{ "name": "openai_api_key", "bytes": 51 }] }
```

### `GET /api/host/secrets/:name`

Reads one secret file's raw contents.

Auth: `requireAdmin`

Response:

```json
{ "name": "openai_api_key", "value": "sk-..." }
```

Error responses:

- `400 bad_request` -- `name` fails the safe-basename check (path traversal guard).
- `404 not_found` -- No file at that name.

### `PUT /api/host/secrets/:name`

Writes (creating or overwriting) one secret file with mode 0600.

Auth: `requireAdmin`

Body:

```json
{ "value": "sk-..." }
```

Response:

```json
{ "ok": true, "name": "openai_api_key" }
```

### `DELETE /api/host/secrets/:name`

Deletes one secret file.

Auth: `requireAdmin`

Response:

```json
{ "ok": true, "name": "openai_api_key" }
```

### `GET /api/host/secrets/user-env` / `POST /api/host/secrets/user-env` / `DELETE /api/host/secrets/user-env`

Separate key/value store for the shared AKM user env (`knowledge/env/user.env`
— assistant-visible config, distinct from the per-file secrets above). GET
returns key names only (never values); POST writes one `{ key, value }` pair;
DELETE removes one key by `?key=`.

Auth: `requireAdmin`

## OpenCode Management

### `GET /api/assistant/model`

Returns the current model from OpenCode's live config.

Auth: `requireAdmin`

Response:

```json
{ "model": "anthropic/claude-sonnet-4" }
```

Error responses:

- `503 opencode_unavailable` -- OpenCode is not reachable.

### `POST /api/assistant/model`

Update the active model. Persists to the assistant OpenCode config and attempts
live-apply via OpenCode's config API.

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
- `500 internal_error` -- persisting the OpenCode model selection failed.

### `GET /api/host/opencode/providers/:id/auth`

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

### `POST /api/host/opencode/providers/:id/auth`

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

### `DELETE /api/host/opencode/providers/:id/auth`

Remove stored credentials for a provider.

Auth: `requireAdmin`

Response:

```json
{ "ok": true }
```

### `GET /api/host/opencode/providers/:id/models`

Lists available models for a specific provider.

Auth: `requireAdmin`

Response:

```json
{ "models": [{ "id": "claude-sonnet-4", "name": "Claude Sonnet 4" }] }
```

Error responses:

- `404 not_found` -- Provider not found.

## Connections

### `POST /api/connections/pairing`

Mint a one-time pairing code (and QR) for attaching a remote client to this
stack's guardian. Creates a durable `direct` guardian principal on the guardian
admin listener; the principal's token is embedded only in the returned code and
is never exposed by any read endpoint.

- **Capability:** `host:stack:write` (admin-capable process only; a non-admin
  served/PWA build cannot reach it).
- **Session/origin:** requires the host-admin session cookie (httpOnly,
  `SameSite=Strict`) and passes the Host-header allowlist, like every other
  `/api/host/*` write.

Body:

```json
{ "label": "My Phone", "url": "https://guardian.example.ts.net/oc" }
```

- `label` (required) -- Human device label. Max **64 characters** — longer
  labels are rejected (`400`) before any principal is minted, so an oversized
  pairing code can never orphan a durable principal.
- `url` (required) -- The guardian `/oc` base URL the client will connect to;
  must be a valid `http(s)` URL.

Response (`201`):

```json
{
  "code": "openpalm-pair:<base64url>",
  "principalId": "my-phone-<16 hex>",
  "qrSvg": "<svg ...>",
  "warnings": ["GUARDIAN_DIRECT_INGRESS is not enabled ..."]
}
```

- `code` -- The one-time pairing code (contains the URL, username, and the
  principal secret). Returned exactly once; not recoverable afterward.
- `principalId` -- The created principal's id (slugged label + a 64-bit random
  suffix so re-pairing the same label never overwrites an existing device).
- `qrSvg` -- An SVG QR encoding of `code`, or `null` if rendering failed (the
  `code` is still returned and usable).
- `warnings` -- Non-fatal notes; notably, a warning when
  `GUARDIAN_DIRECT_INGRESS` is not enabled on the stack, because the paired
  client would otherwise `404` until the operator turns direct ingress on.

Error responses:

- `400 invalid_connection` -- `label` missing/too long, or `url` invalid.
- `403` -- Missing `host:stack:write` capability or host-admin session.
- `500 pairing_mint_failed` -- The guardian admin token secret is missing.
- `502 pairing_mint_failed` -- The guardian admin listener is unreachable
  (e.g. the guardian is not running with a guardian-ingress addon enabled).

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

### `GET /api/host/logs`

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
