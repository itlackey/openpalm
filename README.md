# OpenPalm MVP

This repository contains the minimal MVP implementation aligned to `prd.md` and `api-spec.md`:

- `core/admin/` — SvelteKit operator UI, Admin API, and Control Plane
- `core/guardian/` — Bun HTTP server for channel traffic ingress (HMAC, rate limiting)
- `core/assistant/` — OpenCode assistant runtime configuration and skills
- `channels/` — Channel adapter source code (chat, discord, etc.)
- `packages/lib/` — Shared SDK (`@openpalm/lib`): channel validation, crypto, logger
- `registry/` — Channel registry: compose overlays and Caddy routes available for installation
- `assets/` — Static Docker Compose, Caddyfile, and secrets template

## Architecture: Single Orchestration Path

OpenPalm enforces a strict single orchestration path:

```
CLI / UI / Assistant  -->  Admin API  -->  Control Plane (state + artifacts)
```

**Key rules:**
- The **Admin API** is the sole orchestrator for all stack lifecycle operations.
- The **CLI**, **UI**, and **assistant runtime** are all API clients — none execute Docker Compose or Docker commands directly.
- The **Guardian** is the sole ingress path for channel traffic — all channel adapters forward through Guardian, which validates signatures, payloads, and rate limits before forwarding to the assistant.
- The **assistant runtime** has no Docker socket access and can only request allowlisted admin operations via the Admin API.

See `docs/api-spec.md` for the current endpoint contract, and `docs/prd.md` for MVP constraints.

## Configuration Architecture

Infrastructure configuration uses static files with native composition mechanisms — no string-building or code generation for the core layout.

```
assets/
  docker-compose.yml       # Core services (caddy, postgres, qdrant, openmemory, assistant, guardian, admin)
  Caddyfile                # Seed template for core reverse proxy routes
  secrets.env              # Secrets and environment variable template

registry/                  # Channel registry (at repo root)
  chat.yml                 # Compose overlay: adds channel-chat service
  chat.caddy               # Caddy route: /channels/chat/* → channel-chat:8181
  discord.yml / .caddy     # Same pattern for each channel
  telegram.yml / .caddy
  voice.yml / .caddy
```

**Docker Compose overlays** — Channel services live in separate compose files merged via `-f`:
```bash
docker compose -f docker-compose.yml -f registry/chat.yml -f registry/discord.yml up -d
```

**Caddy imports** — The core Caddyfile loads staged channel routes with `import channels/public/*.caddy` and `import channels/lan/*.caddy`.

**Core Caddy source** — In admin-managed mode, the source-of-truth core
Caddyfile is system-managed at `DATA_HOME/caddy/Caddyfile` and staged to
`STATE_HOME/Caddyfile` during apply.

**Access control** — A `(lan_only)` snippet in the Caddyfile restricts routes to private networks. Channel `.caddy` files are LAN-restricted by default; only files that explicitly include `import public_access` are staged as public routes.

**Environment** — Each service's `environment:` block uses `${VAR}` substitution, scoped to only the variables that service needs. Docker Compose resolves values from `.env` (standalone) or `--env-file` (admin-managed).

See [`assets/README.md`](assets/README.md) for details on adding channels and customizing the configuration.

## User Configuration

All user-editable files live under `CONFIG_HOME` (default `~/.config/openpalm`). There are three touchpoints:

| Path | Purpose |
|---|---|
| `CONFIG_HOME/secrets.env` | Secrets and environment variables (API keys, tokens, passwords) |
| `CONFIG_HOME/channels/` | Channel compose overlays (`.yml`) and Caddy routes (`.caddy`) |
| `CONFIG_HOME/opencode/` | OpenCode extensions — tools, plugins, skills, and `opencode.json` config |

XDG defaults (used when the env vars are unset):

| Variable | Default |
|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` |

Copy [`assets/secrets.env`](assets/secrets.env) as your starting point for secrets, and see [`docs/directory-structure.md`](docs/directory-structure.md) for the complete directory layout and channel discovery rules.

## Standalone Usage

Run the stack without the admin service — just Docker Compose:

```bash
mkdir my-openpalm && cd my-openpalm

# Copy configuration files
cp /path/to/assets/docker-compose.yml .
cp /path/to/assets/Caddyfile .
cp /path/to/assets/secrets.env secrets.env

# Edit secrets.env — fill in ADMIN_TOKEN and API keys
$EDITOR secrets.env

# Copy channel files you want to enable
mkdir registry
cp /path/to/registry/chat.yml registry/
cp /path/to/registry/chat.caddy registry/

# Start the stack
docker compose -f docker-compose.yml -f registry/chat.yml --env-file secrets.env up -d
```

Add more channels by copying their `.yml` and `.caddy` files and adding `-f registry/<name>.yml` to the compose command.


## Debian 13 Kiosk ISO

For plug-and-play appliance installs (Raspberry Pi `arm64` and standard `amd64` systems) that boot directly to an OpenPalm kiosk session, see [`docs/debian13-kiosk-iso.md`](docs/debian13-kiosk-iso.md).

## Development

```bash
./scripts/dev-setup.sh --seed-env

cd core/admin
npm install
npm run dev
```

Admin UI + API runs on `http://localhost:8100`.

From the repo root, convenience scripts are available for all components:

```bash
bun run admin:dev        # core/admin dev server
bun run admin:check      # svelte-check + TypeScript
bun run guardian:dev     # core/guardian server
bun run guardian:test    # guardian tests
bun run lib:test         # packages/lib tests
bun run dev:setup        # seed .dev/ dirs and configs
bun run dev:stack        # start dev stack via docker compose
bun run check            # admin:check + lib:test
```

`dev-setup.sh --seed-env` seeds `.dev/config/secrets.env` from `assets/secrets.env` and sets
`OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, and `OPENPALM_DATA_HOME` to absolute `.dev/`
paths at the bottom of the file. The UI dev server picks these up automatically when
`secrets.env` is loaded — no additional environment setup is needed.

If you plan to use admin-managed install locally, keep `OPENPALM_STATE_HOME` and
`OPENPALM_CONFIG_HOME` pointed at `.dev/` and use `scripts/dev-setup.sh` to keep
ownership aligned with your user.

## Quick start (Admin-Managed)

With the admin service running:

```bash
# Install and bring up the stack via Admin API
curl -X POST http://localhost:8100/admin/install -H "x-admin-token: $ADMIN_TOKEN"

# Check status
curl http://localhost:8100/admin/containers/list -H "x-admin-token: $ADMIN_TOKEN"
```

## Networks

The compose topology uses three Docker networks for access isolation:

| Network | Purpose |
|---------|---------|
| `assistant_net` | Internal backbone — core services communicate here |
| `channel_lan` | Channels restricted to LAN access via Caddy |
| `channel_public` | Channels open to public access via Caddy |

Channel compose overlays declare which network they join. The admin stages channel `.caddy` files from `CONFIG_HOME/channels/` into `STATE_HOME/channels/{lan,public}/` and Caddy imports those staged files. Channels are LAN-restricted unless the route file explicitly includes `import public_access`.

## PRD Definition of Done

The MVP targets five DoD gates from the PRD:

1. Install + health checks
2. Chat channel end-to-end via guardian validation
3. Assistant-requested safe admin action via Admin API
4. Channel access toggle lan/public
5. Authenticated and audited admin operations

No automated test suite exists yet. See `CLAUDE.md` for the current testing status.
