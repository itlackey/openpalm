# Registry

The registry is the addon and automation discovery system for OpenPalm. It provides the available catalog of installable components and sample automations. Runtime state lives elsewhere.

## How it works

Repo source assets live under `.openpalm/state/registry/`. The runtime catalog lives at `~/.openpalm/state/registry/`. Install seeds that directory from bundled assets. Manual refresh replaces it from the remote Git repository.

**Sync flow:**

1. Install seeds `~/.openpalm/state/registry/` from repo assets under `.openpalm/state/registry/`.
2. `refreshRegistryCatalog()` performs a shallow sparse clone of `.openpalm/` into a temporary directory.
3. `materializeRegistryCatalog()` validates the cloned catalog and replaces `~/.openpalm/state/registry/`.
4. Discovery functions scan `~/.openpalm/state/registry/addons/` and `~/.openpalm/state/registry/automations/`.

All git operations use `execFileSync` with argument arrays (no shell interpolation) and validated inputs. URLs must start with `https://`, `git@`, or be an absolute local path. Branch names are validated against a strict regex that rejects shell metacharacters and `..` sequences.

## Configuration

Two environment variables control the registry source:

| Variable | Default | Description |
|---|---|---|
| `OP_REGISTRY_URL` | `https://github.com/itlackey/openpalm.git` | Git URL of the registry repo |
| `OP_REGISTRY_BRANCH` | `main` | Branch to clone/pull |

## What the registry contains

### Addon components

Repo catalog addons live in `.openpalm/state/registry/addons/<name>/`. Runtime available addons live in `~/.openpalm/state/registry/addons/<name>/`. Enabled addons live in `~/.openpalm/config/stack/addons/<name>/`. Each addon directory must contain:

| File | Purpose |
|---|---|
| `compose.yml` | Docker Compose overlay defining the addon's services |
| `.env.schema` | Annotated env var schema declaring required and optional configuration |

Current addons in the registry: `api`, `chat`, `discord`, `ollama`, `slack`, `voice`. (`admin` is a host process, not a compose addon.)

### Automations

Registry automations live in `.openpalm/state/registry/automations/<name>.yml` in the repo source and are materialized into `~/.openpalm/state/registry/automations/<name>.yml` on install or refresh. They become active only after being installed into `~/.openpalm/stash/tasks/` via the admin catalog API or UI.

## Addon structure

A minimal addon has two files:

**`compose.yml`** -- Docker Compose service overlay:

```yaml
# Addon: example — short description
services:
  example:
    image: ${OP_IMAGE_NAMESPACE:-openpalm}/channel:${OP_IMAGE_TAG:-latest}
    restart: unless-stopped
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    environment:
      CHANNEL_EXAMPLE_SECRET_FILE: /run/secrets/channel_example_hmac
    secrets:
      - channel_example_hmac
    networks: [channel_lan]
    depends_on:
      guardian:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/8181' || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
    labels:
      openpalm.name: Example
      openpalm.description: Short human-readable description
```

Required conventions enforced by tests:

- `openpalm.name` and `openpalm.description` labels must be present
- Must join a valid stack network (`channel_lan`, `channel_public`, or `assistant_net`)
- Must have a `restart` policy and `healthcheck`
- Must not use `container_name`, `INSTANCE_ID`, or `INSTANCE_DIR`
- Must not mount the `vault/` directory (single-file vault mounts are allowed)
- Must not mount the Docker socket (except the `admin` addon)
- Must start with a comment header

**`.env.schema`** -- Annotated variable declarations:

```
# Optional package-specific non-secret setting.
# @optional
EXAMPLE_MODE=
```

Schema conventions:

- Every variable must have at least one comment line above it
- Variable names are uppercase with underscores (`[A-Z_][A-Z0-9_]*`)
- Annotations: `@required` marks mandatory variables, `@sensitive` marks secrets
- Channel HMAC secrets are generated as file-based system secrets and must not appear in `.env.schema`
- Must not reference `vault/`, `INSTANCE_ID`, or `INSTANCE_DIR`

## Admin API endpoints

All endpoints require authentication via the `op_session` cookie. Non-browser
callers must `POST /admin/auth/login` with `{ "password": "<OP_UI_LOGIN_PASSWORD>" }`
to receive the cookie, then include it on subsequent requests.

### `GET /admin/automations/catalog`

List available automations from `~/.openpalm/state/registry/automations/`.

Response:

```json
{
  "automations": [
    {
      "name": "health-check",
      "type": "automation",
      "installed": true,
      "description": "Monitor that all services are running",
      "schedule": "every-5-minutes"
    }
  ],
  "source": "registry"
}
```

### `POST /admin/automations/catalog/install`

Install an automation from the runtime registry into `stash/tasks/`.

Request body:

```json
{ "name": "health-check", "type": "automation" }
```

Copies the automation YAML task from `~/.openpalm/state/registry/automations/` into `~/.openpalm/stash/tasks/<name>.yml`. Fails if the automation is already installed or not found in the registry. The assistant container picks it up within 60 s via its background `akm tasks sync` loop.

Channel addons are not installed through this endpoint. Use `POST /admin/addons` instead.

### `POST /admin/automations/catalog/uninstall`

Remove an installed automation.

Request body:

```json
{ "name": "health-check", "type": "automation" }
```

Deletes `stash/tasks/<name>.yml` from disk. The assistant container drops the cron entry within 60 s.

### `POST /admin/automations/catalog/refresh`

Refresh the registry catalog from the remote Git repo.

Response:

```json
{ "ok": true, "root": "/home/user/.openpalm/registry" }
```

### `GET /admin/addons`

List all available addons from `~/.openpalm/state/registry/addons/` with enabled state from `~/.openpalm/config/stack/addons/`.

### `POST /admin/addons`

Enable or disable an addon by copying or removing its directory under `~/.openpalm/config/stack/addons/`. When enabling a channel addon, an HMAC secret is auto-generated.

### `GET /admin/addons/:name` / `POST /admin/addons/:name`

Get or update a specific addon. Detail responses include the raw `.env.schema` and point operators at `stash/vaults/user.env` for values.

## Name validation

All component and automation names must match `^[a-z0-9][a-z0-9-]{0,62}$`: lowercase alphanumeric with hyphens, 1-63 characters, starting with an alphanumeric character.
