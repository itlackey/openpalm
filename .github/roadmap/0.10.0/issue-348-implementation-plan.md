# Issue #348 — Assets & Registry Cleanup Implementation Plan

> Historical archive note: this plan references deleted `registry/components/` and registry-provider abstractions that were not carried into the shipped addon model.

## Pre-Implementation Decisions (LOCKED)

1. **`admin.yml` stays in `assets/` as a system-managed overlay.** It is not user-installable; it is controlled by a feature flag and seeded during install/upgrade. Moving it to registry would break the bootstrap contract.

2. **`ollama.yml` moves to `registry/components/ollama/`.** It is user-elective (opt-in via `spec.features.ollama`), not required for the basic stack. It needs a proper component directory with `compose.yml`, `.env.schema`, and `openpalm.*` labels.

3. **Core automations stay in `assets/` as seeded defaults.** `cleanup-logs.yml`, `cleanup-data.yml`, and `validate-config.yml` are system hygiene seeded on every install. The duplicate `registry/automations/cleanup-logs.yml` is deleted.

4. **`registry/components/index.json` is kept as a hand-maintained catalog file** with CI enforcement via `registry-components.test.ts`. It is not auto-generated.

---

## Workstream 1: Shared Lib Control-Plane Cleanup

### Task 1.1: Replace RegistryProvider interface

**Files:**
- `packages/lib/src/control-plane/registry-provider.ts` — Replace channel-shaped interface with component-shaped interface
- `packages/lib/src/control-plane/fs-registry-provider.ts` — Rewrite to scan `registry/components/` directories

**Changes:**
- Remove `channelYml()`, `channelCaddy()`, `channelNames()` methods
- Add `components(): Record<string, { compose: string; schema: string; caddy?: string }>` and `componentIds(): string[]`
- Rename `automationYml()` to `automations()` for consistency
- `FilesystemRegistryProvider` scans `registry/components/<id>/` for `compose.yml` + `.env.schema` + optional `.caddy`

### Task 1.2: Remove legacy channel install/uninstall from channels.ts

**File:** `packages/lib/src/control-plane/channels.ts`

**Changes:**
- Delete `installChannelFromRegistry()` (line 96-122) — replaced by `createInstance()` in instance-lifecycle.ts
- Delete `uninstallChannel()` (line 145-195) — replaced by `deleteInstance()`
- Keep `discoverChannels()`, `isAllowedService()`, `isValidChannel()` for now (still used by compose assembly)

### Task 1.3: Unify compose assembly in lifecycle.ts

**File:** `packages/lib/src/control-plane/lifecycle.ts`

**Changes:**
- `buildComposeFileList()` (line 264): remove `discoverChannelOverlays()` call, incorporate enabled component instances via `buildComponentComposeArgs()` pattern
- `buildManagedServices()` (line 293): same — use component allowlist instead of channel name discovery
- Remove `loadPersistedChannelSecrets()` (line 136-144) — per-instance secrets replace channel HMAC secrets
- Remove `channelSecrets` from `ControlPlaneState` in types.ts

### Task 1.4: Clean up staging.ts legacy code

**File:** `packages/lib/src/control-plane/staging.ts`

**Changes:**
- Update `writeCaddyRoutes()` (line 129) to use component instances instead of `discoverChannels()`
- Update `persistConfiguration()` (line 350) to stop calling `discoverChannels()` for HMAC secrets
- Delete deprecated aliases: `stageArtifacts`, `persistArtifacts`, `discoverStagedChannelYmls` (lines 401-412)
- Delete `discoverChannelOverlays()` and `discoverStagedChannelYmls()` (lines 282-300)

### Task 1.5: Remove Ollama from CoreAssetProvider

**Files:**
- `packages/lib/src/control-plane/core-asset-provider.ts` — Remove `ollamaCompose()` method
- `packages/lib/src/control-plane/core-assets.ts` — Remove `ensureOllamaCompose()`, remove from `MANAGED_ASSETS`
- `packages/lib/src/control-plane/fs-asset-provider.ts` — Remove `ollamaCompose()` implementation

### Task 1.6: Clean up deprecated aliases and channel types

**Files:**
- `packages/lib/src/control-plane/types.ts` — Delete `ChannelInfo` type (line 91-97), remove `channelSecrets` field (line 134)
- `packages/lib/src/control-plane/staging.ts` — Delete deprecated aliases (secretsSchema→userEnvSchema, stackSchema→systemEnvSchema already done)
- `packages/lib/src/index.ts` — Remove channel exports: `discoverChannels`, `isAllowedService`, `isValidChannel`, `installChannelFromRegistry`, `uninstallChannel`, `discoverChannelOverlays`, `discoverStagedChannelYmls`, legacy aliases

---

## Workstream 2: Admin Package Cleanup

### Task 2.1: Rewrite ViteRegistryProvider for component model

**File:** `packages/admin/src/lib/server/vite-registry-provider.ts`

**Changes:**
- Remove `$registry/channels/*.yml` and `$registry/channels/*.caddy` Vite globs
- Add `$registry/components/**/compose.yml`, `$registry/components/**/.env.schema`, `$registry/components/**/.caddy` globs (or use `index.json` import)
- Replace `channelYml()`, `channelCaddy()`, `channelNames()` with new `components()`, `componentIds()` methods
- Delete backward-compatible static exports `REGISTRY_CHANNEL_YML`, `REGISTRY_CHANNEL_CADDY`, `REGISTRY_CHANNEL_NAMES`

### Task 2.2: Update registry-sync.ts for component model

**File:** `packages/admin/src/lib/server/registry-sync.ts`

**Changes:**
- Delete `RegistryChannelEntry` type (lines 119-126)
- Delete `discoverRegistryChannels()` (lines 142-173)
- Delete `getRegistryChannel()` (lines 218-230)
- Add `discoverRegistryComponents()` that scans `registry-repo/registry/components/*/`
- Keep `ensureRegistryClone()`, `pullRegistry()`, automation functions unchanged

### Task 2.3: Delete legacy admin channel routes

**Files to delete:**
- `packages/admin/src/routes/admin/channels/+server.ts` — duplicated by `/api/components` + `/api/instances`
- `packages/admin/src/routes/admin/channels/install/+server.ts` — duplicated by `POST /api/instances`
- `packages/admin/src/routes/admin/channels/uninstall/+server.ts` — duplicated by `DELETE /api/instances/:id`

### Task 2.4: Rewrite admin registry routes for component model

**Files:**
- `packages/admin/src/routes/admin/registry/+server.ts` — List components from `discoverRegistryComponents()` instead of flat channels
- `packages/admin/src/routes/admin/registry/install/+server.ts` — Use component install flow (copy to `data/catalog/`, then `createInstance()`)
- `packages/admin/src/routes/admin/registry/uninstall/+server.ts` — Use component uninstall flow

### Task 2.5: Clean up admin control-plane barrel and API client

**Files:**
- `packages/admin/src/lib/server/control-plane.ts` — Remove `REGISTRY_CHANNEL_*` re-exports, remove `_installChannelFromRegistry` wrapper
- `packages/admin/src/lib/server/registry.ts` — Delete file (pure re-export shim)
- `packages/admin/src/lib/api.ts` — Remove `fetchChannels()`, update `fetchRegistry()` for component model
- `packages/admin/src/lib/types.ts` — Remove `ChannelInfo` and `ChannelsResponse` types

### Task 2.6: Update ViteAssetProvider for Ollama removal

**File:** `packages/admin/src/lib/server/vite-asset-provider.ts`

**Changes:**
- Remove `import ollamaCompose from "$assets/ollama.yml?raw"`
- Remove `ollamaCompose()` method

### Task 2.7: Update admin UI pages that use channel APIs

**File:** `packages/admin/src/routes/+page.svelte` (and any other pages using `fetchChannels`)

**Changes:**
- Remove `fetchChannels` import and `loadChannels()` function
- Use `fetchComponents()` / `fetchInstances()` for dashboard display

---

## Workstream 3: Registry File Moves

### Task 3.1: Create Ollama component in registry

**New directory:** `registry/components/ollama/`
- `compose.yml` — Converted from `assets/ollama.yml` with `openpalm.*` labels added
- `.env.schema` — With required env vars from the current ollama.yml

### Task 3.2: Delete legacy registry/channels/

**Delete all files:**
- `registry/channels/api.yml`
- `registry/channels/chat.yml`, `registry/channels/chat.caddy`
- `registry/channels/discord.yml`
- `registry/channels/slack.yml`
- `registry/channels/voice.yml`

### Task 3.3: Delete duplicate automation

**Delete:** `registry/automations/cleanup-logs.yml` (duplicate of core automation in assets/)

### Task 3.4: Delete legacy assets

**Delete:** any remaining legacy `secrets.env` asset or references (the current model is `vault/user/user.env` + `vault/stack/stack.env`)
**Delete:** `assets/ollama.yml` (moved to registry/components/ollama/)

### Task 3.5: Update registry/components/index.json

Add the new `ollama` component entry to the index.

---

## Workstream 4: Scripts and CI

### Task 4.1: Update scripts/dev-setup.sh

- Remove `config/channels` from `mkdir -p` list (line 51)
- Update help text that references `secrets.env` (line 11)

### Task 4.2: Update scripts/validate-registry.sh

- Add validation for `registry/automations/` directory
- Ensure `registry/channels/` validation is removed (it already only validates components)

### Task 4.3: Update legacy scripts

- `scripts/release-e2e-test.sh` — Update old staging and flat-vault references to `.dev/vault/user/user.env` and `.dev/vault/stack/stack.env`
- `scripts/upgrade-test.sh` — Update for vault/components layout
- `scripts/iso/files/bin/openpalm-bootstrap.sh` — Update for vault/components layout

---

## Workstream 5: Tests

### Task 5.1: Fix e2e test legacy path

**File:** `packages/admin/e2e/channel-guardian-pipeline.test.ts`
- Line 36: change `STACK_ENV_PATH` from staged-artifact paths to `.dev/vault/stack/stack.env`

### Task 5.2: Remove vestigial test setup

- `packages/admin/src/lib/server/staging.test.ts` line 199 — Remove `config/channels` mkdir
- `packages/admin/src/lib/server/lifecycle.test.ts` lines 270/290/310 — Remove `config/channels` mkdir

### Task 5.3: Update channel tests for new model

**File:** `packages/admin/src/lib/server/channels.test.ts`
- Replace `REGISTRY_CHANNEL_NAMES` import with inline test fixture
- Update tests to use component model where applicable

### Task 5.4: Update lib tests

- Update any tests importing removed channel functions
- Ensure registry-components.test.ts passes with updated index.json (ollama added)

---

## Workstream 6: Documentation

### Task 6.1: Rewrite assets/README.md

Describe the core-only bootstrap role. Remove all references to registry flat files, legacy channel config paths, `secrets.env`, and STATE_HOME staging.

### Task 6.2: Rewrite registry/README.md

Remove the legacy `registry/channels/` section. Document only `registry/components/` and `registry/automations/`.

### Task 6.3: Update API spec

**File:** `docs/technical/api-spec.md`
- Replace all STATE_HOME/artifacts references with current paths
- Replace all CONFIG_HOME/channels references with the current `stack/` and `registry/components/` model as appropriate
- Replace all `secrets.env` references with `vault/user/user.env` (and `vault/stack/stack.env` where system-managed values are meant)
- Document the registry/component install flow

### Task 6.4: Update user-facing docs

- `docs/how-it-works.md` — Update channel discovery, staging references
- `docs/managing-openpalm.md` — Update channel management, directory layout
- `docs/setup-guide.md` — Update legacy flat-vault references
- `docs/manual-setup.md` — Update legacy flat-vault references and directory layout
- `docs/backup-restore.md` — Update legacy flat-vault references
- `docs/memory-privacy.md` — Update legacy flat-vault references

### Task 6.5: Update technical docs

- `docs/technical/directory-structure.md` — Full rewrite for ~/.openpalm/ model
- `docs/technical/environment-and-mounts.md` — Update XDG vars to OP_HOME

### Task 6.6: Update channel package READMEs

All 5 channel packages — Replace `registry/channels/*.yml` references with `registry/components/*/compose.yml`.

### Task 6.7: Update channel-specific setup docs

- `docs/channels/discord-setup.md` — Update legacy flat-vault references
- `docs/channels/slack-setup.md` — Update legacy flat-vault references

---

## Implementation Order

1. **Workstream 1** (lib) — Must go first as all consumers depend on it
2. **Workstream 3** (file moves) — Can partially overlap with W1 (ollama component creation)
3. **Workstream 2** (admin) — Depends on W1 interface changes
4. **Workstream 4** (scripts) — Independent, can run in parallel with W2
5. **Workstream 5** (tests) — After W1+W2+W3 complete
6. **Workstream 6** (docs) — Last, after all code changes stabilize

## Acceptance Criteria

- [ ] `bun run check` passes (svelte-check + TypeScript)
- [ ] `bun run test` passes (non-admin unit tests)
- [ ] `bun run admin:test:unit` passes (admin unit tests)
- [ ] `registry/channels/` directory no longer exists
- [ ] `assets/secrets.env` no longer exists
- [ ] `assets/ollama.yml` no longer exists; `registry/components/ollama/` exists
- [ ] No code imports `REGISTRY_CHANNEL_*` constants
- [ ] No code calls `installChannelFromRegistry()` or `uninstallChannel()`
- [ ] `RegistryProvider` interface has no channel-shaped methods
- [ ] All docs reference `~/.openpalm/` layout, not XDG three-tier
- [ ] All docs reference `vault/user/user.env` and `vault/stack/stack.env`, not `secrets.env`
- [ ] All docs reference the current `stack/` and `registry/components/` runtime model, not `CONFIG_HOME/channels/`
