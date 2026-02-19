# Extensions Guide: Installing & Enabling Extensions (OpenCode Plugins) + Stack Add-ons
*Install OpenCode plugins via Admin UI, API, or CLI. Manage optional stack extensions (channels/tools/skills) without inventing a new config system.*

## 1) Concept: OpenCode `plugin[]` is the canonical extension registry

OpenCode loads plugins via the top-level `plugin` array in `opencode.json`/`opencode.jsonc`, and auto-discovers local plugins under `plugins/` in the directory specified by `OPENCODE_CONFIG_DIR` (or `.opencode/plugins/` by default).

**Container path resolution:** In the OpenPalm stack, extensions live in `opencode/extensions/` in the repository, are `COPY`'d into the container image at `/root/.config/opencode/`, and then merged into `/config/` at startup via `cp -rn` (no-clobber recursive copy). The `OPENCODE_CONFIG_DIR` environment variable is set to `/config/`, so plugins in `/config/plugins/` are auto-discovered. Host-side overrides mounted at `/config` take precedence over baked-in defaults.

**Your rule:** the Admin UI manages extensions by editing `opencode.jsonc -> plugin[]`.
Everything else (channels/services/UI panels) is derived from that.

### Extension directory layout

Extensions are **baked into the container image**. They live in `opencode/extensions/` and `gateway/opencode/` within the repository and are organized by which opencode instance they serve:

| Directory | Container | Purpose |
|---|---|---|
| `opencode/extensions/` | opencode-core | Core agent: plugins (openmemory-http, policy-and-telemetry), skills (memory/SKILL.md), lib (openmemory-client), AGENTS.md |
| `gateway/opencode/` | gateway | Intake agent: skills (channel-intake/SKILL.md), AGENTS.md |

Extensions ship inside the container images. Users can still override or supplement extensions by mounting a volume at `/config` — any files present there take precedence over the baked-in defaults. The installer seeds only an empty `opencode.jsonc` at `~/.config/openpalm/opencode-core/opencode.jsonc` for user-level overrides; it does not seed the extensions themselves.

### Recommended structure in `opencode/extensions/` and `gateway/opencode/`

```text
opencode/
  extensions/
    opencode.jsonc
    AGENTS.md
    plugins/
    skills/
      memory/
        SKILL.md
    lib/
    ssh/
gateway/
  opencode/
    opencode.jsonc
    AGENTS.md
    skills/
      channel-intake/
        SKILL.md
```

### Extension authoring rule

All new assistant features should be implemented as OpenCode extensions (plugin, skill, or shared `lib/` module) under `opencode/extensions/` first, then enabled via `plugin[]` in `opencode.jsonc`.

### Naming conventions

- Plugin files: `kebab-case.ts` (example: `calendar-sync.ts`)
- Skill directories: `kebab-case/` containing `SKILL.md` (example: `memory/SKILL.md`)
- Shared helpers in `lib/`: `kebab-case.ts` matching the plugin domain
- Keep plugin IDs stable (`@scope/name` or `name`) so admin/API/CLI operations remain deterministic

### Quick scaffold: add a local extension in `opencode/extensions/`

1. Create plugin file `opencode/extensions/plugins/calendar-sync.ts`:

```ts
export default {
  name: "calendar-sync",
  async setup() {
    return {
      "calendar.ping": async () => "calendar-sync ready"
    };
  }
};
```

2. (Optional) Add a skill file `opencode/extensions/skills/CalendarOps.SKILL.md`:

```md
# CalendarOps

Use `calendar.ping` before running calendar actions to verify plugin health.
```

3. Register the extension in `opencode/extensions/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "plugins/calendar-sync.ts"
  ]
}
```

4. Rebuild the container image to bake in the new extension, then restart `opencode-core`. If you need to test locally without a rebuild, mount a volume at `/config` pointing to your `opencode/extensions/` directory.

### Best practices

- Keep extensions small and single-purpose.
- Add/update tests near changed code paths (for example `opencode/*.test.ts` for plugin helpers).
- Document behavior and operational constraints in skill files and `AGENTS.md`.
- Prefer local `plugins/` + `lib/` composition over large one-file plugins.

### Primary references

- OpenCode extension documentation: https://opencode.ai/docs/plugins
- Gateway main code: https://github.com/itlackey/openpalm/blob/main/gateway/src/server.ts
- Admin main code: https://github.com/itlackey/openpalm/blob/main/admin/src/server.ts
- Controller main code: https://github.com/itlackey/openpalm/blob/main/controller/server.ts

### Reference architecture (brief)

- `opencode/extensions/` is the canonical source for core agent extensions, baked into the `opencode-core` container image at build time.
- `gateway/opencode/` is the canonical source for gateway agent extensions, baked into the `gateway` container image at build time.
- Users can override or supplement baked-in extensions by mounting a volume at `/config` inside the container — files present there take precedence over image defaults.
- The installer seeds only an empty `opencode.jsonc` at `~/.config/openpalm/opencode-core/opencode.jsonc` for user-level plugin overrides; extension files themselves are not seeded by the installer.
- Gateway handles signature verification/rate limits and forwards validated work to `opencode-core`.
- Admin manages config/extensions and invokes the controller for lifecycle actions.
- Controller is the only container-control plane component and executes compose operations.

---

## 2) Admin UI: Extensions page UX

### Add extension
- **Gallery** — browse curated plugins, skills, and container services
- **npm search** — search the npm registry for OpenCode plugins
- **CLI** — use `bun run assets/state/scripts/extensions-cli.ts install --plugin <id>`

### Source types
- **npm package** (recommended): `name` or `@scope/name`
- **local plugin file** (advanced): `plugins/my-plugin.ts` (in `OPENCODE_CONFIG_DIR`)

### Install flow
Extensions install directly — no staging or approval queue required. The admin password (set during install) is the only credential needed.

### Installed inventory
- plugin id
- enabled/disabled
- actions: remove

---

## 3) Implementation: what "Install" does

### Step 1 — Validate identifier
- strict npm package name validation
- reject shell metacharacters, spaces, etc.

### Step 2 — Update `opencode.jsonc` atomically
- parse JSONC
- append to `plugin[]` if not present
- write temp file + rename
- backup old config

### Step 3 — Restart OpenCode server
OpenCode installs plugin deps at startup (bun install behavior), so restart is the simplest reliable path.

### Step 4 — Confirm load
Use OpenCode event stream and/or plugin init logs to confirm successful load.

---

## 4) Disabling/uninstalling a plugin
- Remove plugin id from `plugin[]`
- Restart OpenCode
- Keep a rollback snapshot of prior config

---

## 5. Adding channel adapters

Channel adapters are Docker containers that bridge external messaging platforms
to the OpenPalm gateway. Each adapter is a thin service that:

1. Receives platform-specific webhooks or socket events.
2. Normalises them to the OpenPalm inbound schema.
3. POSTs the normalised payload to the gateway `/channel/inbound` endpoint.
4. Forwards the gateway response back to the originating platform.

### Registering a new channel adapter

1. Add the service to `docker-compose.yml` with a unique service name.
2. Set `GATEWAY_URL=http://gateway:8080` in the service's environment.
3. Add the service name to `OPENPALM_EXTRA_SERVICES` so the controller
   can manage it (see the controller's dynamic allowlist).
4. Add a gallery entry in `admin/src/gallery.ts` under the `container`
   category so it appears in the admin UI.

---

## 6) Supporting URL/Git installs safely (optional)

If OpenCode does not natively accept URL/Git in `plugin[]`, implement a **resolver**:
- Admin inputs URL/Git
- Resolver clones/builds to a local plugin file:
  - writes to `plugins/<resolved>.ts` (in `OPENCODE_CONFIG_DIR`)
  - adds that local path to `plugin[]`

---

## 7. Developer guide: building a channel adapter

### A) Channel contract

The adapter container is a dumb bridge — it receives platform events,
normalises them, POSTs to `/channel/inbound`, and returns the response.

### B) What the adapter provides

- A Docker image published to a registry (or built locally).
- Environment variables for platform credentials (API keys, webhook secrets).
- A health endpoint at `/health` for the controller to monitor.

### C) What the platform enforces

- Signature verification and replay protection at the gateway.
- Rate limiting per channel.
- Outbound message allowlists.
- Secrets stored in `.env`, never baked into images.
- Audit logging of all inbound/outbound messages.

---

## 8) Community Extension Registry

OpenPalm maintains a **public community registry** in the `assets/state/registry/` folder of this repository. The admin dashboard fetches this registry at runtime — no Docker image rebuild required to discover new extensions.

### How it works

- `assets/state/registry/*.json` — one JSON file per community extension entry
- `assets/state/registry/index.json` — auto-generated aggregated list (rebuilt by CI on every merge to `main`)
- The admin fetches `index.json` from GitHub at runtime and caches results for 10 minutes

### Admin API endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/admin/gallery/community` | GET | None | Search community registry (supports `?q=` and `?category=`) |
| `/admin/gallery/community/refresh` | POST | Token | Force refresh the 10-minute cache |

### Configuring a self-hosted registry

By default the admin fetches from the main OpenPalm repository. To point to your own fork or a private registry, set the `OPENPALM_REGISTRY_URL` environment variable:

```env
OPENPALM_REGISTRY_URL=https://raw.githubusercontent.com/your-org/your-fork/main/assets/state/registry/index.json
```

### Submitting an extension to the community registry

See [`assets/state/registry/README.md`](../assets/state/registry/README.md) for the full contribution guide. The short version:

1. Fork the repository
2. Add a new `assets/state/registry/<your-extension-id>.json` file
3. Open a pull request — CI validates your entry automatically
4. After merge, `assets/state/registry/index.json` is auto-regenerated and the extension becomes discoverable

> Updating registry entries **never triggers a Docker image rebuild** — the CI workflow for building images explicitly excludes the `assets/state/registry/` folder.

---

## 9) CLI usage

```bash
# Install a plugin
bun run assets/state/scripts/extensions-cli.ts install --plugin @scope/plugin

# List installed plugins
bun run assets/state/scripts/extensions-cli.ts list

# Uninstall a plugin
bun run assets/state/scripts/extensions-cli.ts uninstall --plugin @scope/plugin
```

Set `ADMIN_TOKEN` in your environment to authenticate CLI requests.
