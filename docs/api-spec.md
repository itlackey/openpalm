# OpenPalm Admin API Spec (Current Implementation)

This document describes the Admin API routes currently implemented in
`core/admin/src/routes/**/+server.ts`.

## Conventions

- Base URL (direct): `http://localhost:8100`
- Base URL (via Caddy): `http://localhost:8080/admin`
- Protected endpoints require header: `x-admin-token: <ADMIN_TOKEN>`
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

## Lifecycle Endpoints

### `POST /admin/install`

- Ensures XDG directories + OpenCode starter config + starter user secrets.
- Stages artifacts into `STATE_HOME`.
- Runs `docker compose up -d` using staged compose files and staged env file.

Response:

```json
{
  "ok": true,
  "started": ["caddy", "postgres", "qdrant", "openmemory", "openmemory-ui", "assistant", "guardian", "admin", "channel-chat"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" },
  "artifactsDir": "/home/user/.local/state/openpalm/artifacts"
}
```

### `POST /admin/update`

- Re-stages artifacts.
- Re-applies compose with staged overlays.

Response:

```json
{ "ok": true, "restarted": ["caddy", "guardian"], "dockerAvailable": true }
```

### `POST /admin/uninstall`

- Runs compose down.
- Marks in-memory services stopped and re-stages artifacts.

Response:

```json
{ "ok": true, "stopped": ["caddy", "assistant"], "dockerAvailable": true }
```

## Container Operations

### `GET /admin/containers/list`

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
{ "ok": true, "pulled": "...", "started": "..." }
```

Error responses:

- `503 docker_unavailable` — Docker is not reachable.
- `502 pull_failed` — `docker compose pull` failed.
- `502 up_failed` — Images pulled but container recreation failed.

### `POST /admin/containers/up`
### `POST /admin/containers/down`
### `POST /admin/containers/restart`

Body:

```json
{ "service": "channel-chat" }
```

Rules:

- Allowed core services:
  `assistant`, `guardian`, `openmemory`, `openmemory-ui`, `admin`, `caddy`, `postgres`, `qdrant`
- Allowed channel services: `channel-*` only if a matching staged
  `STATE_HOME/artifacts/channels/<name>.yml` exists.

Success response:

```json
{ "ok": true, "service": "channel-chat", "status": "running" }
```

## Channel Management

### `GET /admin/channels`

Returns staged-installed and registry-available channels:

```json
{
  "installed": [
    { "name": "chat", "hasRoute": true, "service": "channel-chat", "status": "running" }
  ],
  "available": [
    { "name": "discord", "hasRoute": false }
  ]
}
```

Notes:

- `installed` is derived from staged `STATE_HOME/artifacts/channels/*.yml`.
- `hasRoute` is derived from staged `STATE_HOME/artifacts/channels/public|lan/*.caddy`.

### `POST /admin/channels/install`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Copies registry files into `CONFIG_HOME/channels/`.
- Ensures system-managed channel secret exists.
- Re-stages artifacts and runs compose up.

### `POST /admin/channels/uninstall`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Removes channel `.yml` and optional `.caddy` from `CONFIG_HOME/channels/`.
- Removes system-managed channel secret from runtime state.
- Re-stages artifacts and stops the channel service.

## Access Scope

### `GET /admin/access-scope`

```json
{ "accessScope": "lan" }
```

Notes:

- Scope is derived from the system-managed core Caddyfile at
  `DATA_HOME/caddy/Caddyfile`.
- If the file contains user-edited IP ranges that don't match the known
  `host` or `lan` patterns, the response returns `"custom"`.

### `POST /admin/access-scope`

Body:

```json
{ "scope": "host" }
```

Accepted values: `"host"` or `"lan"`. The value `"custom"` is read-only —
it cannot be set via POST.

Behavior:

- Updates the `@denied not remote_ip ...` line in
  `DATA_HOME/caddy/Caddyfile`.
- Re-stages `STATE_HOME/artifacts/Caddyfile` and channel snippets.
- Attempts Caddy reload.

**Warning:** If the current scope is `"custom"` (user-edited IP ranges),
a POST to this endpoint will overwrite those custom ranges with the
standard `host` or `lan` pattern. Custom ranges cannot be restored via the
API after being overwritten — they must be re-applied by editing the
Caddyfile directly.

Response:

```json
{ "ok": true, "accessScope": "host" }
```

## Connections

Manage LLM provider credentials and related configuration stored in
`CONFIG_HOME/secrets.env`. Values are patched in-place by `patchSecretsEnvFile`
— existing keys not in the allowed set are never removed or overwritten.

### `GET /admin/connections`

Returns current values for all allowed connection keys, with secret API keys
masked (all but last 4 characters). Non-secret config keys (`GUARDIAN_LLM_PROVIDER`,
`GUARDIAN_LLM_MODEL`, `OPENMEMORY_OPENAI_BASE_URL`) are returned unmasked.

Response:

```json
{
  "connections": {
    "OPENAI_API_KEY": "*********************1234",
    "ANTHROPIC_API_KEY": "",
    "GROQ_API_KEY": "",
    "MISTRAL_API_KEY": "",
    "GOOGLE_API_KEY": "",
    "GUARDIAN_LLM_PROVIDER": "openai",
    "GUARDIAN_LLM_MODEL": "gpt-4o-mini",
    "OPENMEMORY_OPENAI_BASE_URL": "",
    "OPENMEMORY_OPENAI_API_KEY": ""
  }
}
```

Allowed keys (`ALLOWED_CONNECTION_KEYS`):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `GOOGLE_API_KEY`
- `GUARDIAN_LLM_PROVIDER`
- `GUARDIAN_LLM_MODEL`
- `OPENMEMORY_OPENAI_BASE_URL`
- `OPENMEMORY_OPENAI_API_KEY`

### `POST /admin/connections`

Patches one or more allowed keys into `CONFIG_HOME/secrets.env`. Keys not in
`ALLOWED_CONNECTION_KEYS` are silently ignored. Existing keys outside the
allowed set are preserved.

Body:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "GUARDIAN_LLM_PROVIDER": "anthropic"
}
```

Response:

```json
{ "ok": true, "updated": ["OPENAI_API_KEY", "GUARDIAN_LLM_PROVIDER"] }
```

Error responses:

- `400 bad_request` — No valid connection keys were provided.
- `500 internal_error` — Failed to write `secrets.env`.

### `GET /admin/connections/status`

Checks whether at least one LLM provider API key is configured. Returns the
list of required provider keys that are currently empty or absent.

Required provider keys (`REQUIRED_LLM_PROVIDER_KEYS`):
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_API_KEY`

Response:

```json
{ "complete": true, "missing": ["GROQ_API_KEY", "MISTRAL_API_KEY"] }
```

`complete` is `true` when at least one provider key is set; `false` when all are empty.

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

- Allowed names: `compose`, `caddyfile` (alias `caddy` accepted).
- Returns `text/plain` and may include `x-artifact-sha256` header.

### `GET /admin/audit?limit=<n>`

```json
{ "audit": [{ "at": "...", "action": "install", "ok": true }] }
```

## Installed Extensions and Gallery

### `GET /admin/installed`

```json
{
  "installed": ["plugin-memory-context"],
  "activeServices": { "assistant": "running" }
}
```

### Gallery routes

Implemented under `core/admin/src/routes/admin/gallery/**`:

- `GET /admin/gallery/search`
- `GET /admin/gallery/categories`
- `GET /admin/gallery/item/:id`
- `GET /admin/gallery/community`
- `POST /admin/gallery/community/refresh`
- `POST /admin/gallery/install`
- `POST /admin/gallery/uninstall`

## Automations (Cron Jobs)

Manage scheduled automation jobs. User-defined jobs live in
`CONFIG_HOME/automations.json`; system defaults live in
`DATA_HOME/automations.json`. Both are merged at staging time into
`STATE_HOME/artifacts/automations.json`.

### `GET /admin/automations`

Returns merged jobs, scheduler status, and next run times for enabled jobs.

```json
{
  "jobs": [
    {
      "id": "daily-summary",
      "name": "Daily Summary",
      "schedule": "0 9 * * *",
      "prompt": "Give me a summary of system events...",
      "enabled": true,
      "source": "user"
    },
    {
      "id": "system-health-check",
      "name": "System Health Check",
      "schedule": "0 */6 * * *",
      "prompt": "Run a health check...",
      "enabled": true,
      "source": "system",
      "description": "Periodic health monitoring"
    }
  ],
  "schedulerActive": true,
  "nextRuns": {
    "daily-summary": "2026-03-01T09:00:00.000Z",
    "system-health-check": "2026-02-28T18:00:00.000Z"
  }
}
```

### `POST /admin/automations`

Create a new user-defined automation job.

Body:

```json
{
  "id": "weekly-cleanup",
  "name": "Weekly Cleanup",
  "schedule": "0 2 * * 0",
  "prompt": "Review and clean up outdated memories.",
  "enabled": true,
  "description": "Optional description",
  "timeoutMs": 300000
}
```

Rules:
- `id`: lowercase alphanumeric + hyphens, 1-63 chars, must start with alnum.
- `schedule`: standard 5-field cron expression (minute hour dom month dow).
- `timeoutMs`: optional, minimum 1000ms, default 120000ms.
- Duplicate IDs are rejected.

Response:

```json
{ "ok": true, "job": { ... } }
```

### `GET /admin/automations/:id`

Returns a single job and its most recent execution.

```json
{
  "job": { "id": "daily-summary", ... },
  "lastRun": { "at": "...", "jobId": "daily-summary", "ok": true, ... },
  "nextRun": "2026-03-01T09:00:00.000Z"
}
```

### `PATCH /admin/automations/:id`

Update a job. For user-source jobs, any field except `id` can be updated.
For system-source jobs, an override entry is created in
`CONFIG_HOME/automations.json` — the merge logic applies user overrides
without modifying `DATA_HOME/automations.json`.

Body (all fields optional):

```json
{
  "name": "New Name",
  "schedule": "0 10 * * *",
  "prompt": "Updated prompt",
  "enabled": false,
  "description": "Updated description",
  "timeoutMs": 60000
}
```

Response:

```json
{ "ok": true, "job": { ... } }
```

### `DELETE /admin/automations/:id`

Delete a user-defined job. System-managed jobs cannot be deleted — use
PATCH to disable them instead.

Response:

```json
{ "ok": true, "deleted": "job-id" }
```

Error: `400` if the job is system-managed.

### `POST /admin/automations/:id/run`

Manually trigger a job immediately, regardless of its schedule or
enabled state.

Response:

```json
{
  "ok": true,
  "run": {
    "at": "2026-02-28T15:30:00.000Z",
    "jobId": "daily-summary",
    "jobName": "Daily Summary",
    "trigger": "manual",
    "sessionId": "abc123",
    "durationMs": 5432,
    "ok": true,
    "responsePreview": "All services are running..."
  }
}
```

### `GET /admin/automations/history`

Returns recent execution history from the in-memory ring buffer.

Query params:
- `limit` — max entries (default 50, max 200)
- `jobId` — filter to a specific job ID

```json
{
  "history": [
    {
      "at": "2026-02-28T12:00:00.000Z",
      "jobId": "system-health-check",
      "jobName": "System Health Check",
      "trigger": "scheduled",
      "sessionId": "sess-456",
      "durationMs": 8200,
      "ok": true,
      "responsePreview": "All 8 services healthy..."
    }
  ]
}
```

## Not Implemented

The following endpoints are not present in current route code:

- `/admin/setup/*`
- `/admin/gallery/npm-search`
