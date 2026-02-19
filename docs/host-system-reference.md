# OpenPalm Host System Reference

This document describes the on-disk file structure of an installed OpenPalm stack, the directory layout on the host, and the relationship between host paths, container volume mounts, and runtime configuration.

---

## XDG Base Directory Layout

OpenPalm follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/) to organize host-side files into three top-level directories with distinct semantics:

| Directory | Default Path | XDG Override | OpenPalm Override | Semantics |
|-----------|-------------|-------------|-------------------|-----------|
| **Data** | `~/.local/share/openpalm` | `$XDG_DATA_HOME` | `$OPENPALM_DATA_HOME` | Persistent storage — databases, vector stores, blobs. Back this up. |
| **Config** | `~/.config/openpalm` | `$XDG_CONFIG_HOME` | `$OPENPALM_CONFIG_HOME` | User-editable configuration — agent overrides, Caddyfile, channel envs, secrets. |
| **State** | `~/.local/state/openpalm` | `$XDG_STATE_HOME` | `$OPENPALM_STATE_HOME` | Runtime state — compose file, workspace, audit logs. Disposable on reinstall. |

Override precedence: `OPENPALM_*_HOME` > `XDG_*_HOME` > hardcoded defaults.

---

## Working Directory (`.env`)

The installer creates a `.env` file in the current working directory from `assets/config/system.env`. This file is the root of all runtime configuration and is copied into the state directory alongside the compose file.

### Generated `.env` Contents

```env
# XDG paths (resolved at install time)
OPENPALM_DATA_HOME=/home/user/.local/share/openpalm
OPENPALM_CONFIG_HOME=/home/user/.config/openpalm
OPENPALM_STATE_HOME=/home/user/.local/state/openpalm

# Container runtime (detected at install time)
OPENPALM_CONTAINER_PLATFORM=docker
OPENPALM_COMPOSE_BIN=docker
OPENPALM_COMPOSE_SUBCOMMAND=compose
OPENPALM_CONTAINER_SOCKET_PATH=/var/run/docker.sock
OPENPALM_CONTAINER_SOCKET_IN_CONTAINER=/var/run/openpalm-container.sock
OPENPALM_CONTAINER_SOCKET_URI=unix:///var/run/openpalm-container.sock
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=latest-amd64

# Auto-generated secrets
ADMIN_TOKEN=<64-char random token>
CONTROLLER_TOKEN=<64-char random token>
POSTGRES_PASSWORD=<64-char random token>
CHANNEL_CHAT_SECRET=<64-char random token>
CHANNEL_DISCORD_SECRET=<64-char random token>
CHANNEL_VOICE_SECRET=<64-char random token>
CHANNEL_TELEGRAM_SECRET=<64-char random token>

# Channels to enable
OPENPALM_ENABLED_CHANNELS=
```

The `.env` is generated once. Subsequent installer runs update path and runtime variables idempotently via `upsert_env_var()` but never overwrite existing secrets.

---

## Data Directory (`~/.local/share/openpalm`)

Persistent storage for databases, vector stores, and shared volumes. Directories are created by the installer and populated by containers at first startup.

```
~/.local/share/openpalm/
├── postgres/          # PostgreSQL data directory
├── qdrant/            # Qdrant vector database storage
├── openmemory/        # OpenMemory persistent data
├── shared/            # Shared volume between opencode-core, admin, and openmemory
├── caddy/             # Caddy TLS certificates and persistent data
└── admin/             # Admin service persistent state (setup wizard, cron store)
```

### Volume Mount Map (Data)

| Host Path | Container | Mount Point | Mode |
|-----------|-----------|-------------|------|
| `postgres/` | postgres | `/var/lib/postgresql/data` | rw |
| `qdrant/` | qdrant | `/qdrant/storage` | rw |
| `openmemory/` | openmemory | `/data` | rw |
| `shared/` | opencode-core | `/shared` | rw |
| `shared/` | admin | `/shared` | rw |
| `shared/` | openmemory | `/shared` | rw |
| `caddy/` | caddy | `/data` | rw |
| `admin/` | admin | `/app/data` | rw |

---

## Config Directory (`~/.config/openpalm`)

User-editable configuration files. The installer seeds defaults but never overwrites existing files.

```
~/.config/openpalm/
├── opencode-core/
│   └── opencode.jsonc     # User override config (seeded as empty {})
├── caddy/
│   └── Caddyfile          # Reverse proxy configuration
├── channels/
│   ├── chat.env           # Chat channel credentials
│   ├── discord.env        # Discord channel credentials
│   ├── telegram.env       # Telegram channel credentials
│   └── voice.env          # Voice channel credentials
├── cron/                  # Automation definitions (scheduled prompts managed by admin)
│   ├── crontab            # (created by admin when automations are added)
│   └── cron-payloads/     # JSON payload files for each automation (one per automation ID)
├── secrets.env            # API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
└── user.env               # User-level environment overrides
```

### Key Config Files

**`opencode-core/opencode.jsonc`** — User override layer for the opencode-core container. Seeded as an empty JSON object `{}`. Extensions are baked into the container image at build time; this file exists so operators can add npm plugins, change permissions, or configure MCP connections without rebuilding images. Mounted at `/config/opencode.jsonc` inside the container. Inside the container, the config mount is referenced as `OPENCODE_CONFIG_DIR`.

**`caddy/Caddyfile`** — Reverse proxy rules. Routes `/channels/*` to channel adapters, `/admin/*` to the admin service, and enforces LAN-only access via IP matchers.

**`channels/*.env`** — Per-channel credential files (e.g., `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`). Each channel uses its own env file named after the channel (e.g., `channels/discord.env`, `channels/telegram.env`).

**`secrets.env`** — API keys consumed by opencode-core and openmemory. Operators populate this with their provider keys. This file implements the Connections concept -- named credential sets managed via the admin API. Keys use the `OPENPALM_CONN_*` naming prefix.

**`user.env`** — User-level environment variable overrides.

### Volume Mount Map (Config)

| Host Path | Container | Mount Point | Mode |
|-----------|-----------|-------------|------|
| `opencode-core/` | opencode-core | `/config` | rw |
| `opencode-core/` | admin | `/app/config/opencode-core` | rw |
| `caddy/Caddyfile` | caddy | `/etc/caddy/Caddyfile` | ro |
| `caddy/` | admin | `/app/config/caddy` | rw |
| `channels/` | admin | `/app/channel-env` | rw |
| `channels/chat.env` | channel-chat | env_file | — |
| `channels/discord.env` | channel-discord | env_file | — |
| `channels/telegram.env` | channel-telegram | env_file | — |
| `channels/voice.env` | channel-voice | env_file | — |
| `cron/` | opencode-core | `/cron` | rw |
| `secrets.env` | opencode-core | env_file | — |
| `secrets.env` | openmemory | env_file | — |
| `user.env` | opencode-core | env_file | — |
| `user.env` | openmemory | env_file | — |
| (entire config home) | admin | `/app/config-root` | rw |

---

## State Directory (`~/.local/state/openpalm`)

Runtime state, disposable on reinstall.

```
~/.local/state/openpalm/
├── docker-compose.yml     # Active compose file (copied from assets/state/)
├── .env                   # Copy of the working directory .env
├── opencode-core/         # OpenCode runtime state
├── gateway/               # Gateway audit logs and runtime data
├── caddy/                 # Caddy runtime config state
├── workspace/             # OpenCode working directory (mounted as /work)
├── observability/         # Logs and metrics (future)
├── backups/               # Backup storage (future)
└── uninstall.sh           # Uninstall script (copied from assets/state/scripts/)
```

### Volume Mount Map (State)

| Host Path | Container | Mount Point | Mode |
|-----------|-----------|-------------|------|
| (entire state home) | controller | `/workspace` | rw |
| (entire state home) | admin | `/workspace` | rw |
| `opencode-core/` | opencode-core | `/state` | rw |
| `gateway/` | gateway | `/app/data` | rw |
| `caddy/` | caddy | `/config` | rw |
| `workspace/` | opencode-core | `/work` | rw |

---

## Container Socket Mounting

The controller needs access to the host container runtime socket. The installer detects the runtime and configures the socket path.

| Runtime | Host Socket Path | Container Mount Point |
|---------|-----------------|----------------------|
| Docker | `/var/run/docker.sock` | `/var/run/openpalm-container.sock` |
| Podman (Linux) | `/run/user/$UID/podman/podman.sock` | `/var/run/openpalm-container.sock` |
| Podman (macOS) | `/var/run/docker.sock` | `/var/run/openpalm-container.sock` |
| OrbStack (macOS) | `~/.orbstack/run/docker.sock` | `/var/run/openpalm-container.sock` |

Inside the controller, `OPENPALM_CONTAINER_SOCKET_URI` is always `unix:///var/run/openpalm-container.sock`. The controller sets both `DOCKER_HOST` and `CONTAINER_HOST` to this URI when spawning compose commands.

---

## Network Ports and Bind Addresses

| Port | Service | Default Bind | Override Variable |
|------|---------|-------------|-------------------|
| 80 | Caddy HTTP | `0.0.0.0` | `OPENPALM_INGRESS_BIND_ADDRESS` |
| 443 | Caddy HTTPS | `0.0.0.0` | `OPENPALM_INGRESS_BIND_ADDRESS` |
| 3000 | OpenMemory UI | `0.0.0.0` | `OPENPALM_OPENMEMORY_UI_BIND_ADDRESS` |
| 4096 | OpenCode Core | `127.0.0.1` | `OPENCODE_CORE_BIND_ADDRESS` |
| 8765 | OpenMemory API | `0.0.0.0` | `OPENPALM_OPENMEMORY_BIND_ADDRESS` |
| 2222 | OpenCode SSH | `127.0.0.1` | `OPENCODE_CORE_SSH_BIND_ADDRESS` |

Internal-only ports (not exposed to host): gateway (8080), admin (8100), controller (8090), channel adapters (8181–8184), postgres (5432), qdrant (6333/6334).

---

## Service Architecture and Dependencies

```
caddy ──→ gateway ──→ opencode-core ──→ openmemory ──→ qdrant
  │                                            │
  │                                            └──→ postgres
  ├──→ admin ──→ controller
  │
  └──→ openmemory-ui ──→ openmemory

channel-chat ──→ gateway     (profile: channels)
channel-discord ──→ gateway  (profile: channels)
channel-voice ──→ gateway    (profile: channels)
channel-telegram ──→ gateway (profile: channels)
```

Channel adapters are in the `channels` compose profile and are not started by default. Enable with `--profile channels`.

---

## Extensions: Baked-In with Host Override

Extensions follow a layered model:

1. **Baked into images at build time** — `opencode/extensions/` is COPY'd to `/opt/openpalm/opencode-defaults/` in the `opencode-core` image. `gateway/opencode/` is COPY'd to `/opt/openpalm/opencode-defaults/` in the `gateway` image.

2. **Host override layer (opencode-core only)** — `~/.config/openpalm/opencode-core/` is mounted at `/config`. If `/config/opencode.jsonc` exists, the entrypoint uses `/config` as the config directory. If missing, it copies baked-in defaults from `/opt/openpalm/opencode-defaults/` into `/config`.

3. **Gateway has no host override** — the gateway's config is fully baked into its image with no host volume mount.

Extensions are organized into subdirectories by type: `skills/`, `commands/`, `agents/`, `tools/`, `plugins/`.

The installer does not seed extension files (plugins, skills, AGENTS.md). It seeds only an empty `opencode.jsonc` for user-level overrides.

---

## Repository Asset Structure

```
assets/
├── config/                    # User-editable config templates
│   ├── channels/
│   │   ├── chat.env
│   │   ├── discord.env
│   │   ├── telegram.env
│   │   └── voice.env
│   ├── secrets.env
│   ├── ssh/
│   │   └── authorized_keys
│   ├── system.env
│   └── user.env
└── state/                     # Runtime state templates
    ├── caddy/
    │   └── Caddyfile
    ├── content/
    │   └── banner.png
    ├── docker-compose.yml
    ├── registry/              # Community extension registry
    │   ├── README.md
    │   ├── index.json
    │   ├── openpalm-slack-channel.json
    │   └── schema.json
    └── scripts/
        ├── extensions-cli.ts
        ├── install.sh
        ├── install.ps1
        ├── uninstall.ps1
        └── uninstall.sh
```

Extension source code lives in service directories (not in `assets/`):
- `opencode/extensions/` — Core agent extensions
- `gateway/opencode/` — Gateway agent extensions

---

## Installation Flow

1. Detect OS, CPU architecture, and container runtime.
2. Bootstrap install assets from local `assets/` or download tarball from GitHub.
3. Generate `.env` from `assets/config/system.env` with auto-generated secrets.
4. Write resolved XDG paths and runtime config into `.env`.
5. Create XDG directory trees.
6. Copy `docker-compose.yml` and `.env` into the state directory.
7. Seed default configs (seed-not-overwrite): empty `opencode.jsonc`, Caddyfile, channel envs, `secrets.env`, `user.env`.
8. Copy uninstall script into state directory.
9. Start core services via compose.
10. Wait for admin health check, open setup UI in browser.

---

## Uninstallation

| Mode | Command | What It Does |
|------|---------|-------------|
| Default | `./uninstall.sh` | Stops containers, removes compose project |
| Remove images | `./uninstall.sh --remove-images` | Also removes pulled/built images |
| Remove all | `./uninstall.sh --remove-all` | Also removes all XDG directories |