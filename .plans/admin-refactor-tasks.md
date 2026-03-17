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

## Phase 1: Make CLI self-sufficient for Docker lifecycle

**Goal:** All CLI commands work without the admin container being present.

### 1.1 Enhance CLI docker compose command building
- [ ] Replace CLI's `composeProjectArgs()` with lib's `buildComposeFileList()` + `buildEnvFiles()`
- [ ] Create `fullComposeArgs(state)` helper in CLI docker.ts
- [ ] Handle channel overlay compose files in CLI

### 1.2 Add staging step to CLI commands
- [ ] Create `ensureStagedState()` helper using `FilesystemAssetProvider`
- [ ] Stage artifacts before every compose operation
- [ ] CLI reads assets from DATA_HOME (persisted by install)

### 1.3 Rewrite CLI commands to be self-sufficient
- [ ] `start.ts` — stage artifacts, `docker compose up -d` directly (no admin delegation)
- [ ] `stop.ts` — `docker compose down` directly
- [ ] `restart.ts` — `docker compose restart [service]` directly
- [ ] `status.ts` — `docker compose ps` directly, parse output
- [ ] `update.ts` — `docker compose pull` + `up -d --force-recreate`
- [ ] `uninstall.ts` — `docker compose down [-v]` directly
- [ ] `service.ts` — `docker compose start/stop/restart [service]` directly

### 1.4 Keep admin delegation as optional fallback
- [ ] Make admin API calls conditional (only if admin is running)
- [ ] Fallback to direct compose operations when admin is absent
- [ ] Refactor `packages/cli/src/lib/admin.ts` — make all functions optional

### 1.5 Validation
- [ ] All CLI commands work with admin container stopped
- [ ] `openpalm start` starts core services without admin
- [ ] `openpalm status` shows container states without admin
- [ ] `bun run cli:test` passes
- [ ] `bun run test` passes

---

## Phase 2: CLI-hosted web setup wizard

**Goal:** `openpalm install` completes entirely via CLI without admin container.

### 2.1 Port setup wizard to standalone HTML/JS
- [ ] Create `packages/cli/src/setup-wizard/index.html` — single-page wizard UI
- [ ] Create `packages/cli/src/setup-wizard/wizard.js` — vanilla JS wizard logic
- [ ] Create `packages/cli/src/setup-wizard/wizard.css` — styling
- [ ] Create `packages/cli/src/setup-wizard/api.js` — client-side API calls
- [ ] Port all 7 wizard steps from Svelte to vanilla HTML/JS
  - [ ] Admin token step
  - [ ] Owner info step
  - [ ] Provider detection step
  - [ ] LLM provider selection step
  - [ ] Embedding provider step
  - [ ] Model selection step
  - [ ] Ollama in-stack toggle step

### 2.2 Extract setup backend logic to `@openpalm/lib`
- [ ] Create `packages/lib/src/control-plane/setup.ts`
- [ ] Define `SetupInput` interface
- [ ] Implement `performSetup(input, assetProvider)` — shared setup orchestration
- [ ] Implement `detectProviders()` — scan for Ollama, Docker Model Runner, LM Studio
- [ ] Admin's setup route delegates to shared `performSetup()` from lib

### 2.3 CLI serves setup wizard via Bun.serve()
- [ ] Create `packages/cli/src/setup-wizard/server.ts` — Bun HTTP server handler
- [ ] Implement `GET /setup` — serve wizard HTML
- [ ] Implement `GET /api/setup/detect-providers` — call lib's detectProviders()
- [ ] Implement `GET /api/setup/models/:provider` — fetch available models
- [ ] Implement `POST /api/setup/complete` — call lib's performSetup(), signal completion
- [ ] Block until setup completes, then stop server

### 2.4 Remove setup wizard from admin
- [ ] Delete `packages/admin/src/routes/setup/` (Svelte wizard pages)
- [ ] Delete setup-related components from admin UI
- [ ] Keep admin's `POST /admin/install` endpoint for programmatic re-apply
- [ ] Admin UI shows "run `openpalm install`" if setup needed

### 2.5 CLI orchestrates full install without admin
- [ ] Update `install.ts` flow: bootstrap -> wizard -> compose up core only
- [ ] `docker compose up -d` starts core services only (no admin/docker-socket-proxy)
- [ ] Wait for services healthy
- [ ] Push memory config to memory service after setup

### 2.6 Validation
- [ ] `openpalm install` opens browser to local wizard
- [ ] User completes setup through all 7 steps
- [ ] Core services start without admin container
- [ ] Memory configured correctly after wizard
- [ ] `bun run cli:test` passes
- [ ] `bun run admin:test:unit` passes (wizard removed from admin)

---

## Phase 3: Make admin + docker-socket-proxy optional in compose

**Goal:** Docker Compose profiles separate core services from admin.

### 3.1 Add profiles to compose
- [ ] Add `profiles: ["admin"]` to admin service in `assets/docker-compose.yml`
- [ ] Add `profiles: ["admin"]` to docker-socket-proxy service
- [ ] Core services (caddy, memory, assistant, guardian, scheduler) have no profile

### 3.2 Update CLI to use profiles
- [ ] `openpalm start` — default starts core only (no admin profile)
- [ ] `openpalm start --with-admin` — include admin profile
- [ ] `openpalm admin start` — start just the admin service
- [ ] `openpalm admin stop` — stop just the admin service

### 3.3 Remove admin from CORE_SERVICES
- [ ] Update `packages/lib/src/control-plane/types.ts` — remove admin/docker-socket-proxy from CORE_SERVICES
- [ ] Add `OPTIONAL_SERVICES = ["admin", "docker-socket-proxy"] as const`
- [ ] Update all references to CORE_SERVICES in lib, admin, CLI

### 3.4 Update Caddyfile for admin-optional mode
- [ ] Handle missing admin gracefully in Caddyfile (no crash when admin absent)
- [ ] Staging pipeline conditionally includes admin routes based on profile
- [ ] Static fallback page for "admin not installed" (optional)

### 3.5 Make OPENPALM_ADMIN_API_URL optional for assistant
- [ ] Update `assets/docker-compose.yml` — `OPENPALM_ADMIN_API_URL: ${OPENPALM_ADMIN_API_URL:-}`
- [ ] Assistant gracefully handles empty admin URL
- [ ] Assistant-tools handle missing admin (skip admin-dependent features)

### 3.6 Validation
- [ ] `docker compose up -d` without `--profile admin` starts 5 core services
- [ ] `docker compose --profile admin up -d` starts 7 services (adds admin + proxy)
- [ ] Caddy doesn't error when admin is absent
- [ ] All test suites pass
- [ ] Existing installs continue working with admin present

---

## Phase 4: Split assistant-tools into two packages

**Goal:** Separate admin-dependent tools from memory-only tools.

### 4.1 Create `@openpalm/admin-tools` package
- [ ] Create `packages/admin-tools/package.json`
- [ ] Create `packages/admin-tools/src/index.ts` — plugin entry
- [ ] Move all 20 admin-dependent tool files from assistant-tools:
  - [ ] admin-audit.ts
  - [ ] admin-automations.ts
  - [ ] admin-artifacts.ts
  - [ ] admin-channels.ts
  - [ ] admin-config.ts
  - [ ] admin-config-validate.ts
  - [ ] admin-connections.ts
  - [ ] admin-connections-test.ts
  - [ ] admin-containers.ts
  - [ ] admin-containers-events.ts
  - [ ] admin-containers-inspect.ts
  - [ ] admin-guardian-audit.ts
  - [ ] admin-guardian-stats.ts
  - [ ] admin-lifecycle.ts
  - [ ] admin-logs.ts
  - [ ] admin-memory-models.ts
  - [ ] admin-network-check.ts
  - [ ] admin-providers-local.ts
  - [ ] message-trace.ts
  - [ ] stack-diagnostics.ts
- [ ] Move admin-related skills:
  - [ ] openpalm-admin/SKILL.md
  - [ ] log-analysis/SKILL.md
  - [ ] stack-troubleshooting/SKILL.md
- [ ] Add `packages/admin-tools` to root workspaces

### 4.2 Refactor `@openpalm/assistant-tools`
- [ ] Remove all `admin-*` tool registrations from `src/index.ts`
- [ ] Remove `isAdminTool = toolName.startsWith('admin-')` from memory-context.ts
- [ ] Update `tool.execute.before` hook — only inject guidance for THIS package's tools
- [ ] Update `tool.execute.after` hook — only record outcomes for THIS package's tools
- [ ] Keep: memory-*.ts tools, health-check.ts, session hooks, memory/SKILL.md

### 4.3 Split `lib.ts` into two files
- [ ] `packages/assistant-tools/opencode/tools/lib.ts` — memory-only (memoryFetch, etc.)
- [ ] `packages/admin-tools/opencode/tools/lib.ts` — admin API client (adminFetch, etc.)

### 4.4 Add system process session hooks
- [ ] Enhance or add `system-hooks.ts` plugin for system-level session hooks
- [ ] `session.created` — inject system context for scheduler-triggered sessions
- [ ] `session.idle` — system-level idle processing (memory consolidation)

### 4.5 Update OpenCode plugin loading
- [ ] Assistant container: `["@openpalm/assistant-tools", "akm-opencode"]` (no admin-tools)
- [ ] Admin container: `["@openpalm/admin-tools", "@openpalm/assistant-tools"]` (both)
- [ ] Update `ensureOpenCodeSystemConfig()` in lib for assistant config
- [ ] Create admin-specific opencode config if admin runs OpenCode

### 4.6 Update plugin entry points
- [ ] `packages/assistant-tools/src/index.ts` — remove admin tool registrations
- [ ] `packages/admin-tools/src/index.ts` — register all admin tools + skills

### 4.7 Validation
- [ ] `bun run test` passes (includes admin-tools tests)
- [ ] Assistant container loads assistant-tools only — no admin dependency errors
- [ ] Admin container loads both packages — full tool suite works
- [ ] Memory tools work identically before and after split
- [ ] Session hooks fire correctly

---

## Phase 5: Dedicated scheduler sidecar

**Goal:** Lightweight scheduler container becomes the ONLY automation engine.

### 5.1 Create scheduler package
- [ ] Create `packages/scheduler/package.json` (`@openpalm/scheduler`)
- [ ] Create `packages/scheduler/src/server.ts` — Bun HTTP server entry point
- [ ] Create `packages/scheduler/src/scheduler.ts` — imports from @openpalm/lib
- [ ] Add `packages/scheduler` to root workspaces

### 5.2 Implement all 4 action type executors
- [ ] `packages/scheduler/src/actions/http.ts` — fetch calls to URLs
- [ ] `packages/scheduler/src/actions/shell.ts` — execFile with arg arrays
- [ ] `packages/scheduler/src/actions/assistant.ts` — send message to OpenCode API
- [ ] `packages/scheduler/src/actions/api.ts` — call admin API (skip if admin absent)

### 5.3 Remove scheduler from admin
- [ ] Delete scheduler initialization from admin's `hooks.server.ts`
- [ ] Remove or simplify `packages/admin/src/lib/server/scheduler.ts`
- [ ] Keep read-only `GET /admin/automations` endpoint in admin (reads from STATE_HOME)
- [ ] Admin becomes pure web UI + API with zero background processes

### 5.4 Scheduler reads from STATE_HOME/automations/
- [ ] Scheduler reads `STATE_HOME/automations/*.yml` at startup
- [ ] Implement file watching or periodic re-read for new automations
- [ ] No restart required to pick up new automations

### 5.5 Add scheduler to docker-compose.yml
- [ ] Add scheduler service definition to `assets/docker-compose.yml`
- [ ] Configure volumes (automations:ro, artifacts:ro)
- [ ] Configure environment (OPENCODE_API_URL, OPENPALM_ADMIN_API_URL, etc.)
- [ ] Add healthcheck (`/health` on port 8090)
- [ ] Add `depends_on: assistant: condition: service_healthy`

### 5.6 Create Dockerfile for scheduler
- [ ] Create `core/scheduler/Dockerfile`
- [ ] Lightweight Bun runtime, no Docker socket
- [ ] Copy scheduler package + lib
- [ ] User: bun, expose 8090

### 5.7 Scheduler HTTP API
- [ ] `GET /health` — health check
- [ ] `GET /automations` — list loaded automations + next run times
- [ ] `GET /automations/:name/log` — execution history (last 50 runs)
- [ ] `POST /automations/:name/run` — manually trigger (authenticated)

### 5.8 Update CORE_SERVICES
- [ ] Add "scheduler" to CORE_SERVICES in `packages/lib/src/control-plane/types.ts`
- [ ] Update staging pipeline to include scheduler in managed services

### 5.9 CI/CD
- [ ] Update `.github/workflows/release.yml` — build + push scheduler image
- [ ] Add `bun run scheduler:test` script to root package.json

### 5.10 Validation
- [ ] Scheduler sidecar starts and runs all cron jobs
- [ ] `http` actions execute correctly
- [ ] `shell` actions execute correctly
- [ ] `assistant` actions send messages to OpenCode session
- [ ] `api` actions work when admin present, gracefully skip when absent
- [ ] Admin has zero background processes
- [ ] No duplicate automation execution
- [ ] `bun run scheduler:test` passes

---

## Phase 6: Update documentation and architecture rules

**Goal:** All documentation accurately reflects the new architecture.

### 6.1 Update `docs/technical/core-principles.md`
- [ ] Change security invariant #1: "Host CLI or admin is the orchestrator" (not admin-only)
- [ ] Update security invariant #3: assistant isolation with/without admin
- [ ] Document admin-optional architecture
- [ ] Update filesystem contract if needed

### 6.2 Update `CLAUDE.md`
- [ ] Add `packages/lib/` to architecture overview
- [ ] Document `@openpalm/lib` as the shared control-plane library
- [ ] Add lib build commands
- [ ] Document admin-optional mode
- [ ] Update key files table with new packages

### 6.3 Update `assets/README.md`
- [ ] Document dual consumption: CLI (from DATA_HOME) and admin (from Vite bundle)
- [ ] Document FilesystemAssetProvider vs ViteAssetProvider

### 6.4 Update package READMEs
- [ ] Create `packages/lib/README.md` — lib API surface and usage
- [ ] Create `packages/scheduler/README.md` — scheduler sidecar docs
- [ ] Create `packages/admin-tools/README.md` — admin tools package docs
- [ ] Update `packages/cli/README.md` — document self-sufficient mode

### 6.5 Validation
- [ ] All documentation reflects current architecture
- [ ] No references to "admin sole orchestrator" in docs
- [ ] `bun run admin:check` passes (no broken imports)

---

## Summary

| Phase | Status | Tasks | Done | Remaining |
|-------|--------|-------|------|-----------|
| 0 — Extract @openpalm/lib | **COMPLETE** | 50 | 50 | 0 |
| 1 — CLI self-sufficient | **IN PROGRESS** | 16 | 0 | 16 |
| 2 — CLI setup wizard | NOT STARTED | 24 | 0 | 24 |
| 3 — Compose profiles | NOT STARTED | 15 | 0 | 15 |
| 4 — Split assistant-tools | **IN PROGRESS** | 35 | 0 | 35 |
| 5 — Scheduler sidecar | **IN PROGRESS** | 27 | 0 | 27 |
| 6 — Documentation | NOT STARTED | 12 | 0 | 12 |
| **Total** | | **179** | **50** | **129** |

## Dependency Graph

```
Phase 0 (COMPLETE) ─────────────────────────────────────────┐
    │                                                        │
    ├──> Phase 1 (CLI self-sufficient) ──> Phase 2 (wizard)  │
    │                                         │              │
    │    Phase 3 (compose profiles) <─────────┘              │
    │                                                        │
    ├──> Phase 4 (assistant-tools split) [parallel w/ 1,5]   │
    │                                                        │
    ├──> Phase 5 (scheduler sidecar) [parallel w/ 1,4]       │
    │                                                        │
    └──> Phase 6 (documentation) — after all phases ─────────┘
```

**Wave 1 (IN PROGRESS):** Phases 1, 4, and 5 running in parallel (worktree-isolated dev agents).
**Next:** Phase 2 starts after Phase 1 completes. Phase 3 after Phase 2. Phase 6 after all.
