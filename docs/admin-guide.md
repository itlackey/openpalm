## Current control-plane status

OpenPalm now uses Admin as the control-plane executor for allowlisted Compose actions (`up`, `down/stop`, `restart`, `ps`, `logs`, optional `pull`) with service-name validation against the generated compose manifest.

Secrets continue to be managed by the existing secret manager + Stack Spec mappings, with scoped env files rendered for gateway/channel/openmemory/postgres/opencode domains.

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

> **Config path note**: `OPENPALM_CONFIG_HOME` is the host-side XDG path (e.g., `~/.config/openpalm/`). Inside the `opencode-core` container, this directory is volume-mounted and referenced as `OPENCODE_CONFIG_DIR`. The `OPENCODE_CONFIG_DIR` env var is what OpenCode itself uses to locate its configuration at runtime.

```
~/.local/share/openpalm/      (OPENPALM_DATA_HOME — databases, blobs)
  postgres/
  qdrant/
  openmemory/
  shared/
  admin/
  openpalm/

~/.config/openpalm/            (OPENPALM_CONFIG_HOME — source-of-truth inputs)
  stack-spec.json
  secrets.env

~/.local/state/openpalm/       (OPENPALM_STATE_HOME — rendered artifacts + runtime state)
  rendered/
    docker-compose.yml
    caddy/
    env/
  gateway/
  caddy/                      — Caddy runtime config/data
  logs/
  tmp/
  observability/
  backups/
  uninstall.sh                 — copied during install for easy access
```

### Runtime vs Dev Compose

- **Runtime source of truth**: `assets/state/docker-compose.yml` (rendered/applied to `${OPENPALM_STATE_HOME}/rendered/docker-compose.yml`).
- **Dev-only overlay**: `docker-compose.dev.yml` at the repo root (local builds and overrides only).

---

## 2) Settings UI (edit config + restart)

### Do not embed config editing inside Grafana
Use a **dedicated Admin Console**, and link to it from dashboards.

### Admin Console pages
- System status
- Config editor (schema-aware)
- Service control (restart services)
- Plugin management (install/uninstall npm plugins) — see [Plugin management](#plugin-management) below
- Secrets management — see [Secrets](#secrets-management) below
- Automations management — see [Automations](#automations-management) below

### Plugin management

The admin UI manages OpenCode plugins (the `plugin[]` list in `opencode.json`). Users can install and uninstall npm plugin packages, which are automatically resolved by Bun at startup. Skills, agents, commands, and tools are managed manually by advanced users in the OpenCode config directory.

### Secrets management

> **Implementation Status:** Secrets are managed via Secret Manager APIs and stored in `secrets.env`. Stack-spec channel config values may reference secret keys directly using `${SECRET_NAME}` and are validated during render/apply.

The admin UI provides a secrets workflow for managing key/value credentials and runtime config values:

- **What users see**: Secret key names, whether values are configured, and where each key is used.
- **Validation**: Stack render/apply fails fast when channel config references a missing secret key.
- **Storage**: Secrets are stored as key/value entries in `secrets.env` (at `$OPENPALM_CONFIG_HOME/secrets.env`).

### Automations management

The admin UI provides an Automations page for managing user-defined scheduled prompts. Cron execution is owned by the admin container (`cron && bun run src/server.ts`):

- **Creating an automation**: Users provide a Name, a Prompt (the text sent to the assistant), and a Schedule using a cron expression or schedule picker. The automation is assigned a UUID and stored as a JSON payload file in `cron-payloads/`.
- **Enable/disable**: Each automation has a Status toggle. Disabled automations remain stored but are not executed by the cron daemon.
- **Run Now**: A manual trigger button allows users to fire an automation immediately, outside its normal schedule, for testing or one-off use.
- **Edit**: Name, prompt, and schedule can be updated at any time. The change takes effect at the next scheduled run (or immediately if Run Now is used).
- **Delete**: Removes the automation and its payload file permanently.

### Safe config editing flow
1) Parse JSONC
2) Validate schema
3) Policy lint (deny widening permissions to `allow`)
4) Write atomically with backup
5) Restart OpenCode (deterministic)

If `opencode.jsonc` does not exist yet (for example, first boot with an empty override directory), the admin service bootstraps a minimal `{}` config file automatically before read/write operations so the UI and API remain functional.

### Container lifecycle model

Admin is the control-plane executor and performs allowlisted compose operations directly using the mounted container socket.

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
- Edit extension config
- Manage channels (access, config)
- Start/stop/restart containers

---

## 4) Default system maintenance cron jobs (admin)

OpenPalm installs a fixed system-level cron schedule in the `admin` container on startup. These jobs are enabled by default and are not user-configurable in the admin UI.

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

### Gateway security pipeline

Every inbound channel message passes through the Gateway's 6-step security pipeline before reaching the AI assistant:

1. **HMAC signature verification** — Rejects unsigned or tampered requests from channel adapters.
2. **Payload validation** — Validates the structure and content of the incoming message.
3. **Rate limiting** — Caps traffic at 120 requests/min/user; excess requests receive a 429 response.
4. **Intake validation** — The `channel-intake` agent (running with zero tool access) validates and summarizes the input; invalid messages are rejected with 422.
5. **Forward to assistant** — Only the validated summary is forwarded to the AI assistant (default agent with approval gates).
6. **Audit log** — All requests and outcomes are written to the immutable audit log.

This pipeline is enforced at the `/channel/inbound` endpoint on the Gateway container. Network isolation (Caddy + internal Docker network) provides an additional perimeter, but the pipeline is the primary channel security control.

### Capability isolation
Channel adapters should not:
- access Docker
- access host filesystem
- hold non-channel secrets


## Uninstall

To uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/uninstall.sh | bash
```

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/uninstall.ps1 -OutFile $env:TEMP/openpalm-uninstall.ps1; & $env:TEMP/openpalm-uninstall.ps1"
```

Use `--remove-all` to delete all OpenPalm config/state/data directories and `--remove-images` to remove container images.
PowerShell example with full cleanup: `& $env:TEMP/openpalm-uninstall.ps1 -RemoveAll -RemoveImages`.

During setup you choose whether your assistant is accessible only from this machine or from your local network. You can change this later from the admin dashboard.
The setup wizard also lets you configure OpenMemory's OpenAI-compatible endpoint and API key, which are persisted in `~/.config/openpalm/secrets.env`.
