# Admin Service

The `admin` container is the control-plane executor for OpenPalm. It hosts the Admin UI, manages the Docker Compose lifecycle, and exposes the Admin API for all management operations.

## What it does

- **Admin UI** — Web dashboard for managing services, extensions, secrets, and channels
- **Compose lifecycle** — Executes allowlisted `docker compose` operations (start, stop, restart, pull)
- **System maintenance cron** — Runs built-in non-configurable maintenance jobs (image pulls, health checks, database maintenance, log rotation, etc.)
- **Config editor** — Reads and writes `opencode.json` with schema validation, policy lint, and atomic backup

## Directory layout (XDG Base Directory)

```
~/.local/share/openpalm/      (OPENPALM_DATA_HOME — databases, blobs)
~/.config/openpalm/            (OPENPALM_CONFIG_HOME — source-of-truth inputs)
~/.local/state/openpalm/       (OPENPALM_STATE_HOME — runtime artifacts + state env/config)
```

## Authentication

- A temporary admin token is generated during install and stored in `.env` as `ADMIN_TOKEN`
- The token is sent as `x-admin-token` header to all admin API calls
- All write operations (install/uninstall extensions, edit config, manage channels, start/stop containers) require the token
- The admin panel is LAN-only by default

## Admin console pages

| Page | What it does |
|---|---|
| System status | Service health indicators |
| Config editor | Schema-aware JSONC editor with policy lint |
| Service control | Start / stop / restart containers |
| Plugin management | Install and uninstall npm plugins (`plugin[]` in `opencode.json`) |
| Secrets management | Manage key/value credentials in `secrets.env` |
| Stack config | YAML-first stack configuration with template discovery |

### Safe config editing flow

1. Parse JSONC
2. Validate schema
3. Policy lint (deny widening permissions to `allow`)
4. Write atomically with backup
5. Restart OpenCode

### Plugin management

The admin UI manages OpenCode plugins (the `plugin[]` list in `opencode.json`). Skills, agents, commands, and tools are managed manually by advanced users in the OpenCode config directory.

## System maintenance cron jobs

These jobs are enabled by default and are not user-configurable.

| Schedule | Job | Behavior |
|---|---|---|
| `15 3 * * *` | Pull + restart | Pull updated images and run `compose up -d` |
| `17 * * * *` | Log rotation | Compress logs over 5 MB; delete compressed logs older than 14 days |
| `45 3 * * 0` | Image prune | Remove unused images older than 7 days |
| `*/10 * * * *` | Health check | Probe core service health endpoints; restart non-running services |
| `40 2 * * *` | Security scan | Run best-effort vulnerability scan with `docker scout` when available |
| `20 2 * * *` | Database maintenance | Run Postgres `vacuumdb --all --analyze-in-stages` |
| `10 4 * * *` | Filesystem cleanup | Delete stale temporary files from observability temp paths |
| `*/5 * * * *` | Metrics scrape | Persist `docker stats` snapshots with 7-day retention |

Logs are written to `${OPENPALM_STATE_HOME}/observability/maintenance` (or `OPENPALM_MAINTENANCE_LOG_DIR`).

## Installer flow

1. Detect OS + admin privileges
2. Resolve container runtime (`docker` or `podman`) and validate compose command
3. If missing: guide to Docker Desktop / Podman Desktop install (Windows/macOS) or Docker Engine / Podman (Linux)
4. Resolve XDG Base Directory paths (data, config, state)
5. Write resolved absolute paths into `.env`
6. Persist runtime command/socket config in `.env`
7. Generate temporary admin token and write to `.env`
8. Seed default configs into `$OPENPALM_CONFIG_HOME`
9. Start bootstrap services (`caddy` + `admin`) via `compose up`
10. Show spinner while waiting for admin health check
11. Auto-open setup UI in browser (unless `--no-open`)
12. Setup wizard runs on first visit — user signs in with the temporary admin token from `.env`
13. Wizard completion applies full stack and starts core runtime services (assistant, gateway, memory, channels)

## Container lifecycle model

Admin is the control-plane executor and performs allowlisted compose operations directly using the mounted container socket.

**Compose service allowlist:** `assistant`, `gateway`, `openmemory`, `admin`, `channel-chat`, `caddy`. Additional services can be allowed via `OPENPALM_EXTRA_SERVICES` (comma-separated).

## Related docs

- [Admin Guide](docs/admin-guide.md) — Setup and usage guide
- [Admin Concepts](docs/admin-concepts.md) — Core platform concepts
- [API Reference](../dev/docs/api-reference.md) — Admin API endpoints
- [Maintenance Guide](../docs/maintenance.md) — Backup, restore, and upgrade procedures
