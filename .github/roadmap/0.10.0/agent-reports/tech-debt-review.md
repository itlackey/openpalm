# Technical Debt & Code Quality Review -- v0.10.0 Milestone

## Summary

The 0.10.0 milestone is architecturally ambitious: it replaces the legacy channel system with a unified component model, introduces two new packages (`packages/eval/`, `packages/mcp/`), adds a knowledge system with OpenViking and MemRL Q-values, refactors secrets management, and adds an Azure deployment path. The clean break from legacy channels is the highest-risk change -- it touches every layer of the control plane (`@openpalm/lib`, admin, CLI) and invalidates a significant portion of the existing test suite. The review-decisions document resolves the critical cross-plan conflicts well, but the implementation will generate substantial dead code that needs planned removal, and the test coverage strategy for the component system is entirely unaddressed.

---

## Issues Assessment

### #315 -- Azure Container Apps Deployment with Key Vault Integration

**Code quality implications:** Low risk. This is a pure additive deployment script (`deploy/azure/deploy-aca.sh`) with zero modifications to existing source files. The issue correctly identifies that no core code changes are needed -- all inter-service URLs are already configurable via env vars, and `adminFetch()` already handles connection failures gracefully.

**Recommendation: KEEP as-is.** The only concern is CI validation -- the deployment script should have basic linting (shellcheck) added to CI. No interaction with the component system migration.

### #304 -- Brokered Admin-Authorized OpenCode Instance

**Code quality implications:** Medium risk. The review-decisions document (Q4) correctly simplifies this to an ADMIN_TOKEN-based agent embedded in the admin container. However, the knowledge roadmap makes 8 of 24 working days depend on this feature for eval and maintenance. The shell automation fallback (Q5) is the right mitigation but needs test coverage for both paths.

**Recommendation: KEEP but add explicit test coverage for the degraded (shell-only) path.** The brokered instance should not block any other 0.10.0 work. The auth refactor (ADMIN_TOKEN / ASSISTANT_TOKEN split from the pass plan) creates a cross-cutting concern -- the `requireAdmin()` helper in `packages/admin/src/lib/server/helpers.ts` and the auth checks in guardian need updating.

### #302 -- TTS/STT Setup and Admin Interface

**Code quality implications:** Low. The types infrastructure already exists -- `TtsAssignment` and `SttAssignment` are defined in `packages/lib/src/control-plane/types.ts` (lines 62-75), and `CapabilityAssignments` already includes optional `tts?` and `stt?` fields. The admin types in `packages/admin/src/lib/types.ts` also include these. This is incremental work on a well-prepared foundation.

**Recommendation: KEEP.** Minimal tech debt risk. The connection profiles system already supports these capabilities.

### #301 -- Configurable Services

**Code quality implications:** HIGH. This issue is now subsumed by the component system. The original stack-spec v3 `StackServiceConfig` model (`StackSpec.services: Record<string, boolean>` in `packages/lib/src/control-plane/stack-spec.ts`) is obsoleted by the component plan's `compose.yml` + `.env.schema` directory convention. The existing `StackSpec` type, `SetupInput.services` field, and all service-specific staging code become dead code.

**Recommendation: UPDATE to align with component plan.** The issue description should be revised to reflect that "configurable services" are now "components." The existing `StackSpec.services` field should be removed as part of the component migration.

### #300 -- Password Manager (Varlock Improvements)

**Code quality implications:** HIGH. This is a multi-phase refactor that touches auth (ADMIN_TOKEN/ASSISTANT_TOKEN split), secrets storage (PlaintextBackend + encrypted backends), and component lifecycle (per-instance secrets). The pass plan's Phase 1 (auth refactor) affects every route handler's auth check, and Phase 4 (secrets API) adds new API surface.

**Recommendation: KEEP but sequence carefully.** Phase 0 (file permissions hardening) should ship independently and immediately -- it is zero-risk. The auth refactor should land before the component system since components need `@sensitive` field support. The dynamic `ENV_TO_SECRET_KEY` map for component secrets is a significant addition to `@openpalm/lib`.

### #298 -- Add OpenViking Integration

**Code quality implications:** Medium. OpenViking is correctly scoped as an optional component (review-decisions Q1). The assistant-tools package gains a new `vikingFetch()` helper and 6 new tools. The key risk is the graceful degradation path -- every Viking-dependent code path must check for availability and fall back cleanly.

**Recommendation: KEEP but add feature-flag testing.** Every `assembleContext()` code path needs tests with Viking present and absent. The `OPENVIKING_URL` and `OPENVIKING_API_KEY` env vars must be optional with clean fallback behavior.

### #13 -- Advanced Channel Configuration

**Code quality implications:** This issue predates the component system and is now partially or fully addressed by it. The component plan's per-instance `.env.schema` + `.env` configuration model replaces whatever "advanced channel configuration" was originally envisioned. Per-channel OpenCode config (mentioned in the knowledge roadmap) is future work.

**Recommendation: UPDATE or CLOSE.** If the component system's per-instance configuration satisfies the original intent, close this issue with a reference to the component plan. If there are unaddressed aspects (e.g., per-channel OpenCode config), create a new issue with specific scope.

---

## Code Removal Analysis

The component system replaces the legacy `CONFIG_HOME/channels/*.yml` format with a clean break. This requires removing or rewriting significant code across all three consumers of the channel system.

### Files/Functions to REMOVE

**`packages/lib/src/control-plane/channels.ts`** -- The entire channel discovery and install/uninstall system. Specifically:
- `discoverChannels()` -- scans `CONFIG_HOME/channels/` for `.yml` files. Replaced by component instance discovery from `DATA_HOME/components/`.
- `installChannelFromRegistry()` -- copies `.yml`/`.caddy` from registry to `CONFIG_HOME/channels/`. Replaced by component install flow (copy directory to `DATA_HOME/components/`).
- `uninstallChannel()` -- removes `.yml`/`.caddy` from `CONFIG_HOME/channels/`. Replaced by component delete flow.
- `isAllowedService()` -- checks `channel-*` prefix against staged `.yml` files. Needs rewrite for `openpalm-*` prefix convention.
- `isValidChannel()` -- validates against staged `.yml` files. Replaced by instance validation.

**`packages/lib/src/control-plane/staging.ts`** -- Channel-specific staging functions:
- `stageChannelCaddyfiles()` -- stages `.caddy` files from `CONFIG_HOME/channels/` to `STATE_HOME/artifacts/channels/`. Replaced by component Caddy route staging from `DATA_HOME/components/`.
- `stageChannelYmlFiles()` -- stages `.yml` files from `CONFIG_HOME/channels/` to `STATE_HOME/artifacts/channels/`. Replaced by compose overlay chain from `enabled.json`.
- `discoverStagedChannelYmls()` -- discovers staged channel overlays. Replaced by `enabled.json` instance list.

**`packages/lib/src/control-plane/lifecycle.ts`** -- Channel-dependent compose building:
- `buildComposeFileList()` -- appends `discoverStagedChannelYmls()` to compose files. Needs rewrite to build from `enabled.json`.
- `buildManagedServices()` -- appends `channel-*` service names. Needs rewrite for `openpalm-*` prefix.
- `loadPersistedChannelSecrets()` -- reads `CHANNEL_*_SECRET` from `stack.env`. Component secrets go through the unified secret manager.

**`packages/lib/src/control-plane/types.ts`** -- Partial removal:
- `ChannelInfo` type -- replaced by component instance types.
- `ControlPlaneState.channelSecrets` -- replaced by per-instance secrets.

**`packages/lib/src/index.ts`** -- Remove channel exports:
- `discoverChannels`, `isAllowedService`, `isValidChannel`, `installChannelFromRegistry`, `uninstallChannel` -- all replaced.
- `stageChannelCaddyfiles`, `stageChannelYmlFiles`, `discoverStagedChannelYmls` -- all replaced.

**`packages/lib/src/control-plane/registry-provider.ts`** -- Interface redesign:
- `RegistryProvider.channelYml()`, `channelCaddy()`, `channelNames()` -- replaced by component directory discovery.
- `automationYml()`, `automationNames()` -- automations stay separate (review-decisions Q7), but the interface should be split.

**`packages/lib/src/control-plane/fs-registry-provider.ts`** -- Rewrite:
- `FilesystemRegistryProvider` -- reads flat `.yml`/`.caddy` files. Component registry reads directories with `compose.yml` + `.env.schema`.

**`packages/admin/src/lib/server/vite-registry-provider.ts`** -- Rewrite:
- `ViteRegistryProvider` -- uses `import.meta.glob` on flat channel files. Component registry uses directory-based discovery.
- All `REGISTRY_CHANNEL_*` static exports -- dead code after component migration.

**`packages/admin/src/lib/server/registry-sync.ts`** -- Rewrite:
- `discoverRegistryChannels()` -- discovers flat `.yml` files from `registry/channels/`. Component registry discovers directories.
- `getRegistryChannel()` -- reads flat files. Component registry reads directories.

**`packages/admin/src/lib/server/channels.ts`** -- Remove:
- Entire file is a thin wrapper over `@openpalm/lib` channel functions. Replaced by component instance management.

**`packages/admin/src/lib/server/registry.ts`** -- Remove:
- Backward-compatibility re-export of `REGISTRY_CHANNEL_*`. Dead after component migration.

**`packages/admin/src/routes/admin/channels/+server.ts`** -- Rewrite:
- Channel listing endpoint. Replaced by `GET /api/instances`.

**`packages/admin/src/routes/admin/channels/install/+server.ts`** -- Remove:
- Replaced by `POST /api/instances`.

**`packages/admin/src/routes/admin/channels/uninstall/+server.ts`** -- Remove:
- Replaced by `DELETE /api/instances/:instanceId`.

**`packages/admin/src/routes/admin/registry/+server.ts`** -- Rewrite:
- Currently lists channels + automations from flat files. Rewire to `GET /api/registry` for component directories.

**`packages/admin/src/routes/admin/registry/install/+server.ts`** -- Rewrite:
- Currently copies `.yml`/`.caddy` to `CONFIG_HOME/channels/`. Rewire to copy component directory to `DATA_HOME/catalog/`.

**`packages/admin/src/routes/admin/installed/+server.ts`** -- Rewrite:
- Currently lists installed channels. Replaced by `GET /api/instances`.

**`packages/admin/src/lib/components/RegistryTab.svelte`** -- Rewrite:
- Currently renders channel/automation cards from `RegistryResponse`. Rewire to component-based UI.

**`packages/admin/src/lib/types.ts`** -- Partial removal:
- `RegistryChannelItem`, `RegistryAutomationItem`, `RegistryResponse`, `ChannelInfo`, `ChannelsResponse` -- all replaced by component types.

**`packages/cli/src/lib/staging.ts`** -- Update:
- `fullComposeArgs()` and `buildManagedServiceNames()` delegate to lib functions that change.

**`packages/cli/src/commands/install.ts`** -- Update:
- Setup wizard channel step needs to use component system.

**`registry/channels/`** -- Migrate:
- All channel definitions (`chat.yml`, `chat.caddy`, `discord.yml`, `api.yml`, `slack.yml`) must be converted to component directories under `registry/components/`.

**`packages/lib/src/control-plane/stack-spec.ts`** -- Update:
- `StackSpec.channels` and `StackSpec.services` fields become dead code. The component system replaces both.

**`packages/lib/src/control-plane/setup.ts`** -- Update:
- `SetupInput.channels` and `SetupInput.services` fields need rethinking for the component model.
- `buildChannelCredentialEnvVars()`, `CHANNEL_CREDENTIAL_ENV_MAP` -- channel-specific credential handling replaced by unified secret manager.

### Additional Dead Code (post-component migration)

- `ControlPlaneState.channelSecrets` field and all code that reads/writes `CHANNEL_*_SECRET` env vars
- The `persistArtifacts()` function's channel HMAC secret generation loop
- The `stageStackEnv()` function's channel secret injection into `stack.env`
- `isAllowedAction("channels.install")` and `"channels.uninstall"` in the `ALLOWED_ACTIONS` set
- `"extensions.list"` in `ALLOWED_ACTIONS` (replaced by registry/component endpoints)

---

## Test Coverage Plan

### Existing Tests That Break

The component system invalidates the following test files (they test legacy channel APIs):

| Test File | Reason | Action |
|-----------|--------|--------|
| `packages/admin/src/lib/server/channels.test.ts` | Tests `discoverChannels()`, `installChannelFromRegistry()`, `uninstallChannel()`, `isAllowedService()`, `isValidChannel()` -- all legacy channel functions | REWRITE for component system |
| `packages/admin/src/lib/server/staging.test.ts` | Tests channel staging pipeline (stageChannelCaddyfiles, stageChannelYmlFiles) | REWRITE for component staging |
| `packages/admin/src/lib/server/staging-core.test.ts` | Tests core staging with channel artifacts | UPDATE to remove channel assumptions |
| `packages/admin/src/lib/server/lifecycle.test.ts` | Tests lifecycle transitions that include channel staging | UPDATE for component lifecycle |
| `packages/admin/src/lib/server/state.test.ts` | Tests `createState()` which initializes `channelSecrets` | UPDATE to remove `channelSecrets` |
| `packages/admin/e2e/setup-wizard.test.ts` | Tests wizard flow including channel selection | REWRITE for component selection |
| `packages/admin/e2e/channel-guardian-pipeline.test.ts` | Tests full channel-to-guardian pipeline with HMAC | UPDATE -- HMAC still applies but channel-specific secrets change to component secrets |
| `packages/cli/src/commands/install-services.test.ts` | Tests service installation commands | UPDATE for component model |
| `packages/lib/src/control-plane/setup.test.ts` | Tests `performSetup()` with channels and services | REWRITE for component setup |
| Mocked Playwright E2E tests (69 tests) | Many test the registry/channels UI contracts | REWRITE for component UI |

**Estimated test rewrite effort:** 30-40% of the existing 592 admin unit tests touch channel/registry/staging code. The 69 mocked E2E tests will need significant rewrites for the component UI.

### New Tests Needed

**Component System Core (packages/lib):**
1. Component directory validation -- compose.yml + .env.schema contract enforcement
2. Instance creation -- copy directory, write identity vars to `.env`, create state dir
3. Instance ID collision validation against core services
4. `enabled.json` persistence -- read/write/fallback to presence-based discovery
5. Compose overlay chain builder -- correct `-f` and `--env-file` ordering from `enabled.json`
6. Dynamic allowlist -- `buildAllowlist()` with component instances
7. Component Caddy route discovery and staging with LAN-first enforcement
8. Instance lifecycle: create -> configure -> start -> stop -> delete -> archive

**Component System Admin API (packages/admin):**
9. `GET /api/components` -- discovery from built-in, catalog, and registry sources
10. `POST /api/instances` -- create with name collision validation
11. `PUT /api/instances/:id/config` -- update `.env`, handle `@sensitive` fields
12. `DELETE /api/instances/:id` -- stop, clean secrets, archive
13. Instance start/stop/restart lifecycle operations
14. Health check proxy through `openpalm.healthcheck` label
15. `.env.schema` parsing and form JSON generation

**Unified Secret Manager (packages/lib):**
16. `PlaintextBackend` -- read/write/delete secrets in `secrets.env`
17. `PassBackend` -- shell out to `pass` CLI (mock-based)
18. Dynamic `ENV_TO_SECRET_KEY` registration for component `@sensitive` fields
19. Component secret lifecycle -- provision on install, clean on delete
20. `SecretBackend` capability detection and provider auto-selection

**Auth Refactor:**
21. ADMIN_TOKEN vs ASSISTANT_TOKEN separation in route handlers
22. Secrets endpoints reject ASSISTANT_TOKEN
23. Operational endpoints accept both tokens

**Knowledge System (packages/assistant-tools):**
24. `vikingFetch()` -- graceful degradation when Viking not installed
25. `assembleContext()` -- two-phase retrieval with and without Viking
26. Q-value metadata CRUD through memory API
27. Token budget allocation and bin-packing
28. Session extraction hooks -- Viking present vs absent paths

**Eval Framework (packages/eval):**
29. Shell-executable eval runner -- CLI entrypoint
30. Grader registry -- base + LLM judge + tool usage graders
31. Regression clustering
32. Suite execution with skip logic (Viking-dependent suites)

**MCP Server (packages/mcp):**
33. Tool registration -- admin, memory, viking, channels
34. Resource resolution -- skills, artifacts, viking URIs
35. HTTP transport -- request/response cycle
36. Auth -- MCP_API_KEY validation

**Migration Testing:**
37. Clean break scenario -- legacy `CONFIG_HOME/channels/*.yml` files are ignored
38. Upgrade path -- uninstall old channels, upgrade, reinstall as components
39. `enabled.json` corruption recovery -- fallback to presence-based discovery
40. Archive/restore of deleted component instances

---

## Package Structure

### Proposed New Packages

**`packages/eval/`** -- Eval framework

Assessment: APPROPRIATE. This is a distinct concern (measuring assistant quality) with its own CLI entrypoint, suite definitions, and grader implementations. It has a clear dependency on admin API (for LLM judge) and memory API (for retrieval eval), but no reverse dependency. The shell automation integration is correct -- eval suites as CLI-executable scripts.

Concerns:
- Should be added to root `package.json` workspaces
- Needs its own `bun test` command in root scripts
- Suites are YAML definitions that need CI validation (similar to existing automation YAML validation)
- The `packages/eval/suites/` directory should be validated in CI

**`packages/mcp/`** -- MCP server

Assessment: APPROPRIATE. The MCP server is a standalone HTTP service with its own Dockerfile that wraps admin/memory/viking APIs into MCP tools. It follows the same pattern as channel packages (standalone Bun service with SDK dependency).

Concerns:
- Needs a Dockerfile following the Docker dependency resolution pattern (Bun runtime, `bun install --production` for deps)
- Should be added to root workspaces and CI test pipeline
- The component registry entry (`registry/components/mcp/`) is separate from the package source
- Image publishing workflow needed (similar to `publish-channel-*.yml`)

### Shared Library Impact (`@openpalm/lib`)

The component system requires significant changes to `@openpalm/lib`. The key concern is that both CLI and admin consume this library, so changes must be backward-compatible during the transition or coordinated as a breaking change.

**New additions to lib:**
- Component directory discovery and validation
- Instance lifecycle management (create, configure, start, stop, delete)
- `enabled.json` persistence
- Compose overlay chain builder for components
- Dynamic allowlist for component instances
- Secret backend abstraction (`SecretBackend` interface, `PlaintextBackend`)
- Dynamic `ENV_TO_SECRET_KEY` for component secrets
- Auth token types (ADMIN_TOKEN vs ASSISTANT_TOKEN)

**Breaking changes to lib:**
- `ControlPlaneState` loses `channelSecrets` field, gains component instance state
- `buildComposeFileList()` and `buildManagedServices()` change signatures to use component instances
- `RegistryProvider` interface changes from flat files to directory-based discovery
- `stageArtifacts()` and `persistArtifacts()` no longer stage channels
- `SetupInput` type changes -- `channels` and `services` fields become component selections

**Risk:** The CLI and admin must be updated in lockstep. Since both import from `@openpalm/lib`, a breaking change to the lib API breaks both consumers simultaneously. This is manageable since they're in the same monorepo, but the PR should update all three packages atomically.

### Registry Structure Change

The registry moves from flat files:
```
registry/channels/chat.yml
registry/channels/chat.caddy
```

To component directories:
```
registry/components/chat/compose.yml
registry/components/chat/.env.schema
registry/components/chat/.caddy
```

This is a clean improvement but requires:
- CI validation update (validate compose overlays as directories, not flat files)
- Admin's Vite `import.meta.glob` patterns change
- The `$registry` Vite alias must point to the new structure
- `FilesystemRegistryProvider` rewrites for directory-based discovery

---

## CI/CD Impact

### CI Pipeline Changes Needed

**1. Update `ci.yml` "Validate registry YAML files" step:**
- Currently validates `registry/channels/*.yml` as compose overlays
- Must validate `registry/components/*/compose.yml` as overlays
- Must validate `registry/components/*/.env.schema` as valid @env-spec
- Must validate that each component directory contains the required files

**2. Add new package test commands to root `package.json`:**
```
"eval:test": "bun test --cwd packages/eval"
"mcp:test": "bun test --cwd packages/mcp"
```

**3. Update root `test` script to include new packages:**
- Add `packages/eval` and `packages/mcp` to the `bun test` directory list

**4. Add workspace entries to root `package.json`:**
- `"packages/eval"` and `"packages/mcp"` in `workspaces` array

**5. New publish workflows:**
- `publish-mcp.yml` -- build and push MCP Docker image
- No publish workflow needed for eval (it's a dev/testing tool, not a deployed service)

**6. Docker build validation:**
- Add `packages/mcp/Dockerfile` to the compose manifest validation step
- The MCP Dockerfile must follow the Docker dependency resolution pattern

**7. Component validation CI step:**
- New step: validate all `registry/components/*/compose.yml` files
- New step: validate all `registry/components/*/.env.schema` files against @env-spec
- Ensure `.caddy` files in component directories are syntactically valid

### Docker Image Changes

- New image: `openpalm/mcp` -- MCP server
- No new image for eval (runs as a Bun script, not a container)
- Existing channel images (`openpalm/channel-chat`, etc.) are unchanged but their compose definitions move from flat files to component directories

---

## Recommendations

### Critical Path (must do before other 0.10.0 work)

1. **ADD** -- Create a comprehensive component system type definition in `packages/lib/src/control-plane/component-types.ts` before implementing any component code. This should define `ComponentDefinition`, `ComponentInstance`, `InstanceConfig`, `EnabledInstances`, and all related types. Having the type contract first prevents drift between lib/admin/CLI implementations.

2. **UPDATE** -- Revise `packages/lib/src/control-plane/types.ts` to deprecate `ChannelInfo` and `ControlPlaneState.channelSecrets` with `@deprecated` JSDoc annotations. Do not remove them yet -- mark them for removal so the transition is visible.

3. **ADD** -- Create a `packages/lib/src/control-plane/components.ts` module alongside the existing `channels.ts` (not replacing it yet). This allows the component system to be developed and tested without breaking the existing channel system. Switch over happens atomically.

4. **ADD** -- Create a migration checklist issue for the legacy-to-component cutover. This should enumerate every file that changes, every test that breaks, and the exact sequence of operations for the atomic switchover.

### Architecture & Code Quality

5. **UPDATE** -- The `RegistryProvider` interface in `packages/lib/src/control-plane/registry-provider.ts` should be split into `ChannelRegistryProvider` (deprecated) and `ComponentRegistryProvider` (new). This allows the transition to happen incrementally. The current interface mixes channel-specific methods with automation-specific methods.

6. **ADD** -- Create `packages/lib/src/control-plane/secret-backend.ts` with the `SecretBackend` interface, `PlaintextBackend` implementation, and `detectProvider()` logic. Ship Phase 0 of the pass plan (file permissions) and the `PlaintextBackend` as a standalone PR before the full secrets refactor.

7. **REMOVE** -- The `writeOpenCodeProviderConfig()` function in `packages/lib/src/control-plane/connection-mapping.ts` is documented as BROKEN in MEMORY.md (writes `providers` which causes OpenCode v1.2.24 to crash with `ConfigInvalidError`). It should be removed or fixed before 0.10.0 ships. This is existing tech debt.

8. **UPDATE** -- The `ALLOWED_ACTIONS` set in `packages/lib/src/control-plane/lifecycle.ts` needs to be extended for the new component and secrets API actions. Currently it only has channel-era actions (`channels.list`, `channels.install`, `channels.uninstall`). Add component lifecycle actions.

9. **ADD** -- The component system's `enabled.json` persistence at `DATA_HOME/components/enabled.json` needs a JSON schema definition and validation logic. The fallback to presence-based discovery (when `enabled.json` is missing/corrupted) needs explicit test coverage.

### Test Infrastructure

10. **ADD** -- Create a test helper module for component system tests: `packages/admin/src/lib/server/test-helpers-components.ts`. This should provide functions like `makeComponentDir()`, `makeInstanceDir()`, `seedEnabledJson()`, paralleling the existing `seedConfigChannels()` helper.

11. **UPDATE** -- The existing `packages/admin/src/lib/server/test-helpers.ts` `seedConfigChannels()` helper should be marked `@deprecated` with a comment pointing to the component equivalent.

12. **ADD** -- Create a Playwright E2E test for the component lifecycle: create instance -> configure -> start -> verify running -> stop -> delete -> verify archived. This replaces the current channel install/uninstall E2E flow.

13. **ADD** -- Create a migration E2E test that verifies the clean-break behavior: if legacy `CONFIG_HOME/channels/*.yml` files exist, they are ignored (not discovered, not staged, no error). This is a regression test for the clean break.

14. **UPDATE** -- The CI workflow's "Validate registry YAML files" step must be rewritten for the component directory structure before any component directories are added to the registry.

### Dead Code Cleanup

15. **REMOVE** -- `packages/admin/src/lib/server/registry.ts` is already a thin backward-compatibility re-export. It should be removed when the component system lands, with imports redirected to the new component registry module.

16. **REMOVE** -- After the component system lands, perform a dead code sweep using the TypeScript compiler's `--noUnusedLocals` and `--noUnusedParameters` flags. The channel-to-component migration will create orphaned imports and unused variables across many files.

17. **REMOVE** -- The `registry/channels/` directory contents should be migrated to `registry/components/` directories, and the old flat-file directory removed. This should happen in the same PR as the CI validation update.

### Missing Issues

18. **ADD** -- Create a new GitHub issue: "Component system: admin API and lib implementation" covering the core component lifecycle (Phases 1-2 of the components plan). This is the foundation that #298, #301, and #300 all depend on but has no dedicated issue.

19. **ADD** -- Create a new GitHub issue: "Legacy channel removal and test migration" tracking the dead code removal and test rewrites enumerated in this review. This should block the 0.10.0 release.

20. **ADD** -- Create a new GitHub issue: "CI pipeline updates for component registry and new packages" tracking the CI changes enumerated above.

21. **ADD** -- Create a new GitHub issue: "Fix or remove broken writeOpenCodeProviderConfig()" to address the existing tech debt noted in MEMORY.md. This should be fixed before 0.10.0 regardless of the component migration.

22. **UPDATE** -- The `packages/lib/src/control-plane/setup.ts` module's `SetupInput` type includes `channels?: string[]` and `services?: Record<string, boolean>` which will become dead fields. The setup wizard flow (both CLI and admin) needs a coordinated rewrite for the component model. This is not covered by any existing issue.

### Documentation

23. **ADD** -- The clean break from legacy channels needs prominent documentation in release notes. The upgrade path (uninstall old channels -> upgrade to 0.10.0 -> reinstall as components) must be step-by-step with specific commands.

24. **UPDATE** -- `docs/technical/core-principles.md` needs updates for:
    - Component system replacing channel file-drop model (Goal 1)
    - New `DATA_HOME/components/` directory in the filesystem contract
    - Updated operational behavior section (component install replaces channel file-drop)
    - CONFIG_HOME contract change after secrets migration (M8 from review report)

25. **UPDATE** -- `CLAUDE.md` needs updates for:
    - New packages (`packages/eval/`, `packages/mcp/`) in architecture overview
    - New test commands in build/dev commands section
    - Updated key files section
    - Component system in architecture rules summary

---

## Addendum: Filesystem & Mounts Refactor Code Impact Review (2026-03-19)

### Summary

The filesystem refactor proposal collapses the 3-tier XDG model (CONFIG_HOME / DATA_HOME / STATE_HOME) into a single `~/.openpalm/` root with `config/`, `vault/`, `data/`, and `logs/` subdirectories, eliminates the staging pipeline entirely, replaces the `secrets.env` + `stack.env` chain with `user.env` + `system.env` under a `vault/` boundary, and introduces validate-in-place with snapshot rollback. This is the largest structural change in the proposal set -- it touches every control-plane module, every compose file, every test that creates a `ControlPlaneState`, and the dev setup script. The simplification gains are real (31 dirs to ~10, staging pipeline eliminated, backup is one `tar` command), but the migration is a full rewrite of the path layer and a near-total rewrite of the env/staging layer. It should be sequenced as a standalone phase before the component system lands, since the component system would otherwise need to target the old path model and then be rewritten.

### Dead Code Analysis

The following code and data structures become dead with staging elimination:

**Entire staging pipeline (`packages/lib/src/control-plane/staging.ts`):**
- `stageSecretsEnv()` -- copies `CONFIG_HOME/secrets.env` to `STATE_HOME/artifacts/secrets.env`. Dead: no staging tier.
- `stagedEnvFile()` -- returns `STATE_HOME/artifacts/secrets.env` path. Dead: replaced by `vault/user.env`.
- `stagedStackEnvFile()` -- returns `STATE_HOME/artifacts/stack.env` path. Dead: replaced by `vault/system.env`.
- `buildEnvFiles()` -- returns both staged env file paths. Dead: replaced by direct `vault/` paths.
- `stageStackEnv()` -- reads `DATA_HOME/stack.env`, merges admin-managed values, writes to both `DATA_HOME` and `STATE_HOME/artifacts/`. Dead: `system.env` is written in-place.
- `generateFallbackStackEnv()` -- generates initial `stack.env` content with XDG paths, UID/GID, networking. Dead: replaced by `system.env` template seeding.
- `stageChannelYmlFiles()` -- copies channel YMLs from `CONFIG_HOME/channels/` to `STATE_HOME/artifacts/channels/`. Dead: compose overlays read live from `config/components/`.
- `stageChannelCaddyfiles()` -- copies and LAN-scopes Caddy files to `STATE_HOME/artifacts/channels/{lan,public}/`. Dead: Caddy reads live from `data/caddy/channels/`.
- `discoverStagedChannelYmls()` -- discovers staged `.yml` overlays in `STATE_HOME/artifacts/channels/`. Dead: compose overlay discovery reads `config/components/` directly.
- `stageAutomationFiles()` -- copies automation YAMLs from both `DATA_HOME` and `CONFIG_HOME` to `STATE_HOME/automations/`. Dead: scheduler reads live from `config/automations/`.
- `stageEnvSchemas()` -- copies `.env.schema` files from asset provider to `DATA_HOME/assistant/env-schema/`. Dead: schemas live in `vault/` alongside their env files.
- `stageArtifacts()` -- top-level orchestrator returning staged compose + caddyfile content. Dead: compose and Caddyfile are read live.
- `persistArtifacts()` -- writes all staged files to `STATE_HOME/artifacts/`, generates HMAC secrets for new channels, writes `manifest.json`. Dead: no staging tier means no persistence step.
- `buildArtifactMeta()` -- computes SHA-256 checksums for manifest. Dead: no manifest.
- `sha256()` and `randomHex()` -- utility functions. `randomHex()` is still needed for secret generation; `sha256()` may be needed for rollback validation. These survive but move out of staging.

**State factory and lifecycle (`packages/lib/src/control-plane/lifecycle.ts`):**
- `loadPersistedChannelSecrets()` -- reads `CHANNEL_*_SECRET` from `DATA_HOME/stack.env`. Dead: channel secrets live in `vault/system.env` (no separate `stack.env`).
- `reconcileCore()` -- calls `stageArtifacts()` and `persistArtifacts()`. Must be rewritten to validate-in-place + snapshot + write.
- `buildComposeFileList()` -- reads from `STATE_HOME/artifacts/`. Must be rewritten to read from `config/components/` and `OPENPALM_HOME`.
- `buildManagedServices()` -- calls `discoverStagedChannelYmls()`. Must be rewritten to discover from live `config/components/`.
- `isOllamaEnabled()` and `isAdminEnabled()` (in `staging.ts`) -- read from `DATA_HOME/stack.env`. Must be rewritten to read from `vault/system.env` or `config/openpalm.yml`.
- `validateEnvironment()` -- reads schema from `DATA_HOME/secrets.env.schema` and env from `STATE_HOME/artifacts/stack.env`. Must be rewritten for `vault/` paths.
- `updateStackEnvToLatestImageTag()` -- reads/writes `DATA_HOME/stack.env`. Must target `vault/system.env`.
- `writeSetupTokenFile()` -- writes to `STATE_HOME/setup-token.txt`. Must target a new location (likely `data/` or dropped entirely).

**ControlPlaneState type (`packages/lib/src/control-plane/types.ts`):**
- `stateDir: string` field -- eliminated (no STATE_HOME).
- `artifacts: { compose: string; caddyfile: string }` field -- dead (no in-memory staging).
- `artifactMeta: ArtifactMeta[]` field -- dead (no manifest).
- `channelSecrets: Record<string, string>` field -- already marked dead in original review, but now also `stack.env` is gone so the loading path disappears entirely.
- The `ArtifactMeta` type itself becomes dead.

**Secrets module (`packages/lib/src/control-plane/secrets.ts`):**
- `ensureSecrets()` -- creates `CONFIG_HOME/secrets.env`. Must be rewritten for `vault/user.env` + `vault/system.env` split.
- `updateSecretsEnv()` -- writes to `CONFIG_HOME/secrets.env`. Must target `vault/user.env` or `vault/system.env` depending on the key.
- `readSecretsEnvFile()` and `loadSecretsEnvFile()` -- read from `CONFIG_HOME/secrets.env`. Must read from `vault/user.env`.

**Setup status (`packages/lib/src/control-plane/setup-status.ts`):**
- `isSetupComplete()` -- reads from `STATE_HOME/artifacts/stack.env`. Must be rewritten for `vault/system.env`.

**Paths module (`packages/lib/src/control-plane/paths.ts`):**
- `resolveConfigHome()`, `resolveStateHome()`, `resolveDataHome()` -- all three functions are dead. Replaced by a single `resolveOpenPalmHome()` returning `~/.openpalm/` with subdirectory accessors (`configDir()`, `vaultDir()`, `dataDir()`, `logsDir()`, `cacheDir()`).
- `ensureXdgDirs()` -- pre-creates 31 dirs across 3 trees. Replaced by a simpler `ensureDirs()` creating ~10 dirs under one root.
- `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_DATA_HOME` env vars -- all dead. Replaced by `OPENPALM_HOME`.

**Core assets (`packages/lib/src/control-plane/core-assets.ts`):**
- All `resolveDataHome()`-based path resolution -- must change to `OPENPALM_HOME/data/`.
- `coreCaddyfilePath()`, `coreComposePath()`, `ollamaComposePath()`, `adminComposePath()` -- all internal path helpers must be updated.
- `refreshCoreAssets()` -- writes to `DATA_HOME`. Must target new paths.
- `ensureSecretsSchema()` and `ensureStackSchema()` -- write schemas to `DATA_HOME/`. Must target `vault/`.

**Admin barrel re-exports:**
- `packages/admin/src/lib/server/staging.ts` -- re-exports `stagedEnvFile`, `stagedStackEnvFile`, `buildEnvFiles`, `discoverStagedChannelYmls` from lib. All become dead.
- `packages/admin/src/lib/server/paths.ts` -- re-exports `resolveConfigHome`, `resolveStateHome`, `resolveDataHome`, `ensureXdgDirs`. All become dead, replaced by new path API.

**CLI staging (`packages/cli/src/lib/staging.ts`):**
- `ensureStagedState()` -- calls `stageArtifacts()` + `persistArtifacts()`. Entire function is dead. Replaced by reading live compose files.
- `fullComposeArgs()` -- calls `buildComposeFileList()` + `buildEnvFiles()`. Must be rewritten for new path model.

**Env files in compose (`assets/docker-compose.yml`, `assets/admin.yml`):**
- Guardian `env_file:` referencing `STATE_HOME/artifacts/stack.env` -- dead. Guardian gets secrets via `${VAR}` only.
- Guardian `volumes:` mount of `STATE_HOME/artifacts:/app/secrets:ro` -- dead. No bind-mounted secrets file.
- Admin `env_file:` referencing both staged env files -- dead. Admin mounts `vault/` directly.
- All `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_DATA_HOME` variable references in compose -- dead, replaced by `OPENPALM_HOME`.

**Setup module (`packages/lib/src/control-plane/setup.ts`):**
- `buildSecretsFromSetup()` -- writes all secrets into a single `secrets.env`. Must be split: user-facing keys to `vault/user.env`, system tokens to `vault/system.env`.
- `performSetup()` step "Mark setup complete in DATA_HOME stack.env" -- must target `vault/system.env`.
- `CHANNEL_CREDENTIAL_ENV_MAP` and `buildChannelCredentialEnvVars()` -- write channel creds to `CONFIG_HOME/secrets.env`. Must target `vault/system.env` (channel creds are system-managed, not user-editable).

**Manifest endpoint (`packages/admin/src/routes/admin/artifacts/manifest/+server.ts`):**
- Reads `STATE_HOME/artifacts/manifest.json`. Entirely dead with no staging tier.

### Simplification Gains

**Directory creation: 31 dirs to ~10.** `ensureXdgDirs()` currently pre-creates 5 CONFIG subdirs + 9 DATA subdirs + 6 STATE subdirs + WORK_DIR. The new layout creates: `config/`, `config/components/`, `config/automations/`, `config/assistant/`, `vault/`, `data/` (+ per-service subdirs), `logs/`. The function shrinks from ~30 `mkdirSync` calls to ~12. The cognitive load drop is significant -- `ls ~/.openpalm` shows 4 directories instead of requiring knowledge of 3 XDG subtrees.

**Staging pipeline eliminated: ~400 lines of code.** `staging.ts` is 400 lines. The entire file can be replaced by a ~50-line validate-in-place module. Functions removed: `stageSecretsEnv`, `stagedEnvFile`, `stagedStackEnvFile`, `buildEnvFiles`, `stageStackEnv`, `generateFallbackStackEnv`, `stageChannelYmlFiles`, `discoverStagedChannelYmls`, `stageChannelCaddyfiles`, `stageAutomationFiles`, `stageEnvSchemas`, `stageArtifacts`, `persistArtifacts`, `buildArtifactMeta`. The `manifest.json` tracking infrastructure is also removed.

**Env file chain: 3 hops to 1.** Currently: `CONFIG_HOME/secrets.env` -> `DATA_HOME/stack.env` -> `STATE_HOME/artifacts/{secrets,stack}.env`. New: `vault/user.env` + `vault/system.env`, both read directly. Docker Compose uses `--env-file vault/system.env --env-file vault/user.env`. No staging copies.

**Compose invocation simplification.** `buildComposeFileList()` currently reads from `STATE_HOME/artifacts/` for the core compose, then checks for `admin.yml` and `ollama.yml` in staging, then discovers staged channel YMLs. New: reads `config/openpalm.yml` for enabled components, then lists `config/components/*.yml`. The function shrinks from 20 lines with 3 filesystem discovery calls to ~8 lines reading a YAML manifest.

**`buildEnvFiles()` elimination.** Currently returns `[stagedStackEnvFile(), stagedEnvFile()].filter(existsSync)`. New: hardcoded `[vaultDir() + '/system.env', vaultDir() + '/user.env']`. No dynamic discovery.

**Admin container mount simplification.** Currently mounts all 3 XDG trees with identity-mapped paths (`CONFIG_HOME:CONFIG_HOME`). New: mounts `config/` and `vault/` with clean container paths (`/etc/openpalm` and `/etc/openpalm/vault`). The identity-mapping pattern (host path = container path) was clever but fragile; the new pattern uses clean container-internal paths.

**Dev setup (`scripts/dev-setup.sh`): ~50 lines shorter.** Currently creates dirs across 3 trees (CONFIG, STATE, DATA), stages bootstrap artifacts to `STATE/artifacts/`, copies env files. New: creates dirs under `.dev/`, seeds `vault/user.env` and `vault/system.env`, done. No staging bootstrap needed.

**Backup/restore: 2-3 commands to 1.** Currently requires archiving CONFIG_HOME + DATA_HOME (+ optionally STATE_HOME). New: `tar czf backup.tar.gz ~/.openpalm`. Restore is extract + start. No staging regeneration step.

### New Code Required

**1. Validate-in-place module (~100-150 lines, LOW complexity)**

A new `packages/lib/src/control-plane/validate.ts` module that:
- Validates `vault/user.env` against `vault/user.env.schema` using varlock (reuses existing `runVarlockLoad` pattern from `validateEnvironment()`)
- Validates `vault/system.env` against `vault/system.env.schema`
- Runs `docker compose config --dry-run` against proposed compose overlay chain
- Optionally validates Caddyfile via `caddy validate`

This is straightforward -- it reuses existing patterns. The `validateEnvironment()` function in `lifecycle.ts` already does temp-dir-based varlock validation; this just changes the file paths and adds compose dry-run.

**2. Snapshot/rollback module (~80-120 lines, LOW complexity)**

A new `packages/lib/src/control-plane/rollback.ts` module that:
- `snapshot()`: copies current `vault/user.env`, `vault/system.env`, `config/openpalm.yml`, and all `config/components/*.yml` to `~/.cache/openpalm/rollback/`
- `rollback()`: copies snapshot files back to live positions and returns the list of restored files
- `isSnapshotAvailable()`: checks if a valid snapshot exists

This is purely filesystem copy operations -- small and testable. The 5-10 files being snapshotted total a few KB.

**3. File watcher for hot-reload (~30-50 lines, LOW complexity)**

The proposal includes TypeScript pseudocode. This would live in the assistant container's entrypoint (not in `@openpalm/lib`). It uses Node's `fs.watch()` on a single file (`/etc/openpalm/user.env`) with an allowlist of keys. Low complexity, but needs debouncing (editors write temp files then rename). The `fs.watch` API is notoriously platform-dependent, but inside a Docker container targeting Linux, `inotify` is reliable. One edge case: bind-mounted file watches require the directory to be mounted (not just the file), which the proposal addresses by mounting `vault/user.env` as a file path.

**4. `openpalm.yml` reader (~40-60 lines, LOW complexity)**

A new `readOpenPalmConfig()` function that parses `config/openpalm.yml` to determine enabled components and feature flags. This replaces the current implicit discovery (scan for staged files) with explicit configuration. The `yaml` package is already a dependency.

**5. Apply orchestrator rewrite (~150-200 lines, MEDIUM complexity)**

The current `reconcileCore()` + `applyInstall()` + `applyUpdate()` + `applyUninstall()` pattern calls `stageArtifacts()` + `persistArtifacts()`. The new flow is: validate -> snapshot -> write -> deploy -> health check -> rollback on failure. This is more logic than the current write-and-hope approach but not fundamentally complex. The main risk is the automated rollback on failed health checks -- this requires calling `docker compose up -d` twice (once for the new config, once for the rollback), and handling the case where the rollback also fails.

**Total new code estimate:** ~400-600 lines replacing ~400 lines of staging code plus rewriting ~200 lines of lifecycle code. Net code change is roughly neutral, but the new code is simpler and more directly testable.

### Path Constants Rewrite

**72 files** currently reference `CONFIG_HOME`, `DATA_HOME`, `STATE_HOME`, `resolveConfigHome`, `resolveStateHome`, or `resolveDataHome` across the `packages/` directory. Of these:

- **~30 are build artifacts** (`packages/admin/build/server/chunks/*.js` and `.js.map`) -- these are regenerated by `npm run build` and do not need manual edits.
- **~42 are source files** that need manual updates. Breaking these down:

| Package | Source files affected | Key files |
|---------|----------------------|-----------|
| `packages/lib/` | 12 | `paths.ts`, `staging.ts`, `lifecycle.ts`, `secrets.ts`, `setup.ts`, `setup-status.ts`, `channels.ts`, `core-assets.ts`, `core-asset-provider.ts`, `stack-spec.ts`, `scheduler.ts`, `fs-asset-provider.ts` |
| `packages/admin/` | 18 | `paths.ts`, `staging.ts`, `hooks.server.ts`, `control-plane.ts`, and 14 route handlers (`channels/`, `registry/`, `access-scope/`, `containers/`, `install/`, `update/`, `upgrade/`, `uninstall/`, `automations/`, `artifacts/`, `config/validate/`, `logs/`) |
| `packages/cli/` | 8 | `staging.ts`, `paths.ts`, `env.ts`, `docker.ts`, `install.ts`, `uninstall.ts`, `server.ts` (setup wizard), `standalone.ts` |
| `packages/scheduler/` | 4 | `server.ts`, `scheduler.ts`, `shell.ts`, `shell.test.ts` |
| `packages/admin-tools/` | 1 | `README.md` (documentation reference only) |

Additionally, **10 files in `assets/`** reference `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, or `OPENPALM_DATA_HOME`: the 4 compose files (`docker-compose.yml`, `admin.yml`, `ollama.yml`, `validate-config.yml`), `secrets.env`, 2 schema files, 2 cleanup automation YAMLs, and `README.md`.

The env var rename from `OPENPALM_CONFIG_HOME`/`OPENPALM_DATA_HOME`/`OPENPALM_STATE_HOME` to `OPENPALM_HOME` is the highest-risk change because it is a user-visible API break. Existing installations have these vars in their `stack.env` files. The migration path must either (a) support both old and new vars with precedence rules during a transition period, or (b) rewrite the env files as part of the upgrade.

### Compose File Changes

**Current bind mount inventory (from actual compose files):**

`assets/docker-compose.yml` -- 4 services, 12 unique bind mounts:
- memory: 2 mounts (`DATA_HOME/memory:/data`, `DATA_HOME/memory/default_config.json:/app/default_config.json`)
- assistant: 6 mounts (DATA_HOME/assistant, CONFIG_HOME/assistant, STATE_HOME/opencode, DATA_HOME/opencode, WORK_DIR, CONFIG_HOME/stash)
- guardian: 3 mounts (DATA_HOME/guardian, STATE_HOME/audit, STATE_HOME/artifacts) + 1 `env_file` referencing STATE_HOME
- scheduler: 2 mounts (STATE_HOME/automations, STATE_HOME/artifacts)

`assets/admin.yml` -- 3 services, 8 unique bind mounts:
- caddy: 4 mounts (STATE_HOME/artifacts/Caddyfile, STATE_HOME/artifacts/channels, DATA_HOME/caddy/data, DATA_HOME/caddy/config)
- docker-socket-proxy: 1 mount (docker.sock)
- admin: 3 mounts (CONFIG_HOME identity, STATE_HOME identity, DATA_HOME identity) + 2 `env_file` entries referencing STATE_HOME

**Total current: 20 bind mounts + 3 env_file references across 7 services.**

**Proposed mount changes (from fs-mounts-refactor.md):**

All `OPENPALM_CONFIG_HOME`, `OPENPALM_STATE_HOME`, `OPENPALM_DATA_HOME` variable references become `OPENPALM_HOME`-relative paths. Every bind mount path changes. Specifically:

| Service | Mounts that change | Nature of change |
|---------|-------------------|-----------------|
| memory | 2 | `DATA_HOME/memory` -> `OPENPALM_HOME/data/memory` |
| assistant | 6 -> 8 | Adds `vault/user.env` (ro) mount and `logs/opencode/` mount; removes STATE_HOME/opencode; changes all DATA_HOME and CONFIG_HOME refs |
| guardian | 3 -> 2 | Removes `STATE_HOME/artifacts` mount entirely (no bind-mounted secrets); removes `env_file`; changes audit from STATE_HOME to `logs/` |
| scheduler | 2 -> 1 | Removes `STATE_HOME/artifacts` mount; reads automations from `config/automations/` instead of `STATE_HOME/automations/` |
| caddy | 4 -> 3 | Reads Caddyfile from `data/caddy/` instead of `STATE_HOME/artifacts/`; channels from `data/caddy/channels/` instead of `STATE_HOME/artifacts/channels/` |
| admin | 3 -> 5 | Replaces 3 identity-mapped XDG mounts with `config/` + `vault/` + `data/admin/` + `data/workspace/` + registry cache |
| docker-socket-proxy | 1 -> 1 | Unchanged |

**Net: 20 mounts + 3 env_file -> 21 mounts + 0 env_file.** The total count is similar, but the security isolation is strictly better (guardian and scheduler lose access to secrets file mounts).

The `assets/ollama.yml` also needs updating (1 mount: `DATA_HOME/ollama` -> `OPENPALM_HOME/data/ollama`).

### Test Impact

**Tests that become dead or require rewrite:**

| Test File | Lines | Dead/Rewrite | Reason |
|-----------|-------|-------------|--------|
| `packages/admin/src/lib/server/staging.test.ts` | ~530 | **DEAD** | Tests `stageChannelCaddyfiles`, `stageChannelYmlFiles`, `stageSecretsEnv`, `stageAutomationFiles` -- all eliminated |
| `packages/admin/src/lib/server/staging-core.test.ts` | ~380 | **REWRITE** | Tests `stagedEnvFile`, `stagedStackEnvFile`, `buildEnvFiles`, `persistArtifacts`, `manifest.json` -- all eliminated |
| `packages/admin/src/lib/server/lifecycle.test.ts` | ~300 | **REWRITE** | Tests `reconcileCore` path which calls staging functions; `buildComposeFileList` and `buildManagedServices` signatures change |
| `packages/admin/src/lib/server/state.test.ts` | ~150 | **REWRITE** | Tests `createState()` which initializes `stateDir`, `artifacts`, `artifactMeta`, `channelSecrets` -- all changing |
| `packages/admin/src/lib/server/paths.test.ts` | ~80 | **DEAD** | Tests `resolveConfigHome`, `resolveStateHome`, `resolveDataHome` -- all replaced |
| `packages/admin/src/lib/server/lifecycle-validate.test.ts` | ~200 | **REWRITE** | Tests `validateEnvironment()` which reads from STATE_HOME paths |
| `packages/admin/src/routes/admin/config/validate/server.test.ts` | ~150 | **REWRITE** | Tests config validation endpoint using staging paths |
| `packages/admin/src/lib/server/secrets.test.ts` | ~200 | **REWRITE** | Tests `ensureSecrets`, `updateSecretsEnv`, `loadSecretsEnvFile` -- all path-dependent |
| `packages/lib/src/control-plane/setup.test.ts` | ~500 | **REWRITE** | Tests `performSetup()` which calls `ensureXdgDirs()`, writes to `CONFIG_HOME/secrets.env`, calls `applyInstall()` |
| `packages/lib/src/control-plane/install-edge-cases.test.ts` | ~300 | **REWRITE** | Tests edge cases in install that exercise staging pipeline |
| `packages/cli/src/setup-wizard/server.test.ts` + related | ~400 | **REWRITE** | Tests setup wizard server which calls `performSetup()` with XDG paths |
| `packages/cli/src/commands/install-file.test.ts` | ~200 | **REWRITE** | Tests file-based install that exercises staging |

**Estimated test rewrite scope:** ~3,400 lines across 12 test files. Approximately 40% of these (staging.test.ts, paths.test.ts) are fully dead and can be deleted. The remaining 60% need path constant updates and assertion changes.

**New tests needed:**

1. **Validate-in-place tests** -- varlock validation of `user.env` and `system.env` against their schemas; compose dry-run validation; Caddy validation. (~100-150 lines)
2. **Snapshot/rollback tests** -- snapshot creation, rollback restoration, snapshot-not-available guard, concurrent snapshot safety. (~150-200 lines)
3. **File watcher tests** -- key allowlist enforcement, debouncing, malformed input handling. (~100 lines, in assistant container test suite)
4. **`openpalm.yml` reader tests** -- valid/invalid/missing config, default values, enabled component discovery. (~100 lines)
5. **Apply orchestrator tests** -- validate -> snapshot -> write -> deploy flow, automated rollback on health check failure, partial write recovery. (~200-300 lines)
6. **Path migration tests** -- verify `OPENPALM_HOME` resolution with and without env override, subdirectory accessor correctness. (~50 lines)
7. **Env file split tests** -- verify `buildSecretsFromSetup()` correctly splits user-facing keys (to `user.env`) from system-managed tokens (to `system.env`). (~100-150 lines)

**Estimated new test code:** ~800-1,100 lines across 7 test areas. This is less than the ~3,400 lines being removed/rewritten because the new code is structurally simpler (no staging indirection).

### Recommendations

1. **UPDATE** -- Sequence the filesystem refactor as Phase 0 of 0.10.0, before the component system. The component system's `config/components/` directory, `enabled.json` (or `openpalm.yml`), and per-instance `.env` files all depend on the new path model. Building the component system on the old XDG model and then rewriting it for the new model doubles the work. Ship the path refactor first, update all tests, then layer the component system on top.

2. **ADD** -- Create a `packages/lib/src/control-plane/home.ts` module (replacing `paths.ts`) with a single `resolveOpenPalmHome(): string` function and subdirectory accessors (`configDir()`, `vaultDir()`, `dataDir()`, `logsDir()`, `cacheDir()`). This module should support both `OPENPALM_HOME` (new) and the legacy `OPENPALM_CONFIG_HOME` + `OPENPALM_DATA_HOME` + `OPENPALM_STATE_HOME` (old) with a deprecation warning, to allow a smooth upgrade path for existing installations.

3. **ADD** -- Create a one-time migration function `migrateFromXdgLayout()` that detects the old XDG directory structure and moves files to the new `~/.openpalm/` layout. This should: (a) detect if `~/.config/openpalm` exists, (b) create `~/.openpalm/`, (c) move `config/` content, (d) move `data/` content from `~/.local/share/openpalm`, (e) merge `secrets.env` + `stack.env` into `vault/user.env` + `vault/system.env`, (f) skip `STATE_HOME` entirely (it is regenerable). This migration function must be tested against both fresh installs and existing XDG layouts.

4. **REMOVE** -- Delete `packages/lib/src/control-plane/staging.ts` entirely after the refactor lands. Do not attempt an incremental deprecation -- the staging module's functions are so deeply woven into `lifecycle.ts`, `setup.ts`, and the admin/CLI wrappers that a partial removal would be harder than a clean cut. Replace with the new `validate.ts` + `rollback.ts` modules.

5. **REMOVE** -- Delete the `ArtifactMeta` type, the `artifacts` and `artifactMeta` fields from `ControlPlaneState`, and the `packages/admin/src/routes/admin/artifacts/manifest/+server.ts` endpoint. The manifest was infrastructure to track the staging layer -- with no staging, there is no manifest.

6. **UPDATE** -- The `ControlPlaneState` type needs a redesign. The current type carries `stateDir`, `artifacts`, `artifactMeta`, and `channelSecrets` -- all of which die. The new type should carry `homeDir: string` (the single root) and derive `configDir`, `vaultDir`, `dataDir`, `logsDir` from it. The `services` field stays. The `adminToken` and `setupToken` fields stay but should read from `vault/system.env` instead of `CONFIG_HOME/secrets.env`.

7. **UPDATE** -- The admin container's volume mount strategy changes fundamentally. Currently it mounts all 3 XDG trees with identity-mapped paths so that the container's `OPENPALM_CONFIG_HOME` env var equals the host path. The new layout uses clean container-internal paths (`/etc/openpalm`, `/etc/openpalm/vault`), which is a strict improvement but means the admin can no longer assume host path === container path. Any admin code that constructs paths using host-side env vars for in-container filesystem access must be audited. Key files: `packages/admin/src/hooks.server.ts` (reads `OPENPALM_CONFIG_HOME` etc. from env to set path context).

8. **UPDATE** -- The `OPENPALM_HOME` env var unification is a **user-visible breaking change**. The `stack.env.schema` currently defines `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, and `OPENPALM_STATE_HOME` as separate fields. The migration must handle existing installations that set custom values for these. Recommendation: the migration function reads all three legacy vars and verifies they are all under the same parent before collapsing to `OPENPALM_HOME`. If they diverge (user explicitly split them), the migration should warn and require manual resolution rather than silently losing the custom layout.

9. **ADD** -- The hot-reload file watcher needs an explicit design for the race condition where `user.env` is being written (by the admin container via vault mount) while the assistant is reading it. The proposal shows `fs.watch()` + `readFileSync()`, but there is no atomicity guarantee. The admin should write to a temp file and `rename()` it into place (atomic on Linux), and the watcher should use a short debounce (200-500ms) to avoid reading a partially-written file.

10. **UPDATE** -- The `scripts/dev-setup.sh` script must be fully rewritten. It currently creates 3 directory trees and stages bootstrap artifacts. The new version creates `~/.openpalm/` (or `.dev/` for dev mode), seeds `vault/user.env` and `vault/system.env`, copies core compose files to `config/components/`, and writes a default `config/openpalm.yml`. The staging bootstrap (copy compose to `STATE_HOME/artifacts/`) is eliminated entirely.

11. **ADD** -- The `compose.dev.yaml` and `bun run dev:build` command reference `--env-file .dev/state/artifacts/stack.env --env-file .dev/state/artifacts/secrets.env`. These must change to `--env-file .dev/vault/system.env --env-file .dev/vault/user.env`. The root `package.json` scripts that construct compose commands must be updated.

12. **UPDATE** -- The guardian security model improves but introduces a new operational constraint. Currently the guardian bind-mounts `STATE_HOME/artifacts` and reads `stack.env` at runtime for HMAC secrets, allowing hot-reload of channel secrets without restart. The proposal eliminates this mount and uses `${VAR}` substitution only, meaning a guardian recreate is needed when channel secrets change. This is documented as "~2 seconds" but must be tested under load -- the guardian handles all channel ingress, so a recreate drops in-flight requests. The `docker compose up -d --force-recreate --no-deps guardian` command should be benchmarked.

13. **ADD** -- The `config/openpalm.yml` file is a new single source of truth for enabled components and feature flags. This replaces the current implicit discovery (scan for staged files, check env flags). The `openpalm.yml` schema must be defined and validated -- a Zod schema in `@openpalm/lib` would be appropriate, consistent with the existing pattern of schema validation in the setup module. This file also needs a JSON Schema for IDE autocompletion.

14. **UPDATE** -- `docs/technical/core-principles.md` requires significant revisions: the XDG directory model table (Goal 3 / filesystem contract) must be rewritten for the new `~/.openpalm/` layout, the CONFIG_HOME policy becomes a `config/` policy, the STATE_HOME tier disappears, and the volume-mount contract changes completely. The security invariants section needs updating for the vault boundary model. This is a documentation-only change but is architecturally critical since CLAUDE.md declares `core-principles.md` as the authoritative source.
