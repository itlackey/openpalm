# Admin Implementation Guide (Advanced)
*Administrator tools that are user-friendly, password-protected, and safe by design.*

## 1) Cross-platform installer + guided setup

### Goals
- One installer that:
  1) checks prerequisites (Docker/Compose)
  2) installs Docker if needed (or guides user)
  3) selects a directory for persistent data
  4) writes `.env` + compose overrides
  5) boots stack and verifies health

### Recommended path
- **CLI installer (Node/Bun)** first for speed and portability.
- Optional **Tauri UI installer** later for a premium wizard UX.

### Installer flow
1. Detect OS + admin privileges
2. Detect Docker + Compose
3. If missing:
   - Windows/macOS: guide to Docker Desktop install
   - Linux: offer scripted install with explicit confirmation
4. Resolve XDG Base Directory paths (data, config, state)
5. Write resolved absolute paths into `.env`
6. Generate admin password and write to `.env`
7. Seed default configs into `$OPENPALM_CONFIG_HOME`
8. `docker compose up -d`
9. Health check endpoints
10. Setup wizard runs on first visit to admin UI — user enters admin password from `.env`

### Persistent directory layout (XDG Base Directory)
```
~/.local/share/openpalm/      (OPENPALM_DATA_HOME — databases, blobs)
  postgres/
  qdrant/
  openmemory/
  shared/
  caddy/
  admin-app/

~/.config/openpalm/            (OPENPALM_CONFIG_HOME — user-editable config)
  opencode-core/
  opencode-channel/
  caddy/Caddyfile
  channels/

~/.local/state/openpalm/       (OPENPALM_STATE_HOME — runtime state, logs)
  opencode-core/
  opencode-channel/
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

### Restart without mounting Docker socket into admin-app
Use a restricted "controller" sidecar:
- Exposes only a tiny HTTP API (restart specific services)
- Requires shared secret from admin-app
- Allowlisted services only

---

## 3) Admin access protection

### Auth model
- Admin password generated during install and stored in `.env`
- Password sent as `x-admin-token` header to the admin API
- Admin UI is LAN-only via Caddy reverse proxy (network-level protection)
- The admin password is the single credential needed for all admin operations

### Protected actions
All admin write operations require the admin password:
- Install/uninstall extensions
- Edit agent config
- Manage channels (access, config)
- Start/stop/restart containers

---

## 4) Hardening: protect your channels

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
