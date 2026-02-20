# Admin UI Comprehensive Audit Report

## CRITICAL (5 issues)

### C1. `detectChannelAccess` regex never matches — always returns "public"
**File:** `admin/src/server.ts:124`
The regex `\n\}` expects closing brace at column 0, but Caddyfile indents it with a tab (`\n\t\}`). Result: always returns "public" regardless of actual state.

### C2. Channel env file name mismatch — admin writes are never read by containers
**File:** `admin/src/server.ts:150-176`, `assets/state/docker-compose.yml:183/196/209/222`
Admin writes `channel-chat.env`, compose reads `chat.env`. Config never reaches containers.

### C3. `docker compose restart` does not reload env files
**File:** `admin/src/server.ts:696`
After saving channel config, server calls `controllerAction("restart", ...)` which runs `docker compose restart`. This does NOT re-read env_file declarations. Should use `"up"`.

### C4. Container list display is broken — raw string instead of parsed JSON
**File:** `controller/server.ts:65`, `admin/src/server.ts:623-626`, `containers/+page.svelte:76-85`
Controller returns `{ ok: true, containers: "<raw JSON string>" }`. UI expects array/object. All containers always show "Not found".

### C5. JSONC parser cannot handle trailing inline comments or trailing commas
**File:** `admin/src/jsonc.ts:1-6`
Only strips full-line `//` comments. Trailing inline comments and trailing commas break `JSON.parse`.

## HIGH (16 issues)

### H1. Community registry `installTarget` bypasses `validatePluginIdentifier`
**File:** `admin/src/server.ts:541-548`, `admin/src/gallery.ts:285-292`

### H2. `validatePluginIdentifier` path traversal bypass
**File:** `admin/src/extensions.ts:14`
Does NOT block `..`. Path `./plugins/../../../etc/passwd` passes validation.

### H3. `validatePluginIdentifier` prefix mismatch with actual plugin paths
**File:** `admin/src/extensions.ts:14`, `admin/src/gallery.ts:44`
Validator requires `./plugins/` prefix, but gallery uses `plugins/` (no `./`).

### H4. Uninstall never calls `setupManager.removeExtension` — state diverges
**File:** `admin/src/server.ts:584-593`
No `removeExtension` method exists. Extensions remain listed as installed after uninstall.

### H5. `addChannel` called for ALL compose-service installs, not just channels
**File:** `admin/src/server.ts:559`
n8n, ollama, searxng pollute `enabledChannels`.

### H6. `pluginId` install path never calls `setupManager.addExtension`
**File:** `admin/src/server.ts:566-570`

### H7. `n8n`, `ollama`, `searxng` compose service names don't exist in docker-compose.yml
**File:** `admin/src/gallery.ts:195,210,225`
Installation silently fails. Returns 200 OK anyway.

### H8. `command-file`, `agent-file`, `tool-file` install actions have no handler
**File:** `admin/src/server.ts:544-563`
Three gallery items return 400 "unknown install action".

### H9. `controllerAction` swallows all errors — callers always return `200 OK`
**File:** `admin/src/server.ts:74-88`

### H10. `controller` and `openmemory-ui` in admin's `KNOWN_SERVICES` but not in controller's `ALLOWED`
**File:** `admin/src/server.ts:40-44`, `controller/server.ts:13-17`

### H11. No Caddy reload after `setAccessScope`
**File:** `admin/src/server.ts:406-410`
Uses `controllerAction("up", "caddy", ...)` — no-op if already running.

### H12. Missing Caddyfile guard — raw ENOENT crashes
**File:** `admin/src/server.ts:122-148,179-194`

### H13. `POST /admin/setup/step` has no authentication check
**File:** `admin/src/server.ts:391-397`

### H14. `opencode-core` compose healthcheck probes port 3000; service runs on 4096
**File:** `assets/state/docker-compose.yml:95`

### H15. Policy lint bypassed by nested permission structures
**File:** `admin/src/server.ts:871-872`
Only inspects one level deep.

### H16. Default `OPENCODE_CONFIG_PATH` may differ from actual config location
**File:** `admin/src/server.ts:24`

## MEDIUM (20 issues)

### M1. Cron `validateCron` does not validate field ranges
### M2. Empty schedule can be saved via edit form
### M3. Automation name newline injection into crontab
### M4. Automation mutations unconditionally restart `opencode-core`
### M5. `writeCrontab()` not called on server startup
### M6. Read-modify-write race conditions in all JSON stores
### M7. Non-atomic Caddyfile writes with no backup
### M8. `DISCORD_PUBLIC_KEY` rendered as password type
### M9. `DISCORD_PUBLIC_KEY` required field inconsistency
### M10. Channel health badges always show "unknown"
### M11. No duplicate provider name/URL check
### M12. `fetchModels` appends `/models` not `/v1/models`
### M13. Deleted provider does not clear env vars from `secrets.env`
### M14. Cannot clear stored API keys via setup UI
### M15. Setup wizard has no step ordering enforcement
### M16. `setAccessScope` silently no-ops if Caddyfile lacks expected patterns
### M17. `formatTime` parses ISO timestamps as integers
### M18. `applySmallModelToOpencodeConfig` uses non-atomic write
### M19. `agents/channel-intake.md` referenced in gallery but file does not exist
### M20. `POST /admin/setup/access-scope` does not auto-complete the wizard step

## LOW (17 issues)

### L1-L17. See full audit details above.
