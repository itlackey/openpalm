# Plan: Simplify Drift Detection to Container Status

## Summary of Findings

The drift detection system spans 7 files and involves:

1. **`computeDriftReport()`** in `packages/lib/src/admin/compose-runner.ts` (lines 150-203) -- the core function that performs SHA-256 artifact hashing, env-file existence checks, container status comparison, and JSON persistence of a drift report file
2. **`StackManager.computeDriftReport()`** in `packages/lib/src/admin/stack-manager.ts` (lines 138-164) -- builds the arguments object including calling `renderPreview()` (which re-generates all stack artifacts) just to hash them for comparison
3. **Three callers** of the drift computation:
   - `packages/ui/src/routes/stack/drift/+server.ts` (the API endpoint)
   - `packages/ui/src/routes/command/+server.ts` (the `service.drift` command, line 597-601)
   - `packages/lib/src/admin/stack-apply-engine.ts` (pre-apply warning, lines 234-239)
4. **One UI consumer**: `packages/ui/src/lib/components/DriftBanner.svelte`
5. **`persistDriftReport()`** writes `drift-report.json` to disk, but **nothing ever reads it** -- it is write-only

## What to Keep

The genuinely useful information for a non-technical user is: "which containers are running, stopped, or unhealthy?" This is already implemented as the `composePs()` function (lines 211-226 of `compose-runner.ts`) which wraps `docker compose ps --format json` and returns `ServiceHealthState[]` with `name`, `status`, and `health` fields. There is also `composeList()` (line 134-136) which returns the raw JSON.

The `composePs()` function and its `ServiceHealthState` type are the correct primitives to keep.

## What to Remove

| Item | File | Lines | Reason |
|------|------|-------|--------|
| `DriftReport` type | `compose-runner.ts` | 150-155 | Replaced by `ServiceHealthState[]` |
| `computeDriftReport()` | `compose-runner.ts` | 157-196 | Core of the over-engineering: SHA-256 hashing, env-file checks, expected-vs-running comparison |
| `persistDriftReport()` | `compose-runner.ts` | 198-203 | Writes a file nothing reads |
| `ComposeRunnerArtifactOverrides` type | `compose-runner.ts` | 318-322 | Only exists to support drift's artifact hashing in tests |
| `composeArtifactOverrides` variable | `compose-runner.ts` | 324 | Only used by `computeDriftReport` and `persistDriftReport` |
| `setComposeRunnerArtifactOverrides()` | `compose-runner.ts` | 326-328 | Only used in tests for drift |
| `StackManager.computeDriftReport()` | `stack-manager.ts` | 138-164 | Calls `renderPreview()` expensively just to build drift args; no longer needed |
| Drift import + call in `stack-apply-engine.ts` | `stack-apply-engine.ts` | 12, 235-239 | Pre-apply drift warning is redundant; apply itself will fix all drift |

## Simplified Container Status Function

The replacement is simply `composePs()` which already exists at lines 211-226 of `compose-runner.ts`. No new function is needed:

```typescript
// Already exists at compose-runner.ts:205-226
export type ServiceHealthState = {
  name: string;
  status: string;       // "running", "exited", "restarting", etc.
  health?: string | null; // "healthy", "unhealthy", "starting", null
};

export async function composePs(): Promise<{
  ok: boolean;
  services: ServiceHealthState[];
  stderr: string;
}>;
```

## How the Drift API Endpoint Should Change

**`/stack/drift` endpoint** (`packages/ui/src/routes/stack/drift/+server.ts`): Replace the `computeDriftReport` call with `composePs()` (or `composePsWithOverride()`). The response shape changes from `{ ok, drift: DriftReport }` to `{ ok, services: ServiceHealthState[] }`.

New endpoint implementation:

```typescript
import { composePsWithOverride } from "@openpalm/lib/admin/compose-runner";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const result = await composePsWithOverride();
  if (!result.ok) return json(500, { ok: false, error: result.stderr });
  return json(200, { ok: true, services: result.services });
};
```

## UI Component Changes

**`DriftBanner.svelte`** (`packages/ui/src/lib/components/DriftBanner.svelte`):

Current behavior: Fetches `/stack/drift`, checks for `missingServices`, `exitedServices`, `missingEnvFiles`, and `staleArtifacts`. Shows a generic "Compose drift detected" message with a "Reconcile" button.

New behavior: Fetch endpoint, receive `ServiceHealthState[]`, check if any service has `status !== "running"` or `health === "unhealthy"`. Show a more helpful message like "2 containers are stopped: gateway, openmemory" with the same "Reconcile" button.

Replace the `DriftReport` local type definition (lines 4-9) with `ServiceHealthState`, and simplify the `hasDrift()` function (lines 21-24):

```typescript
type ServiceHealth = { name: string; status: string; health?: string | null };

let services: ServiceHealth[] = [];

function hasIssues(svcs: ServiceHealth[]): boolean {
  return svcs.some(s => s.status !== "running" || s.health === "unhealthy");
}

function problemServices(svcs: ServiceHealth[]): ServiceHealth[] {
  return svcs.filter(s => s.status !== "running" || s.health === "unhealthy");
}
```

## Command Router Changes

**`/command/+server.ts`** (line 597-601): The `service.drift` command currently calls `computeDriftReport(manager.computeDriftReport())`. Change to call `composePsWithOverride()` and return the service list. Consider whether `service.drift` should be **removed entirely** and consumers directed to use `service.status` instead. Recommend keeping it but having it return `{ services: ServiceHealthState[] }`.

Remove the import of `computeDriftReport` on line 37.

## Stack Apply Engine Changes

**`stack-apply-engine.ts`** (lines 12, 234-239): Remove the `computeDriftReport` import (line 12) and the drift check block (lines 234-239). The drift warning ("drift_detected_before_apply") is meaningless -- the entire purpose of `applyStack` is to fix drift.

---

## Test Changes

### `stack-apply-engine.test.ts`

1. Remove `setComposeRunnerArtifactOverrides` from import (line 10) and all call sites where it is set up.
2. The tests themselves do not assert on drift report content; they set up the overrides as test infrastructure so that `computeDriftReport` does not fail during `applyStack`. Once the drift call is removed, these overrides are no longer needed.
3. Remove `driftReportPath: join(dir, "drift-report.json")` from every `setComposeRunnerArtifactOverrides` call at lines 232-236, 284-288, 325-329, 364-368, 410-414.

Since `ComposeRunnerArtifactOverrides` fields (`composeFilePath`, `caddyJsonPath`) are only used inside `computeDriftReport()` and `persistDriftReport()`, the entire type and all its usages can be removed.

---

## Step-by-Step Implementation Order

### Step 1: Remove drift from `stack-apply-engine.ts` (lowest risk, highest impact)
- Remove `computeDriftReport` from the import on line 12
- Remove lines 235-239 (the drift check and warning)
- This eliminates the expensive `renderPreview()` call on every apply

### Step 2: Simplify the `/stack/drift` API endpoint
- In `packages/ui/src/routes/stack/drift/+server.ts`:
  - Replace `computeDriftReport` import with `composePsWithOverride` import
  - Remove `getStackManager` import (no longer needed)
  - Return `{ ok: true, services: result.services }` from `composePsWithOverride()`

### Step 3: Simplify `service.drift` in the command router
- In `packages/ui/src/routes/command/+server.ts`:
  - Remove `computeDriftReport` from the import on line 37
  - At line 597-601, replace the handler to call `composePsWithOverride()`

### Step 4: Update `DriftBanner.svelte`
- Change the `DriftReport` type to `ServiceHealth` array
- Update the fetch to parse `services` from the new response shape
- Update `hasDrift()` to check for non-running/unhealthy services
- Improve the banner message to list which containers are affected

### Step 5: Remove drift functions from `compose-runner.ts`
- Delete `DriftReport` type (lines 150-155)
- Delete `computeDriftReport()` function (lines 157-196)
- Delete `persistDriftReport()` function (lines 198-203)
- Delete `ComposeRunnerArtifactOverrides` type (lines 318-322)
- Delete `composeArtifactOverrides` variable (line 324)
- Delete `setComposeRunnerArtifactOverrides()` function (lines 326-328)
- Remove `createHash` import from line 2 (if no longer used)

### Step 6: Remove `computeDriftReport()` from `stack-manager.ts`
- Delete the method at lines 138-164

### Step 7: Clean up tests in `stack-apply-engine.test.ts`
- Remove `setComposeRunnerArtifactOverrides` from import on line 10
- Remove all `setComposeRunnerArtifactOverrides({ ... })` setup calls (5 instances)
- Remove all `setComposeRunnerArtifactOverrides({})` cleanup calls (5 instances)

### Step 8: Run the full test suite
```bash
bun run typecheck
bun test
```

## Net Impact

- **Lines removed**: ~80 lines of library code, ~30 lines of test infrastructure
- **Complexity removed**: SHA-256 hashing, env-file existence checks, JSON file persistence, one full `renderPreview()` call on every apply
- **Performance gain**: `renderPreview()` re-generates all compose/caddy/env artifacts from the spec. Eliminating this from the apply path removes redundant work
- **User experience**: Improved -- the banner shows which specific containers are down instead of a generic "drift detected" message
