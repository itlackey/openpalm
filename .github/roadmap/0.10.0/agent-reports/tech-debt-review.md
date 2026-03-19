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
