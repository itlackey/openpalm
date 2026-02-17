# Admin UI Guide: Installing & Enabling Extensions (OpenCode Plugins) + Stack Add-ons
*Install OpenCode plugins via Admin UI; enable optional stack extensions (channels/tools/skills) without inventing a new config system.*

## 1) Concept: OpenCode `plugin[]` is the canonical extension registry

OpenCode loads plugins via the top-level `plugin` array in `opencode.json`/`opencode.jsonc`, and supports local plugins under `.opencode/plugins/`.

**Your rule:** the Admin UI manages extensions by editing `opencode.jsonc -> plugin[]`.
Everything else (channels/services/UI panels) is derived from that.

---

## 2) Admin UI: Extensions page UX

### Add extension form
- Source type:
  - **npm package** (recommended)
  - **local plugin file** (advanced)
  - URL/Git (optional, implemented as a resolver; see §6)
- Identifier:
  - npm: `name` or `@scope/name`
  - local: `.opencode/plugins/my-plugin.ts`

### Safety preview + verification
- Show diff to `opencode.jsonc`
- Risk classification:
  - NPM plugin executes code in OpenCode runtime → High
- Require step-up auth (passkey/TOTP) to enable/apply

### Apply model
- Enable now → restart OpenCode
- Enable later → stage config until next maintenance restart

### Installed inventory
- plugin id
- enabled/disabled
- last loaded timestamp
- load errors + logs
- actions: disable/remove, view logs

---

## 3) Implementation: what “Install” does

### Step 1 — Validate identifier
- strict npm package name validation
- reject shell metacharacters, spaces, etc.

### Step 2 — Update `opencode.jsonc` atomically
- parse JSONC
- append to `plugin[]` if not present
- write temp file + rename
- backup old config

### Step 3 — Preflight (recommended)
- registry existence check (`npm view <pkg> version`)
- optional install test in temp dir with locked registry settings

### Step 4 — Restart OpenCode server
OpenCode installs plugin deps at startup (bun install behavior), so restart is the simplest reliable path.

### Step 5 — Confirm load
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
But the plugin’s existence is still controlled by `plugin[]`.

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
1. Gateway reads `opencode.jsonc` and extracts `plugin[]`.
2. For each plugin, Gateway attempts to import `extensionManifest`.
3. Gateway builds desired state:
   - channel containers to run
   - required secrets
   - admin UI settings panels
   - packaged skills/tools to mount or register
4. Admin UI shows a plan and requires step-up auth to apply.

**Result:** No separate “extensions.json” registry; OpenCode config remains canonical.

---

## 6) Supporting URL/Git installs safely (optional)

If OpenCode does not natively accept URL/Git in `plugin[]`, implement a **resolver**:
- Admin inputs URL/Git
- Resolver clones/builds to a local plugin file:
  - writes to `.opencode/plugins/<resolved>.ts`
  - adds that local path to `plugin[]`
- Apply requires High/Critical approval because code provenance is weaker

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
- secrets stored in Gateway, injected at runtime
- audit logs + observability

---

## 8) Admin “Enable stack add-ons” flow

After a plugin is installed/loaded:
1. Admin UI detects `extensionManifest`
2. Shows requested add-ons:
   - new services
   - required secrets
   - ports (if any)
3. Admin provides secrets/settings
4. Step-up auth required
5. Gateway writes `compose.extensions.yml` (or equivalent) and triggers controlled restart of only required services
6. Rollback is one click: disable plugin → revert compose override → restart
