# OpenPalm Host System Reference

This document details every directory and file that the OpenPalm installer creates and manages on the host machine. OpenPalm follows the XDG Base Directory Specification, spreading its footprint across three root directories that separate persistent data, user-editable configuration, and ephemeral runtime state.

---

## XDG Directory Layout at a Glance

| Purpose | Default Path | Override Env Var |
|---------|-------------|------------------|
| **Data** — databases, vector stores, blobs | `~/.local/share/openpalm` | `OPENPALM_DATA_HOME` |
| **Config** — agent configs, Caddyfile, channel envs, secrets | `~/.config/openpalm` | `OPENPALM_CONFIG_HOME` |
| **State** — runtime state, compose file, logs, workspace | `~/.local/state/openpalm` | `OPENPALM_STATE_HOME` |

All three paths respect the standard `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` variables if they are set, and fall back to the defaults shown above.

In addition to these three trees, the installer creates a `.env` file in the working directory where the install script was run.

---

## Working Directory

The directory from which `install.sh` (or `install.ps1`) is executed serves as the project root. After installation it contains:

### `.env`

The master environment file. Generated from `assets/config/system.env` on first install, then enriched with auto-generated secrets and resolved paths. It is the single source of truth for every variable referenced by `assets/state/docker-compose.yml`. Key categories of variables:

**XDG paths** — `OPENPALM_DATA_HOME`, `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`

**Container runtime** — `OPENPALM_CONTAINER_PLATFORM` (docker | podman | orbstack), `OPENPALM_COMPOSE_BIN`, `OPENPALM_COMPOSE_SUBCOMMAND`, `OPENPALM_CONTAINER_SOCKET_PATH`, `OPENPALM_CONTAINER_SOCKET_IN_CONTAINER`, `OPENPALM_CONTAINER_SOCKET_URI`, `OPENPALM_IMAGE_TAG`

**Generated secrets** — `ADMIN_TOKEN`, `CONTROLLER_TOKEN`, `POSTGRES_PASSWORD`, `CHANNEL_CHAT_SECRET`, `CHANNEL_DISCORD_SECRET`, `CHANNEL_VOICE_SECRET`, `CHANNEL_TELEGRAM_SECRET`

**Optional overrides** — bind addresses, database name/user, OpenCode timeout, SSH settings, channel-specific bot tokens

The installer is idempotent with respect to `.env`: it only creates the file if absent and uses upsert logic so manually added keys are preserved.

---

## Data Directory (`~/.local/share/openpalm`)

Holds persistent storage that should be backed up. Nothing here is user-edited directly; it is owned by the running containers.

```
~/.local/share/openpalm/
├── admin/              # Admin service persistent data (setup state, preferences)
├── caddy/              # Caddy TLS certificates and persistent data (/data volume)
├── openmemory/         # OpenMemory MCP server data files
├── postgres/           # PostgreSQL data directory (pgdata)
├── qdrant/             # Qdrant vector database storage
└── shared/             # Shared volume accessible by opencode-core and openmemory
```

**Container volume mounts:**

| Host Path | Container | Mount Point |
|-----------|-----------|-------------|
| `admin/` | admin | `/app/data` |
| `caddy/` | caddy | `/data` |
| `openmemory/` | openmemory | `/data` |
| `postgres/` | postgres | `/var/lib/postgresql/data` |
| `qdrant/` | qdrant | `/qdrant/storage` |
| `shared/` | openmemory | `/shared` |
| `shared/` | opencode-core | `/shared` |
| `shared/` | admin | `/shared` |

The `shared/` directory acts as a cross-service file exchange area, accessible to the core agent, memory service, and admin panel simultaneously.

---

## Config Directory (`~/.config/openpalm`)

Holds user-editable configuration. The installer seeds defaults here on first run but never overwrites existing files, so manual edits are preserved across upgrades.

```
~/.config/openpalm/
├── caddy/
│   └── Caddyfile              # Reverse proxy routing rules
├── channels/
│   ├── chat.env               # Chat channel overrides
│   ├── discord.env            # Discord bot token & public key
│   ├── telegram.env           # Telegram bot token & webhook secret
│   └── voice.env              # Voice channel configuration
├── cron/                      # Cron job definitions (mounted into opencode-core)
├── opencode-core/
│   ├── opencode.jsonc         # Core agent OpenCode configuration
│   ├── AGENTS.md              # Safety rules and behavioral constraints
│   ├── lib/
│   │   └── openmemory-client.ts   # OpenMemory REST client library
│   ├── plugins/
│   │   ├── openmemory-http.ts     # Memory recall/writeback pipeline plugin
│   │   └── policy-and-telemetry.ts # Policy enforcement and audit plugin
│   ├── skills/
│   │   ├── ActionGating.SKILL.md   # Risk classification for agent actions
│   │   ├── ChannelIntake.SKILL.md  # Inbound channel request handling
│   │   ├── MemoryPolicy.SKILL.md   # Memory storage policy rules
│   │   └── RecallFirst.SKILL.md    # Memory recall-before-answer behavior
│   └── ssh/
│       └── authorized_keys         # SSH public keys (if SSH access enabled)
├── opencode-gateway/
│   ├── opencode.jsonc         # Gateway intake agent configuration (read-only tools)
│   ├── AGENTS.md              # Safety rules for gateway agent
│   └── skills/
│       ├── ChannelIntake.SKILL.md  # Channel intake behavior for gateway
│       └── RecallFirst.SKILL.md    # Recall-first behavior for gateway
├── secrets.env                # API keys and secrets (OPENAI_BASE_URL, OPENAI_API_KEY)
└── user.env                   # User-specific bind address and runtime overrides
```

### Key Config Files Explained

**`caddy/Caddyfile`** — Defines all HTTP routing. By default it listens on ports 80 and 443, restricts admin and channel paths to LAN-only access (private IP ranges), and proxies to internal services. Routes include `/channels/{chat,voice,discord,telegram}` for channel ingress, `/admin/*` for the admin UI and API, `/admin/opencode*` for the core agent, and `/admin/openmemory*` for the memory UI.

**`opencode-core/opencode.jsonc`** — The primary agent configuration. Sets default permissions (bash, edit, webfetch all require approval), defines the `channel-intake` agent profile with all tools disabled (read-only), and configures the OpenMemory MCP connection. Extensions (plugins, skills, lib) are baked into the container image at build time from `opencode/extensions/`. Files placed in this config directory serve as optional host overrides; they are merged at container startup and take effect on container restart without rebuilding.

**`opencode-gateway/opencode.jsonc`** — The gateway's intake agent configuration. All permissions are set to `never`; the gateway agent is strictly read-only and used for channel message validation before messages reach the core agent. Gateway extensions are baked into the gateway container image, so this config home entry is no longer required for standard deployments. Files here act as optional overrides only.

**`secrets.env`** — Consumed as an `env_file` by the `openmemory` and `opencode-core` containers. Contains API keys for OpenAI-compatible endpoints that power memory features. This file is the appropriate place for any secret that needs to reach the core agent or memory service.

**`user.env`** — Also consumed as an `env_file` by `openmemory` and `opencode-core`. Intended for optional runtime tuning like bind address overrides without touching the system-managed `.env`.

**`channels/*.env`** — Each channel adapter reads its own env file. These are managed through the admin UI but can be edited directly. They contain channel-specific credentials (Discord bot tokens, Telegram secrets, etc.).

**Container volume mounts:**

| Host Path | Container | Mount Point | Mode |
|-----------|-----------|-------------|------|
| `caddy/Caddyfile` | caddy | `/etc/caddy/Caddyfile` | ro |
| `opencode-core/` | opencode-core | `/config` | rw |
| `opencode-core/` | admin | `/app/config/opencode-core` | rw |
| `opencode-gateway/` | gateway | `/app/opencode-config` | ro | *(optional override — gateway extensions are baked in)* |
| `caddy/` | admin | `/app/config/caddy` | rw |
| `channels/` | admin | `/app/channel-env` | rw |
| (config root) | admin | `/app/config-root` | rw |
| `channels/chat.env` | channel-chat | env_file | — |
| `channels/discord.env` | channel-discord | env_file | — |
| `channels/telegram.env` | channel-telegram | env_file | — |
| `channels/voice.env` | channel-voice | env_file | — |
| `secrets.env` | opencode-core, openmemory | env_file | — |
| `user.env` | opencode-core, openmemory | env_file | — |
| `cron/` | opencode-core | `/cron` | rw |

---

## State Directory (`~/.local/state/openpalm`)

Holds runtime state, logs, and ephemeral working data. Safe to delete if you want a fresh start (containers will recreate what they need), though you'll lose audit logs and any in-progress workspace files.

```
~/.local/state/openpalm/
├── .env                       # Copy of the master .env (used by compose)
├── docker-compose.yml         # Active compose file (copied from assets at install)
├── uninstall.sh               # Convenience copy of the uninstall script
├── backups/                   # Backup storage
├── caddy/                     # Caddy runtime config state
├── gateway/                   # Gateway runtime data
├── observability/             # Maintenance logs, metrics snapshots, tmp files
├── opencode-core/             # Core agent runtime state
└── workspace/                 # Agent working directory (mounted as /work)
```

### Key State Files Explained

**`docker-compose.yml`** — The operative compose file. Copied from the repo's `assets/state/docker-compose.yml` during installation. This is the file that `docker compose` actually reads. It defines all services: caddy, postgres, qdrant, openmemory, opencode-core, gateway, admin, controller, and the optional channel adapters (chat, discord, voice, telegram) behind the `channels` profile.

**`.env`** — A copy of the working directory's `.env`, placed here so the compose file and controller have a local reference. The controller mounts the entire state directory as `/workspace`.

**`uninstall.sh`** — A copy of the uninstall script placed here for easy access. Supports `--remove-all` (deletes all three XDG directories and the local `.env`), `--remove-images`, and `--yes` flags.

**`workspace/`** — The agent's working directory, mounted into `opencode-core` at `/work`. This is where the core agent writes files, runs code, and performs tasks.

**`observability/`** — The controller's `maintenance.sh` script writes log-rotated maintenance logs, metrics snapshots (container stats in JSONL), and temporary files here. Logs older than 14 days are auto-pruned, and temp files older than 7 days are cleaned up.

**Container volume mounts:**

| Host Path | Container | Mount Point |
|-----------|-----------|-------------|
| `docker-compose.yml` + `.env` | controller | `/workspace` (parent dir) |
| (state root) | controller | `/workspace` |
| (state root) | admin | `/workspace` |
| `caddy/` | caddy | `/config` |
| `gateway/` | gateway | `/app/data` |
| `opencode-core/` | opencode-core | `/state` |
| `workspace/` | opencode-core | `/work` |

---

## Container Socket

The controller container needs access to the host's container runtime socket to manage the compose stack (pull images, restart services, run maintenance). The socket is bind-mounted into the controller:

| Runtime | Default Host Socket Path | In-Container Path |
|---------|-------------------------|-------------------|
| Docker | `/var/run/docker.sock` | `/var/run/openpalm-container.sock` |
| Podman (Linux) | `/run/user/<uid>/podman/podman.sock` | `/var/run/openpalm-container.sock` |
| OrbStack (macOS) | `~/.orbstack/run/docker.sock` | `/var/run/openpalm-container.sock` |

The in-container path is always `/var/run/openpalm-container.sock` regardless of runtime, abstracted via the `OPENPALM_CONTAINER_SOCKET_URI` variable.

---

## Network Ports

| Port | Service | Default Bind Address | Purpose |
|------|---------|---------------------|---------|
| 80 | caddy | `0.0.0.0` | HTTP ingress (admin UI, channels) |
| 443 | caddy | `0.0.0.0` | HTTPS ingress |
| 8765 | openmemory | `0.0.0.0` | OpenMemory API (direct access) |
| 3000 | openmemory-ui | `0.0.0.0` | OpenMemory dashboard UI |
| 4096 | opencode-core | `127.0.0.1` | OpenCode agent API (localhost only) |
| 2222 | opencode-core | `127.0.0.1` | SSH access (disabled by default) |

All bind addresses are configurable via `*_BIND_ADDRESS` variables in `.env` or `user.env`.

---

## Service Architecture

The compose stack defines these services and their interdependencies:

**Infrastructure layer:** `postgres` (relational DB), `qdrant` (vector DB)

**Core layer:** `openmemory` (memory MCP server, depends on qdrant), `openmemory-ui` (memory dashboard, depends on openmemory), `opencode-core` (primary AI agent, depends on openmemory)

**Routing layer:** `gateway` (channel message routing and intake validation, depends on opencode-core), `controller` (container lifecycle management), `admin` (web UI and setup wizard, depends on controller)

**Edge layer:** `caddy` (reverse proxy, depends on gateway, admin, and openmemory-ui)

**Channel layer (optional, `--profile channels`):** `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram` (all depend on gateway)

---

## Uninstallation

The uninstall script (`uninstall.sh` or `uninstall.ps1`) reads paths from `.env` and supports three modes:

**Default** — stops and removes containers and the compose network.

**`--remove-images`** — also removes all container images used by the stack.

**`--remove-all`** — removes all three XDG directories (`data`, `config`, `state`) and the working directory `.env`. This is a complete wipe.

---

## Maintenance

The controller container includes `maintenance.sh` which provides scheduled operations that write to the `observability/` subdirectory under the state home:

| Task | What It Does |
|------|-------------|
| `pull-and-restart` | Pulls latest images and recreates services |
| `log-rotate` | Compresses logs > 5MB, deletes compressed logs > 14 days |
| `prune-images` | Removes unused images older than 7 days |
| `health-check` | Probes service endpoints, restarts non-running services |
| `security-scan` | Runs Docker Scout vulnerability scan on stack images |
| `db-maintenance` | Runs PostgreSQL vacuum/analyze |
| `filesystem-cleanup` | Deletes temp files older than 7 days |
| `metrics-report` | Captures container stats snapshot as JSONL |