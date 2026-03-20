# OpenPalm Core Assets

This directory contains the core bootstrap infrastructure for OpenPalm. These files define the base stack -- the services that are always present regardless of which components are installed.

## Files

```
docker-compose.yml       # Core services (caddy, admin, assistant, guardian, memory)
Caddyfile                # Core reverse proxy routes (auto-imports component routes)
```

## How Assets Are Consumed

Assets are consumed in two modes:

1. **CLI-managed** -- The CLI reads assets from `DATA_HOME` (persisted during install) via `FilesystemAssetProvider`. The CLI manages compose lifecycle directly on the host.
2. **Admin-managed** -- The admin service bundles assets at build time via Vite (`ViteAssetProvider`) and component definitions from `registry/` via `ViteRegistryProvider`. Components are installed on demand via the admin API, which copies files to `~/.openpalm/config/components/`.

Both CLI and admin use the same shared control-plane library (`@openpalm/lib`) for all lifecycle and configuration logic. The only difference is how assets are loaded: CLI reads from the filesystem, admin reads from Vite-bundled imports.

## Components

Component definitions (channels, services, integrations) live in the `registry/components/` directory at the repo root. Each component is a self-contained directory with a `compose.yml`, `.env.schema`, and optional `.caddy` file. See `registry/README.md` for details.

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

## Caddy Imports

The core `Caddyfile` includes these lines:

```caddy
import channels/public/*.caddy
import channels/lan/*.caddy
```

Caddy loads `.caddy` files from the `channels/public/` and `channels/lan/` directories at startup. No changes to the core Caddyfile are needed when adding or removing components.

**Caddy files are optional.** If a component has no `.caddy` file, it gets no HTTP route through Caddy and is only accessible on the Docker network (host and other containers). This is the default for components that don't need public or LAN access.

## Access Control

The Caddyfile defines a `(lan_only)` snippet:

```caddy
(lan_only) {
    @denied not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1 fc00::/7 fe80::/10
    abort @denied
}
```

Component `.caddy` files are LAN-restricted by default. Add `import public_access` to opt into public routing.

For host-only access (localhost only), replace the IP ranges with `127.0.0.1 ::1`.

## Environment Variables

Each service's `environment:` block lists only the `${VAR}` references it needs. Docker Compose substitutes values from the env files provided via `--env-file`.

User secrets (admin token, LLM API keys) live in `~/.openpalm/vault/user.env`. System-managed infrastructure config lives in `~/.openpalm/vault/system.env`. Each container only receives the secrets it explicitly declares.

## Adding a New Component

See `registry/README.md` for the full component model. In brief:

1. Create a directory under `registry/components/<id>/` with `compose.yml` and `.env.schema`
2. Optionally add a `.caddy` file for HTTP routing
3. Install via the admin API or copy to `~/.openpalm/config/components/`

## Customization Reference

| What you want to change | What to edit |
|--------------------------|-------------|
| Add a component | Install from registry or drop files into `config/components/` |
| Remove a component | Uninstall via admin API or remove from `config/components/` |
| Add HTTP routing to a component | Create a `.caddy` file for it |
| Remove HTTP routing | Delete the `.caddy` file (component becomes docker-network only) |
| Change access (LAN vs public) | Edit the `.caddy` file: add/remove `import public_access` |
| Change LAN IP ranges | Edit the `(lan_only)` snippet in `Caddyfile` |
| Restrict to localhost only | Change `(lan_only)` IPs to `127.0.0.1 ::1` |
| Change ingress port | Set `OP_INGRESS_PORT` in env file (default: 8080) |
| Change bind address | Set `OP_INGRESS_BIND_ADDRESS` in env file (default: 127.0.0.1) |
| Use different image registry | Set `OP_IMAGE_NAMESPACE` in env file |
| Change home directory | Set `OP_HOME` in env file (default: ~/.openpalm) |
