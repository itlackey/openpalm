# OpenPalm Admin API Spec (Current Implementation)

This document describes the Admin API routes currently implemented in
`packages/admin/src/routes/**/+server.ts`.

## Conventions

- Base URL: `http://localhost:3880`
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

Auth: Protected by admin token (`x-admin-token`) when `OP_ADMIN_TOKEN` is set.
When no admin token is configured (dev/LAN), the endpoint is open.

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
- Explicit mutation endpoints (`POST /admin/connections`,
  `POST /admin/addons`, `POST /admin/addons/:name`,
  `POST /admin/setup`) are the allowed write path
  for requested config changes.

### `POST /admin/install`

- Ensures directories + OpenCode starter config + starter user secrets.
- Seeds only missing defaults in `config/`; never overwrites existing user files.
- Writes configuration files to their final locations.
- Runs `docker compose up -d` using `stack/core.compose.yml`, installed addon overlays, and vault env files.

Response:

```json
{
  "ok": true,
  "started": ["memory", "assistant", "guardian", "admin", "chat"],
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
images, and recreates all containers. After responding, schedules a deferred
self-recreation of the admin container so the HTTP response is flushed first.

Response:

```json
{
  "ok": true,
  "imageTag": "0.9.0",
  "backupDir": "/home/user/.openpalm/backups/2025-01-01T00-00-00",
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
{ "ok": true, "pulled": "...", "started": ["memory", "assistant", "guardian"] }
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
  `assistant`, `guardian`, `memory`, `scheduler`, `admin`
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

Checks inter-container connectivity by probing each core service health endpoint from within the admin container.

Auth: `requireAuth`

Response:

```json
{
  "results": {
    "guardian": { "status": "reachable", "latencyMs": 12 },
    "memory": { "status": "reachable", "latencyMs": 8 },
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

- `name` (required) -- Addon name (must exist under `registry/addons/<name>/compose.yml`).
- `enabled` (optional) -- Set to `true` or `false` to enable/disable.

Response:

```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

Error responses:

- `400 bad_request` -- `name` is missing.
- `404 not_found` -- Addon name is not available in `registry/addons/`.
- `500 internal_error` -- Failed to update addon state on disk.

### `GET /admin/addons/:name`

Returns detail for a single addon.

Response:

```json
{ "name": "chat", "enabled": true }
```

Error responses:

- `404 not_found` -- Addon name is not available in `registry/addons/`.

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

- `404 not_found` -- Addon name is not available in `registry/addons/`.
- `500 internal_error` -- Failed to update addon state on disk.

## Registry

Unified registry for automations. Channel/addon management is handled by `/admin/addons` endpoints against `registry/addons/` and active `stack/addons/`.

### `GET /admin/registry`

Lists available registry automations with install status. Channel addons are
managed via `/admin/addons`. Reads from `~/.openpalm/registry/automations/`.

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

### `POST /admin/registry/install`

Install a registry automation. Channel addons are managed via
`POST /admin/addons/:name`.

Body:

```json
{ "name": "daily-summary", "type": "automation" }
```

- `name` (required) -- Must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- `type` (required) -- Must be `"automation"`. Passing `"channel"` returns 400.

Copies the `.yml` into `config/automations/` and refreshes runtime files.
The scheduler sidecar auto-reloads via file watching.

Response:

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

Error responses:

- `400 invalid_input` -- Invalid name, type is not `"automation"`, item not
  found in registry, or item already installed.

### `POST /admin/registry/refresh`

Refreshes the registry index from the configured registry source.

Response:

```json
{ "ok": true, "updated": true }
```

Error responses:

- `500 registry_sync_error` — Refresh failed.

### `POST /admin/registry/uninstall`

Uninstall a registry automation. Channel addons are managed via
`POST /admin/addons/:name`.

Body:

```json
{ "name": "daily-summary", "type": "automation" }
```

- `name` (required) -- Automation name.
- `type` (required) -- Must be `"automation"`. Passing `"channel"` returns 400.

Removes the `.yml` from `config/automations/` and refreshes runtime files.
The scheduler sidecar auto-reloads via file watching.

Response:

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

## Automations

### `GET /admin/automations`

Lists all automation configs from `config/automations/`.

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

## Connections

Manage LLM provider credentials and related configuration stored in
`vault/stack/stack.env`. Values are patched in-place by `patchSecretsEnvFile`
-- existing keys not in the allowed set are never removed or overwritten.

### `GET /admin/connections`

Returns the current capability assignments from `stack.yml` and masked secret
values from `vault/stack/stack.env`.

Response:

```json
{
  "capabilities": {
    "llm": "openai/gpt-4o-mini",
    "embeddings": { "provider": "openai", "model": "text-embedding-3-small", "dims": 1536 },
    "memory": { "userId": "default_user" }
  },
  "secrets": {
    "OPENAI_API_KEY": "*********************1234",
    "ANTHROPIC_API_KEY": "",
    "GROQ_API_KEY": "",
    "MISTRAL_API_KEY": "",
    "GOOGLE_API_KEY": "",
    "SYSTEM_LLM_PROVIDER": "openai",
    "SYSTEM_LLM_BASE_URL": "",
    "SYSTEM_LLM_MODEL": "gpt-4o-mini",
    "OPENAI_BASE_URL": "",
    "EMBEDDING_MODEL": "text-embedding-3-small",
    "EMBEDDING_DIMS": "1536",
    "MEMORY_USER_ID": "default_user"
  }
}
```

### `POST /admin/connections`

Saves provider credentials to `vault/stack/stack.env`, updates `stack.yml`
capabilities.

Body:

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "baseUrl": "",
  "systemModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDims": 1536,
  "memoryUserId": "default_user",
  "customInstructions": ""
}
```

- `provider` (required) -- Must be a supported provider name.
- `apiKey` -- API key to write to `vault/stack/stack.env`.
- `baseUrl` -- Provider base URL.
- `systemModel` -- Model name for the LLM capability.
- `embeddingModel` -- Model name for the embeddings capability.
- `embeddingDims` -- Embedding dimensions (falls back to known defaults or 1536).
- `memoryUserId` -- User ID for memory capability (default `"default_user"`).
- `customInstructions` -- Custom instructions for memory.

Response:

```json
{
  "ok": true,
  "dimensionWarning": null,
  "dimensionMismatch": false
}
```

Error responses:

- `400 bad_request` -- `provider` is missing or not in scope.
- `500 internal_error` -- Failed to write `vault/stack/stack.env` or `stack.yml`.

### `GET /admin/connections/status`

Checks whether `stack.yml` has non-empty capability assignments for the
system LLM and embeddings provider/model. Leading and trailing whitespace is
ignored during the completeness check. API keys are not required here.

Response:

```json
{ "complete": true, "missing": [] }
```

`complete` is `true` when `capabilities.llm` and `capabilities.embeddings.provider/model`
are non-empty strings after trimming; otherwise `missing` lists what is absent.

### `POST /admin/connections/test`

Tests a connection endpoint by fetching models from the given base URL. Derives
the provider type from the URL (Ollama for URLs containing `ollama` or `:11434`,
otherwise OpenAI-compatible).

Auth: `requireAdmin`

Body:

```json
{
  "baseUrl": "http://host.docker.internal:11434",
  "apiKey": "",
  "kind": "openai_compatible_local"
}
```

- `baseUrl` (required) -- The endpoint to test.
- `apiKey` -- Optional API key for authentication.
- `kind` -- Connection kind hint (informational).

Response:

```json
{
  "ok": true,
  "models": ["llama3.2:3b", "nomic-embed-text"],
  "error": null,
  "errorCode": null
}
```

On failure:

```json
{
  "ok": false,
  "error": "Connection refused",
  "errorCode": "connection_error"
}
```

### `GET /admin/connections/assignments`

Returns the current `stack.yml` capability assignments:

```json
{
  "capabilities": {
    "llm": "openai/gpt-4.1-mini",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dims": 1536
    },
    "memory": {
      "userId": "default_user",
      "customInstructions": ""
    }
  }
}
```

### `POST /admin/connections/assignments`

Saves validated capability updates back to `stack.yml`. The request body may either be the capabilities
object directly or `{ "capabilities": ... }`.

Supported top-level keys are `llm`, `slm`, `embeddings`, `memory`, `tts`,
`stt`, and `reranking`. Unknown keys are rejected with `400 bad_request`.

Example body:

```json
{
  "capabilities": {
    "llm": "anthropic/claude-sonnet-4",
    "embeddings": {
      "provider": "google",
      "model": "text-embedding-004",
      "dims": 768
    },
    "memory": {
      "userId": "owner",
      "customInstructions": "Keep it concise."
    }
  }
}
```

Response:

```json
{ "ok": true, "capabilities": { "llm": "anthropic/claude-sonnet-4", "..." : "..." } }
```

Error responses:

- `400 bad_request` -- malformed capability payload, unknown keys, or invalid field types.
- `500 internal_error` -- `stack.yml` could not be written.

### `GET /admin/connections/export/mem0`

Exports the compatibility-formatted memory config derived from current
`stack.yml` capabilities. The route name remains `export/mem0`
for backward compatibility, but the generated file configures OpenPalm's
Bun-based memory service.

Returns the config as a downloadable JSON file (`mem0-config.json`).

Auth: `requireAdmin`

Response: `application/json` with `Content-Disposition: attachment; filename="mem0-config.json"`.

Error responses:

- `404 not_found` -- No stack configuration found.

### `GET /admin/connections/export/opencode`

Exports the generated `opencode.json` config from `config/assistant/opencode.json`.
Returns the config as a downloadable JSON file with `_nextSteps` guidance.

Auth: `requireAdmin`

Response: `application/json` with `Content-Disposition: attachment; filename="opencode.json"`.

Error responses:

- `404 not_found` -- opencode.json has not been generated yet.
- `500 internal_error` -- Failed to read opencode.json.

## Memory Configuration

Manage the Memory service LLM and embedding provider configuration stored at
`data/memory/default_config.json`. The persisted file still uses a
mem0-shaped JSON schema for compatibility, but the running service is the
OpenPalm Bun-based memory API backed by SQLite and `sqlite-vec`.

Changes are persisted to disk.

### `GET /admin/memory/config`

Returns the persisted config, provider lists, and known embedding dimension mappings.

Response:

```json
{
  "config": {
    "mem0": {
      "llm": { "provider": "openai", "config": { "model": "gpt-4o-mini", "temperature": 0.1, "max_tokens": 2000, "api_key": "env:OPENAI_API_KEY" } },
      "embedder": { "provider": "openai", "config": { "model": "text-embedding-3-small", "api_key": "env:OPENAI_API_KEY" } },
      "vector_store": { "provider": "sqlite-vec", "config": { "collection_name": "memory", "db_path": "/data/memory.db", "embedding_model_dims": 1536 } }
    },
    "memory": { "custom_instructions": "" }
  },
  "providers": {
    "llm": ["openai", "anthropic", "ollama", "groq", "together", "mistral", "deepseek", "xai", "lmstudio", "model-runner"],
    "embed": ["openai", "ollama", "huggingface", "lmstudio"]
  },
  "embeddingDims": {
    "openai/text-embedding-3-small": 1536,
    "ollama/nomic-embed-text": 768
  }
}
```

### `POST /admin/memory/config`

Saves a full Memory config to disk.

Body: A complete `MemoryConfig` object (same shape as `config` in the GET response).

Response:

```json
{
  "ok": true,
  "persisted": true,
  "dimensionWarning": null,
  "dimensionMismatch": false
}
```

- `dimensionMismatch` is `true` when the new config's embedding dimensions
  differ from the previously persisted config. Requires a vector-store reset.
- `dimensionWarning` is a human-readable message when `dimensionMismatch` is `true`.

Error responses:

- `400 bad_request` -- Missing or invalid memory config structure.

### `POST /admin/memory/models`

Proxy endpoint for listing available models from a provider's API. Resolves
`env:` API key references server-side before making the upstream request.

Body:

```json
{
  "provider": "ollama",
  "apiKeyRef": "env:OPENAI_API_KEY",
  "baseUrl": "http://host.docker.internal:11434"
}
```

- `provider` (required) -- Must be a recognized LLM or embedding provider name.
- `apiKeyRef` -- Raw API key or `env:VAR_NAME` reference resolved from
  `process.env` then `vault/stack/stack.env`.
- `baseUrl` -- Provider API base URL. Falls back to provider defaults when empty.

Provider API conventions:

| Provider | URL Pattern | Auth |
| -------- | ----------- | ---- |
| Ollama | `{baseUrl}/api/tags` | None |
| Anthropic | Static list (no API) | N/A |
| OpenAI, Groq, Mistral, Together, DeepSeek, xAI, LM Studio, Model Runner | `{baseUrl}/v1/models` | `Bearer {key}` (optional) |

Response:

```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "status": "ok", "reason": "provider_api", "error": null }
```

On failure (unreachable provider, timeout, etc.):

```json
{ "models": [], "status": "recoverable_error", "reason": "network", "error": "Request timed out after 5s" }
```

`status` is `"ok"` on success or `"recoverable_error"` when the provider could not be reached.
`reason` indicates how the model list was obtained: `"provider_api"` (live fetch),
`"provider_static"` (built-in list, e.g. Anthropic), or on error: `"network"`, `"auth"`, `"parse"`, or `"unknown"`.

Error responses:

- `400 bad_request` -- Invalid or missing provider name.

### `POST /admin/memory/reset-collection`

Deletes the configured vector store data so the memory service recreates it
with the correct embedding dimensions on next restart. In the current default
configuration this removes the SQLite database and companion WAL/SHM files; it
also removes any legacy Qdrant directory if one exists. This is a destructive
operation that deletes all stored memories.

Response:

```json
{
  "ok": true,
  "collection": "memory",
  "restartRequired": true
}
```

The memory container must be restarted after a successful reset for the new
collection to be created.

Error responses:

- `502 collection_reset_failed` -- Failed to delete the configured vector-store data.

### Ollama Integration Notes

When using Ollama as the LLM or embedding provider with Memory:

1. **Config key**: The Ollama provider expects `ollama_base_url` (not `base_url`)
   in the mem0 config. The admin UI handles this automatically.

2. **Docker networking**: On Linux hosts, containers need
   `extra_hosts: ["host.docker.internal:host-gateway"]` in docker-compose.yml
   to reach `http://host.docker.internal:11434`. Docker Desktop (Mac/Windows)
   adds this automatically.

3. **Embedding dimensions**: The configured vector store must use
   `embedding_model_dims` matching the embedding model's output dimensions
   (e.g., 1024 for `qwen3-embedding:0.6b`, 768 for `nomic-embed-text`).
   A dimension mismatch causes silent insert failures.

4. **Model compatibility**: Models that use `<think>` tags (e.g., qwen3:4b)
   can break mem0's JSON fact extraction parser. Use models without thinking
   mode (e.g., `qwen2.5:14b`) for the LLM provider. Embedding models are
   unaffected.

## Configuration Endpoints

### `GET /admin/config/validate`

Run varlock environment validation against `vault/stack/stack.env` using the
bundled schema. Always returns 200; validation failures
are non-fatal and are logged to the audit trail.

**Authentication:** Required (`x-admin-token`)

**Response:**

```json
{ "ok": true, "errors": [], "warnings": [] }
```

When validation finds issues:

```json
{
  "ok": false,
  "errors": ["ERROR: ADMIN_TOKEN is required but not set"],
  "warnings": ["WARN: OPENAI_BASE_URL is not a valid URL"]
}
```

**Error responses:**

- `401 unauthorized` — Missing or invalid `x-admin-token`.

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
{ "status": "ready", "url": "http://localhost:3881/" }
```

When unreachable:

```json
{ "status": "unavailable", "url": "http://localhost:3881/" }
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
- `500 internal_error` -- Failed to write API key to vault.

### `GET /admin/opencode/providers/:id/models`

Lists available models for a specific provider.

Auth: `requireAdmin`

Response:

```json
{ "models": [{ "id": "claude-sonnet-4", "name": "Claude Sonnet 4" }] }
```

Error responses:

- `404 not_found` -- Provider not found.

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
