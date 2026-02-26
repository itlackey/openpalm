# Admin Service

The `admin` container is the control-plane executor for OpenPalm. It manages the Docker Compose lifecycle and exposes the Admin API for all management operations.

## What it does

- **Admin API** — RESTful endpoints for managing services, extensions, secrets, and channels
- **Compose lifecycle** — Executes allowlisted `docker compose` operations (start, stop, restart, pull)
- **Config editor** — Reads and writes `opencode.json` with schema validation, policy lint, and atomic backup

## Directory layout (XDG Base Directory)

```
~/.local/share/openpalm/      (OPENPALM_DATA_HOME — databases, blobs)
~/.config/openpalm/            (OPENPALM_CONFIG_HOME — source-of-truth inputs)
~/.local/state/openpalm/       (OPENPALM_STATE_HOME — runtime artifacts + state env/config)
```

## Authentication

- A secure admin token is generated during install and stored in `.env` as `ADMIN_TOKEN`
- The token is sent as `x-admin-token` header to all admin API calls
- All write operations (install/uninstall extensions, edit config, manage channels, start/stop containers) require the token
- The admin API is LAN-only by default

## Container lifecycle model

Admin is the control-plane executor and performs allowlisted compose operations directly using the mounted container socket.

**Compose service allowlist:** `assistant`, `gateway`, `openmemory`, `admin`, `channel-chat`, `caddy`. Additional services can be allowed via `OPENPALM_EXTRA_SERVICES` (comma-separated).

## Installer flow

1. Detect OS and Docker
2. Resolve XDG Base Directory paths (data, config, state)
3. Write resolved absolute paths into `.env`
4. Persist runtime command/socket config in `.env`
5. Generate secure admin token and write to `.env`
6. Seed default configs into `$OPENPALM_CONFIG_HOME`
7. Copy embedded full-stack compose to state directory
8. Write Caddy JSON config with routing
9. Pull all container images
10. Start all services via `compose up`
11. Health check admin and gateway
12. Print API URLs and operational commands

## Related docs

- [API Reference](../dev/docs/api-reference.md) — Admin API endpoints
- [Maintenance Guide](../docs/maintenance.md) — Backup, restore, and upgrade procedures
