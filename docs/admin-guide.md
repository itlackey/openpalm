# Admin Implementation Guide (Advanced)
*Administrator tools that are user-friendly, password-protected, and safe by design.*

## 1) Cross-platform installer + guided setup

### Goals
- One installer that:
  1) checks prerequisites for selected runtime (Docker/Podman/OrbStack compose)
  2) guides runtime installation if missing
  3) selects a directory for persistent data
  4) writes `.env` + runtime/compose overrides
  5) boots stack, shows startup progress indicator, and verifies health

### Recommended path
- **CLI installer (Node/Bun)** first for speed and portability.
- Optional **Tauri UI installer** later for a premium wizard UX.

### Installer flow
1. Detect OS + admin privileges
2. Resolve runtime (`docker`, `podman`, or `orbstack`) and validate compose command
3. If missing:
  - Windows/macOS: guide to Docker Desktop / Podman Desktop / OrbStack install
  - Linux: guide to Docker Engine or Podman install
4. Resolve XDG Base Directory paths (data, config, state)
5. Write resolved absolute paths into `.env`
6. Persist runtime command/socket config in `.env`
6. Generate admin password and write to `.env`
7. Seed default configs into `$OPENPALM_CONFIG_HOME`
8. Run compose up via selected runtime
9. Show spinner while waiting for health check endpoints
10. Auto-open setup UI in browser (unless user disables)
11. Setup wizard runs on first visit to admin UI — user enters admin password from `.env`

### Persistent directory layout (XDG Base Directory)
```
~/.local/share/openpalm/      (OPENPALM_DATA_HOME — databases, blobs)
  postgres/
  qdrant/
  openmemory/
  shared/
  caddy/
  admin/

~/.config/openpalm/            (OPENPALM_CONFIG_HOME — user-editable config)
  opencode-core/
  caddy/Caddyfile
  channels/
  user.env
  secrets.env

~/.local/state/openpalm/       (OPENPALM_STATE_HOME — runtime state, logs)
  opencode-core/
  gateway/
  caddy/
  workspace/
  observability/
  backups/
```

---

## 2) Settings UI (edit config + restart)

### Do not embed config editing inside Grafana
Use a **dedicated Admin Console**, and link to it from dashboards.

### Admin Console pages
- System status
- Config editor (schema-aware)
- Service control (restart services)
- Extension gallery (install/uninstall)

### Safe config editing flow
1) Parse JSONC
2) Validate schema
3) Policy lint (deny widening permissions to `allow`)
4) Write atomically with backup
5) Restart OpenCode (deterministic)

### Restart without mounting Docker socket into admin
Use a restricted "controller" sidecar:
- Exposes only a tiny HTTP API (restart specific services)
- Requires shared secret from admin
- Allowlisted services only

---

## 3) Admin access protection

### Auth model
- Admin password generated during install and stored in `.env`
- Password sent as `x-admin-token` header to the admin API
- Setup wizard includes an early access-scope choice (`host` or `lan`) that tightens Caddy + published port bindings for host-only installs
- The admin password is the single credential needed for all admin operations

### Protected actions
All admin write operations require the admin password:
- Install/uninstall extensions
- Edit agent config
- Manage channels (access, config)
- Start/stop/restart containers

---

## 4) Default system maintenance cron jobs (controller)

OpenPalm installs a fixed system-level cron schedule in the `controller` container on startup. These jobs are enabled by default and are not user-configurable in the admin UI.

| Schedule | Job | Behavior |
|---|---|---|
| `15 3 * * *` | Pull + restart | Pull updated images and run `compose up -d` to recreate services when needed |
| `17 * * * *` | Log rotation | Compress maintenance logs over 5MB; delete compressed logs older than 14 days |
| `45 3 * * 0` | Image prune | Remove unused container images older than 7 days |
| `*/10 * * * *` | Health check | Probe core service health endpoints, capture resource usage, restart non-running services |
| `40 2 * * *` | Security scan | Run best-effort vulnerability scan with `docker scout` when available |
| `20 2 * * *` | Database maintenance | Run Postgres `vacuumdb --all --analyze-in-stages` |
| `10 4 * * *` | Filesystem cleanup | Delete stale temporary files from observability temp paths |
| `*/5 * * * *` | Metrics scrape | Persist `docker stats` snapshots for dashboard/reporting pipelines (with 7-day retention) |

Logs for each job are written to `${OPENPALM_STATE_HOME}/observability/maintenance` (or `OPENPALM_MAINTENANCE_LOG_DIR` when explicitly set).

---

## 5) Hardening: protect your channels

### Universal channel hardening
- Dedicated secrets per channel
- Signature verification (when supported)
- Replay protection (timestamp + nonce)
- Rate limiting per user/channel
- Max message size + attachment allowlist
- Outbound allowlist for fetches

### Network placement
- Public entrypoint: reverse proxy + TLS
- Keep OpenCode/OpenMemory private; only Gateway can access them

### Capability isolation
Channel adapters should not:
- access Docker
- access host filesystem
- hold non-channel secrets
