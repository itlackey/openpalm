# Extensions Guide: Installing & Enabling Extensions (OpenCode Plugins) + Stack Add-ons
*Install OpenCode plugins via Admin UI, API, or CLI. Manage optional stack extensions (channels/tools/skills) without inventing a new config system.*

## 1) Concept: OpenCode `plugin[]` is the canonical extension registry

OpenCode loads plugins via the top-level `plugin` array in `opencode.json`/`opencode.jsonc`, and supports local plugins under `.opencode/plugins/`.

**Your rule:** the Admin UI manages extensions by editing `opencode.jsonc -> plugin[]`.
Everything else (channels/services/UI panels) is derived from that.

---

## 2) Admin UI: Extensions page UX

### Add extension
- **Gallery** — browse curated plugins, skills, and container services
- **npm search** — search the npm registry for OpenCode plugins
- **CLI** — use `bun run scripts/extensions-cli.ts install --plugin <id>`

### Source types
- **npm package** (recommended): `name` or `@scope/name`
- **local plugin file** (advanced): `.opencode/plugins/my-plugin.ts`

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

## 5) Extending the stack via plugins (channels/tools/skills) without a new config system

### Key idea
An OpenCode plugin may optionally export a **manifest** describing stack add-ons.
But the plugin's existence is still controlled by `plugin[]`.

#### Convention: `extensionManifest`
Plugin package exports:
- the OpenCode plugin itself
- `extensionManifest` metadata

Example shape:
```ts
export const extensionManifest = {
  id: "com.yourorg.telegram-channel",
  channels: [
    {
      id: "telegram",
      service: {
        image: "yourorg/assistant-telegram:1.0.0",
        env: ["TELEGRAM_BOT_TOKEN"],
        ports: []
      }
    }
  ],
  skills: ["skills/TelegramOps.SKILL.md"],
  tools: ["tools/telegram_send.ts"],
  adminUI: {
    settingsSchema: "schemas/telegram.settings.json"
  }
}
```

### How the stack uses it
1. Admin-app reads `opencode.jsonc` and extracts `plugin[]`.
2. For each plugin, admin attempts to import `extensionManifest`.
3. Admin-app builds desired state:
   - channel containers to run
   - required secrets
   - admin UI settings panels
   - packaged skills/tools to mount or register
4. Admin UI shows a plan. Admin confirms to apply.

**Result:** No separate "extensions.json" registry; OpenCode config remains canonical.

---

## 6) Supporting URL/Git installs safely (optional)

If OpenCode does not natively accept URL/Git in `plugin[]`, implement a **resolver**:
- Admin inputs URL/Git
- Resolver clones/builds to a local plugin file:
  - writes to `.opencode/plugins/<resolved>.ts`
  - adds that local path to `plugin[]`

---

## 7) Developer guide: building a plugin that adds a new channel

### A) Channel contract (unchanged)
Your channel container is a dumb adapter:
- receive message
- normalize payload
- POST to Gateway `/channel/inbound`
- return response

### B) What the plugin provides
- `extensionManifest.channels[]` entry with container image + env schema
- optional skills/tools bundled with the plugin
- optional admin UI settings schema

### C) What the platform enforces
- signature verification (when applicable)
- replay protection + rate limits
- outbound allowlists
- secrets stored in `.env`, injected at runtime
- audit logs + observability

---

## 8) Community Extension Registry

OpenPalm maintains a **public community registry** in the `registry/` folder of this repository. The admin dashboard fetches this registry at runtime — no Docker image rebuild required to discover new extensions.

### How it works

- `registry/*.json` — one JSON file per community extension entry
- `registry/index.json` — auto-generated aggregated list (rebuilt by CI on every merge to `main`)
- The admin fetches `index.json` from GitHub at runtime and caches results for 10 minutes

### Admin API endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/admin/gallery/community` | GET | None | Search community registry (supports `?q=` and `?category=`) |
| `/admin/gallery/community/refresh` | POST | Token | Force refresh the 10-minute cache |

### Configuring a self-hosted registry

By default the admin fetches from the main OpenPalm repository. To point to your own fork or a private registry, set the `OPENPALM_REGISTRY_URL` environment variable:

```env
OPENPALM_REGISTRY_URL=https://raw.githubusercontent.com/your-org/your-fork/main/registry/index.json
```

### Submitting an extension to the community registry

See [`registry/README.md`](../registry/README.md) for the full contribution guide. The short version:

1. Fork the repository
2. Add a new `registry/<your-extension-id>.json` file
3. Open a pull request — CI validates your entry automatically
4. After merge, `registry/index.json` is auto-regenerated and the extension becomes discoverable

> Updating registry entries **never triggers a Docker image rebuild** — the CI workflow for building images explicitly excludes the `registry/` folder.

---

## 9) CLI usage

```bash
# Install a plugin
bun run scripts/extensions-cli.ts install --plugin @scope/plugin

# List installed plugins
bun run scripts/extensions-cli.ts list

# Uninstall a plugin
bun run scripts/extensions-cli.ts uninstall --plugin @scope/plugin
```

Set `ADMIN_TOKEN` in your environment to authenticate CLI requests.
