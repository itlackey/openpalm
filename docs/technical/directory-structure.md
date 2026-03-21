# Directory Structure & Volume Design

OpenPalm uses a single home directory (`~/.openpalm/` by default) with a small
set of top-level directories that separate concerns by owner and sensitivity.

---

## Home Layout

```
~/.openpalm/                  OP_HOME — root of all OpenPalm state
├── config/                   User-editable configuration
├── stack/                    Live compose assembly
├── vault/                    Secrets boundary
├── data/                     Service-managed persistent data
└── logs/                     Audit and debug logs
```

| Directory | Owner | Purpose |
|-----------|-------|---------|
| **config/** | User | Non-secret config: automations, connections, OpenCode extensions |
| **stack/** | User + CLI/Admin | Live compose assets: `core.compose.yml` + addon overlays |
| **vault/user/** | User | User-managed secrets: `user.env` (LLM keys, owner info) |
| **vault/stack/** | Admin | System-managed secrets: `stack.env` (admin token, HMAC, paths) |
| **data/** | Services | Memory, assistant state, guardian runtime data, stash, workspace |
| **logs/** | Services | Consolidated audit/debug output |

**config/ is the user-owned persistent source of truth** and the primary touchpoint for user-managed config.
Allowed writers are: direct user edits; explicit admin UI/API config actions;
and assistant-triggered admin API config actions that are authenticated,
allowlisted, and executed on user request. Automatic lifecycle sync
(install/update/startup apply/setup reruns/upgrades) is non-destructive:
it may seed missing defaults but must not overwrite existing user files.
Services write their durable runtime data to data/; the admin also manages
system-policy files there.

---

## Full Directory Tree

```
~/.openpalm/                           # OP_HOME
├── stack/
│   ├── core.compose.yml               # Base compose definition
│   └── addons/
│       ├── admin/
│       │   └── compose.yml
│       ├── chat/
│       │   └── compose.yml
│       ├── api/
│       │   └── compose.yml
│       └── voice/
│           └── compose.yml
│
├── vault/
│   ├── user/
│   │   └── user.env                   # User secrets: LLM provider keys
│   └── stack/
│       └── stack.env                  # System secrets: admin token, HMAC keys, paths
│
├── config/
│   ├── automations/                   # Scheduled automations (YAML format)
│   │   └── <name>.yml
│   └── assistant/                     # OpenCode user extensions (tools, plugins, skills)
│       ├── opencode.json             # User OpenCode config (schema ref only; never overwritten)
│       ├── tools/
│       ├── plugins/
│       └── skills/
│
├── data/
│   ├── admin/                        # Admin runtime home
│   ├── memory/                       # Memory persistent data (SQLite + sqlite-vec)
│   ├── assistant/                    # Assistant runtime state
│   ├── opencode/                     # OpenCode data directory
│   ├── guardian/                     # Guardian runtime data
│   ├── stash/                        # AKM stash directory
│   └── workspace/                    # Shared assistant workspace
│
└── logs/                              # Audit and debug logs
    ├── admin-audit.jsonl
    └── guardian-audit.log

~/.cache/openpalm/                     # Ephemeral cache (rollback snapshots)

~/.openpalm/data/workspace/            # Assistant workspace mounted at /work
```

---

## Volume Mounts

Each container mounts only what it needs. The table below shows every bind
mount in the stack.

### Memory

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$OP_HOME/data/memory` | `/data` | rw | Memory service data |
| `$OP_HOME/data/memory/default_config.json` | `/app/default_config.json` | ro | Memory service LLM/embedder config |

### Assistant (OpenCode Runtime)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| baked into image | `/etc/opencode` | ro | Core OpenCode config baked into the assistant image |
| `$OP_HOME/config` | `/etc/openpalm` | ro | Host-side OpenPalm config bundle |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | User extensions -- custom tools, plugins, skills |
| `$OP_HOME/vault/user/user.env` | `/etc/openpalm-vault/user.env` | ro | User-managed provider keys |
| `$OP_HOME/data/assistant` | `/home/opencode/.opencode` | rw | Assistant runtime state |
| `$OP_HOME/data/stash` | `/home/opencode/.akm` | rw | AKM stash data |
| `$OP_HOME/data/workspace` | `/work` | rw | Working directory for projects |
| `$OP_HOME/logs/opencode` | `/home/opencode/.local/state/opencode` | rw | OpenCode logs/state |

Users drop tools, plugins, or skills into `config/assistant/` and they appear
inside the container at the standard OpenCode user config path. Core config is
still baked into the image at `/etc/opencode`.

### Guardian

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$OP_HOME/data/guardian` | `/app/data` | rw | Guardian runtime data |
| `$OP_HOME/logs` | `/app/audit` | rw | Guardian audit log (guardian-audit.log) |

The guardian discovers channel secrets via the `loadChannelSecrets()` function
(server.ts). It reads `CHANNEL_*_SECRET` environment variables injected by
Docker Compose from the vault env files.

### Admin

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$OP_HOME/config` | config mount | rw | Component files, extensions |
| `$OP_HOME/vault` | vault mount | rw | Secrets (user/user.env, stack/stack.env) |
| `$OP_HOME/data` | data mount | rw | Manage system-policy files, pre-create subdirs |
| `$OP_HOME/logs` | logs mount | rw | Audit logs |

The admin accesses Docker via the socket proxy (HTTP over `admin_docker_net`).

The admin provides the web UI and API. Scheduled automations run separately on
the dedicated `scheduler` service.

### Docker Socket Proxy

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$OP_DOCKER_SOCK` | `/var/run/docker.sock` | **ro** | Docker daemon socket (proxy only) |

The `docker-socket-proxy` (Tecnativa) is the **only** container that mounts
the Docker socket. It exposes a filtered HTTP API on port 2375 within the
isolated `admin_docker_net` network -- a dedicated network shared only with the
admin service. No other service can reach the proxy. The admin connects via
`DOCKER_HOST=tcp://docker-socket-proxy:2375`.

**`OP_DOCKER_SOCK`** is auto-detected by the setup scripts via
`docker context inspect` and written to `vault/stack/stack.env`.
If not set, it defaults to `/var/run/docker.sock`.

---

## Docker Networks

| Network | Services | Purpose |
|---------|----------|---------|
| `assistant_net` | memory, assistant, guardian, admin, scheduler | Internal service mesh |
| `channel_lan` | guardian, addon edge services | LAN-restricted channel access |
| `channel_public` | guardian, addon edge services | Publicly accessible channels |

Component compose overlays specify which networks they join.

---

## Secrets & Config Management

Runtime configuration is split into two env files in `vault/`:

### `vault/stack/stack.env` -- system-managed config

Seeded by setup scripts. Contains host-detected infrastructure config.
The CLI/admin may update this file during lifecycle operations -- it is system-managed
and not intended for direct user editing:

- **Paths:** `OP_HOME`
- **User/Group:** `OP_UID`, `OP_GID` (auto-detected from host)
- **Docker Socket:** `OP_DOCKER_SOCK` (auto-detected, supports OrbStack/Colima)
- **Images:** `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG`
- **Host binds:** `OP_ADMIN_PORT`, `OP_ASSISTANT_PORT`, `OP_MEMORY_PORT`, `OP_CHAT_PORT`, `OP_API_PORT`, `OP_VOICE_PORT`
- **Memory:** `MEMORY_DASHBOARD_API_URL`, `MEMORY_USER_ID`
- **Channel HMAC keys:** `CHANNEL_<NAME>_SECRET` (auto-generated per channel by admin)

### `vault/user/user.env` -- user secrets

User-managed secrets. By convention this file contains LLM provider keys:

```env
# vault/user/user.env
OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=
```

### Adding a secret for a new channel

No manual secret creation is required. Installing a channel via the admin API
auto-generates a channel HMAC secret and writes it into `vault/stack/stack.env`.
The guardian reads channel secrets from environment variables injected by
Docker Compose.

---

## Addon Discovery

Addon overlays live in `~/.openpalm/stack/addons/`.

The compose command you run determines which addons are enabled. Manual users do
that by including the desired addon compose files with `-f`. Tools such as the
CLI, admin, or `stack/start.sh` may help generate the same compose command, but
they do not replace this file-based model.

## Runtime Updates

To change the running stack:

1. Edit files under `~/.openpalm/config/`, `~/.openpalm/vault/`, or `~/.openpalm/stack/` as needed.
2. Rerun `docker compose` with the desired `-f` file list, or use `stack/start.sh` with the same addon set.

Automatic lifecycle operations remain non-destructive for `config/`: they may
seed missing defaults, but they do not overwrite existing user configuration
files. Explicit config mutations happen only through direct edits, admin UI/API
actions, or authenticated/allowlisted assistant calls via the admin API.

An addon needs:
- `compose.yml` -- compose definition for the service (required)

`CHANNEL_<NAME>_SECRET` values are generated by admin logic and written into
`vault/stack/stack.env` during lifecycle operations.

---

## Automations

OpenPalm supports scheduled automations on the dedicated `scheduler` service
using Croner. Automation files are YAML. No system cron or root privileges are
required.

### Adding an automation

Drop a `.yml` file into `config/automations/`:

```yaml
# health-check.yml
name: Health Check
schedule: every-5-minutes
action:
  type: api
  method: GET
  path: /health
```

Three action types are supported: `api` (admin API call with auto-injected
token), `http` (any HTTP endpoint), and `shell` (execFile with argument array).

### File naming

Filenames must be lowercase alphanumeric with hyphens and a `.yml` extension
(`[a-z0-9][a-z0-9-]*.yml`). Examples: `backup.yml`, `weekly-cleanup.yml`.

The scheduler loads automation files from `config/automations/` on startup.
Changes take effect after restarting the `scheduler` service.

---

## Working Directory

The assistant container mounts `~/.openpalm/data/workspace` at `/work` and sets
it as the working directory. This is where the assistant operates on user
projects and scripts.

| Variable | Default | Purpose |
|----------|---------|---------|
| `~/.openpalm/data/workspace` | default workspace | Host directory mounted at `/work` in the assistant |
