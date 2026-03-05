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
  "started": ["caddy", "openmemory", "openmemory-ui", "assistant", "guardian", "admin", "channel-chat"],
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
  `assistant`, `guardian`, `openmemory`, `openmemory-ui`, `admin`, `caddy`
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
masked (all but last 4 characters). Non-secret config keys (`SYSTEM_LLM_PROVIDER`,
`SYSTEM_LLM_MODEL`, `SYSTEM_LLM_BASE_URL`, `OPENAI_BASE_URL`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMS`, `OPENMEMORY_USER_ID`) are returned unmasked.

Response:

```json
{
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
    "OPENMEMORY_USER_ID": "default_user"
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
- `OPENMEMORY_USER_ID`

### `POST /admin/connections`

Patches one or more allowed keys into `CONFIG_HOME/secrets.env`. Keys not in
`ALLOWED_CONNECTION_KEYS` are silently ignored. Existing keys outside the
allowed set are preserved.

Body:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "SYSTEM_LLM_PROVIDER": "anthropic"
}
```

Response:

```json
{ "ok": true, "updated": ["OPENAI_API_KEY", "SYSTEM_LLM_PROVIDER"] }
```

Error responses:

- `400 bad_request` — No valid connection keys were provided.
- `500 internal_error` — Failed to write `secrets.env`.

### `GET /admin/connections/status`

Checks whether the system LLM connection is configured. Returns `complete: true`
when both `SYSTEM_LLM_PROVIDER` and `SYSTEM_LLM_MODEL` are set. API keys are
never required (optional for all providers).

Response:

```json
{ "complete": true, "missing": [] }
```

`complete` is `true` when provider and model are set; `false` with `missing` listing what's absent.

## OpenMemory Configuration

Manage the OpenMemory (mem0) LLM and embedding provider configuration stored
at `DATA_HOME/openmemory/default_config.json`. Changes are persisted to disk
and optionally pushed to the running OpenMemory container via its REST API.

### `GET /admin/openmemory/config`

Returns the persisted config, the live runtime config (if reachable), provider
lists, and known embedding dimension mappings.

Response:

```json
{
  "config": {
    "mem0": {
      "llm": { "provider": "openai", "config": { "model": "gpt-4o-mini", "temperature": 0.1, "max_tokens": 2000, "api_key": "env:OPENAI_API_KEY" } },
      "embedder": { "provider": "openai", "config": { "model": "text-embedding-3-small", "api_key": "env:OPENAI_API_KEY" } },
      "vector_store": { "provider": "qdrant", "config": { "collection_name": "openmemory", "path": "/data/qdrant", "embedding_model_dims": 1536 } }
    },
    "openmemory": { "custom_instructions": "" }
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

### `POST /admin/openmemory/config`

Saves a full OpenMemory config to disk and pushes it to the running container.

Body: A complete `OpenMemoryConfig` object (same shape as `config` in the GET response).

Response:

```json
{ "ok": true, "persisted": true, "pushed": true }
```

Error responses:

- `400 bad_request` — Missing or invalid `mem0` structure.

### `POST /admin/openmemory/models`

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

- `provider` (required) — Must be a recognized LLM or embedding provider name.
- `apiKeyRef` — Raw API key or `env:VAR_NAME` reference resolved from
  `process.env` then `CONFIG_HOME/secrets.env`.
- `baseUrl` — Provider API base URL. Falls back to provider defaults when empty.

Provider API conventions:

| Provider | URL Pattern | Auth |
| -------- | ----------- | ---- |
| Ollama | `{baseUrl}/api/tags` | None |
| Anthropic | Static list (no API) | N/A |
| OpenAI, Groq, Mistral, Together, DeepSeek, xAI, LM Studio, Model Runner | `{baseUrl}/v1/models` | `Bearer {key}` (optional) |

Response:

```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "error": undefined }
```

On failure (unreachable provider, timeout, etc.):

```json
{ "models": [], "error": "Request timed out after 5s" }
```

Error responses:

- `400 bad_request` — Invalid or missing provider name.

### Ollama Integration Notes

When using Ollama as the LLM or embedding provider with OpenMemory:

1. **Config key**: The Ollama provider expects `ollama_base_url` (not `base_url`)
   in the mem0 config. The admin UI handles this automatically.

2. **Docker networking**: On Linux hosts, containers need
   `extra_hosts: ["host.docker.internal:host-gateway"]` in docker-compose.yml
   to reach `http://host.docker.internal:11434`. Docker Desktop (Mac/Windows)
   adds this automatically.

3. **Embedding dimensions**: The Qdrant collection must be created with
   `embedding_model_dims` matching the embedding model's output dimensions
   (e.g., 1024 for `qwen3-embedding:0.6b`, 768 for `nomic-embed-text`).
   A dimension mismatch causes silent insert failures.

4. **Model compatibility**: Models that use `<think>` tags (e.g., qwen3:4b)
   can break mem0's JSON fact extraction parser. Use models without thinking
   mode (e.g., `qwen2.5:14b`) for the LLM provider. Embedding models are
   unaffected.

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

## Installed Services

### `GET /admin/installed`

```json
{
  "installed": ["chat"],
  "activeServices": { "assistant": "running" }
}
```

## Setup

### `GET /admin/setup`

**No authentication required.** Returns setup status and which config keys are set
(booleans only, never values). During first-run (before setup is complete), also
returns an ephemeral `setupToken` for authenticating the setup POST.

Response:

```json
{
  "setupComplete": false,
  "installed": false,
  "setupToken": "abc123...",
  "detectedUserId": "node",
  "configured": {
    "OPENAI_API_KEY": false,
    "OPENAI_BASE_URL": false,
    "OPENMEMORY_USER_ID": false,
    "GROQ_API_KEY": false,
    "MISTRAL_API_KEY": false,
    "GOOGLE_API_KEY": false
  }
}
```

### `POST /admin/setup`

Runs the setup wizard. During first-run, authenticates with the ephemeral
`setupToken` via `x-admin-token` header. After setup is complete, requires
normal admin auth.

Body:

```json
{
  "adminToken": "my-secure-token",
  "llmProvider": "openai",
  "llmApiKey": "sk-...",
  "llmBaseUrl": "",
  "systemModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDims": 1536,
  "openmemoryUserId": "default_user"
}
```

All fields except `adminToken` are optional. The endpoint:
1. Writes credentials to `CONFIG_HOME/secrets.env`
2. Builds and writes OpenMemory config
3. Runs `docker compose up` to start the stack
4. Pushes config to OpenMemory and provisions the user (fire-and-forget)

Response:

```json
{
  "ok": true,
  "started": ["caddy", "openmemory", "assistant", "guardian"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

### `POST /admin/setup/models`

Proxy endpoint for listing available models during setup. Same behavior as
`POST /admin/openmemory/models` but accepts the ephemeral setup token for
first-run authentication.

## Local Provider Detection

### `GET /admin/providers/local`

Probes well-known local LLM provider endpoints to detect which are running.
During first-run setup, accepts the ephemeral setup token; after setup,
requires admin auth.

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
