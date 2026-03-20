# registry

Catalog of installable components and automations. Components are the unified model for all optional stack containers -- channels, services, and integrations are all components.

## Components (`registry/components/`)

Each component is a directory containing a Docker Compose fragment.

```
registry/components/
  chat/
    compose.yml          # Docker Compose service definition
    .env.schema          # Environment variable schema
  api/
    compose.yml
    .env.schema
  discord/
    compose.yml
    .env.schema
  slack/
    compose.yml
    .env.schema
  voice/
    compose.yml
    .env.schema
  openviking/
    compose.yml
    .env.schema
  ollama/
    compose.yml
    .env.schema
  admin/
    compose.yml
    .env.schema
```

### Available components

| Component | Description | Category |
|-----------|-------------|----------|
| `chat` | Browser-based chat widget | messaging |
| `api` | OpenAI and Anthropic compatible API facade | integration |
| `discord` | Discord bot adapter via WebSocket gateway | messaging |
| `slack` | Slack bot adapter via Socket Mode WebSocket | messaging |
| `voice` | Voice interface with STT and TTS | messaging |
| `openviking` | OpenViking integration | integration |
| `ollama` | Ollama local LLM runtime | ai |
| `admin` | Admin web UI and API | management |

### Component directory structure

Every component directory must contain:

- **`compose.yml`** -- Docker Compose service definition with `openpalm.*` labels
- **`.env.schema`** -- Environment variable schema with `INSTANCE_ID`, `INSTANCE_DIR` identity vars and `@required`/`@sensitive` annotations

### compose.yml conventions

Component compose files follow these conventions:

- **Service name**: `openpalm-${INSTANCE_ID}` -- uses Compose variable substitution, resolved at runtime
- **Container name**: `openpalm-${INSTANCE_ID}` -- matches the service name
- **env_file**: `${INSTANCE_DIR}/.env` -- points to the instance's environment file
- **Networks**: `openpalm-internal` -- all components join the internal network
- **Labels**: metadata for discovery and UI rendering

Required labels:

| Label | Description |
|-------|-------------|
| `openpalm.name` | Display name shown in the admin UI |
| `openpalm.description` | One-line description of the component |

Optional labels:

| Label | Description |
|-------|-------------|
| `openpalm.icon` | Lucide icon name for UI rendering |
| `openpalm.category` | Grouping category (messaging, integration, networking, ai, etc.) |
| `openpalm.healthcheck` | Internal URL to poll for health status |
| `openpalm.docs` | Path or URL to documentation |

The compose.yml is copied unchanged into the instance directory. `${INSTANCE_ID}` and `${INSTANCE_DIR}` are resolved by Docker Compose at runtime via `--env-file`, not by string interpolation. No template rendering.

### Installing a component

Via admin API:
```bash
curl -X POST http://localhost:8100/api/registry/chat/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

This copies the component directory to the local catalog at `~/.openpalm/data/catalog/`. From there, create an instance via the admin UI or API.

### index.json

The `index.json` file at `registry/components/index.json` lists all available components with metadata extracted from compose labels. This file is auto-generated from the component directories.

## Submitting a new component

1. Create a directory under `registry/components/<id>/`.
2. Add `compose.yml` with the required labels and conventions above.
3. Add `.env.schema` with `INSTANCE_ID`, `INSTANCE_DIR`, and any component-specific variables.
4. Open a pull request. CI validates the component structure.
5. After merge, add an entry to `index.json`.

### CI validation

The `scripts/validate-registry.sh` script runs on every PR that touches `registry/components/`. It checks:

- Every component directory has `compose.yml` and `.env.schema`
- `compose.yml` contains the required `openpalm.name` and `openpalm.description` labels
- `.env.schema` has `INSTANCE_ID` and `INSTANCE_DIR` identity variables with `@required`
- No vault mount violations in `compose.yml`
- Service names follow the `openpalm-${INSTANCE_ID}` convention

Run locally: `./scripts/validate-registry.sh`

## Automations (`registry/automations/`)

Pre-built YAML automations that can be installed to `~/.openpalm/config/automations/`.

| File | Description |
|---|---|
| `health-check.yml` | Checks admin health endpoint every 5 minutes |
| `update-containers.yml` | Pulls and restarts updated container images |
| `prompt-assistant.yml` | Sends a scheduled prompt to the assistant |
| `assistant-daily-briefing.yml` | Sends a daily briefing prompt to the assistant |

Browse and install automations from the admin console, or copy any file directly to `~/.openpalm/config/automations/`.

See [`docs/managing-openpalm.md`](../docs/managing-openpalm.md) for automation configuration details.
