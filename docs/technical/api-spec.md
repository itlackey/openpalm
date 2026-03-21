# OpenPalm Admin API Spec (Current Implementation)

This document describes the Admin API routes currently implemented in
`packages/admin/src/routes/**/+server.ts`.

## Conventions

- Base URL: `http://localhost:8100`
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

## Lifecycle Endpoints

Policy for this section:

- `config/` is the user-owned persistent source of truth.
- `POST /admin/install`, `POST /admin/update`, and startup auto-apply are
  automatic lifecycle operations: non-destructive for existing user config files
  in `config/`; they only seed missing defaults.
- Explicit mutation endpoints (`POST /admin/connections`,
  `POST /admin/channels/install`, `POST /admin/channels/uninstall`,
  `POST /admin/setup`) are the allowed write path
  for requested config changes.

### `POST /admin/install`

- Ensures directories + OpenCode starter config + starter user secrets.
- Seeds only missing defaults in `config/`; never overwrites existing user files.
- Writes configuration files to their final locations.
- Runs `docker compose up -d` using compose files and env files.

Response:

```json
{
  "ok": true,
  "started": ["memory", "assistant", "guardian", "admin", "channel-chat"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" },
  "artifactsDir": "/home/user/.openpalm/data"
}
```

### `POST /admin/update`

- Non-destructive for existing user config; seeds missing defaults only.
- Writes configuration files to their final locations.
- Re-applies compose with component overlays.

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
{ "service": "channel-chat" }
```

Rules:

- Allowed core services:
  `assistant`, `guardian`, `memory`, `admin`
- Allowed channel services: `channel-*` only if a matching component directory
  exists in `config/components/`.

Success response:

```json
{ "ok": true, "service": "channel-chat", "status": "running" }
```

## Channel Management

### `GET /admin/channels`

Returns installed and registry-available channels:

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

- `installed` is derived from component directories in `config/components/`.
- `hasRoute` indicates whether the component has an HTTP route configured.

### `POST /admin/channels/install`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Copies registry files into `config/components/`.
- Ensures system-managed channel secret exists.
- Runs compose up.

Response:

```json
{
  "ok": true,
  "channel": "chat",
  "service": "channel-chat",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

### `POST /admin/channels/uninstall`

Body:

```json
{ "channel": "chat" }
```

Behavior:

- Removes component directory from `config/components/`.
- Removes system-managed channel secret from runtime state.
- Stops the channel service.

Response:

```json
{
  "ok": true,
  "channel": "chat",
  "service": "channel-chat",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

## Registry

Unified registry for channels and automations. Add-on definitions live in `.openpalm/stack/addons/` and automations in `.openpalm/config/automations/`. These are bundled into the admin image at build time.

### `GET /admin/registry`

Lists all registry items (channels and automations) with install status.

Response:

```json
{
  "channels": [
    { "name": "chat", "type": "channel", "installed": true, "hasRoute": true, "description": "..." }
  ],
  "automations": [
    { "name": "daily-summary", "type": "automation", "installed": false, "description": "...", "schedule": "0 9 * * *" }
  ],
  "source": "remote"
}
```

`source` indicates where the registry data was loaded from (e.g. `"bundled"` when
using build-time bundled stack assets).

### `POST /admin/registry/install`

Install a registry item (channel or automation).

Body:

```json
{ "name": "chat", "type": "channel" }
```

- `name` (required) — Must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- `type` (required) — Must be `"channel"` or `"automation"`.

For channels: copies component files into `config/components/`,
generates HMAC secret, and runs compose up.

For automations: copies `.yml` into `config/automations/` and reloads
the scheduler.

Response (channel):

```json
{
  "ok": true,
  "name": "chat",
  "type": "channel",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

Response (automation):

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

Error responses:

- `400 invalid_input` — Invalid name, invalid type, item not found in registry,
  or item already installed.

### `POST /admin/registry/refresh`

Refreshes the registry index from bundled stack assets.

Response:

```json
{ "ok": true, "updated": true }
```

Error responses:

- `500 registry_sync_error` — Refresh failed.

### `POST /admin/registry/uninstall`

Uninstall a registry item (channel or automation).

Body:

```json
{ "name": "chat", "type": "channel" }
```

For channels: removes component directory from `config/components/`, clears channel secret,
and stops the Docker service.

For automations: removes `.yml` from `config/automations/` and reloads
the scheduler.

Response (channel):

```json
{
  "ok": true,
  "name": "chat",
  "type": "channel",
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

Response (automation):

```json
{ "ok": true, "name": "daily-summary", "type": "automation" }
```

## Automations

### `GET /admin/automations`

Lists all automation configs with scheduler status and
execution logs.

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
      "fileName": "daily-summary.yml",
      "logs": []
    }
  ],
  "scheduler": {
    "running": true,
    "jobCount": 1
  }
}
```

## Connections

Manage LLM provider credentials and related configuration stored in
`vault/user/user.env`. Values are patched in-place by `patchSecretsEnvFile`
-- existing keys not in the allowed set are never removed or overwritten.

### `GET /admin/connections`

Returns the canonical v1 DTO plus a compatibility `connections` map.

- `profiles` contains canonical connection profiles (`openai_compatible_remote` or `openai_compatible_local`).
- `assignments` contains canonical required-capability assignments (`llm`, `embeddings`).
- `connections` preserves the legacy masked key/value response for existing clients.

Response:

```json
{
  "profiles": [
    {
      "id": "primary",
      "name": "Primary connection",
      "kind": "openai_compatible_remote",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "auth": {
        "mode": "api_key",
        "apiKeySecretRef": "env:OPENAI_API_KEY"
      }
    }
  ],
  "assignments": {
    "llm": {
      "connectionId": "primary",
      "model": "gpt-4.1-mini"
    },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  },
  "connections": {
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

Allowed keys (`ALLOWED_CONNECTION_KEYS`):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `GOOGLE_API_KEY`
- `SYSTEM_LLM_PROVIDER`
- `SYSTEM_LLM_BASE_URL`
- `SYSTEM_LLM_MODEL`
- `OPENAI_BASE_URL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMS`
- `MEMORY_USER_ID`

### `POST /admin/connections`

Supports three payload shapes:

1) **Canonical DTO (preferred)**

```json
{
  "profiles": [
    {
      "id": "primary",
      "name": "Primary connection",
      "kind": "openai_compatible_remote",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "auth": { "mode": "api_key" }
    }
  ],
  "assignments": {
    "llm": { "connectionId": "primary", "model": "gpt-4.1-mini" },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  },
  "memoryUserId": "default_user",
  "customInstructions": "",
  "memoryModel": ""
}
```

2) **Unified save (has `provider` key)**

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "baseUrl": "",
  "systemModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDims": 1536,
  "memoryUserId": "default_user",
  "customInstructions": "",
  "capabilities": ["llm", "embeddings"]
}
```

3) **Legacy key patch (compatibility)**

Patches one or more allowed keys into `vault/user/user.env`. Keys not in
`ALLOWED_CONNECTION_KEYS` are silently ignored. Existing keys outside the
allowed set are preserved.

```json
{
  "OPENAI_API_KEY": "sk-...",
  "SYSTEM_LLM_PROVIDER": "anthropic"
}
```

Response (canonical DTO and unified save paths):

```json
{
  "ok": true,
  "pushed": true,
  "pushError": null,
  "dimensionWarning": null,
  "dimensionMismatch": false
}
```

Response (legacy key patch path):

```json
{ "ok": true, "updated": ["OPENAI_API_KEY", "SYSTEM_LLM_PROVIDER"] }
```

Error responses:

- `400 bad_request` -- No valid connection keys were provided.
- `500 internal_error` -- Failed to write `vault/user/user.env`.

### `GET /admin/connections/status`

Checks whether the system LLM connection is configured. Returns `complete: true`
when both `SYSTEM_LLM_PROVIDER` and `SYSTEM_LLM_MODEL` are set. API keys are
never required (optional for all providers).

Response:

```json
{ "complete": true, "missing": [] }
```

`complete` is `true` when provider and model are set; `false` with `missing` listing what's absent.

### `POST /admin/connections/test`

Tests a connection endpoint by fetching models from the given base URL. Derives
the provider type from the URL (Ollama for URLs containing `ollama` or `:11434`,
otherwise OpenAI-compatible). Accepts setup token or admin token.

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

### `GET /admin/connections/profiles`

Returns canonical connection profiles from `config/connections/profiles.json`.

```json
{
  "profiles": [
    {
      "id": "primary",
      "name": "Primary connection",
      "kind": "openai_compatible_remote",
      "provider": "openai",
      "baseUrl": "https://api.openai.com",
      "auth": {
        "mode": "api_key",
        "apiKeySecretRef": "env:OPENAI_API_KEY"
      }
    }
  ]
}
```

### `POST /admin/connections/profiles`

Create a profile.

```json
{
  "profile": {
    "id": "local-lmstudio",
    "name": "LM Studio",
    "kind": "openai_compatible_local",
    "provider": "lmstudio",
    "baseUrl": "http://host.docker.internal:1234",
    "auth": { "mode": "none" }
  }
}
```

When `auth.mode` is `"api_key"`, the profile payload may include a top-level
`apiKey` field with the raw key. The handler derives the `apiKeySecretRef`
from the provider and patches the key into `vault/user/user.env`.

### `PUT /admin/connections/profiles`

Update an existing profile by id (id provided inside `profile` object).

### `DELETE /admin/connections/profiles`

Delete by id:

```json
{ "id": "local-lmstudio" }
```

Error responses:

- `400 bad_request` -- malformed profile payload.
- `404 not_found` -- profile id not found.
- `409 conflict` -- duplicate create or profile currently referenced by assignments.

### `GET /admin/connections/profiles/:id`

Returns a single profile by URL parameter id.

```json
{
  "profile": {
    "id": "primary",
    "name": "Primary connection",
    "kind": "openai_compatible_remote",
    "provider": "openai",
    "baseUrl": "https://api.openai.com",
    "auth": {
      "mode": "api_key",
      "apiKeySecretRef": "env:OPENAI_API_KEY"
    }
  }
}
```

Error responses:

- `404 not_found` -- profile id not found.

### `PUT /admin/connections/profiles/:id`

Update a profile by URL parameter id. The `id` from the URL takes precedence
over any id in the request body.

Body:

```json
{
  "profile": {
    "name": "Updated Name",
    "kind": "openai_compatible_local",
    "provider": "ollama",
    "baseUrl": "http://host.docker.internal:11434",
    "auth": { "mode": "none" }
  }
}
```

Response:

```json
{ "ok": true, "profile": { "id": "primary", "..." : "..." } }
```

### `DELETE /admin/connections/profiles/:id`

Delete a profile by URL parameter id. No request body needed.

Response:

```json
{ "ok": true, "id": "primary" }
```

Error responses:

- `404 not_found` -- profile id not found.
- `409 conflict` -- profile currently referenced by assignments.

### `GET /admin/connections/assignments`

Returns canonical capability assignments:

```json
{
  "assignments": {
    "llm": { "connectionId": "primary", "model": "gpt-4.1-mini" },
    "embeddings": {
      "connectionId": "primary",
      "model": "text-embedding-3-small",
      "embeddingDims": 1536
    }
  }
}
```

### `POST /admin/connections/assignments`

Save canonical assignments. Also writes the OpenCode provider config as a
side effect. If any `connectionId` does not exist in profiles, returns
`409 conflict`.

Response:

```json
{ "ok": true, "assignments": { "llm": { "..." : "..." }, "embeddings": { "..." : "..." } } }
```

### `GET /admin/connections/export/mem0`

Exports the compatibility-formatted memory config derived from current
connection profiles and assignments. The route name remains `export/mem0`
for backward compatibility, but the generated file configures OpenPalm's
Bun-based memory service.

Returns the config as a downloadable JSON file (`mem0-config.json`).

Auth: admin token or setup token.

Response: `application/json` with `Content-Disposition: attachment; filename="mem0-config.json"`.

Error responses:

- `404 not_found` -- No connection profiles found.
- `409 conflict` -- LLM or embeddings connection profile not found.

### `GET /admin/connections/export/opencode`

Exports the generated `opencode.json` config from `config/assistant/opencode.json`.
Returns the config as a downloadable JSON file with `_nextSteps` guidance.

Auth: admin token or setup token.

Response: `application/json` with `Content-Disposition: attachment; filename="opencode.json"`.

Error responses:

- `404 not_found` -- opencode.json has not been generated yet.
- `500 internal_error` -- Failed to read opencode.json.

### Setup-token route variants

During setup (or with admin token), the same handlers are available at:

- `GET/POST/PUT/DELETE /admin/setup/connections/profiles`
- `GET/POST /admin/setup/connections/assignments`

These routes use setup-token compatible auth and preserve the same payload and
error semantics as their `/admin/connections/*` counterparts.

## Memory Configuration

Manage the Memory service LLM and embedding provider configuration stored at
`data/memory/default_config.json`. The persisted file still uses a
mem0-shaped JSON schema for compatibility, but the running service is the
OpenPalm Bun-based memory API backed by SQLite and `sqlite-vec`.

Changes are persisted to disk and pushed to the running Memory container via
its REST API (`PUT /api/v1/config/`).

### `GET /admin/memory/config`

Returns the persisted config, the live runtime config (if reachable), provider
lists, and known embedding dimension mappings.

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
  "runtimeConfig": null,
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

Saves a full Memory config to disk and pushes it to the running container.

Body: A complete `MemoryConfig` object (same shape as `config` in the GET response).

Response:

```json
{
  "ok": true,
  "persisted": true,
  "pushed": true,
  "pushError": null,
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
  `process.env` then `vault/user/user.env`.
- `baseUrl` -- Provider API base URL. Falls back to provider defaults when empty.

Provider API conventions:

| Provider | URL Pattern | Auth |
| -------- | ----------- | ---- |
| Ollama | `{baseUrl}/api/tags` | None |
| Anthropic | Static list (no API) | N/A |
| OpenAI, Groq, Mistral, Together, DeepSeek, xAI, LM Studio, Model Runner | `{baseUrl}/v1/models` | `Bearer {key}` (optional) |

Response:

```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "error": null }
```

On failure (unreachable provider, timeout, etc.):

```json
{ "models": [], "error": "Request timed out after 5s" }
```

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

Run varlock environment validation against `vault/user/user.env` using the
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

### `GET /admin/audit?limit=<n>`

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
