# OpenPalm Components

**Status:** Proposal
**Scope:** All optional stack containers are components. A component is a directory with a `compose.yml` and `.env.schema`. Enabling a component copies its directory into the data path as an instance. Each instance's `compose.yml` is used as a compose overlay. No code generation, no templating, no channel/service distinction.

> **Filesystem context:** This plan uses the `~/.openpalm/` single-root layout defined in [fs-mounts-refactor.md](fs-mounts-refactor.md). All paths below are relative to `~/.openpalm/` unless noted otherwise.

---

## What's a Component

A component is a directory containing:

```
discord/
  compose.yml      # standard Docker Compose fragment
  .env.schema      # standard Varlock @env-spec schema
  .caddy           # optional Caddy route snippet
```

That's the entire contract. Caddy is a component. Discord is a component. Ollama is a component. There's no distinction between them at the system level.

---

## Clean Break from Legacy Channels

This is a clean break from the legacy channel format (`~/.config/openpalm/channels/*.yml` under the old XDG layout). There is no coexistence and no dual-format pipeline. The legacy channel format is dropped entirely in 0.10.0.

Users upgrading from earlier versions run `openpalm migrate`, which handles both the filesystem relocation (XDG to `~/.openpalm/`) and the channel-to-component transition. Legacy `.yml` overlays are moved to `config/components/` during migration. See [fs-mounts-refactor.md Part 8](fs-mounts-refactor.md#part-8-migration-09x--0100) for the full migration flow. This must be prominently documented in release notes.

---

## Instances

When a user enables a component, the admin container copies the entire component directory into the data path as an instance:

```
~/.openpalm/data/components/           # persistent instance data + config (back this up)
  caddy/
    compose.yml      # copied from source, unmodified
    .env.schema      # copied from source
    .env             # instance identity vars + user values written here
    .caddy           # copied from source (if present)
    data/            # persistent volumes (certs, databases, etc.)
  discord-main/
    compose.yml
    .env.schema
    .env
    .caddy
  discord-gaming/
    compose.yml
    .env.schema
    .env
    .caddy
```

All component instance data lives under `~/.openpalm/data/components/` — this is what you back up (along with the rest of `~/.openpalm/`). Runtime logs go to `~/.openpalm/logs/`. User-editable non-secret config lives in `~/.openpalm/config/` (compose overlays, automations, assistant extensions). Secrets live in `~/.openpalm/vault/` (see [fs-mounts-refactor.md](fs-mounts-refactor.md) for the full layout).

Each instance is a complete, self-contained copy. The user's config lives in `.env` alongside the compose and schema files. Want two Discord bots? Two instance directories, each with their own `compose.yml` and `.env`.

The instance name is chosen by the user at creation time. For components where you'd only ever run one (Caddy, Ollama), the convention is to name it the same as the component: `caddy`, `ollama`. Nothing enforces this — it's just a convention.

---

## Compose Overlays

No compose files are generated or modified. Each instance's `compose.yml` is passed directly to Docker Compose as an overlay, with an `--env-file` pointing to the instance's `.env`. The two vault env files (`vault/system.env` and `vault/user.env`) are always included first for `${VAR}` substitution of stack-level secrets:

```bash
docker compose \
  --env-file ~/.openpalm/vault/system.env \
  --env-file ~/.openpalm/vault/user.env \
  -f ~/.openpalm/config/components/core.yml \
  -f ~/.openpalm/config/components/admin.yml \
  -f ~/.openpalm/data/components/caddy/compose.yml \
  --env-file ~/.openpalm/data/components/caddy/.env \
  -f ~/.openpalm/data/components/discord-main/compose.yml \
  --env-file ~/.openpalm/data/components/discord-main/.env \
  -f ~/.openpalm/data/components/discord-gaming/compose.yml \
  --env-file ~/.openpalm/data/components/discord-gaming/.env \
  up -d
```

This is standard Docker Compose behavior. The vault env files provide stack-level secrets (admin token, HMAC secrets, LLM keys, etc.) for `${VAR}` substitution in compose files. Each component overlay adds its services to the stack. The admin container (or CLI) builds the `-f` and `--env-file` flag list from the enabled instance directories.

### How instance identity works

Each instance's `compose.yml` uses standard Compose variable references (`${INSTANCE_ID}`, `${INSTANCE_DIR}`) that Docker Compose resolves at runtime via its native env substitution. The admin does not modify the compose.yml file — it is copied as-is from the component source. Instead, the admin writes an instance `.env` file containing the identity variables:

```bash
# ~/.openpalm/data/components/discord-main/.env
INSTANCE_ID=discord-main
INSTANCE_DIR=/home/user/.openpalm/data/components/discord-main
```

When `docker compose up` runs with `--env-file` pointing to this `.env`, Compose resolves all `${INSTANCE_ID}` and `${INSTANCE_DIR}` references natively. No admin-side find-and-replace, no string interpolation, no rewriting of compose files. This preserves core principle #5 (no template rendering).

### Component compose.yml conventions

A component's source `compose.yml` uses Compose variable references that are resolved at runtime by Docker Compose:

```yaml
# channels/discord/compose.yml
services:
  openpalm-${INSTANCE_ID}:
    image: openpalm/channel-discord:latest
    container_name: openpalm-${INSTANCE_ID}
    restart: unless-stopped
    env_file:
      - ${INSTANCE_DIR}/.env
    volumes:
      - ${INSTANCE_DIR}/data:/state
    networks:
      - openpalm-internal
    labels:
      openpalm.name: Discord
      openpalm.description: Discord bot channel adapter
      openpalm.icon: message-circle
      openpalm.category: messaging
      openpalm.docs: /docs/components/discord.md
      openpalm.healthcheck: http://openpalm-${INSTANCE_ID}:3000/health
```

The compose.yml is copied unchanged into the instance directory. When Docker Compose runs with the instance's `--env-file`, it resolves `${INSTANCE_ID}` to `discord-main` and `${INSTANCE_DIR}` to the data path. The file on disk always contains the variable references, never concrete values.

### Service name prefix convention

Component service names use the `openpalm-{instanceId}` prefix to prevent collisions with core services. On instance creation, the admin validates that the chosen instance ID does not collide with any core service name (`opencode-core`, `gateway`, `openmemory`, `admin`). The `openpalm-` prefix on the Compose service name provides additional namespace isolation.

Components that are naturally singletons (Caddy, Ollama) use a fixed service name but still include the `openpalm-` prefix:

```yaml
# services/caddy/compose.yml
services:
  openpalm-caddy:
    image: caddy:2-alpine
    container_name: openpalm-caddy
    restart: unless-stopped
    env_file:
      - ${INSTANCE_DIR}/.env
    ports:
      - "${LAN_BIND:-0.0.0.0}:443:443"
      - "${LAN_BIND:-0.0.0.0}:80:80"
    volumes:
      - ${INSTANCE_DIR}/data:/data
      - ${INSTANCE_DIR}/Caddyfile:/etc/caddy/Caddyfile:ro
    networks:
      - openpalm-internal
    labels:
      openpalm.name: Caddy
      openpalm.description: Reverse proxy with automatic TLS
      openpalm.icon: lock
      openpalm.category: networking
      openpalm.docs: /docs/components/caddy.md
      openpalm.healthcheck: http://openpalm-caddy:80
```

---

## .env.schema

Same as before — standard Varlock @env-spec. The admin UI parses it and renders the config form. Fields marked `@sensitive` are managed by the unified secret manager (which wraps Varlock and the configured Varlock provider). Sensitive values are never stored as plaintext in the instance `.env` file — the admin resolves them through the secret backend at runtime.

```bash
# channels/discord/.env.schema

# Discord bot configuration
# ---

# Your bot's token from the Discord Developer Portal.
# https://discord.com/developers/applications
# @required @sensitive
DISCORD_BOT_TOKEN=

# Right-click your server → Copy Server ID.
# @required
DISCORD_GUILD_ID=

# ---

# Behavior
# ---

# Character(s) that prefix bot commands.
DISCORD_PREFIX=!

# Text shown under the bot's name in the member list.
DISCORD_ACTIVITY_MESSAGE=Listening for messages
```

### Secret flow for `@sensitive` fields

When a user configures a component instance:

1. The admin UI renders the config form from `.env.schema`.
2. For fields marked `@sensitive` (e.g., `DISCORD_BOT_TOKEN`), the user enters the value in the form.
3. The admin writes the sensitive value to the unified secret manager under a namespaced key (e.g., `components/discord-main/DISCORD_BOT_TOKEN`).
4. The instance `.env` file contains a reference that the secret manager resolves at compose-up time, not the plaintext secret.
5. Non-sensitive fields (e.g., `DISCORD_PREFIX`, `DISCORD_GUILD_ID`) are written directly to the `.env` file.

This ensures all secrets — core, component, and ad-hoc — flow through the same secret management system. No separate plaintext `.env` path for component secrets.

---

## Caddy Routes

Each component directory can optionally include a `.caddy` file containing a Caddy route snippet. This follows the same pattern as the current channel Caddy routes.

### How it works

1. When a component is enabled, the admin (or CLI) discovers any `.caddy` file in the instance directory.
2. The `.caddy` snippet is copied into the Caddy import directory at `data/caddy/channels/`.
3. The main Caddyfile (at `data/caddy/Caddyfile`) uses `import channels/*.caddy` to pick up all component routes.
4. Caddy is reloaded after a component is enabled or disabled.

### LAN-first default

All component Caddy routes are LAN-restricted by default, matching the existing security invariant. Public exposure requires explicit user opt-in via the component's `.env` configuration (e.g., `PUBLIC_ACCESS=true`).

### Example `.caddy` file

```caddy
# channels/discord/.caddy
# Discord webhook endpoint (LAN-only by default)
@discord-webhook path /webhook/discord/*
handle @discord-webhook {
    reverse_proxy openpalm-{$INSTANCE_ID}:3000
}
```

Components without a `.caddy` file (e.g., Ollama, background workers) simply have no external routes — they communicate over the internal Docker network only.

---

## Compose Labels

Minimal set. Only what the admin UI needs to render a card and check health.

| Label | Required | Description |
|-------|----------|-------------|
| `openpalm.name` | Yes | Display name |
| `openpalm.description` | Yes | One-line description |
| `openpalm.icon` | No | Lucide icon name |
| `openpalm.category` | No | Grouping for UI (messaging, networking, ai, etc.) |
| `openpalm.docs` | No | Path or URL to documentation |
| `openpalm.healthcheck` | No | URL to poll on the internal network |

No `kind`. No `multi-instance`. No `instance-keys`. The system doesn't need to know any of that.

---

## Discovery

Three sources, all the same structure:

1. **Built-in** — `components/` in the repo. Ships with Discord, Telegram, Caddy, Ollama, etc.
2. **Registry** — `registry/components/` in the registry repo. Each is a directory with `compose.yml` + `.env.schema` + optional `.caddy`.
3. **User-local** — Directories in `data/catalog/`. For user-authored components.

Discovery scans for directories containing a `compose.yml`, reads the labels, and presents them in the admin UI.

Override: user-local > registry > built-in (by directory name).

---

## Enabled Instance Persistence

The list of enabled component instances is persisted at `data/components/enabled.json`. This file survives admin container restarts and is the source of truth for which instances should be included in the compose overlay chain.

```json
{
  "instances": [
    { "id": "caddy", "component": "caddy", "enabled": true },
    { "id": "discord-main", "component": "discord", "enabled": true },
    { "id": "discord-gaming", "component": "discord", "enabled": true },
    { "id": "ollama", "component": "ollama", "enabled": false }
  ]
}
```

On startup, the admin reads `enabled.json` and builds the compose overlay chain from the instances marked as enabled. If `enabled.json` is missing or corrupted, the admin falls back to scanning for instance directories that contain a `.env` file (presence-based discovery).

---

## Admin API

One API tree.

```
GET    /api/components                          # list available components
GET    /api/components/:componentId             # component detail + schema

GET    /api/instances                            # list all instances with status
POST   /api/instances                            # create instance { component, name }
GET    /api/instances/:instanceId                # instance detail + config + status
PUT    /api/instances/:instanceId/config         # update .env values, restart
DELETE /api/instances/:instanceId                 # stop, archive instance directory

POST   /api/instances/:instanceId/start
POST   /api/instances/:instanceId/stop
POST   /api/instances/:instanceId/restart

GET    /api/instances/:instanceId/logs
GET    /api/instances/:instanceId/health
GET    /api/instances/:instanceId/schema         # parsed .env.schema as JSON
```

### Lifecycle

**Create:**
1. Validate the instance ID does not collide with core service names.
2. Copy component directory to `data/components/{instanceId}/`.
3. Write instance identity vars to `.env` (`INSTANCE_ID`, `INSTANCE_DIR`).
4. Populate `.env` defaults from `.env.schema`.
5. Add instance to `enabled.json`.
6. Present config form to user.

**Configure + Start:**
1. Write user values to `.env` (non-sensitive fields directly; `@sensitive` fields through the unified secret manager).
2. If a `.caddy` file exists, copy it to `data/caddy/channels/`.
3. Add the instance's `compose.yml` and `--env-file` to the overlay list.
4. Run `docker compose --env-file vault/system.env --env-file vault/user.env -f ... --env-file ... up -d`.
5. Reload Caddy if a `.caddy` file was added.

**Stop:**
1. Run `docker compose stop {container_name}`.
2. Remove from overlay list.
3. If a `.caddy` file was placed in `data/caddy/channels/`, remove it and reload Caddy.

**Delete:**
1. Stop the container.
2. Clean up Docker volumes created by the component (volumes with the `openpalm-{instanceId}` prefix).
3. Remove any secrets stored in the unified secret manager under the instance's namespace.
4. Remove the `.caddy` file from `data/caddy/channels/` (if any) and reload Caddy.
5. Move instance directory to `data/archived/`.
6. Remove from `enabled.json`.

---

## Admin UI

One tab: **Components**.

```
+-- Components ----------------------------------------------------+
|                                                                   |
|  -- Messaging -------------------------------------------------- |
|                                                                   |
|  discord-main             Running        [Configure] [...]        |
|  discord-gaming           Running        [Configure] [...]        |
|  telegram-main            Stopped        [Start]     [...]        |
|                                                                   |
|  -- Networking ------------------------------------------------- |
|                                                                   |
|  caddy                    Disabled       [Enable]                 |
|  cloudflare-tunnel        Disabled       [Enable]                 |
|                                                                   |
|  -- AI --------------------------------------------------------- |
|                                                                   |
|  ollama                   Running        [Configure] [...]        |
|                                                                   |
|  ---------------------------------------------------------------- |
|                                          [+ New Instance]         |
|                                                                   |
+-------------------------------------------------------------------+
```

**[+ New Instance]** opens a picker showing available components, then asks for a name. The config form (from `.env.schema`) appears after creation.

**[Configure]** opens the config form for that instance.

**[...]** overflow: Stop, Restart, Logs, Clone, Delete.

Instances are grouped by `openpalm.category` from the compose labels. No tab switching, no hierarchy — just a flat list of instances grouped by category.

### Configure view

```
+-- discord-main --------------------------------------------------+
|                                                                   |
|  -- Discord bot configuration ---------------------------------- |
|                                                                   |
|  Bot Token         [****encrypted****]             (required)     |
|    Your bot's token from the Discord Developer Portal.            |
|    Managed by the secret manager.                                 |
|                                                                   |
|  Server ID         [123456789012345678]            (required)     |
|    Right-click your server -> Copy Server ID.                     |
|                                                                   |
|  -- Behavior --------------------------------------------------- |
|                                                                   |
|  Command Prefix    [!]                                            |
|  Activity Message  [Listening for messages]                       |
|                                                                   |
|                                                          [Save]   |
+-------------------------------------------------------------------+
```

Everything rendered from the `.env.schema`. One form renderer, used for every component. Fields marked `@sensitive` show a masked value and are persisted through the unified secret manager, not as plaintext in the `.env` file.

---

## Setup Wizard

```
-- Optional Components -------------------------------------------

[ ] Discord         Bot channel adapter
[ ] Telegram        Telegram bot adapter
[ ] Web Chat        Browser-based chat widget
[ ] Email (IMAP)    Receive messages via email
[ ] Caddy           Reverse proxy with auto-TLS
[ ] Cloudflare Tunnel  Public access without open ports
[ ] Ollama          Local LLM inference
```

Checking one creates an instance (named after the component), shows its config form. All unchecked by default.

---

## Dynamic Allowlist

The compose runner allows operations on core containers plus any container from an enabled instance:

```typescript
const CORE = ["opencode-core", "gateway", "openmemory", "admin"];

function buildAllowlist(instances: string[]): Set<string> {
  return new Set([
    ...CORE,
    ...instances.map(id => `openpalm-${id}`),
  ]);
}
```

---

## Compose Structure

```yaml
# config/components/core.yml -- base stack, system-managed (may be updated on upgrade)
services:
  gateway:
    expose: ["3000"]
  opencode:
    expose: ["3000"]
  memory:
    expose: ["8080"]

networks:
  openpalm-internal:
    driver: bridge
```

```yaml
# config/components/admin.yml -- admin overlay, system-managed
services:
  admin:
    ports:
      - "${LAN_BIND:-0.0.0.0}:${ADMIN_PORT:-8080}:3000"
```

Enabled instances are overlays. The vault env files are always included first for stack-level `${VAR}` substitution:

```bash
docker compose \
  --env-file ~/.openpalm/vault/system.env \
  --env-file ~/.openpalm/vault/user.env \
  -f ~/.openpalm/config/components/core.yml \
  -f ~/.openpalm/config/components/admin.yml \
  -f ~/.openpalm/data/components/caddy/compose.yml \
  --env-file ~/.openpalm/data/components/caddy/.env \
  -f ~/.openpalm/data/components/discord-main/compose.yml \
  --env-file ~/.openpalm/data/components/discord-main/.env \
  -f ~/.openpalm/data/components/discord-gaming/compose.yml \
  --env-file ~/.openpalm/data/components/discord-gaming/.env \
  -f ~/.openpalm/data/components/ollama/compose.yml \
  --env-file ~/.openpalm/data/components/ollama/.env \
  up -d
```

The admin container (or CLI) reads `enabled.json` and builds the `-f` / `--env-file` chain from the enabled instances. This list persists across admin container restarts.

### Directory summary

```
~/.openpalm/
├── config/                            # user-owned non-secret config
│   ├── openpalm.yml                   # enabled components, feature flags, network
│   ├── components/                    # compose overlays (core + component)
│   │   ├── core.yml                   # base stack (system-managed)
│   │   ├── admin.yml                  # admin overlay (system-managed)
│   │   └── ...                        # user-installed channel overlays
│   ├── automations/                   # scheduled tasks
│   └── assistant/                     # user OpenCode extensions
│
├── vault/                             # secrets boundary
│   ├── user.env                       # user-editable: LLM keys, provider URLs
│   ├── user.env.schema
│   ├── system.env                     # system-managed: admin token, HMAC secrets, paths
│   └── system.env.schema
│
├── data/                              # service-managed persistent data
│   ├── components/                    # enabled instances
│   │   ├── enabled.json               # enabled instance list (survives restarts)
│   │   ├── caddy/
│   │   │   ├── compose.yml            # copied from source, unmodified
│   │   │   ├── .env.schema
│   │   │   ├── .env                   # identity vars + user config values
│   │   │   ├── .caddy                 # optional Caddy route snippet
│   │   │   └── data/                  # certs, persistent state
│   │   └── discord-main/
│   │       ├── compose.yml
│   │       ├── .env.schema
│   │       ├── .env
│   │       └── .caddy
│   ├── catalog/                       # user-local component definitions
│   ├── archived/                      # deleted instances (recoverable)
│   ├── caddy/                         # Caddy runtime data
│   │   ├── Caddyfile
│   │   └── channels/                  # .caddy snippets (import dir)
│   └── ...                            # other service data dirs
│
└── logs/                              # audit and debug logs
```

---

## Registry

```
registry/
+-- components/
|   +-- slack/
|   |   +-- compose.yml
|   |   +-- .env.schema
|   |   +-- .caddy
|   +-- searxng/
|   |   +-- compose.yml
|   |   +-- .env.schema
|   +-- n8n/
|       +-- compose.yml
|       +-- .env.schema
+-- index.json
```

Installing a registry component copies its directory into `data/catalog/`, making it available for instance creation. Same files, same formats.

### Catalog entry removal

When a catalog entry is removed (uninstalled from the registry), existing instances continue working. The instance directory is a complete, self-contained copy — the catalog entry is just the source template used at instance creation time. Removing the catalog entry only prevents creating new instances from that template.

---

## Adding a New Component

1. Create a directory with `compose.yml` + `.env.schema` + optional `.caddy`.
2. Put it in `components/` (built-in), submit to the registry, or drop it in the user config dir.

That's it. No code changes. No admin UI changes. The discovery scan picks it up and the form renderer handles the rest.

---

## Implementation Phases

### Phase 1: Core

- [ ] Networking simplification (Caddy removal from core, Docker DNS routing)
- [ ] Component instance directory structure: `data/components/` for instance data, `data/catalog/` for user-local definitions
- [ ] Component directory convention: `compose.yml` + `.env.schema` + optional `.caddy`
- [ ] Discovery: scan built-in, catalog, and registry directories; parse compose labels
- [ ] @env-spec parser integration in admin container
- [ ] Instance creation: copy component directory as-is, write identity vars (`INSTANCE_ID`, `INSTANCE_DIR`) to `.env`
- [ ] Service name collision validation against core services on instance creation
- [ ] Compose overlay runner: build `-f` / `--env-file` chain from enabled instances (prepend `--env-file vault/system.env --env-file vault/user.env`)
- [ ] Caddy route management: discover `.caddy` files, copy to `data/caddy/channels/`, reload Caddy
- [ ] Enabled instance persistence: `enabled.json` at `data/components/`
- [ ] Dynamic allowlist from enabled instances
- [ ] Unified secret manager integration for `@sensitive` fields

### Phase 2: Admin API

- [ ] `GET /api/components` — list available
- [ ] `GET /api/components/:id` — detail + schema
- [ ] `POST /api/instances` — create (with name collision validation)
- [ ] `GET /api/instances` — list with status
- [ ] `GET/PUT/DELETE /api/instances/:id` — CRUD + config
- [ ] `POST .../start`, `.../stop`, `.../restart`
- [ ] `GET .../logs`, `.../health`, `.../schema`

### Phase 3: Admin UI

- [ ] Components tab: flat list grouped by category
- [ ] Instance cards with status
- [ ] New instance flow: pick component -> name -> config form
- [ ] Configure view: form from `.env.schema` (with secret manager integration for `@sensitive` fields)
- [ ] Overflow: stop, restart, logs, clone, delete
- [ ] Setup wizard: optional components step

### Phase 4: Registry

- [ ] `components/` directory in registry repo
- [ ] Install flow: download directory, add to user-local catalog
- [ ] CI validation for submissions
- [ ] See also: **Unified Component Registry plan** for collapsing gallery/community/npm into this system

### Phase 5: Docs

- [ ] `docs/components/` — per component
- [ ] `docs/development/adding-a-component.md` — compose.yml + .env.schema + .caddy
- [ ] Update security guide, architecture diagram, README
- [ ] Release notes: document `openpalm migrate` for combined FS + channel-to-component migration, upgrade path

---

## CLI Integration

> Added 2026-03-18 by agent review consensus (3/5 agents). The component plan was written entirely from the admin container's perspective, but core principle: "Host CLI or admin is the orchestrator."

The CLI (`packages/cli/`) must support the full component lifecycle without requiring the admin container. Both CLI and admin import from `@openpalm/lib`, so the component logic lives in lib and is consumed by both.

**Lib-first rule (mandatory):** ALL component lifecycle logic — discovery, instance creation, validation, compose chain building, enabled.json persistence, Caddy route management — MUST be implemented in `packages/lib/src/control-plane/`. The CLI and admin are thin consumers. The CLI calls lib functions directly. The admin calls them from API route handlers. Neither may contain independent control-plane logic. This ensures identical behavior regardless of whether the user manages their stack via CLI or admin UI.

### CLI Commands

```
openpalm component list                    # List available components (built-in + catalog)
openpalm component instances               # List enabled instances with status
openpalm component add <component> [name]  # Create instance from component
openpalm component configure <instance>    # Interactive .env.schema configuration
openpalm component remove <instance>       # Stop, archive, remove from enabled.json
openpalm component start <instance>        # Start a stopped instance
openpalm component stop <instance>         # Stop a running instance
```

### Staging Elimination

The staging tier (`STATE_HOME`) is eliminated in 0.10.0. The current staging pipeline in `packages/lib/src/control-plane/staging.ts` is replaced by the validate-in-place model (see [fs-mounts-refactor.md Part 4](fs-mounts-refactor.md#part-4-validation--rollback)). All staging functions are removed:

- `stageChannelYmlFiles()` → removed. Component compose overlays are used directly from `data/components/` via `--env-file` — no staging needed.
- `stageChannelCaddyfiles()` → replaced by direct copy of `.caddy` snippets from `data/components/*/.caddy` to `data/caddy/channels/`.
- `discoverStagedChannelYmls()` → replaced by reading `data/components/enabled.json` and building the overlay chain.
- `buildComposeFileList()` → updated to start with `config/components/core.yml` + `config/components/admin.yml` (if admin enabled), then append component overlays from enabled instances.
- `fullComposeArgs()` in `packages/cli/src/lib/staging.ts` → rewritten. Builds the full compose invocation:
  1. `--env-file vault/system.env --env-file vault/user.env` (always first)
  2. `-f config/components/core.yml` (always)
  3. `-f config/components/admin.yml` (if admin enabled in `config/openpalm.yml`)
  4. For each enabled instance: `-f data/components/{id}/compose.yml --env-file data/components/{id}/.env`
- `staging.ts` itself → eliminated or renamed. The staging module is replaced by a validate-and-apply module that validates proposed changes against temp copies, snapshots current state to `~/.cache/openpalm/rollback/`, and writes to live paths only after validation passes.

### Shared Library Surface

All component lifecycle logic lives in `@openpalm/lib`:

```typescript
// packages/lib/src/control-plane/components.ts (new)
export function discoverComponents(sources: string[]): ComponentDefinition[];
export function createInstance(component: string, instanceId: string, openpalmHome: string): void;
export function removeInstance(instanceId: string, openpalmHome: string): void;
export function readEnabledInstances(openpalmHome: string): EnabledInstance[];
export function writeEnabledInstances(openpalmHome: string, instances: EnabledInstance[]): void;
export function buildComponentComposeArgs(openpalmHome: string): string[];
```

All path resolution uses `OPENPALM_HOME` (`~/.openpalm/` by default) as the single root. The `home.ts` module (which replaces the old `paths.ts`) provides the path helpers.

Both CLI and admin call these functions. The CLI calls them directly; the admin calls them from API route handlers.

---

## Cross-Component Environment Injection

> Added 2026-03-18 by agent review consensus (3/5 agents). This addresses the design gap where optional components need to inject environment variables into existing core services.

### Problem

When OpenViking (a component) is installed, the assistant container needs `OPENVIKING_URL` and `OPENVIKING_API_KEY` in its environment. But component compose overlays add new services — they do not modify existing service environment blocks.

### Solution: Compose Overlay Service Extension

Docker Compose overlays CAN add environment variables to existing services. A component's `compose.yml` can reference a core service name and add to its environment:

```yaml
# registry/components/openviking/compose.yml
services:
  # The OpenViking container itself
  openpalm-${INSTANCE_ID}:
    image: ghcr.io/itlackey/openviking:0.4.2
    restart: unless-stopped
    networks:
      - assistant_net
    volumes:
      - ${INSTANCE_DIR}/data/workspace:/workspace
      - ${INSTANCE_DIR}/data/ov.conf:/app/ov.conf:ro

  # Extension of the existing assistant service (adds env vars only)
  assistant:
    environment:
      OPENVIKING_URL: http://openpalm-${INSTANCE_ID}:1933
      OPENVIKING_API_KEY: ${OPENVIKING_API_KEY}
```

When Docker Compose merges this overlay with `config/components/core.yml`, the `assistant` service's environment block is extended (not replaced) with the new variables. This is standard Compose merge behavior for maps. The `${OPENVIKING_API_KEY}` reference is resolved by Docker Compose from the vault env files (`--env-file vault/system.env --env-file vault/user.env`) or from the component's own `--env-file`.

### Constraints

1. **Component overlays MUST NOT override existing environment variables** in core services. Only add new keys.
2. **The core service name (`assistant`) is part of the contract.** If core service names change, component overlays that extend them break. Core service names are stable and documented.
3. **Only `assistant_net` services** should be extended this way. Components must not inject env vars into guardian, admin, or other security-boundary services.
4. **Collision detection:** The admin should validate that no two enabled components inject the same environment variable into the same core service.

### Which Components Use This Pattern

| Component | Core Service Extended | Variables Injected |
|-----------|----------------------|-------------------|
| OpenViking | `assistant` | `OPENVIKING_URL`, `OPENVIKING_API_KEY` |
| MCP | (none — standalone) | — |
| Ollama | `assistant`, `memory` | `OLLAMA_URL` (already in core compose with default) |

---

## Upgrade Path: 0.9.x → 0.10.0

> Added 2026-03-18 by agent review consensus (4/5 agents). The clean break from legacy channels (review-decisions Q8) is a breaking change that requires explicit user communication.

### `openpalm migrate` — Combined Migration Tool

The 0.10.0 upgrade involves two breaking changes: the filesystem layout (XDG to `~/.openpalm/`) and the channel-to-component transition. Both are handled by a single `openpalm migrate` command. See [fs-mounts-refactor.md Part 8](fs-mounts-refactor.md#part-8-migration-09x--0100) for the full migration flow.

The migration tool handles:
1. **Directory relocation** — XDG directories (`~/.config/openpalm/`, `~/.local/share/openpalm/`, `~/.local/state/openpalm/`) to `~/.openpalm/`
2. **Env file splitting** — `secrets.env` + `stack.env` to `vault/user.env` + `vault/system.env`
3. **Channel-to-component conversion** — legacy `.yml` overlays in `channels/` move to `config/components/`

### Migration Detection

On first startup after upgrade (if `openpalm migrate` has not been run), the admin and CLI detect the old XDG layout:

1. **Scan for `~/.config/openpalm/`**, `~/.local/share/openpalm/`, `~/.local/state/openpalm/`.
2. **If found:** display a migration notice directing the user to run `openpalm migrate`.

### Admin UI Banner

When a legacy installation is detected:

```
Legacy installation detected
Run `openpalm migrate` to move to the new ~/.openpalm/ layout.
Your files are preserved — nothing is deleted until you run `openpalm migrate --cleanup`.
[View upgrade guide] [Dismiss]
```

### CLI Warning

When `openpalm status` or `openpalm up` detects the old layout:

```
WARNING: Legacy XDG installation detected.
Run `openpalm migrate` to upgrade to the ~/.openpalm/ layout.
See: docs/upgrade-0.10.0.md
```

### Pre-Upgrade Export (Future)

A `openpalm export-config` command that dumps current channel configs, secrets, and connection profiles to a single file would reduce upgrade friction. This is recommended but not required for 0.10.0 — the migration tool and documentation are sufficient.

### Upgrade Steps (documented in release notes)

1. Back up `~/.config/openpalm/`, `~/.local/share/openpalm/`, `~/.local/state/openpalm/`
2. Upgrade to 0.10.0 (`openpalm update` or pull new images)
3. Run `openpalm migrate` — handles directory relocation, env file splitting, and channel-to-component conversion
4. Verify the stack is working: `openpalm status`
5. Optionally clean up old directories: `openpalm migrate --cleanup`

Old XDG directories are preserved (not deleted) until the user explicitly runs `openpalm migrate --cleanup`.

---

## Testing Strategy

> Added 2026-03-18 by agent review consensus (3/5 agents).

### Unit Tests (packages/lib)

| Test Area | Description |
|-----------|-------------|
| Component directory validation | `compose.yml` + `.env.schema` contract enforcement |
| Instance creation | Copy directory, write identity vars (`INSTANCE_ID`, `INSTANCE_DIR`) |
| Instance ID collision | Reject names that collide with core services |
| `enabled.json` persistence | Read/write/fallback to presence-based discovery |
| Compose overlay chain | Correct `-f` and `--env-file` ordering (vault env files first, then core.yml, then component overlays) |
| Dynamic allowlist | `buildAllowlist()` includes component instances |
| Caddy route management | Discover `.caddy` files, copy to `data/caddy/channels/` |
| Instance lifecycle | Create → configure → start → stop → delete → archive |

### Admin API Tests (packages/admin)

| Test Area | Description |
|-----------|-------------|
| `GET /api/components` | Discovery from built-in, catalog, registry sources |
| `POST /api/instances` | Create with name collision validation |
| `PUT /api/instances/:id/config` | Update `.env`, handle `@sensitive` fields |
| `DELETE /api/instances/:id` | Stop, clean secrets, archive |
| Start/stop/restart | Instance lifecycle operations |
| Health check proxy | Via `openpalm.healthcheck` compose label |
| `.env.schema` parsing | Form JSON generation from schema |

### E2E Tests (Playwright)

| Test Area | Description |
|-----------|-------------|
| Component lifecycle | Create → configure → start → verify → stop → delete |
| Setup wizard | Optional components step |
| Migration detection | Legacy XDG layout detected → banner directing to `openpalm migrate` |
| Multi-instance | Two instances of same component, different configs |

### Test Migration Budget

The component system invalidates ~30-40% of existing admin unit tests (channel/registry/staging tests). Budget 3-5 working days for test migration. Key files requiring rewrite:

- `channels.test.ts` — legacy channel discovery/install/uninstall (replaced by component discovery)
- `staging.test.ts` — staging pipeline (eliminated; replaced by validate-and-apply tests)
- `lifecycle.test.ts` — lifecycle transitions with channel artifacts (updated for `~/.openpalm/` paths)
- `setup-wizard.test.ts` (Playwright) — wizard channel selection step (updated for component selection)
- Mocked E2E tests — registry/channels UI contracts (updated for components UI)
