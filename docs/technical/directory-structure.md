# Directory Structure & Volume Design

OpenPalm uses a single home directory (`~/.openpalm/` by default) with four
subdirectories that separate concerns by owner and sensitivity.

---

## Four-Directory Layout

```
~/.openpalm/                  OP_HOME — root of all OpenPalm state
├── config/                   User-editable configuration
├── vault/                    Secrets boundary
├── data/                     Service-managed persistent data
└── logs/                     Audit and debug logs
```

| Directory | Owner | Purpose |
|-----------|-------|---------|
| **config/** | User | Non-secret config: components, automations, OpenCode extensions |
| **vault/user/** | User | User-managed secrets: `user.env` (LLM keys, owner info) |
| **vault/stack/** | Admin | System-managed secrets: `stack.env` (admin token, HMAC, paths) |
| **data/** | Admin + Services | Memory, assistant home, guardian, component catalog |
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
├── vault/
│   ├── user/
│   │   └── user.env                   # User secrets: LLM provider keys
│   └── stack/
│       └── stack.env                  # System secrets: admin token, HMAC keys, paths
│
├── config/
│   ├── components/                    # Installed component instances
│   │   ├── channel-chat/
│   │   │   ├── compose.yml
│   │   │   └── .env
│   │   └── channel-discord/
│   │       ├── compose.yml
│   │       └── .env
│   ├── connections/                   # Canonical connection profile storage (user-editable JSON)
│   │   └── profiles.json             # Canonical profiles + assignments (v1 schema)
│   ├── automations/                   # Scheduled automations (YAML format, executed in-process)
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
│   ├── assistant/                    # System-managed OpenCode config (opencode.jsonc, AGENTS.md)
│   ├── opencode/                    # OpenCode data directory
│   ├── guardian/                    # Guardian runtime data
│   ├── catalog/                     # Installed component catalog
│   └── automations/                 # System-managed automations (YAML, pre-installed)
│       └── <name>.yml
│
└── logs/                              # Audit and debug logs
    ├── admin-audit.jsonl
    └── guardian-audit.log

~/.cache/openpalm/                     # Ephemeral cache (rollback snapshots)

~/openpalm/                            # WORK_DIR (assistant workspace)
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
| `$OP_HOME/data/assistant` | `/etc/opencode` | rw | System config (`OPENCODE_CONFIG_DIR`) -- model, plugins, persona |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | User extensions -- custom tools, plugins, skills |
| `$OP_HOME/data/opencode` | `/home/opencode/.local/share/opencode` | rw | OpenCode data directory |
| `$OP_WORK_DIR` | `/work` | rw | Working directory for projects |

Users drop tools, plugins, or skills into `config/assistant/` and they
appear inside the container at the standard OpenCode user config path. This
complements the system config at `/etc/opencode/` without requiring a rebuild.

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

Scheduled automations run in-process on the admin container using the
Croner scheduler. The admin container runs as non-root (USER node).

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
| `channel_lan` | guardian, channel services | LAN-restricted channel access |
| `channel_public` | guardian, channel services | Publicly accessible channels |

Component compose overlays specify which networks they join.

---

## Secrets & Config Management

Runtime configuration is split into two env files in `vault/`:

### `vault/stack/stack.env` -- system-managed config

Seeded by setup scripts. Contains host-detected infrastructure config.
The admin reads and updates this file on each apply -- it is system-managed
and not intended for direct user editing:

- **Paths:** `OP_HOME`, `OP_WORK_DIR`
- **User/Group:** `OP_UID`, `OP_GID` (auto-detected from host)
- **Docker Socket:** `OP_DOCKER_SOCK` (auto-detected, supports OrbStack/Colima)
- **Images:** `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG`
- **Networking:** `OP_INGRESS_BIND_ADDRESS`, `OP_INGRESS_PORT`
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

## Component Discovery

Components are discovered from `config/components/` at apply time.

Add-on definitions (channels, services) live in `stack/addons/` and are bundled into
the admin image at build time. Automations live in `stack/automations/`. Components
are installed from the addon catalog via the admin API or manually by placing a
directory with `compose.yml` in `config/components/`. No container rebuild required.
The admin's apply endpoint scans the directory and runs compose operations against
discovered files.

## Apply Action (Required)

OpenPalm uses an explicit **apply** step to synchronize source configuration
into the running stack:

1. Read user-edited files from `config/` and system assets bundled with the admin.
2. Write configuration files directly to their final locations.
3. Run `docker compose` and restart services.

The admin automatically runs apply during application startup. Restarting the
admin container syncs the latest source configuration into the running stack.

Automatic lifecycle apply is a non-destructive sync for config/: it writes
from current source files and may seed missing defaults, but it does not
overwrite existing user configuration files. Explicit config mutations in
config/ happen only through explicit user-intent actions -- direct edits,
admin UI/API config actions, or authenticated/allowlisted assistant calls via
admin API. (See [core-principles.md](./core-principles.md) for the full policy.)

A component needs:
- `compose.yml` -- compose definition for the service (required)
- `.env` -- instance environment variables (created during install)

`CHANNEL_<NAME>_SECRET` values are generated by admin logic and written into
`vault/stack/stack.env` on every apply.

---

## Automations

OpenPalm supports scheduled automations on the admin container using an
in-process scheduler (Croner). Automation files are YAML. The scheduler
runs in-process -- no system cron or root privileges required.

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

### System automations

System-managed automation files live in `data/automations/`. These are
seeded during install and survive updates. They use the same YAML format as
user automations.

### Precedence

User files with the same name as a system file override the system version.
The in-process scheduler loads files on startup and reloads after
component install/uninstall. Changes require a container restart (triggered
by apply).

---

## Working Directory

The assistant container mounts `$OP_WORK_DIR` (default: `$HOME/openpalm`)
at `/work` and sets it as the working directory. This is where the assistant
operates on user projects and scripts.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OP_WORK_DIR` | `$HOME/openpalm` | Host directory mounted at `/work` in the assistant |
