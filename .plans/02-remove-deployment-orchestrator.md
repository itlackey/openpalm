# Plan: Remove the Deployment Orchestrator (Finding 02)

## Executive Summary

The file `packages/lib/src/admin/stack-apply-engine.ts` (422 lines) contains a multi-phase deployment orchestrator (`applyStack`) that mimics Kubernetes-style rolling deployments with phased rollout, health gating, impact planning, rollback, and fallback recovery. For a single-machine Docker Compose system, this is severe over-engineering. Docker Compose already handles service diffing, startup ordering via `depends_on`, and health checks.

**Target state**: The entire apply flow should be: validate secrets, render artifacts, write them, run `docker compose up -d --remove-orphans`, reload Caddy if its config changed. If it fails, return Docker's own error message to the UI.

**This plan is a "master plan" for Finding 02.** It encompasses and coordinates the work described in the sibling plans for Findings 03, 04, 06, and 14, since all four are about removing subsystems of the same deployment orchestrator. Those plans remain valid as detailed references; this plan defines the correct execution order and identifies all cross-cutting concerns.

## Relationship to Other Plans

| Finding | Plan | Relationship |
|---------|------|-------------|
| 03 -- Three-Tier Recovery | `.plans/03-remove-three-tier-recovery.md` | **Subset of this plan.** Removing rollback, fallback bundle, `.prev` backups. |
| 04 -- Impact Planning | `.plans/04-remove-impact-planning.md` | **Subset of this plan.** Removing deriveImpact, per-service iteration, impact-plan.ts. |
| 06 -- Preflight Checks | `.plans/06-consolidate-preflight-checks.md` | **Subset of this plan.** Removing per-apply preflight from the engine. |
| 14 -- previewComposeOperations | `.plans/14-remove-preview-compose-operations.md` | **Subset of this plan.** Removing dead function. |

All four of these are orchestration subsystems wired into `applyStack()`. Implementing them in isolation would require repeatedly modifying the same function body. This plan defines a single pass that removes all four together.

## Current Architecture of `applyStack()` (Lines 215-350)

The current flow has **9 phases** that execute sequentially:

1. **Render preview** (line 216): `manager.renderPreview()` -- generates all artifacts in memory.
2. **Read existing artifacts** (line 217): `readExistingArtifacts()` -- reads every on-disk config file for diffing.
3. **Validate secrets** (lines 219-222): `manager.validateReferencedSecrets()` -- verifies secret references resolve.
4. **Acquire apply lock** (lines 225-229): File-based mutex with PID/timestamp.
5. **Derive impact** (line 232): `deriveImpact()` -- diffs all artifacts, runs `docker compose config --services` on old and new files, computes reload/restart/up/down lists.
6. **Run preflight checks** (lines 234-252): Drift detection + `runApplyPreflight()` (socket check, port check, writable mounts, image pulls).
7. **Stage and promote artifacts** (lines 256-262): Write to `.next` files, validate compose, atomically promote with `.prev` backups.
8. **Execute compose operations** (lines 264-317): Phased rollout by service with optional health gating per-service.
9. **Three-tier error recovery** (lines 321-341): Rollback `.prev` files, re-up all 8 core services one-by-one, fallback to admin+caddy if rollback fails.
10. **Post-apply self-test** (lines 344-347): Validate fallback bundle integrity.

**The simplified flow removes phases 2, 5, 6, 9, 10, and replaces phase 8 with a single compose command.**

## Target Architecture of Simplified `applyStack()`

```typescript
export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  caddyReloaded: boolean;
  warnings: string[];
};

export async function applyStack(
  manager: StackManager,
  options?: { apply?: boolean }
): Promise<StackApplyResult> {
  // 1. Render artifacts in memory
  const generated = manager.renderPreview();

  // 2. Validate secret references
  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];
  let caddyReloaded = false;

  if (options?.apply ?? true) {
    const applyLockPath = manager.getPaths().applyLockPath
      ?? join(manager.getPaths().stateRootPath, "apply.lock");
    acquireApplyLock(applyLockPath, 10 * 60_000);

    try {
      // 3. Detect caddy change before writing new artifacts
      const caddyJsonPath = manager.getPaths().caddyJsonPath;
      const existingCaddyJson = existsSync(caddyJsonPath)
        ? readFileSync(caddyJsonPath, "utf8")
        : "";
      const caddyChanged = existingCaddyJson !== generated.caddyJson;

      // 4. Write artifacts directly
      manager.renderArtifacts(generated);

      // 5. Single compose up -- Docker handles service diffing and ordering
      const result = await composeActionWithOverride("up", []);
      if (!result.ok) throw new Error(`compose_up_failed:${result.stderr}`);

      // 6. Caddy reload (the one thing Docker Compose can't handle)
      if (caddyChanged) {
        const reload = await composeExecWithOverride(
          "caddy",
          ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]
        );
        if (!reload.ok) {
          warnings.push(`caddy_reload_failed:${reload.stderr}`);
        } else {
          caddyReloaded = true;
        }
      }
    } finally {
      releaseApplyLock(applyLockPath);
    }
  }

  return { ok: true, generated, caddyReloaded, warnings };
}
```

**Lines removed**: ~250 lines from the function body.
**Lines remaining**: ~50 lines.

## Complete File-by-File Change Specification

### Files to DELETE entirely (7+ files, ~260 lines)

| File | Lines | Reason |
|------|-------|--------|
| `packages/lib/src/admin/impact-plan.ts` | 64 | Entire module removed (Finding 04) |
| `packages/lib/src/admin/impact-plan.test.ts` | 21 | Tests for removed module |
| `packages/lib/src/admin/health-gate.ts` | 72 | Health gating removed -- Docker Compose handles healthchecks via `depends_on: condition: service_healthy` |
| `packages/lib/src/admin/health-gate.test.ts` | 39 | Tests for removed module |
| `packages/lib/src/admin/fallback-bundle.ts` | 29 | Fallback bundle validation removed (Finding 03) |
| `packages/lib/src/admin/fallback-bundle-checksums.ts` | 6 | Checksums for removed bundle |
| `packages/lib/src/admin/fallback-bundle.test.ts` | ~29 | Tests for removed module |
| `packages/ui/src/scripts/self-test-fallback.ts` | 27 | Standalone script calling removed `selfTestFallbackBundle()` |
| `packages/ui/src/lib/server/self-test-fallback.ts` | 20 | Server module wrapping removed function |

Also delete embedded fallback assets:

| File | Reason |
|------|--------|
| `packages/lib/src/embedded/state/docker-compose-fallback.yml` | Fallback compose file no longer needed |
| `packages/lib/src/embedded/state/caddy/fallback-caddy.json` | Fallback caddy config no longer needed |

### File: `packages/lib/src/admin/stack-apply-engine.ts` (Major rewrite)

**Current**: 422 lines, 15 imports, 12 functions/types.
**Target**: ~100 lines, 5 imports, 4 functions/types.

**Imports to remove** (lines 1-18):
- Line 1: Remove `renameSync` from `node:fs` import
- Line 2: Remove `randomUUID` from `node:crypto` import (transaction IDs removed)
- Lines 5-8: Remove `composeActionForFileWithOverride`, `composeConfigServicesWithOverride`, `composeServiceNames`, `composeLogsValidateTail`, `computeDriftReport` from `./compose-runner.ts` import
- Line 14: Remove entire `import { pollUntilHealthy, resolveServiceHealthConfig } from "./health-gate.ts"`
- Line 15: Remove entire `import { computeImpactFromChanges, diffServiceSets, type StackImpact } from "./impact-plan.ts"`
- Line 17: Remove entire `import { validateFallbackBundle } from "./fallback-bundle.ts"`
- Line 18: Remove entire `import { runApplyPreflight } from "./preflight-checks.ts"`

**Types/constants to remove**:

| Item | Lines | Reason |
|------|-------|--------|
| `RolloutMode` type | 20 | No more safe/fast modes -- single compose up |
| `CoreRecoveryServices` constant | 30 | Only used in rollback |
| `ExistingArtifacts` type | 32-43 | Only used for impact diffing and rollback |

**Functions to remove entirely**:

| Function | Lines | Reason |
|----------|-------|--------|
| `readIfExists()` | 45-48 | Used by `readExistingArtifacts()` |
| `readExistingArtifacts()` | 50-75 | Impact diffing and rollback |
| `writeArtifact()` (standalone) | 77-80 | Used by `restoreArtifacts()` and `fallbackToAdminAndCaddy()` |
| `restoreArtifacts()` | 82-101 | Rollback only |
| `fallbackToAdminAndCaddy()` | 103-136 | Fallback tier |
| `selfTestFallbackBundle()` | 138-147 | Post-apply self-test |
| `enabledChannelServices()` | 149-151 | Used only by `deriveImpact()` |
| `deriveImpact()` | 153-213 | Impact planning |
| `restorePrevArtifacts()` | 378-394 | Rollback only |
| `previewComposeOperations()` | 396-422 | Dead code (Finding 14) |

**Functions to keep and simplify**:

| Function | Lines | Change |
|----------|-------|--------|
| `applyStack()` | 215-350 | **Major rewrite.** See target architecture above. |
| `acquireApplyLock()` | 352-362 | **Keep as-is.** Concurrency protection is reasonable. |
| `releaseApplyLock()` | 364-366 | **Keep as-is.** |
| `parseLockContent()` | 368-376 | **Keep as-is.** |

**`StackApplyResult` type change** (lines 22-28):
```typescript
// Before:
export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  impact: StackImpact;
  warnings: string[];
  preflightWarnings?: string[];
};

// After:
export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  caddyReloaded: boolean;
  warnings: string[];
};
```

### File: `packages/lib/src/admin/stack-apply-engine.test.ts` (Major rewrite)

**Current**: 472 lines, 5 describe blocks, ~15 tests.
**Target**: ~120 lines, 2 describe blocks, ~6 tests.

**Tests to DELETE**:

| Test/Block | Lines | Reason |
|------------|-------|--------|
| All `describe("applyStack impact detection")` tests | 68-174 | Impact system removed |
| `describe("applyStack rollout modes")` | 217-256 | Rollout modes removed |
| `describe("fallback self-test")` | 259-266 | Fallback bundle removed |
| `describe("applyStack failure injection")` -- falls back when rollback fails | 355-400 | Three-tier recovery removed |
| `describe("applyStack failure injection")` -- throws fallback_compose_validation_failed | 402-448 | Fallback bundle removed |
| `describe("previewComposeOperations")` | 451-471 | Function removed |

**Tests to KEEP (with modifications)**:

| Test | Lines | Modification |
|------|-------|-------------|
| Throws when secrets reference is missing | 176-194 | Keep, update assertion format |
| Caddy reload path references caddy.json | 196-213 | Simplify, assert `caddyReloaded` |
| Aborts before artifact writes on compose validation failure | 269-315 | Simplify, remove preflight workarounds |
| Triggers rollback when service action fails | 317-353 | Rename to "throws when compose up fails", remove rollback verification |

**New tests to ADD**:

| Test | Purpose |
|------|---------|
| Succeeds with no warnings on unchanged artifacts (dry-run) | Basic success path |
| Reports caddyReloaded when caddy config changes | Caddy reload detection |
| Reloads caddy after successful compose up | Full apply with caddy reload |

### File: `packages/lib/src/admin/stack-manager.ts` (Moderate changes)

1. Remove `validateFallbackBundle` import (line 6)
2. Remove `fallbackComposeFilePath`/`fallbackCaddyJsonPath` from `StackManagerPaths`
3. Remove fallback seeding from `renderArtifacts()` (lines 192-212)
4. Remove fallback seeding from `renderArtifactsToTemp()` (lines 261-269)
5. Simplify `promote()` (remove `.prev` backups)
6. Remove `cleanupBackups()` method and `backups` array
7. Remove private methods: `buildFallbackCompose()` and `buildFallbackCaddyJson()`

### File: `packages/lib/src/admin/compose-runner.ts` (Minor changes)

1. Remove `composeActionForFile()` (lines 284-289) -- only used by `fallbackToAdminAndCaddy()`
2. Remove from `ComposeRunnerOverrides` type: `composeActionForFile?` field
3. Remove `composeActionForFileWithOverride()` (lines 340-348)

### File: `packages/ui/src/lib/components/StackEditor.svelte` (Minor UI change)

Replace impact display with simplified status:
```svelte
// Before:
const impact = r.data?.impact || {};
// ... complex impact display

// After:
let msg = 'Stack applied successfully.';
if (r.data?.caddyReloaded) msg += ' Caddy config reloaded.';
if (r.data?.warnings?.length) msg += ' Warnings: ' + r.data.warnings.join(', ');
statusMsg = msg;
```

### File: `packages/ui/src/lib/server/init.ts` (Minor change)

Remove `fallbackComposeFilePath` and `fallbackCaddyJsonPath` from the `StackManager` constructor call.

### File: `packages/ui/e2e/env.ts` (Minor change)

Remove `OPENPALM_PREFLIGHT_SKIP_DOCKER_CHECKS` and `OPENPALM_PREFLIGHT_SKIP_PORT_CHECKS` env vars.

---

## Step-by-Step Implementation Order

### Phase 1: Delete leaf modules with no dependents

Delete these files in any order (no cross-dependencies):
1. `packages/lib/src/admin/fallback-bundle-checksums.ts`
2. `packages/lib/src/admin/fallback-bundle.test.ts`
3. `packages/lib/src/admin/impact-plan.test.ts`
4. `packages/lib/src/admin/health-gate.test.ts`
5. `packages/lib/src/embedded/state/docker-compose-fallback.yml`
6. `packages/lib/src/embedded/state/caddy/fallback-caddy.json`
7. `packages/ui/src/scripts/self-test-fallback.ts`
8. `packages/ui/src/lib/server/self-test-fallback.ts`

### Phase 2: Delete modules with single consumers

1. Delete `packages/lib/src/admin/fallback-bundle.ts`
2. Delete `packages/lib/src/admin/impact-plan.ts`
3. Delete `packages/lib/src/admin/health-gate.ts`
4. Delete `packages/lib/src/admin/preflight-checks.ts`

### Phase 3: Rewrite `stack-apply-engine.ts`

In a single pass:
1. Remove all imports for deleted modules
2. Remove `RolloutMode`, `CoreRecoveryServices`, `ExistingArtifacts` types/constants
3. Remove all 10 functions listed above
4. Update `StackApplyResult` type (remove `impact`, `preflightWarnings`; add `caddyReloaded`)
5. Rewrite `applyStack()` to the simplified ~50-line version
6. Keep the lock functions as-is

### Phase 4: Update `stack-manager.ts`

1. Remove `validateFallbackBundle` import
2. Remove `fallbackComposeFilePath`/`fallbackCaddyJsonPath` from `StackManagerPaths`
3. Remove fallback seeding from `renderArtifacts()` and `renderArtifactsToTemp()`
4. Simplify `promote()` (remove `.prev` backups)
5. Remove `cleanupBackups()`, `backups` array, private fallback methods

### Phase 5: Update `compose-runner.ts`

Remove `composeActionForFile()`, `composeActionForFileWithOverride()`, and the override field.

### Phase 6: Update consumers

1. `packages/ui/src/lib/server/init.ts` -- remove fallback path fields
2. `packages/ui/src/lib/components/StackEditor.svelte` -- update status display
3. `packages/ui/e2e/env.ts` -- remove preflight skip vars
4. `test/docker/docker-stack.docker.ts` -- remove preflight skip vars

### Phase 7: Rewrite `stack-apply-engine.test.ts`

1. Remove old imports
2. Remove test helpers (`withSkippedDockerSocketCheck`, `withDisabledPortCheck`, `withHealthGateTimeoutMs`)
3. Update `createManager()` to remove fallback paths
4. Delete all impact/rollout/fallback/previewComposeOperations tests
5. Keep and simplify: secret validation, compose validation failure, compose up failure
6. Add new tests: dry-run success, caddy reload detection, full apply with caddy reload

### Phase 8: Verification

```bash
bun run typecheck                  # Zero type errors
bun test                          # All tests pass
```

## Risk Assessment

### Low Risk
- **UI changes**: Cosmetic only (StackEditor status message)
- **API route changes**: All routes are passthrough -- serialize `result` to JSON without destructuring

### Medium Risk
- **Atomic promote without `.prev` backups**: After this change, if compose up fails, new config files are on disk but services may be in a mixed state. **Mitigation**: Same state Docker Compose users are in normally. Rerunning `compose up` converges toward desired state.
- **Caddy reload failure**: New behavior pushes a warning instead of triggering rollback. **Mitigation**: Caddy keeps running with previous config on reload failure. User sees warning, can retry.
- **Loss of per-service visibility**: Impact plan told users which services changed. **Mitigation**: `docker compose up -d` prints its own output showing recreated services.

### High Risk
- **Test coverage gap during transition**: Old ~15 tests cover edge cases of old system. New ~6 tests cover simplified flow. **Mitigation**: New behavior is simpler, fewer tests achieve equivalent coverage.

## Net Impact

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| stack-apply-engine.ts | 422 lines | ~100 lines | -322 lines |
| Modules deleted | 0 | 7+ files (~260 lines) | -260 lines |
| Test file lines | ~472 lines | ~120 lines | -352 lines |
| **Net reduction** | - | - | **~960 lines** |
| Exported functions removed | - | - | 6 |
| Modules deleted | - | - | 7+ |
