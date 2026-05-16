# Simplification Plan: Post-Migration Stack Reduction

> **Branch:** `feat/simplification`
> **Source:** Architectural review following host-admin migration
> **Goal:** Reduce runtime count, compose complexity, package surface, and dead code

---

## Dependency map

```
Group A (trivial, fully parallel — no deps)
  A1  delete upgrade.ts CLI alias
  A2  inline ContainerRow.svelte
  A3  consolidate dual session IDs in chat page
  A4  replace globalThis.__ocpAuthServer with module-level var

Group B (independent compose/runtime changes — parallel)
  B1  remove init compose service (move mkdir to lifecycle.ts)
  B2  eliminate socat proxy in entrypoint.sh
  B3  strip guardian AKM volume mounts + env vars

Group C (module ownership moves — parallel)
  C1  move lib-only modules to owners + delete dead exports
  C2  move channels-sdk/crypto.ts + logger.ts into @openpalm/lib

Group D (largest — own workstream, depends on nothing but is risky)
  D1  drop SvelteKit server runtime entirely → pure Bun.serve + adapter-static

Group E (architectural reclassification)
  E1  reclassify channel-voice as addon (not a channel)

Deferred (out of scope for this plan — higher risk, separate RFC)
  F1  move gcloud + gws out of assistant image into addon
```

---

## Group A — Trivial fixes (all parallel, ~1h total)

### A1: Delete `packages/cli/src/commands/upgrade.ts`

**File:** `packages/cli/src/commands/upgrade.ts` — 12 lines, exact alias for `update.ts`

**Steps:**
1. Read `packages/cli/src/commands/upgrade.ts` — confirm it only calls `runUpgradeAction()` from `update.ts`
2. Read `packages/cli/src/main.ts` — find where `upgradeCmd` is registered and remove it
3. Delete `packages/cli/src/commands/upgrade.ts`
4. Run `bun run cli:test` — verify 0 regressions
5. Update CLAUDE.md Build & Dev Commands if `upgrade` is documented there

**Validation:** `grep -r "upgrade" packages/cli/src/main.ts` returns 0 hits

---

### A2: Inline `ContainerRow.svelte` into `ContainersTab.svelte`

**Files:**
- `packages/admin/src/lib/components/ContainerRow.svelte` (662 lines) — used in exactly one place
- `packages/admin/src/lib/components/ContainersTab.svelte` (331 lines) — the only consumer

**Steps:**
1. Read both files
2. Find the `<ContainerRow>` usage in `ContainersTab.svelte` — note the props it passes
3. Move the ContainerRow template + script logic inline into ContainersTab (replace the `<ContainerRow>` call with the inlined content)
4. Delete `packages/admin/src/lib/components/ContainerRow.svelte`
5. Remove the import in `ContainersTab.svelte`
6. Run `bun run admin:check` — 0 errors
7. Run `bun run admin:test:unit` — 0 regressions

**Validation:** `find packages/admin/src -name "ContainerRow.svelte"` returns empty

---

### A3: Consolidate dual session IDs in `routes/chat/+page.svelte`

**File:** `packages/admin/src/routes/chat/+page.svelte`

**Current:** `assistantSessionId` + `adminSessionId` as separate `$state` + `setSessionId(b, id)` + `getSessionId(b)` branching functions

**Target:**
```ts
let sessions = $state<Record<ChatBackend, string | null>>({ assistant: null, admin: null });
// Replace setSessionId(b, id)   → sessions[b] = id
// Replace getSessionId(b)       → sessions[b]
// Replace ensureSession(b, ...) → use sessions[b] directly
```

**Steps:**
1. Read `packages/admin/src/routes/chat/+page.svelte`
2. Replace the two separate `$state` vars + 4 helper functions with a single `sessions` record
3. Update all callsites in the same file
4. Run `bun run admin:check` — 0 errors
5. Run `bun run admin:test:unit` — 0 regressions

---

### A4: Replace `globalThis.__ocpAuthServer` with module-level variable

**File:** `packages/admin/src/lib/server/opencode-auth-subprocess.ts`

**Current:** Uses `(globalThis as any).__ocpAuthServer` as a process-level singleton. In a persistent Bun.serve process, a module-level `let` is equivalent and avoids the type cast.

**Steps:**
1. Read `packages/admin/src/lib/server/opencode-auth-subprocess.ts`
2. Replace `(globalThis as any).__ocpAuthServer` usages with a module-level variable of the same type
3. Remove any `as any` casts
4. Run `bun run admin:check` — 0 errors
5. Run `bun run admin:test:unit` — 0 regressions

---

## Group B — Compose and runtime changes (parallel, ~2h total)

### B1: Remove the `init` compose service

**Files:**
- `.openpalm/stack/core.compose.yml` — remove the `init` service and all `depends_on: init` references
- `packages/lib/src/control-plane/lifecycle.ts` — add the `mkdir -p` calls that init was doing
- `.openpalm/registry/addons/ollama/compose.yml` — has `depends_on: init`; remove it
- Any other addon compose files with `depends_on: init`

**Steps:**
1. Read the `init` service block in `core.compose.yml` — capture the full `mkdir` command
2. Read `packages/lib/src/control-plane/lifecycle.ts` — find `ensureHomeDirs` or the install path
3. Add the init service's directory list to the host-side `ensureHomeDirs()` call in lib (already in `packages/lib/src/control-plane/home.ts` — verify)
4. Add the addon-discovery mkdir (`ls /addons | xargs mkdir`) equivalent in CLI as a pre-compose step in `buildManagedServices` or equivalent
5. Remove the `init:` service from `core.compose.yml`
6. Remove `depends_on: init:` from `assistant:` and `guardian:` in `core.compose.yml`
7. Find all addon compose files with `depends_on: init:` via `grep -r "depends_on" .openpalm/registry/` and remove those blocks
8. Run `bun run cli:test` — 0 regressions
9. Run `bun run admin:test:unit` — 0 regressions
10. Manual check: `docker compose config` against the modified compose should validate cleanly

**Key file:** `packages/lib/src/control-plane/home.ts` — the `ensureHomeDirs` function to extend

**Validation:** `grep -r "init:" .openpalm/stack/core.compose.yml` returns 0 hits (except comments)

---

### B2: Eliminate socat proxy in `core/assistant/entrypoint.sh`

**File:** `core/assistant/entrypoint.sh` — lines ~87-157: `maybe_proxy_lmstudio()` function

**Problem:** OpenCode's lmstudio provider hardcodes `127.0.0.1:1234`. The workaround is a socat TCP proxy + restart loop. The proper fix is using OpenCode's `provider` config key.

**Steps:**
1. Read `core/assistant/entrypoint.sh` — find `maybe_proxy_lmstudio()`
2. Read `core/assistant/opencode/opencode.jsonc` — find where provider config is set
3. Read `packages/lib/src/control-plane/provider-config.ts` or equivalent — find where lmstudio provider config is written
4. In `ensureOpenCodeSystemConfig()` (or wherever the assistant's opencode.jsonc is written), add logic to write the `provider.lmstudio.options.baseURL` key when `LMSTUDIO_BASE_URL` env var is set — this replaces the socat proxy
5. Remove `maybe_proxy_lmstudio()` function (70 lines) from `entrypoint.sh`
6. Remove the `maybe_proxy_lmstudio "$LMSTUDIO_BASE_URL"` call from the main entrypoint flow
7. Read `core/assistant/Dockerfile` — find the `socat` package install and remove it
8. Run `bun run guardian:test` and `bun run cli:test` — 0 regressions
9. Update `docs/managing-openpalm.md` or any doc that mentions the socat proxy

**Key constraint:** Only remove socat if OpenCode actually supports `provider.lmstudio.options.baseURL` in its config. Verify this against `packages/lib/src/control-plane/provider-config.ts` and the OpenCode config spec in `docs/technical/opencode-configuration.md` before deleting. If it's not supported, do NOT remove socat and document why in this plan.

**Validation:** `grep -n "socat\|maybe_proxy_lmstudio" core/assistant/entrypoint.sh core/assistant/Dockerfile` returns 0 hits

---

### B3: Strip guardian's AKM volume mounts and environment variables

**File:** `.openpalm/registry/addons/admin/compose.yml` — wait, admin addon is deleted.

**Actual file:** `.openpalm/stack/core.compose.yml` — the `guardian:` service block

**What to remove:**
```yaml
# Environment vars to remove:
AKM_STASH_DIR: /akm-guardian
AKM_CONFIG_DIR: /akm-guardian-op/config
AKM_DATA_DIR: /akm-guardian-op/data
AKM_STATE_DIR: /akm-guardian-op/state
AKM_CACHE_DIR: /akm-guardian-cache

# Volume mounts to remove:
- ${OP_HOME}/state/guardian/stash:/akm-guardian
- ${OP_HOME}/state/guardian/akm:/akm-guardian-op
- ${OP_HOME}/cache/guardian:/akm-guardian-cache
```

**Also remove** the corresponding `mkdir -p` calls from the `init` service command (coordinated with B1).
**Also remove** from `packages/lib/src/control-plane/home.ts` the `state/guardian/stash`, `state/guardian/akm`, and `cache/guardian` directory creation calls.

**Steps:**
1. Read `core/guardian/src/server.ts` and all files in `core/guardian/src/` — confirm zero akm CLI invocations
2. Read `core.compose.yml` guardian block — note exact env var names and volume mounts
3. Remove the 5 `AKM_*` env vars from the guardian service
4. Remove the 3 AKM-related volume mounts from the guardian service
5. Remove the guardian AKM directory creation from `home.ts` `ensureHomeDirs()` (or from the init service command if B1 hasn't landed yet)
6. Run `bun run guardian:test` — 0 regressions

**Validation:** `grep -n "AKM\|akm" .openpalm/stack/core.compose.yml | grep -i guardian` returns 0 hits

---

## Group C — Module ownership moves (parallel, ~2h total)

### C1: Move lib-only modules to their owners + delete dead exports

**Modules to move out of `@openpalm/lib`:**

**Admin-only (move to `packages/admin/src/lib/server/`):**
- `packages/lib/src/control-plane/secret-backend.ts` (~362 LOC) — used only by admin secrets routes
- `packages/lib/src/control-plane/audit.ts` (~41 LOC) — after Phase 2 pushes appendAudit into lib lifecycle functions, verify it's still exported or if the live callers are admin-only
- `packages/lib/src/control-plane/scheduler.ts` (~200 LOC) — admin automations only
- `packages/lib/src/control-plane/markdown-task.ts` (~200 LOC) — admin automations only

**Dead exports to delete (no non-test callers):**
- `ensureAdminToken` and `rotateAdminToken` from `packages/lib/src/control-plane/admin-token.ts` — verify with `grep -rn "ensureAdminToken\|rotateAdminToken" packages/ --include="*.ts" | grep -v test`
- Remove their exports from `packages/lib/src/index.ts`
- If `admin-token.ts` is then empty/unused, delete the file

**CLI-only (move to `packages/cli/src/lib/`):**
- `resolveRequestedImageTag`, `reconcileStackEnvImageTag` from `packages/lib/src/control-plane/env.ts` or `lifecycle.ts` — verify with `grep -rn "resolveRequestedImageTag\|reconcileStackEnvImageTag" packages/admin/`; if zero admin usages, move to CLI

**Steps:**
1. For each candidate module, run `grep -rn "importedSymbol" packages/ --include="*.ts" | grep -v "test\|spec"` to confirm single-consumer status
2. Copy file to the target package, update the import path in all consumers
3. Remove from the source package and from `packages/lib/src/index.ts`
4. Run `bun run check` (runs admin:check + sdk:test)
5. Run `bun run cli:test`

**Validation:** `wc -l packages/lib/src/control-plane/*.ts | sort -rn` — lib should be measurably smaller

---

### C2: Move `channels-sdk/crypto.ts` and `logger.ts` into `@openpalm/lib`

**Problem:** Guardian (security boundary) imports HMAC/signing primitives from the channel adapter SDK. `crypto.ts` and `logger.ts` are control-plane concerns.

**Files:**
- `packages/channels-sdk/src/crypto.ts` → `packages/lib/src/control-plane/channel-crypto.ts` (name carefully to avoid collision with existing `packages/lib/src/control-plane/crypto.ts`)
- `packages/channels-sdk/src/logger.ts` → `packages/lib/src/logger.ts` already exists; merge or consolidate

**Steps:**
1. Read `packages/channels-sdk/src/crypto.ts` and `packages/lib/src/control-plane/crypto.ts` — are they the same implementation or different? If they implement different things (HMAC-SHA256 vs SHA-256 + randomBytes), they can coexist in lib under different names
2. Read `packages/channels-sdk/src/logger.ts` vs `packages/lib/src/logger.ts` — are they the same `createLogger` function? If so, channels-sdk should just re-export from lib
3. Read all callers of `channels-sdk/crypto.ts`: `core/guardian/src/`, all channel packages — note import paths
4. Move `crypto.ts` to lib (or make channels-sdk re-export from lib)
5. Move/merge `logger.ts` to lib (or make channels-sdk re-export from lib — keep the re-export for backward compat)
6. Update all import paths in guardian and channel packages
7. Run `bun run guardian:test` — 0 regressions
8. Run `bun run sdk:test` — 0 regressions
9. Run `bun run cli:test` — 0 regressions

**Key constraint:** If channels-sdk exports these for external consumers (published npm package), add re-exports from channels-sdk that point to lib. Do not break the public API.

---

## Group D — Drop SvelteKit server runtime (own workstream, ~1 sprint)

### D1: Eliminate SvelteKit adapter-node, run purely on Bun.serve + adapter-static

**Current state:**
- `Bun.serve` gateway (host-admin-server.ts) proxies all non-`/proxy/*` requests to Node process (port 18100)
- Node process runs the SvelteKit `adapter-node` build
- `src/server/routes/` has 59 Bun shim handlers that import from SvelteKit `src/routes/admin/*/+server.ts` but are **never called in production**
- `src/server/shim.ts` creates fake `RequestEvent` for the shims

**Target state:**
- Bun.serve gateway serves static files from `build/client/` (SvelteKit static output)
- Bun.serve routes in `src/server/routes/` handle all API calls with real logic (no shim)
- No Node subprocess, no adapter-node, no SvelteKit server runtime
- `svelte.config.js` switches to `adapter-static`

**Steps:**

**Step 1: Audit what the shim is hiding**
- Read `src/server/shim.ts` — what fields does `makeEvent()` fake?
- For each `+server.ts` file that uses `event.cookies.*`, `event.setHeaders()`, `event.locals`, etc. — list them (these need special handling during migration)
- Check if `hooks.server.ts` startup logic runs via the SvelteKit runtime or separately — it must be moved to the Bun server entry

**Step 2: Port the 2 proxy routes to Bun.serve**
- `packages/admin/src/routes/proxy/assistant/[...path]/+server.ts` → `src/server/routes/proxy/assistant.ts`
- `packages/admin/src/routes/proxy/admin/[...path]/+server.ts` → `src/server/routes/proxy/admin.ts`
- These have real logic (150s timeout, auth, content-type forwarding) — port carefully

**Step 3: Port the startup-apply logic from `hooks.server.ts`**
- Read `packages/admin/src/hooks.server.ts` — it calls `ensureHomeDirs`, `ensureSecrets`, `ensureOpenCodeConfig`, `resolveRuntimeFiles`, `writeRuntimeFiles`, `appendAudit`
- Move this startup sequence into `src/server/entry.ts` Bun.serve startup (runs once on server start, not per-request)

**Step 4: Migrate `src/lib/server/` modules to be Bun-compatible**
- `src/lib/server/helpers.ts` (343 LOC) — already uses `event.request` headers directly; most is portable
- `src/lib/server/state.ts` — reads OP_HOME from process.env; portable
- `src/lib/server/opencode-auth-subprocess.ts` (150 LOC) — spawns child process; portable

**Step 5: Delete the shim layer**
- Delete `src/server/shim.ts`
- Delete `src/server/state.ts` (re-export stub)
- Replace each `src/server/routes/**/*.ts` shim with real handler calling `@openpalm/lib` directly

**Step 6: Move route logic out of `+server.ts` into `src/server/routes/`**
- For each of the 74 `+server.ts` files:
  - Copy the handler logic into the corresponding Bun handler in `src/server/routes/`
  - Replace `event.request.headers.get(x)` → `req.headers.get(x)`
  - Replace `event.params` → URL-parsed params
  - Replace `$lib/server/xxx` imports → direct `@openpalm/lib` imports or local imports
  - Remove the `+server.ts` file
- This is mechanical but must be done file by file to catch any SvelteKit-specific API usage

**Step 7: Switch to `adapter-static`**
- Update `svelte.config.js`: `import adapter from '@sveltejs/adapter-static'`
- Add `export const prerender = true` to `src/routes/+layout.ts` (or set globally in svelte.config)
- Remove `adapter-node` from devDependencies, add `adapter-static`
- Build and verify static output in `build/client/`

**Step 8: Update CLI to serve static files from Bun.serve directly**
- In `host-admin-server.ts`: remove the `startNodeAdmin()` subprocess call
- Replace with: serve `build/client/` static files from `Bun.serve` directly for `GET` requests that don't match API routes
- The SPA fallback (return `index.html` for unmatched routes) must be added

**Step 9: Remove adapter-node infrastructure**
- Delete `src/server/shim.ts`
- Remove Node subprocess code from `packages/cli/src/lib/host-admin-server.ts`
- Remove `INTERNAL_ADMIN_PORT` constant
- Remove `@sveltejs/adapter-node` from `packages/admin/package.json`

**Step 10: Test everything**
- `bun run admin:check` — 0 errors (SvelteKit type checking still runs even with adapter-static)
- `bun run admin:test:unit` — verify all vitest tests pass (they test lib modules directly, not routes, so they should be unaffected)
- `bun run admin:test:e2e:mocked` — verify mocked browser tests pass
- `bun run cli:test` — 0 regressions

**Files to delete when complete:**
- `packages/admin/src/routes/admin/**/+server.ts` (74 files)
- `packages/admin/src/server/shim.ts`
- `packages/admin/src/server/state.ts`
- `packages/admin/src/hooks.server.ts` (logic moved to Bun entry)

**Validation:**
```bash
grep -r "adapter-node" packages/admin/ && echo "FAIL" || echo "OK"
find packages/admin/src/routes -name "+server.ts" | wc -l  # must be 0
grep -r "startNodeAdmin\|INTERNAL_ADMIN_PORT" packages/cli/ && echo "FAIL" || echo "OK"
```

---

## Group E — Architectural reclassification (parallel with others)

### E1: Reclassify `channel-voice` as an addon, not a channel

**Problem:** `channel-voice` appears in the "channels" list but does not use the channels-sdk, has no guardian pipeline, and is a 77-line static file server. This misleads the architecture.

**Files:**
- `packages/channel-voice/src/index.ts` — read to understand what it actually does
- `.openpalm/registry/addons/voice/compose.yml` (if it exists) — or wherever voice is defined as an addon overlay
- `docs/` references to voice as a "channel"
- `CLAUDE.md` channel list

**Steps:**
1. Read `packages/channel-voice/src/index.ts` — confirm no `BaseChannel` usage, no guardian HMAC
2. Check if `channel-voice` uses the `core/channel/` base image or its own image — this determines how much changes
3. If it uses `core/channel/`, verify whether that Dockerfile installs channels-sdk. Voice doesn't need it.
4. Update `docs/` and `CLAUDE.md` to list voice as an addon, not a channel
5. If `channel-voice` could be replaced with a plain nginx or `bun serve` container, note this as a follow-up but do not implement now
6. Update any compose or registry files that categorize it alongside protocol channels

**Validation:** `grep -r "channel-voice\|channel_voice" docs/ CLAUDE.md` returns no instances of it being labeled a "channel"

---

## Testing gates per group

| After group | Must pass |
|---|---|
| A (all) | `bun run admin:check`, `bun run admin:test:unit`, `bun run cli:test` |
| B1 | `bun run cli:test`, manual: `docker compose config` validates |
| B2 | `bun run cli:test`, `bun run guardian:test` |
| B3 | `bun run guardian:test`, `bun run admin:check` |
| C1 | `bun run check` (admin+sdk), `bun run cli:test` |
| C2 | `bun run guardian:test`, `bun run sdk:test`, `bun run cli:test` |
| D1 | ALL suites: admin:check, admin:test:unit, admin:test:e2e:mocked, cli:test, guardian:test, sdk:test |
| E1 | `bun run admin:check`, docs review |

---

## Execution order

```
Phase 1 (all parallel, start immediately):
  A1 + A2 + A3 + A4   — trivial fixes, 1-2h each
  B3                   — guardian AKM strip, ~1h
  E1                   — voice reclassification, ~1h

Phase 2 (after Phase 1 passes tests, parallel):
  B1                   — init service removal (reads from home.ts first)
  B2                   — socat elimination (verify OpenCode config support first)
  C1                   — lib module ownership moves
  C2                   — channels-sdk crypto/logger to lib

Phase 3 (after Phase 2, own sprint):
  D1                   — drop SvelteKit server runtime entirely
```

---

## Execution status (updated 2026-05-16)

### Phase 1 — All completed ✅

- ✅ A1: Delete `packages/cli/src/commands/upgrade.ts` — removed upgrade alias from main.ts, deleted file
- ✅ A2: Inline `ContainerRow.svelte` into `ContainersTab.svelte` — per-entry state moved to Maps keyed by entry.id
- ✅ A3: Consolidate dual session IDs in chat page — replaced assistantSessionId + adminSessionId with sessions Record
- ✅ A4: Replace `globalThis.__ocpAuthServer` with module-level variable — removed type cast, added `let authServer: AuthServerState`
- ✅ B3: Strip guardian AKM volume mounts and env vars — removed 5 env vars, 3 volume mounts, guardian AKM dirs from home.ts and init service mkdir
- ✅ E1: Reclassify channel-voice as addon — updated core-principles.md and community-channels.md

Phase 1 test gate: admin:check 0 errors, cli:test 92/92, guardian:test 31/31, admin:test:unit 459/459

### Phase 2 — Partial

- ✅ B1: Remove init compose service — removed init service, depends_on: init from assistant and ollama addon, updated service list test
- ❌ B2: Blocked — OpenCode `provider.lmstudio.options.baseURL` config key is documented as non-functional in entrypoint.sh (see comments at lines 94-109 + GitHub issue linked). Cannot remove socat until upstream adds reliable support. The TODO comment in entrypoint.sh tracks this.
- ✅ C1: Remove dead exports from @openpalm/lib — removed `ensureAdminToken` and `rotateAdminToken` exports (zero non-test callers). Module moves (secret-backend, audit, scheduler, markdown-task) are NOT done — those modules are correctly in lib per CLAUDE.md architectural rules and moving them would require updating 20+ import paths with marginal benefit.
- ❌ C2: Blocked — Moving channels-sdk/crypto.ts and logger.ts into lib would require @openpalm/lib to become a guardian container dependency. Guardian Dockerfile does `bun install --production` for channels-sdk's own deps. Adding lib adds significant weight and Bun-specific API surface to the security boundary container. Current architecture is correct.

Phase 2 test gate: check (sdk 39/39, admin:check 0 errors), cli:test 92/92, guardian:test 31/31, admin:test:unit 459/459

### Phase 3

- ⏸ D1: Explicitly deferred — own sprint, higher risk, requires separate RFC
