# Directory Structure & Volume Design

OpenPalm follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)
to organize host-side files into three tiers. Each tier has a clear owner
(user vs. system) and a single Docker mount target.

---

## Three-Tier Layout

```
~/.config/openpalm/         CONFIG_HOME  — user-editable
~/.local/share/openpalm/    DATA_HOME    — opaque service data
~/.local/state/openpalm/    STATE_HOME   — assembled runtime
```

| Tier | Env Variable | Default | Owner | Purpose |
|------|-------------|---------|-------|---------|
| **CONFIG_HOME** | `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User | Secrets, channels, OpenCode extensions |
| **DATA_HOME** | `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Services | Postgres, Qdrant, OpenMemory, assistant home |
| **STATE_HOME** | `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Admin | Assembled runtime, audit logs |

**CONFIG_HOME is the single user touchpoint.** Users edit files here: add
channels, manage secrets, drop in OpenCode extensions. The other two tiers are
opaque — services write persistent data to DATA_HOME and the admin assembles
runtime artifacts in STATE_HOME.

---

## Full Directory Tree

```
CONFIG_HOME (~/.config/openpalm/)
├── secrets.env              # User secrets only: ADMIN_TOKEN and LLM provider keys
├── channels/                # Installed channel definitions (populated via admin API or manually)
│   ├── <name>.yml           # Compose overlay for channel-<name> (installed from registry or manually added)
│   └── <name>.caddy         # Caddy route (optional — installed alongside .yml)
└── opencode/                # OpenCode user extensions (tools, plugins, skills)
    ├── opencode.json        # User OpenCode config (schema ref only; never overwritten)
    ├── tools/               # Custom tool definitions
    ├── plugins/             # Custom plugin definitions
    └── skills/              # Custom skill definitions

STATE_HOME (~/.local/state/openpalm/)
├── artifacts/
│   ├── docker-compose.yml   # Staged core compose file
│   ├── stack.env            # Staged stack config (merged from DATA_HOME/stack.env + admin-managed values)
│   ├── secrets.env          # Staged copy of CONFIG_HOME/secrets.env
│   └── manifest.json        # Artifact checksums & timestamps
│   ├── Caddyfile            # Staged Caddy config (copied from DATA_HOME/caddy/Caddyfile)
│   └── channels/            # Staged channel overlays/snippets used at runtime
└── audit/
    ├── admin-audit.jsonl    # Admin audit log
    └── guardian-audit.log    # Guardian audit log

DATA_HOME (~/.local/share/openpalm/)
├── stack.env                # Source of truth for host-detected infrastructure config
├── postgres/                # PostgreSQL data files
├── qdrant/                  # Qdrant vector-store data
├── openmemory/              # OpenMemory persistent data
├── assistant/               # Assistant /home/opencode (dotfiles, caches)
├── guardian/                 # Guardian runtime data
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

### PostgreSQL

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/postgres` | `/var/lib/postgresql/data` | rw | Database files |

### Qdrant

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/qdrant` | `/qdrant/storage` | rw | Vector-store data |

### OpenMemory MCP

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/openmemory` | `/data` | rw | Memory service data |

### Assistant (OpenCode Runtime)

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$DATA_HOME/assistant` | `/home/opencode` | rw | User home (dotfiles, caches) |
| `$CONFIG_HOME/opencode` | `/home/opencode/.config/opencode` | rw | OpenCode extensions overlay |
| `$OPENPALM_WORK_DIR` | `/work` | rw | Working directory for projects |

The OpenCode extensions mount overlays onto the assistant's home directory.
Users drop tools, plugins, or skills into `CONFIG_HOME/opencode/` and they
appear inside the container at the standard OpenCode user config path. This
complements the built-in config at `/opt/opencode/` without requiring a rebuild.

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
| `$STATE_HOME` | `$STATE_HOME` (same path) | rw | Assembled runtime, audit logs |
| `/var/run/docker.sock` | `/var/run/docker.sock` | rw | Docker daemon for orchestration |

The admin is the only container with Docker socket access. It mounts
CONFIG_HOME, DATA_HOME, and STATE_HOME using identical host-to-container paths,
and uses `process.env.OPENPALM_*` to resolve paths at runtime. The DATA_HOME
mount allows the admin to pre-create subdirectories with correct ownership
before other services start.

---

## Docker Networks

| Network | Services | Purpose |
|---------|----------|---------|
| `assistant_net` | caddy, postgres, qdrant, openmemory, openmemory-ui, assistant, guardian, admin | Internal service mesh |
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
config that the admin never overwrites:

- **XDG paths:** `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_WORK_DIR`
- **User/Group:** `OPENPALM_UID`, `OPENPALM_GID` (auto-detected from host)
- **Docker Socket:** `OPENPALM_DOCKER_SOCK` (auto-detected, supports OrbStack/Colima)
- **Images:** `OPENPALM_IMAGE_NAMESPACE`, `OPENPALM_IMAGE_TAG`
- **Networking:** `OPENPALM_INGRESS_BIND_ADDRESS`, `OPENPALM_INGRESS_PORT`
- **OpenMemory:** `OPENMEMORY_DASHBOARD_API_URL`, `OPENMEMORY_USER_ID`
- **Database:** `POSTGRES_PASSWORD` (auto-generated by setup.sh, updated in-place by admin)
- **Channel HMAC keys:** `CHANNEL_<NAME>_SECRET` (auto-generated per channel by admin)

On each apply, the admin reads `DATA_HOME/stack.env`, merges in its dynamic
values (`POSTGRES_PASSWORD`, `OPENPALM_SETUP_COMPLETE`, `CHANNEL_*_SECRET`),
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

System-managed values (`POSTGRES_PASSWORD`, `CHANNEL_*_SECRET`, `OPENPALM_*`)
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

Until apply runs, edits in `CONFIG_HOME` are source-of-truth inputs but are not
active runtime configuration.

A channel needs:
- `<name>.yml` — compose overlay defining the service (required)
- `<name>.caddy` — Caddy route for HTTP access (optional)

`CHANNEL_<NAME>_SECRET` values are generated by admin logic and written into
`DATA_HOME/stack.env` (then staged to `STATE_HOME/artifacts/stack.env`) on every apply.

---

## Working Directory

The assistant container mounts `$OPENPALM_WORK_DIR` (default: `$HOME/openpalm`)
at `/work` and sets it as the working directory. This is where the assistant
operates on user projects and scripts.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENPALM_WORK_DIR` | `$HOME/openpalm` | Host directory mounted at `/work` in the assistant |
