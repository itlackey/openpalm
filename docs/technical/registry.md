# Registry

The registry is the addon and automation discovery system for OpenPalm. It provides a catalog of installable components (channel addons, service addons) and automations that operators can browse, install, and manage through the admin API.

## How it works

The registry is backed by a Git repository. By default it points at the main OpenPalm repo itself (`itlackey/openpalm`), using a sparse checkout to fetch only the `.openpalm/` directory tree. The cloned content lives in the local cache at `~/.cache/openpalm/registry-repo/`.

**Sync flow:**

1. On first access, the system runs a shallow sparse clone (`--depth 1 --filter=blob:none --sparse`) of the registry repo, checking out only the `stack/` subtree.
2. On subsequent calls, `pullRegistry()` runs `git pull` to fetch the latest changes.
3. Discovery functions scan the cloned repo for addon components (`.openpalm/stack/addons/`) and automations (`.openpalm/config/automations/`).

All git operations use `execFileSync` with argument arrays (no shell interpolation) and validated inputs. URLs must start with `https://` or `git@`. Branch names are validated against a strict regex that rejects shell metacharacters and `..` sequences.

## Configuration

Two environment variables control the registry source:

| Variable | Default | Description |
|---|---|---|
| `OP_REGISTRY_URL` | `https://github.com/itlackey/openpalm.git` | Git URL of the registry repo |
| `OP_REGISTRY_BRANCH` | `main` | Branch to clone/pull |

## What the registry contains

### Addon components

Addons live in `.openpalm/stack/addons/<name>/`. Each addon directory must contain:

| File | Purpose |
|---|---|
| `compose.yml` | Docker Compose overlay defining the addon's services |
| `.env.schema` | Annotated env var schema declaring required and optional configuration |

Current addons in the registry: `admin`, `api`, `chat`, `discord`, `ollama`, `openviking`, `slack`, `voice`.

### Automations

Automations live in `.openpalm/config/automations/<name>.yml`. Each is a YAML file with fields like `name`, `description`, `schedule`, `enabled`, and `action`. The scheduler sidecar picks these up via file watching.

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
      CHANNEL_EXAMPLE_SECRET: ${CHANNEL_EXAMPLE_SECRET:-}
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
# HMAC secret used to sign messages sent to the guardian.
# Auto-generated during instance creation if left blank.
# @required @sensitive
CHANNEL_EXAMPLE_SECRET=
```

Schema conventions:

- Every variable must have at least one comment line above it
- Variable names are uppercase with underscores (`[A-Z_][A-Z0-9_]*`)
- Annotations: `@required` marks mandatory variables, `@sensitive` marks secrets
- Channel addons must have at least one `@sensitive` field (the HMAC secret)
- Must not reference `vault/`, `INSTANCE_ID`, or `INSTANCE_DIR`

## Admin API endpoints

All endpoints require authentication via `x-admin-token` header.

### `GET /admin/registry`

List available automations from the registry. Tries the cloned registry repo first; falls back to on-disk `config/automations/`.

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
  "source": "remote"
}
```

The `source` field is `"remote"` when reading from the cloned repo, `"local"` when falling back to disk.

### `POST /admin/registry/install`

Install an automation from the registry into `config/automations/`.

Request body:

```json
{ "name": "health-check", "type": "automation" }
```

Copies the automation YAML from the registry into `config/automations/<name>.yml`. Fails if the automation is already installed or not found in the registry. The scheduler auto-reloads via file watching.

Channel addons are not installed through this endpoint. Use `POST /admin/addons` instead.

### `POST /admin/registry/uninstall`

Remove an installed automation.

Request body:

```json
{ "name": "health-check", "type": "automation" }
```

Deletes `config/automations/<name>.yml` from disk. The scheduler auto-reloads.

### `POST /admin/registry/refresh`

Pull the latest registry content from the remote Git repo.

Response:

```json
{ "ok": true, "updated": true }
```

The `updated` field is `false` when the local clone was already up to date.

### `GET /admin/addons`

List all available addons with their enabled/disabled status and env configuration. Scans `stack/addons/` on disk.

### `POST /admin/addons`

Enable or disable an addon and optionally update its env config. When enabling a channel addon, an HMAC secret is auto-generated.

### `GET /admin/addons/:name` / `POST /admin/addons/:name`

Get or update a specific addon's configuration.

## Merged registry

When installing automations, the system builds a merged registry that combines remote (cloned repo) automations with local on-disk automations. Remote entries take precedence over local ones. This allows the registry to provide updated versions of automations while preserving any local-only automations the operator has created.

For addon components, the merged registry uses remote component definitions when available, falling back to locally installed addon IDs.

## Name validation

All component and automation names must match `^[a-z0-9][a-z0-9-]{0,62}$`: lowercase alphanumeric with hyphens, 1-63 characters, starting with an alphanumeric character.
