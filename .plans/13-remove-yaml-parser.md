# Plan: Remove YAML Regex Parsers

## Problem Statement

Two functions in `packages/lib/src/admin/` hand-parse Docker Compose YAML using fragile line-based regex. Both assume exactly 2-space indentation, no comments inline with service names, and no multi-line values. The correct approach -- calling `docker compose config --services` -- is already implemented and already used exclusively by all active code paths.

Both functions are dead code with zero callers.

## Functions to Remove

### Function A: `parseServiceNamesFromComposeFile()`
- **File**: `packages/lib/src/admin/compose-runner.ts`
- **Lines**: 74-91
- **Visibility**: Private (not exported)
- **Callers**: **None**. Completely dead code.
- **Replacement**: `composeConfigServices()` at lines 93-98 already exists and is the sole mechanism used by `allowedServiceSet()` via `composeConfigServicesWithOverride()`.

### Function B: `computeServiceConfigHashes()`
- **File**: `packages/lib/src/admin/impact-plan.ts`
- **Lines**: 25-42
- **Visibility**: Exported but never imported anywhere
- **Callers**: **None**. No file in the codebase imports or calls this function.
- **Uses the identical fragile regex**: `/^\s{2}([a-zA-Z0-9_-]+):\s*$/`

## Callers and Dependents Analysis

| Function | Exported? | Callers | Action |
|---|---|---|---|
| `parseServiceNamesFromComposeFile` | No | 0 | Delete lines 74-91 |
| `computeServiceConfigHashes` | Yes | 0 | Delete lines 25-42 |

**Functions that remain untouched** (already correct):
- `composeConfigServices()` (compose-runner.ts:93-98) -- calls `docker compose config --services`
- `composeConfigServicesWithOverride()` (compose-runner.ts:107-110) -- override-aware wrapper
- `allowedServiceSet()` (compose-runner.ts:112-116) -- already uses `composeConfigServicesWithOverride()`
- `deriveImpact()` (stack-apply-engine.ts:153-213) -- already uses `composeConfigServicesWithOverride()`

## Edge Cases: Docker Unavailability

The regex parser could theoretically work without Docker running. However:
- `parseServiceNamesFromComposeFile` has zero callers, so this is moot.
- `allowedServiceSet()` already handles Docker unavailability through the override mechanism. All test files already use this pattern.
- The admin UI calls this at runtime when Docker is expected to be running.

## Test Changes

**No test changes are needed.**

- `compose-runner.test.ts`: Does not reference `parseServiceNamesFromComposeFile`. All 6 tests exercise other functions that remain unchanged.
- `impact-plan.test.ts`: Does not import or test `computeServiceConfigHashes`. Tests only `computeImpactFromChanges`.
- `stack-apply-engine.test.ts`: Uses `setComposeConfigServicesOverride()` to mock service lists. No regex parsing involved.

## Imports to Clean Up

**`compose-runner.ts`**: `existsSync` and `readFileSync` imports at line 1 are still used by `computeDriftReport()` and `acquireApplyLock()`. No import cleanup needed.

**`impact-plan.ts`**: No import cleanup needed.

---

## Step-by-Step Implementation Order

### Step 1: Delete `parseServiceNamesFromComposeFile`

From `packages/lib/src/admin/compose-runner.ts`, delete lines 74-91. Private function with no callers.

### Step 2: Delete `computeServiceConfigHashes`

From `packages/lib/src/admin/impact-plan.ts`, delete lines 25-42. Exported function with no callers.

### Step 3: Run type checker

```bash
bun run typecheck
```

### Step 4: Run full test suite

```bash
bun test
```

Expected: all 534 tests pass, 10 skip (unchanged).

### Step 5: Verify build

```bash
cd packages/ui && bun run build
```

## Risk Assessment

**Risk: None.** Both functions are dead code. The removal is strictly a deletion with no behavioral change. The existing `composeConfigServices` pipeline is battle-tested and covered by unit tests.

## Net Impact

- **Lines removed**: ~36 (18 + 18)
- **Functions removed**: 2
- **Tests changed**: 0
- **Behavior change**: None
