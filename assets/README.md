# OpenPalm Core Assets

This directory contains the core bootstrap infrastructure for OpenPalm. These files define the base stack -- the services that are always present regardless of which components are installed.

## Files

```
docker-compose.yml          # Core services (memory, assistant, guardian, scheduler)
opencode.jsonc              # OpenCode project config (baked into assistant image)
AGENTS.md                   # Assistant persona and guidelines (baked into assistant image)
cleanup-data.yml            # Core automation: clean up old data files
cleanup-logs.yml            # Core automation: clean up old log files
validate-config.yml         # Core automation: periodic config validation
redact.env.schema           # Varlock schema for redaction rules
setup-config.schema.json    # JSON schema for setup configuration
system.env.schema           # Varlock schema for system.env variables
user.env.schema             # Varlock schema for user.env variables
```

## How Assets Are Consumed

Assets are consumed in two modes:

1. **CLI-managed** -- The CLI reads assets from `data/` (persisted during install) via `FilesystemAssetProvider`. The CLI manages compose lifecycle directly on the host.
2. **Admin-managed** -- The admin service bundles assets at build time via Vite (`ViteAssetProvider`) and component definitions from `registry/` via `ViteRegistryProvider`. Components are installed on demand via the admin API, which copies files to `~/.openpalm/config/components/`.

Both CLI and admin use the same shared control-plane library (`@openpalm/lib`) for all lifecycle and configuration logic. The only difference is how assets are loaded: CLI reads from the filesystem, admin reads from Vite-bundled imports.

## Components

Component definitions (channels, services, integrations) live in the `registry/components/` directory at the repo root. Each component is a self-contained directory with a `compose.yml`. See `registry/README.md` for details.

## Docker Compose

The core `docker-compose.yml` defines infrastructure services. Component services are added as separate compose files that are merged at runtime using the `-f` flag:

```bash
docker compose \
  -f docker-compose.yml \
  -f config/components/channel-chat/compose.yml \
  -f config/components/channel-discord/compose.yml \
  up -d
```

Docker Compose merges all `-f` files into a single configuration. Component overlays can reference networks and services defined in the core file.

## Environment Variables

Each service's `environment:` block lists only the `${VAR}` references it needs. Docker Compose substitutes values from the env files provided via `--env-file`.

User secrets (admin token, LLM API keys) live in `~/.openpalm/vault/user.env`. System-managed infrastructure config lives in `~/.openpalm/vault/system.env`. Each container only receives the secrets it explicitly declares.

## Adding a New Component

See `registry/README.md` for the full component model. In brief:

1. Create a directory under `registry/components/<id>/` with `compose.yml`
2. Install via the admin API or copy to `~/.openpalm/config/components/`

## Customization Reference

| What you want to change | What to edit |
|--------------------------|-------------|
| Add a component | Install from registry or drop files into `config/components/` |
| Remove a component | Uninstall via admin API or remove from `config/components/` |
| Change ingress port | Set `OP_INGRESS_PORT` in env file (default: 8080) |
| Change bind address | Set `OP_INGRESS_BIND_ADDRESS` in env file (default: 127.0.0.1) |
| Use different image registry | Set `OP_IMAGE_NAMESPACE` in env file |
| Change home directory | Set `OP_HOME` in env file (default: ~/.openpalm) |
