# Plan: Simplify SetupManager Sanitization

## Current State Analysis

**File**: `packages/lib/src/admin/setup-manager.ts` (232 lines)

The file currently contains 7 internal functions dedicated to reading and normalizing the state file:

| Function | Lines | Purpose |
|---|---|---|
| `sanitizeStringArray` | 67-70 | Filters non-string items from arrays |
| `uniqueStrings` | 72-74 | Deduplicates string arrays |
| `sanitizeServiceInstances` | 76-83 | Per-field string type check on `{openmemory, psql, qdrant}` |
| `sanitizeSmallModel` | 85-91 | Per-field string type check on `{endpoint, modelId}` |
| `sanitizeSteps` | 93-105 | Per-field `=== true` check on 8 boolean step flags |
| `sanitizeProfile` | 107-113 | Per-field string type check on `{name, email}` |
| `normalizeState` | 115-129 | Orchestrator that calls all 6 above |

The `DEFAULT_STATE` constant (lines 37-65) already defines the correct shape. The `getState()` method (lines 139-147) already has a try/catch that returns a spread of `DEFAULT_STATE` on parse failure. The problem is that the "happy path" still runs every value through the 6 sanitization functions field by field -- 60+ lines of per-field type guards for data the tool itself writes.

## Design: Simplified Read Logic

Replace the per-field sanitization cascade with a **structural validation** approach: parse the JSON, verify a few key structural invariants (top-level shape), and if anything is wrong, return `DEFAULT_STATE`.

```typescript
getState(): SetupState {
  if (!existsSync(this.path)) return structuredClone(DEFAULT_STATE);
  try {
    const parsed = JSON.parse(readFileSync(this.path, "utf8"));
    if (!isValidSetupState(parsed)) return structuredClone(DEFAULT_STATE);
    return parsed as SetupState;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
```

The `isValidSetupState` function performs a single structural check:

```typescript
function isValidSetupState(value: unknown): value is SetupState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.completed === "boolean" &&
    typeof v.accessScope === "string" &&
    ["host", "lan", "public"].includes(v.accessScope as string) &&
    typeof v.serviceInstances === "object" && v.serviceInstances !== null &&
    typeof v.smallModel === "object" && v.smallModel !== null &&
    typeof v.profile === "object" && v.profile !== null &&
    typeof v.steps === "object" && v.steps !== null &&
    Array.isArray(v.enabledChannels) &&
    Array.isArray(v.installedExtensions)
  );
}
```

This is ~12 lines replacing 6 functions + 1 orchestrator (~65 lines).

## Functions to Remove

1. **`sanitizeStringArray`** (lines 67-70) -- removed entirely
2. **`uniqueStrings`** (lines 72-74) -- removed as standalone function; inline in `setEnabledChannels`: `state.enabledChannels = [...new Set(channels)]`
3. **`sanitizeServiceInstances`** (lines 76-83) -- removed entirely
4. **`sanitizeSmallModel`** (lines 85-91) -- removed entirely
5. **`sanitizeSteps`** (lines 93-105) -- removed entirely
6. **`sanitizeProfile`** (lines 107-113) -- removed entirely
7. **`normalizeState`** (lines 115-129) -- removed entirely, replaced by `isValidSetupState`

## What DEFAULT_STATE Should Look Like

The existing `DEFAULT_STATE` (lines 37-65) is already correct and does not need to change. The only change is how it is returned: use `structuredClone(DEFAULT_STATE)` for deep copies instead of manual spreading.

## Every Consumer of SetupManager

### Direct import (library-level)

| File | Methods Used |
|---|---|
| `packages/lib/src/admin/setup-manager.test.ts` | `new SetupManager()`, `.getState()`, `.completeStep()`, `.setAccessScope()`, `.setServiceInstances()`, `.completeSetup()`, `.isFirstBoot()`, `.setProfile()` |

### Lazy singleton via `getSetupManager()` (SvelteKit routes)

| File | Methods Used |
|---|---|
| `packages/ui/src/lib/server/init.ts` | `new SetupManager(DATA_DIR)` -- singleton factory |
| `packages/ui/src/routes/setup/status/+server.ts` | `.getState()`, `.isFirstBoot()` |
| `packages/ui/src/routes/setup/step/+server.ts` | `.getState()`, `.completeStep()` |
| `packages/ui/src/routes/setup/access-scope/+server.ts` | `.getState()`, `.setAccessScope()` |
| `packages/ui/src/routes/setup/complete/+server.ts` | `.getState()`, `.completeSetup()` |
| `packages/ui/src/routes/setup/service-instances/+server.ts` | `.getState()`, `.setServiceInstances()`, `.setSmallModel()` |
| `packages/ui/src/routes/setup/health-check/+server.ts` | `.getState()` |
| `packages/ui/src/routes/setup/channels/+server.ts` | `.getState()`, `.setEnabledChannels()` |
| `packages/ui/src/routes/command/+server.ts` | `.getState()`, `.completeStep()`, `.setAccessScope()`, `.setProfile()`, `.setServiceInstances()`, `.setSmallModel()`, `.setEnabledChannels()`, `.completeSetup()` |
| `packages/ui/src/routes/state/+server.ts` | `.getState()` |

### Contract tests (HTTP-level)

| File | Interaction |
|---|---|
| `test/contracts/setup-wizard-gate.contract.test.ts` | Writes `setup-state.json` directly to disk. Does NOT import SetupManager. |

**Impact assessment**: None of the consumers call the sanitization functions directly. They all go through the `SetupManager` public API. The refactor is entirely internal to the `getState()` read path. The public API, `SetupState` type, and `SmallModelConfig` type all remain unchanged.

## Test Changes Needed

**File**: `packages/lib/src/admin/setup-manager.test.ts`

### Tests that pass as-is (no changes needed)

All test groups exercising the public API continue to pass without modification:
- `SetupManager.getState` -- "returns default state when no state file exists" (line 19)
- `SetupManager.completeStep` -- both tests (lines 44-70)
- `SetupManager.setAccessScope` -- all three scope tests (lines 73-97)
- `SetupManager.setServiceInstances` -- both tests (lines 138-167)
- `SetupManager.completeSetup` -- both tests (lines 169-193)
- `SetupManager.isFirstBoot` -- both tests (lines 195-210)
- `SetupManager.setProfile` -- one test (lines 213-224)

### Tests that need adjustment

The `"normalizeState via getState"` describe block (lines 99-136):

1. **"preserves 'public' scope when read back from disk"** (line 100) -- Still passes. Written file has valid structure.
2. **"defaults an invalid scope value to 'host'"** (line 110) -- Still passes. `isValidSetupState` rejects invalid `accessScope`, returns `DEFAULT_STATE` with `accessScope: "host"`.
3. **"defaults a missing scope to 'host'"** (line 124) -- Still passes. Missing required fields → rejected → defaults returned.

### New tests to add

```typescript
describe("SetupManager.getState (corrupt file handling)", () => {
  it("returns default state when file contains invalid JSON", () => {
    // Write garbage to file, verify defaults returned
  });

  it("returns default state when file has wrong structure", () => {
    // Write { completed: "yes" }, verify defaults returned
  });
});
```

### Rename existing describe block

Rename `"normalizeState via getState (regression: scope handling)"` to `"getState validation (regression: scope handling)"`.

### Contract test fix

`test/contracts/setup-wizard-gate.contract.test.ts` (lines 75-88) writes a state file missing the `profile` field. Add `profile: { name: "", email: "" }` to the written state.

---

## Step-by-Step Implementation Order

### Step 1: Add `isValidSetupState` function

In `packages/lib/src/admin/setup-manager.ts`, add the new validation function after `DEFAULT_STATE` (after line 65). ~12 lines.

### Step 2: Rewrite `getState()` method

Replace lines 139-147 with the simplified version using `structuredClone(DEFAULT_STATE)` and `isValidSetupState`. ~8 lines replacing ~9 lines.

### Step 3: Delete the 6 sanitization functions and `normalizeState`

Remove lines 67-129 entirely. Deletes ~63 lines.

### Step 4: Inline `uniqueStrings` in `setEnabledChannels`

Replace line 215 (`state.enabledChannels = uniqueStrings(channels)`) with `state.enabledChannels = [...new Set(channels)]`.

### Step 5: Update tests

- Rename the `"normalizeState via getState"` describe block (line 99)
- Add the two new corrupt-file tests
- Fix contract test to include `profile` field

### Step 6: Run tests and verify

```bash
bun test packages/lib/src/admin/setup-manager.test.ts
bun run typecheck
bun test
```

## Net Line Count Change

| Category | Before | After | Delta |
|---|---|---|---|
| Sanitization functions (6) | 47 lines | 0 lines | -47 |
| `normalizeState` orchestrator | 15 lines | 0 lines | -15 |
| `isValidSetupState` (new) | 0 lines | 12 lines | +12 |
| `getState()` body | 9 lines | 6 lines | -3 |
| **Total** | | | **-53 lines** |

File shrinks from 232 to ~179 lines, with clearer intent: "if the file is valid, use it; otherwise start fresh."

## Risks and Mitigations

**Risk**: A partially-valid file (user completed 5/8 wizard steps, then one field corrupted) resets to defaults, losing wizard progress.

**Mitigation**: Acceptable. The wizard takes 2-3 minutes to redo. Silently "fixing" corrupted data per-field can produce inconsistent state. A clean reset is more predictable.
