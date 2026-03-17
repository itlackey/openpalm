# Admin Decoupling — Task Tracker (#316)

> Comprehensive task list for decoupling the admin container from the core OpenPalm stack.
> See `.claude/plans/lovely-prancing-journal.md` for full architectural plan.

---

## Phase 0: Extract shared library (`@openpalm/lib`)

**Goal:** Move portable control-plane logic from admin to a shared package. No behavior change — admin re-exports from lib.

### 0.1 Create `packages/lib/` package
- [x] Create `packages/lib/package.json` (`@openpalm/lib`, Bun target, workspace:*)
- [x] Create `packages/lib/tsconfig.json`
- [x] Create `packages/lib/src/index.ts` barrel export
- [x] Add `packages/lib` to root `package.json` workspaces array
- [x] Add `@openpalm/lib` dependency to `packages/admin/package.json`

### 0.2 Extract pure-functional modules to lib
- [x] `packages/lib/src/control-plane/types.ts` — ControlPlaneState, CoreServiceName, ChannelInfo, etc.
- [x] `packages/lib/src/control-plane/paths.ts` — resolveConfigHome, resolveDataHome, resolveStateHome, ensureXdgDirs
- [x] `packages/lib/src/control-plane/env.ts` — parseEnvContent, parseEnvFile, mergeEnvContent
- [x] `packages/lib/src/control-plane/audit.ts` — appendAudit
- [x] `packages/lib/src/control-plane/secrets.ts` — ensureSecrets, updateSecretsEnv, loadSecretsEnvFile, etc.
- [x] `packages/lib/src/control-plane/channels.ts` — discoverChannels, isAllowedService, install/uninstall
- [x] `packages/lib/src/control-plane/connection-profiles.ts` — CRUD for connection profiles
- [x] `packages/lib/src/control-plane/connection-mapping.ts` — buildOpenCodeMapping, buildMem0Mapping
- [x] `packages/lib/src/control-plane/setup-status.ts` — isSetupComplete, readSecretsKeys, detectUserId
- [x] `packages/lib/src/control-plane/memory-config.ts` — readMemoryConfig, writeMemoryConfig, pushConfigToMemory
- [x] `packages/lib/src/control-plane/model-runner.ts` — detectLocalProviders
- [x] `packages/lib/src/control-plane/scheduler.ts` — parseAutomationYaml, Croner-based scheduler
- [x] `packages/lib/src/control-plane/connection-migration-flags.ts` — migration compat detection
- [x] `packages/lib/src/provider-constants.ts` — LLM_PROVIDERS, EMBEDDING_DIMS, etc.
- [x] `packages/lib/src/logger.ts` — createLogger factory

### 0.3 CoreAssetProvider dependency injection
- [x] Create `packages/lib/src/control-plane/core-asset-provider.ts` interface (10 methods)
- [x] Create `packages/lib/src/control-plane/fs-asset-provider.ts` (FilesystemAssetProvider)
- [x] Create `packages/admin/src/lib/server/vite-asset-provider.ts` (ViteAssetProvider with $assets imports)
- [x] Refactor `packages/lib/src/control-plane/core-assets.ts` — all functions accept CoreAssetProvider param

### 0.4 RegistryProvider dependency injection
- [x] Create `packages/lib/src/control-plane/registry-provider.ts` interface (5 methods)
- [x] Create `packages/lib/src/control-plane/fs-registry-provider.ts` (FilesystemRegistryProvider)
- [x] Create `packages/admin/src/lib/server/vite-registry-provider.ts` (ViteRegistryProvider with import.meta.glob)
- [x] Refactor `packages/lib/src/control-plane/channels.ts` — installChannelFromRegistry/installAutomationFromRegistry accept RegistryProvider

### 0.5 Extract staging pipeline and lifecycle
- [x] `packages/lib/src/control-plane/staging.ts` — stageArtifacts(state, assets), persistArtifacts(state, assets)
- [x] `packages/lib/src/control-plane/lifecycle.ts` — applyInstall/Update/Uninstall/Upgrade accept CoreAssetProvider
- [x] Replace `adminPkg.version` with `process.env.OPENPALM_IMAGE_TAG ?? "latest"` in staging

### 0.6 Invert dependency — admin thin re-exports
- [x] `packages/admin/src/lib/server/types.ts` — pure re-export from @openpalm/lib
- [x] `packages/admin/src/lib/server/paths.ts` — pure re-export
- [x] `packages/admin/src/lib/server/env.ts` — pure re-export
- [x] `packages/admin/src/lib/server/audit.ts` — pure re-export
- [x] `packages/admin/src/lib/server/secrets.ts` — pure re-export
- [x] `packages/admin/src/lib/server/setup-status.ts` — pure re-export
- [x] `packages/admin/src/lib/server/docker.ts` — pure re-export
- [x] `packages/admin/src/lib/server/model-runner.ts` — pure re-export
- [x] `packages/admin/src/lib/server/memory-config.ts` — pure re-export
- [x] `packages/admin/src/lib/server/connection-profiles.ts` — pure re-export
- [x] `packages/admin/src/lib/server/connection-mapping.ts` — pure re-export
- [x] `packages/admin/src/lib/server/connection-migration-flags.ts` — pure re-export
- [x] `packages/admin/src/lib/server/scheduler.ts` — pure re-export
- [x] `packages/admin/src/lib/server/channels.ts` — wrapped re-export (pre-injects viteRegistry)
- [x] `packages/admin/src/lib/server/core-assets.ts` — wrapped re-export (pre-injects viteAssets)
- [x] `packages/admin/src/lib/server/staging.ts` — wrapped re-export (pre-injects viteAssets)
- [x] `packages/admin/src/lib/server/lifecycle.ts` — wrapped re-export (pre-injects viteAssets)
- [x] `packages/admin/src/lib/server/registry.ts` — re-export from vite-registry-provider
- [x] `packages/admin/src/lib/server/control-plane.ts` — comprehensive barrel with all re-exports + wraps

### 0.7 CLI uses @openpalm/lib
- [x] Add `@openpalm/lib` dependency to `packages/cli/package.json`
- [x] Rewrite `packages/cli/src/lib/paths.ts` — re-export resolveConfigHome/DataHome/StateHome from lib
- [x] Update `packages/cli/src/lib/docker.ts` — call lib's ensureXdgDirs() for core dirs

### 0.8 Docker wrapper in lib
- [x] `packages/lib/src/control-plane/docker.ts` — composeUp, composeDown, composePs, etc.
- [x] `packages/admin/src/lib/server/docker.ts` — re-exports from @openpalm/lib

### 0.9 Validation
- [x] `bun run admin:check` — 651 files, 0 errors
- [x] `bun run admin:test:unit` — 601 tests pass
- [x] `bun run admin:test:e2e:mocked` — 69 tests pass
- [x] `bun run test` (non-admin) — 350 tests pass
- [x] `bun run cli:test` — 23 tests pass
- [x] Fix staging-core.test.ts IMAGE_TAG assertion (was using adminPkg.version)

---

## Phase 1: Make CLI self-sufficient for Docker lifecycle ✓

**Goal:** All CLI commands work without the admin container being present.

### 1.1 Enhance CLI docker compose command building
- [x] Replace CLI's `composeProjectArgs()` with lib's `buildComposeFileList()` + `buildEnvFiles()`
- [x] Create `fullComposeArgs(state)` helper in CLI staging.ts
- [x] Handle channel overlay compose files in CLI

### 1.2 Add staging step to CLI commands
- [x] Create `ensureStagedState()` helper using `FilesystemAssetProvider`
- [x] Stage artifacts before every compose operation
- [x] CLI reads assets from DATA_HOME (persisted by install)

### 1.3 Rewrite CLI commands to be self-sufficient
- [x] `start.ts` — stage artifacts, `docker compose up -d` directly (tryAdmin fallback to direct)
- [x] `stop.ts` — `docker compose down` directly
- [x] `restart.ts` — `docker compose restart [service]` directly
- [x] `status.ts` — `docker compose ps` directly, parse output
- [x] `update.ts` — `docker compose pull` + `up -d --force-recreate`
- [x] `uninstall.ts` — `docker compose down [-v]` directly
- [x] `service.ts` — `docker compose start/stop/restart [service]` directly
- [x] `logs.ts` — `docker compose logs --tail 100` directly (fixed double-compose bug)

### 1.4 Keep admin delegation as optional fallback
- [x] Make admin API calls conditional (only if admin is running)
- [x] Fallback to direct compose operations when admin is absent
- [x] Refactor `packages/cli/src/lib/admin.ts` — tryAdminRequest returns null if unreachable

### 1.5 Validation
- [x] All CLI commands work with admin container stopped
- [x] `openpalm start` starts core services without admin
- [x] `openpalm status` shows container states without admin
- [x] `bun run cli:test` passes — 23 tests
- [x] `bun run test` passes — 298 non-admin tests

---

## Phase 2: CLI-hosted web setup wizard

**Goal:** `openpalm install` completes entirely via CLI without admin container.

### 2.1 Port setup wizard to standalone HTML/JS
- [x] Create `packages/cli/src/setup-wizard/index.html` — single-page wizard UI
- [x] Create `packages/cli/src/setup-wizard/wizard.js` — vanilla JS wizard logic (2027 lines, all steps)
- [x] Create `packages/cli/src/setup-wizard/wizard.css` — styling (952 lines, full design system)
- [x] API calls embedded in wizard.js (no separate api.js needed)
- [x] Port all wizard steps from Svelte to vanilla HTML/JS
  - [x] Welcome + admin token step
  - [x] Connection hub + add connection steps (cloud + local)
  - [x] Model assignment step (LLM + embedding)
  - [x] Options step (Ollama in-stack toggle)
  - [x] Review + install step with deploy status

### 2.2 Extract setup backend logic to `@openpalm/lib`
- [x] Create `packages/lib/src/control-plane/setup.ts`
- [x] Define `SetupInput` interface
- [x] Implement `performSetup(input, assetProvider)` — shared setup orchestration
- [x] Implement `detectProviders()` — scan for Ollama, Docker Model Runner, LM Studio
- [x] Admin's setup route delegates to shared `performSetup()` from lib

### 2.3 CLI serves setup wizard via Bun.serve()
- [x] Create `packages/cli/src/setup-wizard/server.ts` — Bun HTTP server handler
- [x] Implement `GET /setup` — serve wizard HTML
- [x] Implement `GET /api/setup/detect-providers` — call lib's detectProviders()
- [x] Implement `GET /api/setup/models/:provider` — fetch available models
- [x] Implement `POST /api/setup/complete` — call lib's performSetup(), signal completion
- [x] Block until setup completes, then stop server

### 2.4 Remove setup wizard from admin
- [x] Delete `packages/admin/src/routes/setup/` (Svelte wizard pages)
- [x] Delete setup-related components from admin UI (kept ModelSelector used by ConnectionsTab)
- [x] Keep admin's `POST /admin/install` endpoint for programmatic re-apply
- [x] Admin UI shows "run `openpalm install`" if setup needed

### 2.5 CLI orchestrates full install without admin
- [x] Update `install.ts` flow: bootstrap -> wizard -> compose up core only
- [x] `docker compose up -d` starts core services only (no admin/docker-socket-proxy)
- [x] Stage artifacts via ensureStagedState() before compose up
- [x] Uses buildManagedServiceNames() for targeted service startup

### 2.6 Validation
- [x] `openpalm install` serves local wizard on port 8100
- [x] Wizard JS covers all setup steps (welcome, connections, models, options, review+deploy)
- [x] Core services start without admin container after wizard completion
- [x] `bun run test` passes (415 tests)
- [x] `bun run admin:test:unit` passes (601 tests)
- [x] `bun run admin:check` passes (652 files, 0 errors)

---

## Phase 3: Make admin + docker-socket-proxy optional in compose ✓

**Goal:** Docker Compose profiles separate core services from admin.

### 3.1 Add profiles to compose
- [x] Add `profiles: ["admin"]` to admin service in `assets/docker-compose.yml`
- [x] Add `profiles: ["admin"]` to docker-socket-proxy service
- [x] Core services (caddy, memory, assistant, guardian, scheduler) have no profile

### 3.2 Update CLI to use profiles
- [x] `openpalm start` — default starts core only (no admin profile)
- [x] `openpalm start --with-admin` — include admin profile
- [x] `openpalm start admin` / `stop admin` / `restart admin` — auto-includes `--profile admin`
- [x] Same for docker-socket-proxy service name

### 3.3 Remove admin from CORE_SERVICES
- [x] Update `packages/lib/src/control-plane/types.ts` — remove admin/docker-socket-proxy from CORE_SERVICES
- [x] Add `OPTIONAL_SERVICES = ["admin", "docker-socket-proxy"] as const`
- [x] Add `OptionalServiceName` type
- [x] Update all references to CORE_SERVICES in lib, admin, CLI
- [x] Update `packages/admin/src/lib/server/types.ts` — re-export OPTIONAL_SERVICES + OptionalServiceName
- [x] Update lifecycle.test.ts — 5 core services, admin in OPTIONAL_SERVICES

### 3.4 Update Caddyfile for admin-optional mode
- [x] Handle missing admin gracefully in Caddyfile (`fail_duration 5s` on admin reverse_proxy)
- [x] Caddy doesn't crash when admin is absent — requests fail gracefully after 5s

### 3.5 Make OPENPALM_ADMIN_API_URL optional for assistant
- [x] Update `assets/docker-compose.yml` — `OPENPALM_ADMIN_API_URL: ${OPENPALM_ADMIN_API_URL:-}`
- [x] Assistant gracefully handles empty admin URL (admin-tools only loaded when admin present)
- [x] Assistant-tools (memory-only) have zero admin references (verified in Phase 4 split)
- [x] Scheduler's OPENPALM_ADMIN_API_URL also made optional

### 3.6 Validation
- [x] `docker compose up -d` without `--profile admin` starts 5 core services
- [x] `docker compose --profile admin up -d` starts 7 services (adds admin + proxy)
- [x] Caddy handles admin absence with `fail_duration 5s`
- [x] `bun run admin:check` — 652 files, 0 errors
- [x] `bun run admin:test:unit` — 602 tests pass
- [x] `bun run test` — 415 tests pass
- [x] `bun run cli:test` — 33 tests pass

---

## Phase 4: Split assistant-tools into two packages ✓

**Goal:** Separate admin-dependent tools from memory-only tools.

### 4.1 Create `@openpalm/admin-tools` package
- [x] Create `packages/admin-tools/package.json`
- [x] Create `packages/admin-tools/src/index.ts` — plugin entry
- [x] Move all 20 admin-dependent tool files from assistant-tools:
  - [x] admin-audit.ts
  - [x] admin-automations.ts
  - [x] admin-artifacts.ts
  - [x] admin-channels.ts
  - [x] admin-config.ts
  - [x] admin-config-validate.ts
  - [x] admin-connections.ts
  - [x] admin-connections-test.ts
  - [x] admin-containers.ts
  - [x] admin-containers-events.ts
  - [x] admin-containers-inspect.ts
  - [x] admin-guardian-audit.ts
  - [x] admin-guardian-stats.ts
  - [x] admin-lifecycle.ts
  - [x] admin-logs.ts
  - [x] admin-memory-models.ts
  - [x] admin-network-check.ts
  - [x] admin-providers-local.ts
  - [x] message-trace.ts
  - [x] stack-diagnostics.ts
- [x] Move admin-related skills:
  - [x] openpalm-admin/SKILL.md
  - [x] log-analysis/SKILL.md
  - [x] stack-troubleshooting/SKILL.md
- [x] Add `packages/admin-tools` to root workspaces

### 4.2 Refactor `@openpalm/assistant-tools`
- [x] Remove all `admin-*` tool registrations from `src/index.ts`
- [x] Remove `isAdminTool = toolName.startsWith('admin-')` from memory-context.ts
- [x] Update `tool.execute.before` hook — only inject guidance for THIS package's tools
- [x] Update `tool.execute.after` hook — only record outcomes for THIS package's tools
- [x] Keep: memory-*.ts tools, health-check.ts, session hooks, memory/SKILL.md

### 4.3 Split `lib.ts` into two files
- [x] `packages/assistant-tools/opencode/tools/lib.ts` — memory-only (memoryFetch, etc.)
- [x] `packages/admin-tools/opencode/tools/lib.ts` — admin API client (adminFetch, etc.)

### 4.4 Add system process session hooks
- [x] Enhance or add `system-hooks.ts` plugin for system-level session hooks
- [x] `session.created` — inject system context for scheduler-triggered sessions
- [x] `session.idle` — system-level idle processing (memory consolidation)

### 4.5 Update OpenCode plugin loading
- [x] Assistant container: `["@openpalm/assistant-tools", "akm-opencode"]` (no admin-tools)
- [x] Admin container: `["@openpalm/admin-tools", "@openpalm/assistant-tools"]` (both)
- [x] Update `ensureOpenCodeSystemConfig()` in lib for assistant config
- [x] Create admin-specific opencode config if admin runs OpenCode

### 4.6 Update plugin entry points
- [x] `packages/assistant-tools/src/index.ts` — remove admin tool registrations
- [x] `packages/admin-tools/src/index.ts` — register all admin tools + skills

### 4.7 Validation
- [x] `bun run test` passes (includes admin-tools tests)
- [x] Assistant container loads assistant-tools only — no admin dependency errors
- [x] Admin container loads both packages — full tool suite works
- [x] Memory tools work identically before and after split
- [x] Session hooks fire correctly

---

## Phase 5: Dedicated scheduler sidecar ✓

**Goal:** Lightweight scheduler container becomes the ONLY automation engine.

### 5.1 Create scheduler package
- [x] Create `packages/scheduler/package.json` (`@openpalm/scheduler`)
- [x] Create `packages/scheduler/src/server.ts` — Bun HTTP server entry point
- [x] Create `packages/scheduler/src/scheduler.ts` — imports from @openpalm/lib
- [x] Add `packages/scheduler` to root workspaces

### 5.2 Implement all 4 action type executors
- [x] `packages/scheduler/src/actions/http.ts` — fetch calls to URLs
- [x] `packages/scheduler/src/actions/shell.ts` — execFile with arg arrays
- [x] `packages/scheduler/src/actions/assistant.ts` — send message to OpenCode API
- [x] `packages/scheduler/src/actions/api.ts` — call admin API (skip if admin absent)

### 5.3 Remove scheduler from admin
- [x] Delete scheduler initialization from admin's `hooks.server.ts`
- [x] Remove or simplify `packages/admin/src/lib/server/scheduler.ts`
- [x] Keep read-only `GET /admin/automations` endpoint in admin (reads from STATE_HOME)
- [x] Admin becomes pure web UI + API with zero background processes

### 5.4 Scheduler reads from STATE_HOME/automations/
- [x] Scheduler reads `STATE_HOME/automations/*.yml` at startup
- [x] Implement file watching or periodic re-read for new automations
- [x] No restart required to pick up new automations

### 5.5 Add scheduler to docker-compose.yml
- [x] Add scheduler service definition to `assets/docker-compose.yml`
- [x] Configure volumes (automations:ro, artifacts:ro)
- [x] Configure environment (OPENCODE_API_URL, OPENPALM_ADMIN_API_URL, etc.)
- [x] Add healthcheck (`/health` on port 8090)
- [x] Add `depends_on: assistant: condition: service_healthy`

### 5.6 Create Dockerfile for scheduler
- [x] Create `core/scheduler/Dockerfile`
- [x] Lightweight Bun runtime, no Docker socket
- [x] Copy scheduler package + lib
- [x] User: bun, expose 8090

### 5.7 Scheduler HTTP API
- [x] `GET /health` — health check
- [x] `GET /automations` — list loaded automations + next run times
- [x] `GET /automations/:name/log` — execution history (last 50 runs)
- [x] `POST /automations/:name/run` — manually trigger (authenticated)

### 5.8 Update CORE_SERVICES
- [x] Add "scheduler" to CORE_SERVICES in `packages/lib/src/control-plane/types.ts`
- [x] Update staging pipeline to include scheduler in managed services

### 5.9 CI/CD
- [x] Update `.github/workflows/release.yml` — build + push scheduler image
- [x] Add `bun run scheduler:test` script to root package.json

### 5.10 Validation
- [x] Scheduler sidecar starts and runs all cron jobs
- [x] `http` actions execute correctly
- [x] `shell` actions execute correctly
- [x] `assistant` actions send messages to OpenCode session
- [x] `api` actions work when admin present, gracefully skip when absent
- [x] Admin has zero background processes
- [x] No duplicate automation execution
- [x] `bun run scheduler:test` passes

---

## Phase 6: Update documentation and architecture rules ✓

**Goal:** All documentation accurately reflects the new architecture.

### 6.1 Update `docs/technical/core-principles.md`
- [x] Change security invariant #1: "Host CLI or admin is the orchestrator" (not admin-only)
- [x] Update security invariant #3: assistant isolation with/without admin
- [x] Update filesystem contract — CLI/admin as orchestrator, DATA_HOME write policy
- [x] Update operational behavior — CLI or admin applies configuration

### 6.2 Update `CLAUDE.md`
- [x] Add `packages/lib/` to architecture overview with all new packages
- [x] Document `@openpalm/lib` as the shared control-plane library
- [x] Document admin-optional mode (compose profiles)
- [x] Update key files table with lib, CLI staging, scheduler, assistant-tools, admin-tools
- [x] Update architecture diagram to show CLI as primary orchestrator
- [x] Update Assets section to document dual consumption (FilesystemAssetProvider vs ViteAssetProvider)

### 6.3 Update `assets/README.md`
- [x] Document dual consumption: CLI (from DATA_HOME) and admin (from Vite bundle)
- [x] Document FilesystemAssetProvider vs ViteAssetProvider
- [x] Add CLI-managed mode alongside standalone and admin-managed

### 6.4 Update package READMEs
- [x] Create `packages/lib/README.md` — lib API surface and usage
- [x] Create `packages/scheduler/README.md` — scheduler sidecar docs
- [x] Create `packages/admin-tools/README.md` — admin tools package docs
- [x] Update `packages/cli/README.md` — document self-sufficient mode

### 6.5 Validation
- [x] All documentation reflects current architecture
- [x] No references to "admin sole orchestrator" in docs
- [x] `bun run admin:check` — 639 files, 0 errors (post Phase 2.4 cleanup)

---

## Summary

| Phase | Status | Tasks | Done | Remaining |
|-------|--------|-------|------|-----------|
| 0 — Extract @openpalm/lib | **COMPLETE** | 50 | 50 | 0 |
| 1 — CLI self-sufficient | **COMPLETE** | 17 | 17 | 0 |
| 2 — CLI setup wizard | **COMPLETE** | 24 | 24 | 0 |
| 3 — Compose profiles | **COMPLETE** | 18 | 18 | 0 |
| 4 — Split assistant-tools | **COMPLETE** | 35 | 35 | 0 |
| 5 — Scheduler sidecar | **COMPLETE** | 27 | 27 | 0 |
| 6 — Documentation | **COMPLETE** | 15 | 15 | 0 |
| **Total** | | **186** | **186** | **0** |

## Dependency Graph

```
Phase 0 (COMPLETE) ─────────────────────────────────────────┐
    │                                                        │
    ├──> Phase 1 (COMPLETE) ──> Phase 2 (COMPLETE)           │
    │                                  │                     │
    │    Phase 3 (COMPLETE) <──────────┘                     │
    │                                                        │
    ├──> Phase 4 (COMPLETE) [parallel w/ 1,5]                │
    │                                                        │
    ├──> Phase 5 (COMPLETE) [parallel w/ 1,4]                │
    │                                                        │
    └──> Phase 6 (COMPLETE) ────────────────────────────────┘
```

**All 186 tasks COMPLETE.** Phases 0-6 committed on `feat/decouplingAdmin`.
**Next:** Final 5-agent end-to-end review.
