# Code Drift Report

Source of truth: `docs/admin-concepts.md` (technical) and `docs/user-concepts.md` (user-facing), plus all updated documentation files from the documentation drift remediation pass.

Code, scripts, and configuration files were reviewed against the canonical five concepts (Extensions, Connections, Channels, Automations, Gateway). This report lists every instance where code drifts from, contradicts, or is incomplete relative to the documentation.

---

## CRITICAL Severity Issues

These are code-level contradictions that will cause incorrect runtime behavior or break documented contracts.

| # | File | Issue |
|---|------|-------|
| 1 | `gateway/src/server.ts` | HMAC verification runs AFTER payload validation — steps 1 and 2 of the Gateway pipeline are reversed relative to the documented order (HMAC first, then payload validation) |
| 2 | `gateway/src/server.ts` | Rate-limit key uses `getUTCMinutes()` creating a fixed-window counter that resets on the minute boundary instead of the documented sliding-window 120/min/user limit |
| 3 | `gateway/src/server.ts` | First audit-log write is missing `sessionId`, making the audit trail incomplete |
| 4 | `assets/state/docker-compose.yml` | Uses `OPENCODE_CONFIGURATION_DIRECTORY` instead of the documented `OPENCODE_CONFIG_DIR` env var |
| 5 | `opencode/entrypoint.sh` | Uses `OPENCODE_CONFIGURATION_DIRECTORY` instead of `OPENCODE_CONFIG_DIR`; does not create `cron-payloads/` directory |
| 6 | `opencode/extensions/tool/` | Directory uses singular `tool/` — must be renamed to `tools/` per documented plural convention |
| 7 | `opencode/extensions/command/` | Directory uses singular `command/` — must be renamed to `commands/` per documented plural convention |

---

## HIGH Severity Issues

Direct contradictions or critical omissions relative to the documented concepts.

| # | File | Issue |
|---|------|-------|
| 8 | `admin/src/gallery.ts` | Risk scale uses `low/medium/high/critical` instead of documented `lowest/low/medium/medium-high/highest` |
| 9 | `admin/src/gallery.ts` | `GalleryCategory` type only has `plugin | skill | container` — missing `command`, `agent`, `tool` |
| 10 | `admin/src/gallery.ts` | Channels classified as `category: "container"` — Channels are a separate top-level concept, not an extension type |
| 11 | `admin/src/server.ts` | All Automations routes named `/admin/crons*` with comments saying "Cron jobs" instead of "Automations" |
| 12 | `admin/src/server.ts` | Connections concept entirely absent — no API routes for managing connections, no `OPENPALM_CONN_*` handling |
| 13 | `admin/src/server.ts` | Trigger metadata uses `cronJobId`/`cronJobName` field names instead of `automationId`/`automationName` |
| 14 | `admin/src/cron-store.ts` | Types named `CronJob`/`CronStore`/`CronState` instead of `Automation`/`AutomationStore`/`AutomationState`; `enabled` boolean instead of documented `Status` field |
| 15 | `admin/src/types.ts` | `ProviderConnection` type does not implement the full Connections model — no `OPENPALM_CONN_*` prefix, no type discriminator (AI Provider / Platform / API Service), no `secrets.env` storage convention |
| 16 | `admin/ui/setup-ui.js` | `/admin/containers/up` endpoint used for Channels — conflates Channels with container extensions |
| 17 | `admin/ui/setup-ui.js` | Plugin example shows `risk: "low"` but Plugin is the highest-risk extension type |
| 18 | `admin/ui/setup-ui.js` | No Connections management step in the setup wizard — user has no way to configure connections during setup |
| 19 | `admin/ui/setup-ui.js` | API keys presented as raw inputs instead of using the Connection abstraction |
| 20 | `admin/ui/setup-ui.js` | No Automations step in the setup wizard |
| 21 | `admin/ui/tests/` | All test files are stubs with minimal assertions; no coverage for Connections, Automations, risk badges, or gallery category filters |
| 22 | `channels/chat/server.ts` | Defaults to port 8181 — collides with `channels/webhook/server.ts` which also defaults to 8181 |
| 23 | `channels/webhook/server.ts` | Defaults to port 8181 — collides with `channels/chat/server.ts` |
| 24 | `controller/server.ts` | `channel-webhook` missing from `CORE_SERVICES` allowlist — webhook channel cannot be managed by the controller |
| 25 | `controller/server.ts` | Route `/down/` executes `stop` command — semantic mismatch between route name and action |
| 26 | `assets/state/registry/schema.json` | `category` enum missing `command`, `agent`, `tool` values |
| 27 | `assets/state/registry/schema.json` | `risk` enum uses wrong labels (should be `lowest/low/medium/medium-high/highest`) |
| 28 | `assets/state/registry/schema.json` | `installAction` enum missing values for commands, agents, and custom tools |
| 29 | `assets/config/secrets.env` | No `OPENPALM_CONN_*` prefixed variables — the Connections naming convention is entirely absent |

---

## MEDIUM Severity Issues

Inconsistent terminology, missing feature implementations, or incomplete alignments.

| # | File | Issue |
|---|------|-------|
| 30 | `admin/src/server.ts` | Extension listing endpoints only return plugins and skills, not all 5 extension types |
| 31 | `admin/src/server.ts` | No health-check endpoint that covers all 5 concepts (Extensions, Connections, Channels, Automations, Gateway) |
| 32 | `admin/src/gallery.ts` | Gallery search/filter does not support all documented extension categories |
| 33 | `admin/src/types.ts` | No `Automation` type defined — only `CronJob` type exists |
| 34 | `admin/ui/setup-ui.js` | Gallery category filters in UI only show Plugin, Skill, Container — missing Command, Agent, Tool |
| 35 | `admin/ui/setup-ui.js` | Risk badge rendering uses old 4-tier scale colors, not the documented 5-tier hierarchy |
| 36 | `gateway/opencode/opencode.jsonc` | Does not reference channel-intake agent by name |
| 37 | `channels/*/` | Public/private per-channel access control not implemented — documentation describes a toggle, but code only implements token-gating |
| 38 | `assets/config/` | Caddyfile configurations have no public route variant — all routes are LAN-only by default, contradicting the documented per-channel public/private toggle |
| 39 | `opencode/Dockerfile` | Comment lists `lib` as extension sub-type and omits `commands/` and `tools/` from the documented directory structure |
| 40 | `admin/src/server.ts` | "Cron" terminology used in all log messages and internal comments instead of "Automation" |
| 41 | `admin/ui/setup-ui.js` | Extensions section header says "Plugins" instead of "Extensions" |
| 42 | `controller/server.ts` | Services list uses internal container names without mapping to the documented Channel concept names |

---

## LOW Severity Issues

Minor naming inconsistencies or undocumented features that don't break functionality.

| # | File | Issue |
|---|------|-------|
| 43 | `gateway/src/types.ts` | `ChannelMessage` type has undocumented `attachments` field not described in any concept document |
| 44 | `opencode/extensions/opencode.jsonc` | Uses `ANTHROPIC_API_KEY` directly instead of `OPENPALM_CONN_ANTHROPIC_API_KEY` (Connections convention) |
| 45 | `admin/src/server.ts` | Internal variable names use `cron` prefix throughout (e.g., `cronStore`, `cronJob`) |
| 46 | `admin/src/gallery.ts` | Internal comments reference "plugins" when describing general extension operations |
| 47 | `admin/ui/setup-ui.js` | Health check display groups services by internal names, not by concept categories |
| 48 | `channels/chat/server.ts` | No reference to Gateway pipeline in code comments |
| 49 | `channels/webhook/server.ts` | No reference to Gateway pipeline in code comments |
| 50 | `controller/server.ts` | Log messages use mixed terminology ("services" / "containers" / "channels") |
| 51 | `opencode/entrypoint.sh` | Comment block lists extension directories without using documented plural convention |
| 52 | `opencode/Dockerfile` | Extension COPY directives use singular paths where plural directories are documented |

---

## Cross-Cutting Patterns

### 1. `OPENCODE_CONFIGURATION_DIRECTORY` vs `OPENCODE_CONFIG_DIR`
The docker-compose file and entrypoint script use `OPENCODE_CONFIGURATION_DIRECTORY` while all documentation specifies `OPENCODE_CONFIG_DIR`. This env var name mismatch means the documented configuration path will not work at runtime.

**Affected**: `assets/state/docker-compose.yml`, `opencode/entrypoint.sh`, `opencode/Dockerfile`

### 2. Connections concept has zero code implementation
No API routes, no type definitions, no UI components, and no env var conventions exist for the Connections concept. The `secrets.env` file stores raw API keys without the `OPENPALM_CONN_*` prefix convention. The `ProviderConnection` type in `types.ts` is a minimal stub that doesn't implement the documented model.

**Affected**: `admin/src/server.ts`, `admin/src/types.ts`, `admin/ui/setup-ui.js`, `assets/config/secrets.env`, `opencode/extensions/opencode.jsonc`

### 3. "Cron" terminology pervades the entire codebase
Every code file that deals with scheduled tasks uses "cron" in type names, variable names, route paths, log messages, and comments. The canonical term "Automations" appears nowhere in the code.

**Affected**: `admin/src/server.ts`, `admin/src/cron-store.ts`, `admin/src/types.ts`, `admin/ui/setup-ui.js`, `controller/server.ts`

### 4. Extension type system is incomplete
The gallery, registry schema, and admin API only recognize 3 of 5 extension types (plugin, skill, container). Commands, Agents, and Custom Tools are not registered, filterable, or manageable through the admin interface. The "container" category is used where "channel" should be a separate concept.

**Affected**: `admin/src/gallery.ts`, `admin/src/server.ts`, `admin/ui/setup-ui.js`, `assets/state/registry/schema.json`

### 5. Risk scale mismatch
Code uses a generic 4-tier scale (`low/medium/high/critical`) while documentation defines a 5-tier type-based hierarchy (`lowest/low/medium/medium-high/highest` mapped to Skill/Command/Agent/Custom Tool/Plugin respectively).

**Affected**: `admin/src/gallery.ts`, `admin/ui/setup-ui.js`, `assets/state/registry/schema.json`

### 6. Singular directory names in codebase
The actual extension directories use singular names (`command/`, `tool/`) while all documentation specifies plural (`commands/`, `tools/`). This is a file-system level mismatch.

**Affected**: `opencode/extensions/command/`, `opencode/extensions/tool/`, `opencode/entrypoint.sh`, `opencode/Dockerfile`

### 7. Gateway pipeline order violation
The gateway implementation processes payload validation before HMAC verification, violating the documented pipeline order. This is a security concern — unauthenticated payloads are being parsed and validated before authentication is confirmed.

**Affected**: `gateway/src/server.ts`

---

## Files Reviewed

| Area | Files | CRITICAL | HIGH | MEDIUM | LOW |
|------|-------|----------|------|--------|-----|
| Admin Service | `server.ts`, `gallery.ts`, `cron-store.ts`, `types.ts` + 11 others | 0 | 6 | 6 | 4 |
| Admin UI | `setup-ui.js`, `index.html`, test files | 0 | 6 | 4 | 0 |
| Gateway | `server.ts`, `types.ts`, config files | 3 | 0 | 3 | 3 |
| Channels + Controller | `chat/server.ts`, `webhook/server.ts`, `controller/server.ts` + 16 others | 0 | 2 | 5 | 4 |
| Infrastructure Configs | `docker-compose.yml`, `schema.json`, `secrets.env`, Caddyfiles + 15 others | 2 | 3 | 2 | 0 |
| Extensions + OpenCode | `entrypoint.sh`, `Dockerfile`, extension dirs, test files + 20 others | 2 | 0 | 2 | 3 |
| **TOTALS** | **~110 files** | **7** | **17** | **22** | **14** |

---

## Recommended Fix Priority

### Priority 1 — Security & Runtime Correctness
1. **Gateway pipeline order** (`gateway/src/server.ts`) — Move HMAC verification before payload validation
2. **Env var name** (`assets/state/docker-compose.yml`, `opencode/entrypoint.sh`) — Rename `OPENCODE_CONFIGURATION_DIRECTORY` to `OPENCODE_CONFIG_DIR`
3. **Port collision** (`channels/chat/server.ts`, `channels/webhook/server.ts`) — Assign distinct default ports
4. **Controller allowlist** (`controller/server.ts`) — Add `channel-webhook` to `CORE_SERVICES`

### Priority 2 — Schema & Type Alignment
5. **Registry schema** (`assets/state/registry/schema.json`) — Add all 5 extension type categories, fix risk enum to 5-tier scale, add missing installAction values
6. **Gallery types** (`admin/src/gallery.ts`) — Update `GalleryCategory` to include all types, fix risk scale, stop classifying Channels as `container`
7. **Automation types** (`admin/src/cron-store.ts`, `admin/src/types.ts`) — Rename `CronJob` → `Automation`, `CronStore` → `AutomationStore`, update all field names

### Priority 3 — API Route Alignment
8. **Automation routes** (`admin/src/server.ts`) — Rename `/admin/crons*` → `/admin/automations*`, update trigger metadata field names
9. **Connections API** (`admin/src/server.ts`, `admin/src/types.ts`) — Implement Connections CRUD routes, type definitions, and `OPENPALM_CONN_*` env var convention
10. **Extension listing** (`admin/src/server.ts`) — Expand extension endpoints to return all 5 types

### Priority 4 — UI Alignment
11. **Setup wizard** (`admin/ui/setup-ui.js`) — Add Connections step, add Automations step, fix risk badge colors, update gallery filters to all 5 types
12. **Terminology** (`admin/ui/setup-ui.js`) — Replace "Plugins" headers with "Extensions", fix Channel management to not use container endpoints

### Priority 5 — Directory Rename
13. **Extension directories** — Rename `opencode/extensions/command/` → `commands/`, `opencode/extensions/tool/` → `tools/`
14. **Dockerfile + entrypoint** — Update COPY paths and directory creation to use plural names

### Priority 6 — Terminology Sweep
15. **Global rename** — "cron"/"cronJob" → "automation" in all code variable names, log messages, and comments
16. **Secrets convention** — Add `OPENPALM_CONN_*` prefix to all credential env vars in `secrets.env` and consuming code
17. **Comment cleanup** — Update code comments that reference old terminology or incomplete concept lists
