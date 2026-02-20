## Overview

Completely rebuild the admin UI from the ground up using SvelteKit. The current implementation is non-functional and should not be used as a reference. All design and functionality decisions must be based solely on the latest project documentation. Additionally, deliver a complete suite of automated tests to verify each required feature.

## Requirements

- Rewrite the entire admin UI as a modern SvelteKit SPA
- **Do not reuse or reference any code from the existing admin UI**
- Derive the complete feature set from the provided project documentation only
- Implement end-to-end automated tests for every feature
- Ensure accessibility and responsive design
- Follow best practices for SvelteKit architecture, state management, and code organization

## Deliverables

- A new `admin/` app implemented in SvelteKit with all required features
- Automated tests for each UI component and workflow (unit + e2e)
- Documentation on development, testing, and deployment of the admin UI

---

## Feature List

The admin UI serves as the sole management interface for OpenPalm. It is served by the `admin` service on `:8100`, routed through Caddy at `/admin/*`, and restricted to LAN access. All protected operations require the `x-admin-token` header ([API Reference](docs/api-reference.md)).

The five core user-facing concepts are **Extensions**, **Connections**, **Channels**, **Automations**, and the **Gateway** ([User Concepts](docs/user-concepts.md), [Admin Concepts](docs/admin-concepts.md)).

---

### 1. Setup Wizard (First-Boot)

A guided 7-step onboarding flow that runs on the first visit to the admin UI.

**Steps:**
1. **Welcome** — introduction and overview
2. **Access Scope** — choose `host` (localhost-only) or `lan` (local network); updates Caddy matchers and compose bind addresses
3. **Service Instances** — configure external service instance URLs (OpenMemory, PostgreSQL, Qdrant) and the OpenMemory OpenAI-compatible endpoint (`openaiBaseUrl`, `openaiApiKey`)
4. **Health Check** — verify gateway and OpenCode Core are running (`GET /admin/setup/health-check`)
5. **Security** — admin password confirmation
6. **Channels** — select which channel adapters to enable
7. **Extensions** — select initial extensions to install

**API Endpoints:**
- `GET /admin/setup/status` — current wizard state, completed steps, channel/extension selections, OpenMemory provider config
- `POST /admin/setup/step` — mark a step complete
- `POST /admin/setup/access-scope` — set host vs LAN scope
- `POST /admin/setup/service-instances` — set external service URLs and OpenMemory provider
- `POST /admin/setup/complete` — finalize setup
- `GET /admin/setup/health-check` — probe gateway and OpenCode health

**References:** [Admin Guide §1](docs/admin-guide.md), [API Reference — Setup Wizard](docs/api-reference.md), [Architecture — URL Routing](docs/architecture.md)

---

### 2. System Status Dashboard

A landing page showing the health and operational state of all services.

**Features:**
- [ ] Health indicators for each core service (gateway, OpenCode Core, OpenMemory, admin, controller, Caddy)
- [ ] Health indicators for enabled channel adapters (chat, discord, voice, telegram)
- [ ] Container status list via `GET /admin/containers/list`

**References:** [Architecture — Container Inventory](docs/architecture.md), [Admin Guide §2](docs/admin-guide.md)

---

### 3. Extension Gallery

Browse, install, and uninstall extensions that add capabilities to the assistant. The gallery surfaces extensions from three sources and displays risk badges for each item.

**Extension types** (from [OpenCode docs](https://opencode.ai/docs/)):
| Type | Risk | Description |
|---|---|---|
| [Skill](https://opencode.ai/docs/skills/) | Lowest | Markdown behavioral directive — influences reasoning only |
| [Command](https://opencode.ai/docs/commands/) | Low | Slash command definition — triggers a prompt |
| [Agent](https://opencode.ai/docs/agents/) | Medium | Specialized assistant persona with its own tool policy |
| [Custom Tool](https://opencode.ai/docs/custom-tools/) | Medium-High | TypeScript function callable by the LLM |
| [Plugin](https://opencode.ai/docs/plugins/) | Highest | TypeScript lifecycle hooks — can observe/modify all tool calls |
| Channel | Medium | Adapter service managed via Docker Compose |
| Service | Medium-High | Infrastructure add-on (e.g., Ollama, SearXNG, n8n) |

**Discovery sources:**
1. **Curated gallery** — officially reviewed, shipped with OpenPalm
2. **Community registry** — fetched at runtime from GitHub (`OPENPALM_REGISTRY_URL`), 10-minute cache
3. **npm search** — live search of `registry.npmjs.org` for OpenCode plugins (unreviewed)

**Features:**
- [ ] Search and browse extensions with free-text query and category filter
- [ ] Display risk badges (lowest / low / medium / medium-high / highest) with explanatory labels
- [ ] Category tabs/filter (`plugin`, `skill`, `command`, `agent`, `tool`, `channel`, `service`)
- [ ] Detail view per extension showing name, description, risk, type, install status
- [ ] Install action — delegates to config update or controller depending on type
- [ ] Uninstall action — removes extension config entry or stops container
- [ ] npm search tab for discovering non-curated OpenCode plugins
- [ ] Community registry tab with manual cache refresh
- [ ] Installed extensions inventory (`GET /admin/installed`)

**API Endpoints:**
- `GET /admin/gallery/search?q=&category=`
- `GET /admin/gallery/categories`
- `GET /admin/gallery/item/:id`
- `GET /admin/gallery/npm-search?q=`
- `GET /admin/gallery/community?q=&category=`
- `POST /admin/gallery/community/refresh`
- `POST /admin/gallery/install`
- `POST /admin/gallery/uninstall`
- `GET /admin/installed`

**References:** [Extensions Guide](docs/extensions-guide.md), [Extensions Reference](docs/extensions-reference.md), [Admin Concepts — Extensions](docs/admin-concepts.md), [User Concepts — Extensions](docs/user-concepts.md), [API Reference — Gallery](docs/api-reference.md), [OpenCode Plugin Docs](https://opencode.ai/docs/plugins/), [OpenCode Skills Docs](https://opencode.ai/docs/skills/)

---

### 4. Channel Management

Configure and control the messaging channel adapters that bridge external platforms to the assistant.

**Supported channels:**
| Channel | Port | Key credentials | Caddy route |
|---|---|---|---|
| Web Chat | `:8181` | `CHAT_INBOUND_TOKEN` (optional) | `/channels/chat*` |
| Telegram | `:8182` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `/channels/telegram*` |
| Voice | `:8183` | — | `/channels/voice*` |
| Discord | `:8184` | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` | `/channels/discord*` |

**Features:**
- [ ] List all channel adapters with status (enabled/disabled/error) and current access mode
- [ ] Per-channel credential configuration form (bot tokens, webhook secrets)
- [ ] Access toggle: switch between `lan` (private) and `public` per channel
- [ ] Start / stop channel containers via controller
- [ ] Display setup guidance per platform (e.g., Discord Developer Portal steps)

**API Endpoints:**
- `GET /admin/channels` — list channels with access mode and config keys
- `POST /admin/channels/access` — set `lan` or `public` per channel
- `GET /admin/channels/config?service=<name>` — read channel env config
- `POST /admin/channels/config` — update channel env config with optional restart

**Security:** All channel messages pass through the Gateway's 6-step security pipeline (HMAC verification → payload validation → rate limiting → intake validation → forward → audit). Access defaults to LAN-only.

**References:** [User Concepts — Channels](docs/user-concepts.md), [Admin Concepts — Channels](docs/admin-concepts.md), [Architecture — URL Routing](docs/architecture.md), [API Reference — Channel Adapters](docs/api-reference.md), [Security Guide §2](docs/security.md)

---

### 5. Automations Management

Create and manage scheduled prompts that let the assistant act proactively on a cron schedule.

**Features:**
- [ ] List all automations with name, schedule, status (enabled/disabled), and last-run info
- [ ] Create automation: name, prompt text, and schedule (cron expression or friendly picker)
- [ ] Edit automation: update name, prompt, schedule, or enabled/disabled status
- [ ] Delete automation
- [ ] "Run Now" manual trigger to fire an automation immediately outside its schedule
- [ ] Cron expression validation on create/update
- [ ] Display cron schedule in human-readable form

**Automation properties:** ID (UUID), Name, Prompt, Schedule (Unix cron), Status (enabled/disabled). Each runs in its own isolated session (`cron-<job-id>`).

**API Endpoints:**
- `GET /admin/automations` — list all automations
- `POST /admin/automations` — create new automation
- `POST /admin/automations/update` — update existing automation
- `POST /admin/automations/delete` — delete automation
- `POST /admin/automations/trigger` — "Run Now" immediate trigger

**References:** [User Concepts — Automations](docs/user-concepts.md), [Admin Concepts — Automations](docs/admin-concepts.md), [Architecture — Automations](docs/architecture.md), [API Reference — Automations](docs/api-reference.md)

---

### 6. Providers Management

Add, configure, and assign AI provider endpoints for the assistant and memory system.

**Features:**
- [ ] List configured providers (name, endpoint URL, configured status)
- [ ] Add new provider (name, URL, API key)
- [ ] Edit provider (update name, URL, API key)
- [ ] Delete provider (removes associated model assignments)
- [ ] List available models from a provider endpoint
- [ ] Assign a provider + model to a role (e.g., `small`, `openmemory`)

**API Endpoints:**
- `GET /admin/providers` — list all providers and assignments
- `POST /admin/providers` — add a provider
- `POST /admin/providers/update` — update a provider
- `POST /admin/providers/delete` — delete a provider
- `POST /admin/providers/models` — list models from a provider
- `POST /admin/providers/assign` — assign a provider+model to a role

**References:** [API Reference — Providers](docs/api-reference.md), [OpenCode Providers Docs](https://opencode.ai/docs/providers/)

---

### 7. Config Editor

View and edit the `opencode.jsonc` agent configuration file with schema awareness and policy enforcement.

**Features:**
- [ ] Read and display current `opencode.jsonc` content
- [ ] Edit with JSONC syntax support (comments preserved)
- [ ] Policy lint: reject any config that widens a permission to `"allow"` (only `"ask"` and `"deny"` permitted)
- [ ] Atomic writes with timestamped `.bak` backup of previous config
- [ ] Optional restart of `opencode-core` after save
- [ ] Bootstrap empty `{}` config if `opencode.jsonc` doesn't exist on first boot

**API Endpoints:**
- `GET /admin/config` — read current config (text/plain)
- `POST /admin/config` — write config with policy lint and optional restart

**References:** [Admin Guide §2 — Safe Config Editing](docs/admin-guide.md), [API Reference — Config Editor](docs/api-reference.md), [OpenCode Config Docs](https://opencode.ai/docs/config/), [OpenCode Permissions Docs](https://opencode.ai/docs/permissions/)

---

### 8. Container Management

Start, stop, and restart individual services in the Docker Compose stack.

**Features:**
- [ ] List all running containers with status
- [ ] Start a service (`POST /admin/containers/up`)
- [ ] Stop a service (`POST /admin/containers/down`)
- [ ] Restart a service (`POST /admin/containers/restart`)

**Allowed services:** `opencode-core`, `gateway`, `openmemory`, `admin`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`, `caddy`

**API Endpoints:**
- `GET /admin/containers/list`
- `POST /admin/containers/up`
- `POST /admin/containers/down`
- `POST /admin/containers/restart`

**Note:** The admin service delegates all lifecycle operations to the Controller (`:8090`), which is the only container with Docker socket access.

**References:** [Architecture — Container Inventory](docs/architecture.md), [API Reference — Container Management](docs/api-reference.md), [Security Guide §5](docs/security.md)

---

### 9. Embedded UIs

The admin dashboard embeds two external UIs via Caddy reverse proxy routes.

**Features:**
- [ ] **OpenCode UI** — embedded at `/admin/opencode*` → `opencode-core:4096` ([OpenCode Web/Server Mode](https://opencode.ai/docs/web/))
- [ ] **OpenMemory UI** — embedded at `/admin/openmemory*` → `openmemory-ui:3000`

**References:** [Architecture — URL Routing via Caddy](docs/architecture.md), [API Reference — LAN Web UIs](docs/api-reference.md)

---

### 10. Authentication & Security

All admin write operations are protected by password-based authentication.

**Features:**
- [ ] Login screen / password entry on first access
- [ ] `x-admin-token` header sent with all protected API requests
- [ ] Unauthenticated access allowed only for: `/health`, `/admin/setup/*`, gallery read endpoints, and static assets
- [ ] Admin panel only accessible from local network (enforced by Caddy LAN matchers)

**References:** [Admin Guide §3 — Access Protection](docs/admin-guide.md), [Security Guide](docs/security.md), [Architecture — Security Model](docs/architecture.md)

---

### 11. Static UI Assets

The admin service serves static files for the SPA.

**Features:**
- [ ] Serve `index.html`, JavaScript bundles, CSS, and static assets (logo, etc.)
- [ ] SPA routing — all unmatched `/admin*` routes serve `index.html`

**References:** [Architecture — URL Routing](docs/architecture.md)

---

## Cross-Cutting Concerns

- [ ] **Responsive design** — usable on desktop and tablet
- [ ] **Accessibility** — WCAG 2.1 AA compliance; keyboard navigable, screen-reader friendly
- [ ] **Error handling** — display meaningful error messages for API failures (401, 403, 422, 429, 502)
- [ ] **Loading states** — show loading indicators during API calls
- [ ] **Toast / notification system** — provide feedback for successful and failed operations
- [ ] **SvelteKit best practices** — proper routing, stores, SSR/CSR configuration for SPA mode

---

## Test Requirements

- [ ] **Unit tests** for each UI component (Vitest + Testing Library)
- [ ] **Integration tests** for API interactions
- [ ] **E2E tests** for each feature workflow (Playwright)
- [ ] Cover all happy paths and key error scenarios (auth failure, validation errors, service unavailable)

---

## Key Documentation References

| Document | Description |
|---|---|
| [User Concepts](docs/user-concepts.md) | End-user guide to Extensions, Connections, Channels, Automations, Gateway |
| [Admin Concepts](docs/admin-concepts.md) | Architecture concepts with full technical detail |
| [Admin Guide](docs/admin-guide.md) | Installer flow, admin console pages, maintenance, hardening |
| [Architecture](docs/architecture.md) | Container inventory, data flow, URL routing, storage, security model |
| [API Reference](docs/api-reference.md) | All service endpoints: gateway, admin, controller, channels |
| [Extensions Guide](docs/extensions-guide.md) | Extension types, install/uninstall flows, channel authoring, community registry |
| [Extensions Reference](docs/extensions-reference.md) | Technical reference for all extension types |
| [Security Guide](docs/security.md) | Defense-in-depth security layers |
| [Host System Reference](docs/host-system-reference.md) | Host paths, env vars, network ports |
| [Backup & Restore](docs/backup-restore.md) | Backup/restore procedures |
| [Upgrade Guide](docs/upgrade-guide.md) | Upgrade procedures |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and resolutions |

**OpenCode documentation:**
| Topic | URL |
|---|---|
| Configuration | https://opencode.ai/docs/config/ |
| Skills | https://opencode.ai/docs/skills/ |
| Commands | https://opencode.ai/docs/commands/ |
| Agents | https://opencode.ai/docs/agents/ |
| Custom Tools | https://opencode.ai/docs/custom-tools/ |
| Plugins | https://opencode.ai/docs/plugins/ |
| Providers | https://opencode.ai/docs/providers/ |
| Permissions | https://opencode.ai/docs/permissions/ |
| Web/Server Mode | https://opencode.ai/docs/web/ |

---

## Guidance

- For each checkbox above, expand into specific UI/UX flows based on the most recent documentation
- Prioritize thorough test coverage: every feature must include robust tests
- Work closely with project documentation and maintainers to clarify unclear requirements

---

**Note:** This feature list was derived from the current project documentation and admin API implementation. Confirm with maintainers before development begins.
