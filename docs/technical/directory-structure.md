# Directory Structure & Volume Design

OpenPalm follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)
to organize host-side files into three tiers. Each tier has a clear owner
(user vs. system) and a single Docker mount target.

---

## Three-Tier Layout

```
~/.config/openpalm/         CONFIG_HOME  — user-editable
~/.local/share/openpalm/    DATA_HOME    — admin/service-managed data
~/.local/state/openpalm/    STATE_HOME   — assembled runtime
```

| Tier | Env Variable | Default | Owner | Purpose |
|------|-------------|---------|-------|---------|
| **CONFIG_HOME** | `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User | Secrets, channels, OpenCode extensions |
| **DATA_HOME** | `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Admin + Services | Memory, assistant home, guardian, caddy data, stack.env |
| **STATE_HOME** | `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Admin | Assembled runtime, audit logs |

**CONFIG_HOME is the user-owned persistent source of truth** and the primary touchpoint for user-managed config.
Allowed writers are: direct user edits; explicit admin UI/API config actions;
and assistant-triggered admin API config actions that are authenticated,
allowlisted, and executed on user request. Automatic lifecycle sync
(install/update/startup apply/setup reruns/upgrades) is non-destructive:
it may seed missing defaults but must not overwrite existing user files.
Services write their durable runtime data to DATA_HOME; the admin also manages
system-policy files there (`stack.env`, `caddy/Caddyfile`, `automations/`).
The admin assembles runtime artifacts in STATE_HOME.

---

## Full Directory Tree

```
CONFIG_HOME (~/.config/openpalm/)
├── secrets.env              # User secrets only: ADMIN_TOKEN and LLM provider keys
├── connections/             # Canonical connection profile storage (user-editable JSON)
│   └── profiles.json        # Canonical profiles + assignments (v1 schema)
├── channels/                # Installed channel definitions (populated via admin API or manually)
│   ├── <name>.yml           # Compose overlay for channel-<name> (installed from registry or manually added)
│   └── <name>.caddy         # Caddy route (optional — installed alongside .yml)
├── automations/             # Scheduled automations (YAML format, executed in-process)
│   └── <name>.yml          # Automation YAML file: schedule, action type, and config
└── assistant/               # OpenCode user extensions (tools, plugins, skills)
    ├── opencode.json        # User OpenCode config (schema ref only; never overwritten)
    ├── tools/               # Custom tool definitions
    ├── plugins/             # Custom plugin definitions
    └── skills/              # Custom skill definitions

STATE_HOME (~/.local/state/openpalm/)
├── artifacts/
│   ├── docker-compose.yml   # Staged core compose file
│   ├── stack.env            # Staged stack config (merged from DATA_HOME/stack.env + admin-managed values)
│   ├── secrets.env          # Staged copy of CONFIG_HOME/secrets.env
│   ├── manifest.json        # Artifact checksums & timestamps
│   ├── Caddyfile            # Staged Caddy config (copied from DATA_HOME/caddy/Caddyfile)
│   └── channels/            # Staged channel overlays/snippets used at runtime
├── automations/             # Staged automation YAML files (assembled from DATA_HOME + CONFIG_HOME)
│   └── <name>.yml          # Staged automation YAML loaded by in-process scheduler
└── audit/
    ├── admin-audit.jsonl    # Admin audit log
    └── guardian-audit.log    # Guardian audit log

DATA_HOME (~/.local/share/openpalm/)
├── stack.env                # Source of truth for host-detected infrastructure config
├── admin/                   # Admin runtime home (varlock state, future per-admin cache)
├── memory/              # Memory persistent data (SQLite + embedded Qdrant)
├── assistant/               # System-managed OpenCode config (opencode.jsonc, AGENTS.md)
├── opencode/                # OpenCode data directory
├── guardian/                 # Guardian runtime data
├── automations/             # System-managed automations (YAML, pre-installed, survive updates)
│   └── <name>.yml          # System automation YAML file
└── caddy/
    ├── Caddyfile            # System-managed core Caddy policy source
    ├── data/                # Caddy TLS certificates
    └── config/              # Caddy runtime config
```

---

## Volume Mounts

Each container mounts only what it needs. The table below shows every bind
mount in the stack.

### Caddy (Reverse Proxy)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$STATE_HOME/artifacts/Caddyfile` | `/etc/caddy/Caddyfile` | ro | Staged Caddy config |
| `$STATE_HOME/artifacts/channels` | `/etc/caddy/channels` | ro | Staged channel `.caddy` route files |
| `$DATA_HOME/caddy/data` | `/data/caddy` | rw | TLS certificates and state |
| `$DATA_HOME/caddy/config` | `/config/caddy` | rw | Caddy runtime config |

The staged Caddyfile includes `import channels/public/*.caddy` and
`import channels/lan/*.caddy` — Caddy loads staged route files from
`/etc/caddy/channels/` at startup. Adding or removing a `.caddy` file in
CONFIG_HOME/channels/ requires an apply action that re-stages channel files
into STATE_HOME/artifacts/channels before Caddy reload.

The source-of-truth core Caddyfile is `DATA_HOME/caddy/Caddyfile` and is
system-managed by admin logic.

### Memory

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/memory` | `/data` | rw | Memory service data |
| `$DATA_HOME/memory/default_config.json` | `/app/default_config.json` | ro | mem0 LLM/embedder config |

### Assistant (OpenCode Runtime)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/assistant` | `/etc/opencode` | rw | System config (`OPENCODE_CONFIG_DIR`) — model, plugins, persona |
| `$CONFIG_HOME/assistant` | `/home/opencode/.config/opencode` | rw | User extensions — custom tools, plugins, skills |
| `$STATE_HOME/opencode` | `/home/opencode/.local/state/opencode` | rw | Logs and session state |
| `$DATA_HOME/opencode` | `/home/opencode/.local/share/opencode` | rw | OpenCode data directory |
| `$OPENPALM_WORK_DIR` | `/work` | rw | Working directory for projects |

Users drop tools, plugins, or skills into `CONFIG_HOME/assistant/` and they
appear inside the container at the standard OpenCode user config path. This
complements the system config at `/etc/opencode/` without requiring a rebuild.

### Guardian

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/guardian` | `/app/data` | rw | Guardian runtime data |
| `$STATE_HOME/audit` | `/app/audit` | rw | Guardian audit log (guardian-audit.log) |
| `$STATE_HOME/artifacts/stack.env` | `/app/secrets/stack.env` | ro | Channel HMAC secrets (file-based discovery) |

The guardian discovers channel secrets via the `loadChannelSecrets()` function
(server.ts). It reads from the bind-mounted `stack.env` file at the path
specified by `GUARDIAN_SECRETS_PATH` (default: `/app/secrets/stack.env`).
If the file is unavailable, it falls back to reading `CHANNEL_*_SECRET`
environment variables directly (useful for dev/test without a secrets file).

### Admin

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$CONFIG_HOME` | `$CONFIG_HOME` (same path) | rw | Channel files, secrets, extensions |
| `$DATA_HOME` | `$DATA_HOME` (same path) | rw | Pre-create DATA_HOME subdirs, ensure ownership |
| `$STATE_HOME` | `$STATE_HOME` (same path) | rw | Assembled runtime, audit logs, staged automations |

The admin accesses Docker via the socket proxy (HTTP over `admin_docker_net`).
It mounts CONFIG_HOME, DATA_HOME, and STATE_HOME using identical
host-to-container paths, and uses `process.env.OPENPALM_*` to resolve paths
at runtime. The DATA_HOME mount allows the admin to manage system-policy files
(`stack.env`, `caddy/Caddyfile`, `automations/`), pre-create subdirectories
with correct ownership, and seed missing defaults before other services start.

Scheduled automations run in-process on the admin container using the
Croner scheduler. Staged YAML automation files from `STATE_HOME/automations/`
are loaded on startup. The admin container runs as non-root (USER node).
See the Automations section below for file format and configuration.

---

## Docker Networks

| Network | Services | Purpose |
|---------|----------|---------|
| `assistant_net` | caddy, memory, assistant, guardian, admin | Internal service mesh |
| `channel_lan` | caddy, guardian, channel services | LAN-restricted channel access |
| `channel_public` | caddy, guardian, channel services | Publicly accessible channels |

Channel compose overlays specify which network they join. HTTP routing access is
controlled by staged `.caddy` files: routes are LAN-restricted by default and
become public only when the source `.caddy` includes `import public_access`.
A channel with no `.caddy` file gets no HTTP route regardless of network — it's
only reachable on the Docker network.

---

## Secrets & Config Management

All runtime configuration is split into two staged env files in `STATE_HOME/artifacts/`:

### `stack.env` — ALL system-managed config

The source of truth is `DATA_HOME/stack.env`, seeded by `setup.sh` (or
`scripts/dev-setup.sh --seed-env` in dev). Contains host-detected infrastructure
config. The admin reads, merges, and updates this file on each apply — it is
system-managed and not intended for direct user editing:

- **XDG paths:** `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_WORK_DIR`
- **User/Group:** `OPENPALM_UID`, `OPENPALM_GID` (auto-detected from host)
- **Docker Socket:** `OPENPALM_DOCKER_SOCK` (auto-detected, supports OrbStack/Colima)
- **Images:** `OPENPALM_IMAGE_NAMESPACE`, `OPENPALM_IMAGE_TAG`
- **Networking:** `OPENPALM_INGRESS_BIND_ADDRESS`, `OPENPALM_INGRESS_PORT`
- **Memory:** `MEMORY_DASHBOARD_API_URL`, `MEMORY_USER_ID`
- **Channel HMAC keys:** `CHANNEL_<NAME>_SECRET` (auto-generated per channel by admin)

On each apply, the admin reads `DATA_HOME/stack.env`, merges in its dynamic
values (`OPENPALM_SETUP_COMPLETE`, `CHANNEL_*_SECRET`),
updates `DATA_HOME/stack.env`, and stages the result to
`STATE_HOME/artifacts/stack.env` for compose consumption.

### `secrets.env` — user secrets

A staged copy of `CONFIG_HOME/secrets.env`, copied as-is. By convention this
file contains only `ADMIN_TOKEN` and LLM provider keys:

```env
# CONFIG_HOME/secrets.env
ADMIN_TOKEN=<token>
OPENAI_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=
```

System-managed values (`CHANNEL_*_SECRET`, `OPENPALM_*`)
live in `stack.env` and do not need to appear here, but extra variables are
allowed if a user has a specific need.

### Adding a secret for a new channel

No manual secret creation is required. Installing a channel via the admin API
auto-generates a channel HMAC secret, writes it into `DATA_HOME/stack.env`,
and stages the result to `STATE_HOME/artifacts/stack.env` on the next apply.
The guardian reads channel secrets from the bind-mounted `stack.env`.

---

## Channel Discovery

Channels are discovered from `CONFIG_HOME/channels/` at apply time, then staged
into `STATE_HOME/artifacts/channels/` for runtime use.

Channel definitions are cataloged in the `registry/` directory and bundled into
the admin image at build time. Channels are installed from the registry via the
admin API (`POST /admin/channels/install`) or manually by placing `.yml` (and
optional `.caddy`) files in `CONFIG_HOME/channels/`. No container rebuild
required. The admin's apply endpoint scans the directory, stages discovered
channels into STATE_HOME, then runs compose/Caddy operations against staged
files only.

## Apply Action (Required)

OpenPalm uses an explicit **apply** step to synchronize source configuration
into runtime state:

1. Read user-edited files from `CONFIG_HOME` and system assets bundled with the admin.
2. Copy whole files into `STATE_HOME` (`artifacts/`, `channels/`, staged `Caddyfile`).
3. Run `docker compose` and reload/restart services using only staged files.

The admin automatically runs apply during application startup. Restarting the
admin container syncs the latest source configuration into runtime state when
the app starts.

Automatic lifecycle apply is a non-destructive sync for CONFIG_HOME: it stages
from current source files and may seed missing defaults, but it does not
overwrite existing user configuration files. Explicit config mutations in
CONFIG_HOME happen only through explicit user-intent actions — direct edits,
admin UI/API config actions, or authenticated/allowlisted assistant calls via
admin API. (See [core-principles.md](./core-principles.md) for the full policy.)

Until apply runs, edits in `CONFIG_HOME` are source-of-truth inputs but are not
active runtime configuration.

A channel needs:
- `<name>.yml` — compose overlay defining the service (required)
- `<name>.caddy` — Caddy route for HTTP access (optional)

`CHANNEL_<NAME>_SECRET` values are generated by admin logic and written into
`DATA_HOME/stack.env` (then staged to `STATE_HOME/artifacts/stack.env`) on every apply.

---

## Automations

OpenPalm supports scheduled automations on the admin container using an
in-process scheduler (Croner). Automation files are YAML and follow the same
staging pattern as channels: user files in CONFIG_HOME, system files in
DATA_HOME, both staged to STATE_HOME for runtime consumption. The scheduler
runs in-process — no system cron or root privileges required.

### Adding an automation

Drop a `.yml` file into `CONFIG_HOME/automations/`:

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

System-managed automation files live in `DATA_HOME/automations/`. These are
seeded during install and survive updates. They use the same YAML format as
user automations.

### Staging and precedence

On every apply, the admin stages automation files into `STATE_HOME/automations/`:

1. Copy all `.yml` files from `DATA_HOME/automations/` (system automations)
2. Copy all `.yml` files from `CONFIG_HOME/automations/` (user automations)

User files with the same name as a system file override the system version.
The in-process scheduler loads staged files on startup and reloads after
channel install/uninstall. Changes require a container restart (triggered
by apply).

---

## Working Directory

The assistant container mounts `$OPENPALM_WORK_DIR` (default: `$HOME/openpalm`)
at `/work` and sets it as the working directory. This is where the assistant
operates on user projects and scripts.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENPALM_WORK_DIR` | `$HOME/openpalm` | Host directory mounted at `/work` in the assistant |
