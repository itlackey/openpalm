# Plan: Remove Three-Tier Failure Recovery Cascade

## Summary of What Exists

The current `applyStack()` function in `stack-apply-engine.ts` implements a three-tier failure recovery cascade:

1. **Normal apply** (lines 254-320): Stages artifacts to `.next` files, promotes them (creating `.prev` backups), runs compose operations.
2. **Full rollback** (lines 321-337): On failure, restores artifacts from in-memory `ExistingArtifacts` snapshot, restores `.prev` files, re-ups all 8 core services one by one via `CoreRecoveryServices`.
3. **Fallback bundle** (lines 333-336): If rollback fails, runs `fallbackToAdminAndCaddy()` which validates a SHA-256 integrity-checked minimal compose file and starts only admin + caddy.

After a successful apply, a `selfTestFallbackBundle()` check also runs (lines 344-347).

**Why this should be removed**: The admin container is already running when `applyStack()` is called (it is the one processing the HTTP request). If `docker compose up` fails, the correct behavior is to return the error to the UI. The user retries from the admin panel. The rollback/fallback cascade adds failure modes that are harder to debug than the original compose error.

---

## Part 1: Files to Remove Entirely

### 1a. `packages/lib/src/admin/fallback-bundle.ts` (29 lines)
- Contains `validateFallbackBundle()` and types `FallbackBundlePaths`, `FallbackBundleValidation`.
- Only consumed by:
  - `stack-apply-engine.ts` line 17 (import), line 108, line 142
  - `stack-manager.ts` line 6 (import), lines 197-199, 208-210
- **Action**: Delete this file entirely.

### 1b. `packages/lib/src/admin/fallback-bundle-checksums.ts` (6 lines)
- Contains `BUNDLE_VERSION` and `FALLBACK_BUNDLE_CHECKSUMS` constants.
- Only consumed by `fallback-bundle.ts` line 3.
- **Action**: Delete this file entirely.

### 1c. `packages/lib/src/admin/fallback-bundle.test.ts` (29 lines)
- Tests `validateFallbackBundle()`.
- **Action**: Delete this file entirely.

### 1d. `packages/ui/src/scripts/self-test-fallback.ts` (27 lines)
- Standalone script that creates a `StackManager` and calls `selfTestFallbackBundle()`.
- **Action**: Delete this file entirely.

### 1e. `packages/ui/src/lib/server/self-test-fallback.ts` (20 lines)
- Exports `runFallbackSelfTest()` which calls `selfTestFallbackBundle()`.
- **Action**: Delete this file entirely. Check for imports of this module first.

### 1f. `packages/lib/src/embedded/state/docker-compose-fallback.yml` (47 lines)
- The embedded fallback compose file (minimal admin + caddy only).
- Consumed by `resolveEmbeddedStatePath("docker-compose-fallback.yml")` in `stack-manager.ts` line 194.
- **Action**: Delete this file.

### 1g. `packages/lib/src/embedded/state/caddy/fallback-caddy.json` (22 lines)
- The embedded fallback Caddy config (admin-only reverse proxy).
- Consumed by `resolveEmbeddedStatePath("caddy/fallback-caddy.json")` in `stack-manager.ts` line 205.
- **Action**: Delete this file.

---

## Part 2: Functions to Remove from Files with Mixed Concerns

### 2a. `stack-apply-engine.ts` -- Functions to remove entirely

| Function | Lines | Reason |
|---|---|---|
| `restoreArtifacts()` | 82-101 | Only called at line 325 inside the rollback `catch` block |
| `restorePrevArtifacts()` | 378-394 | Only called at line 326 inside the rollback `catch` block |
| `fallbackToAdminAndCaddy()` | 103-136 | Only called at line 336 inside the rollback-failure `catch` block |
| `selfTestFallbackBundle()` (export) | 138-147 | Only called at line 345 (post-apply self-test) and in test/UI consumer files being deleted |
| `CoreRecoveryServices` constant | 30 | Only used inside the rollback block at line 329 |

### 2b. `stack-apply-engine.ts` -- Types and utilities to remove

| Item | Lines | Reason |
|---|---|---|
| `ExistingArtifacts` type | 32-43 | Only used by `readExistingArtifacts()` and `restoreArtifacts()`. However, `readExistingArtifacts()` is also used at line 217 for impact detection via `deriveImpact()`. See note below. |
| `readExistingArtifacts()` | 50-75 | **Keep this function.** It is called at line 217 to read existing artifacts for the impact-detection diff in `deriveImpact()`. It is NOT rollback-only. |
| `readIfExists()` | 45-48 | **Keep this function.** It is called by `readExistingArtifacts()`. |
| `writeArtifact()` | 77-80 | Only used by `restoreArtifacts()` (lines 85-100) and `fallbackToAdminAndCaddy()` (lines 111, 125). After removing those callers, this function is unused. **Remove.** |

### 2c. `stack-apply-engine.ts` -- The `catch` block in `applyStack()` (lines 321-337)

This is the core of the three-tier recovery. Currently implements rollback + fallback cascade.

**Replace with**:

```typescript
} catch (error) {
  throw error;
} finally {
  releaseApplyLock(applyLockPath);
}
```

### 2d. `stack-apply-engine.ts` -- Post-apply fallback self-test (lines 344-347)

**Remove this block entirely.** It runs after every successful apply to verify the fallback bundle is still valid.

### 2e. `stack-apply-engine.ts` -- Imports to clean up

- Line 6: Remove `composeActionForFileWithOverride` from the import (only used in `fallbackToAdminAndCaddy()`).
- Line 17: Remove `import { validateFallbackBundle } from "./fallback-bundle.ts"` entirely.
- Line 1: Remove `renameSync` from the `node:fs` import (only used by `restorePrevArtifacts()`).

### 2f. `stack-manager.ts` -- Fallback bundle seeding in `renderArtifacts()` (lines 192-212)

**Remove this entire block** (lines 192-212). This seeds the fallback compose and caddy files on disk during artifact rendering.

### 2g. `stack-manager.ts` -- Fallback bundle seeding in `renderArtifactsToTemp()` (lines 261-269)

**Remove this entire block** (lines 261-269).

### 2h. `stack-manager.ts` -- `.prev` backup logic in `renderArtifactsToTemp().promote()` (lines 277-285)

The `promote()` function currently creates `.prev` backups.

**Simplify to**:

```typescript
promote: () => {
  for (const entry of staged) {
    renameSync(entry.tempPath, entry.livePath);
  }
},
```

The `renameSync` from `.next` to live is atomic on POSIX and prevents partial writes. The `.prev` backup creation is only useful for rollback, which is being removed.

### 2i. `stack-manager.ts` -- Remove `cleanupBackups()` method (lines 292-295)

**Remove entirely.** With no `.prev` files being created, there is nothing to clean up.

Also remove the `backups` array declaration at line 228.

### 2j. `stack-manager.ts` -- Remove `buildFallbackCompose()` and `buildFallbackCaddyJson()` private methods (lines 504-509)

**Remove both methods.**

### 2k. `stack-manager.ts` -- Remove `fallbackComposeFilePath` and `fallbackCaddyJsonPath` from `StackManagerPaths` type (lines 28-29)

**Remove both fields.** They are optional, so removing them is a non-breaking type change.

### 2l. `stack-manager.ts` -- Remove `validateFallbackBundle` import (line 6)

**Remove this import.**

---

## Part 3: How Error Handling Should Work After Removal

1. **Pre-apply validation errors** (secret validation, preflight checks) -- throw immediately. The UI gets a clear error.
2. **Compose validation failure on staged file** (line 258-260) -- throws `compose_validation_failed:...`. Staged `.next` files are cleaned up. Live files untouched.
3. **Compose up/restart/reload failures** (lines 271-310) -- Docker Compose's own error messages, passed through to the UI.
4. **The catch block** simply re-throws. The `finally` block releases the apply lock.
5. **The UI** receives the error. The admin container is still running. The user can fix and retry.

The success path simplifies to just `staged.cleanup()` (removes `.next` files).

---

## Part 4: Every Consumer That Needs Updating

| File | What to change |
|---|---|
| `packages/lib/src/admin/stack-apply-engine.ts` | Remove 6 functions/constants, simplify catch block, remove post-apply self-test, clean up imports. See Part 2a-2e. |
| `packages/lib/src/admin/stack-manager.ts` | Remove fallback seeding, `.prev` backup logic, `cleanupBackups()`, private methods, path types, import. See Part 2f-2l. |
| `packages/ui/src/lib/server/init.ts` | Remove lines 57-60 (`fallbackComposeFilePath` and `fallbackCaddyJsonPath` from StackManager constructor). |
| `packages/cli/src/commands/install.ts` | Remove lines 267-271 (writing `caddy-fallback.json`) and lines 330-334 (writing `docker-compose-fallback.yml`). |
| `packages/lib/src/admin/compose-runner.ts` | Remove `composeActionForFile`, `composeActionForFileWithOverride`, and the field in `ComposeRunnerOverrides`. Keep `composeConfigValidateForFile`. |
| `docs/cli.md` | Line 178: change rollback/fallback description to "On failure, return the error to the admin UI." |

---

## Part 5: Test Files That Need Updating

### 5a. `packages/lib/src/admin/stack-apply-engine.test.ts`

**Tests to remove entirely:**

| Test | Lines | Reason |
|---|---|---|
| `describe("fallback self-test")` with `it("reports errors for missing bundle")` | 259-266 | Tests `selfTestFallbackBundle()` being removed |
| `it("falls back when rollback fails")` | 355-400 | Tests tier-2 → tier-3 escalation |
| `it("throws fallback_compose_validation_failed when fallback compose invalid")` | 402-448 | Tests fallback compose validation failure |

**Tests to update:**

| Test | Lines | Change needed |
|---|---|---|
| `it("safe mode triggers rollback on health gate failure")` | 217-256 | Rename to "throws on health gate failure". Remove `composeActionForFile` and `composeConfigValidateForFile` from overrides. |
| `it("triggers rollback when a service action fails")` | 317-353 | Rename to "throws when a service action fails". Remove `composeConfigValidateForFile` from overrides. |

**Other changes:**
- Remove `import { selfTestFallbackBundle }` from line 11.
- Remove `fallbackComposeFilePath` and `fallbackCaddyJsonPath` from `createManager()` (lines 62-63).

### 5b. `packages/lib/src/admin/fallback-bundle.test.ts`

**Delete entirely** (see Part 1c).

---

## Part 6: Step-by-Step Implementation Order

### Step 1: Delete standalone fallback files (no dependents)

- `packages/lib/src/admin/fallback-bundle-checksums.ts`
- `packages/lib/src/admin/fallback-bundle.test.ts`
- `packages/lib/src/embedded/state/docker-compose-fallback.yml`
- `packages/lib/src/embedded/state/caddy/fallback-caddy.json`
- `packages/ui/src/scripts/self-test-fallback.ts`
- `packages/ui/src/lib/server/self-test-fallback.ts`

### Step 2: Remove fallback bundle validation module

Delete `packages/lib/src/admin/fallback-bundle.ts`.

### Step 3: Clean up `stack-apply-engine.ts`

a. Remove imports: `renameSync`, `composeActionForFileWithOverride`, `validateFallbackBundle`
b. Remove `CoreRecoveryServices`, `writeArtifact()`, `restoreArtifacts()`, `fallbackToAdminAndCaddy()`, `selfTestFallbackBundle()`
c. Remove `restorePrevArtifacts()`
d. Simplify catch block to just re-throw
e. Remove post-apply self-test block
f. Remove `staged.cleanupBackups()` call

### Step 4: Clean up `stack-manager.ts`

a. Remove `validateFallbackBundle` import
b. Remove `fallbackComposeFilePath`/`fallbackCaddyJsonPath` from `StackManagerPaths`
c. Remove fallback seeding blocks from `renderArtifacts()` and `renderArtifactsToTemp()`
d. Simplify `promote()` to remove `.prev` backup creation
e. Remove `backups` array and `cleanupBackups()`
f. Remove `buildFallbackCompose()`/`buildFallbackCaddyJson()` private methods

### Step 5: Clean up `compose-runner.ts`

Remove `composeActionForFile()`, its override field, and `composeActionForFileWithOverride()`.

### Step 6: Update consumers

a. `packages/ui/src/lib/server/init.ts`: Remove fallback path fields from StackManager constructor.
b. `packages/cli/src/commands/install.ts`: Remove fallback file writing.

### Step 7: Update tests

Update `stack-apply-engine.test.ts` per Part 5a.

### Step 8: Update documentation

Update `docs/cli.md` line 178.

### Step 9: Run verification

```bash
bun run typecheck
bun test
```

Expected: 5 fewer tests, zero type errors, all remaining tests pass.
