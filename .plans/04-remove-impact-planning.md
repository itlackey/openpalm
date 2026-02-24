# Plan: Remove Impact Planning System

## Overview of What Exists

The impact planning system consists of two modules working together:

**`packages/lib/src/admin/impact-plan.ts`** (64 lines) exports:
- `StackImpact` type (lines 1-7) -- `{ reload: string[]; restart: string[]; up: string[]; down: string[]; fullStack?: boolean }`
- `createEmptyImpact()` (lines 9-11)
- `unique()` (lines 13-15, private)
- `diffServiceSets()` (lines 17-23)
- `computeServiceConfigHashes()` (lines 25-42) -- dead code, never called anywhere
- `computeImpactFromChanges()` (lines 44-64)

**`packages/lib/src/admin/stack-apply-engine.ts`** contains:
- `deriveImpact()` (lines 153-213) -- reads existing vs generated artifacts, string-diffs every env file, computes which services to reload/restart/up/down
- `readExistingArtifacts()` (lines 50-75) -- reads all on-disk artifacts for comparison
- `ExistingArtifacts` type (lines 32-43)
- `readIfExists()` (lines 45-48)
- `restoreArtifacts()` (lines 82-101) -- used by rollback, writes back old artifacts
- The `applyStack()` function (lines 215-350) orchestrates: deriveImpact, then iterates impact.up/restart/reload/down calling per-service compose commands
- `StackApplyResult` type (lines 22-28) includes `impact: StackImpact`

**The core issue**: Docker Compose's `docker compose up -d` already compares running container state against the compose file and only recreates changed services. The existing code already calls `runCompose(["up", "-d", "--remove-orphans"])` when services is an empty array. The entire impact planning system reimplements what Docker Compose does natively.

## What to Remove

**Delete entirely:**
- `packages/lib/src/admin/impact-plan.ts` (all 64 lines)
- `packages/lib/src/admin/impact-plan.test.ts` (all 21 lines)

**Remove from `stack-apply-engine.ts`:**
- Import of `computeImpactFromChanges`, `diffServiceSets`, `type StackImpact` from `./impact-plan.ts` (line 15)
- Import of `composeConfigServicesWithOverride` from `./compose-runner.ts` (line 7) -- only used by `deriveImpact`
- `ExistingArtifacts` type (lines 32-43)
- `readIfExists()` helper (lines 45-48)
- `readExistingArtifacts()` function (lines 50-75)
- `enabledChannelServices()` helper (lines 149-151)
- `deriveImpact()` function (lines 153-213)
- `restoreArtifacts()` function (lines 82-101) -- used only by the rollback path
- The `StackImpact` field from `StackApplyResult` type (line 25)
- The `serviceCache` variable (line 231) and the call to `deriveImpact` (line 232)
- The `pullServices: impact.up` argument to preflight (line 245)
- The per-service iteration loop (lines 264-317) -- replace with single `docker compose up -d --remove-orphans` plus Caddy reload

## The Caddy Reload Special Case

Caddy uses a hot-reload mechanism rather than container restart. This is the one piece the impact system does that Docker Compose cannot handle natively. The replacement is approximately 10 lines:

```typescript
// Detect if caddy config changed by comparing existing file to generated
const caddyJsonPath = manager.getPaths().caddyJsonPath;
const existingCaddyJson = existsSync(caddyJsonPath)
  ? readFileSync(caddyJsonPath, "utf8")
  : "";
const caddyChanged = existingCaddyJson !== generated.caddyJson;

// After staging + promoting artifacts and running `docker compose up -d --remove-orphans`:
if (caddyChanged) {
  const result = await composeExecWithOverride(
    "caddy",
    ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]
  );
  if (!result.ok) throw new Error(`caddy_reload_failed:${result.stderr}`);
}
```

This replaces: (a) reading all existing artifacts, (b) computing impact for every env file, (c) running `docker compose config --services` on old and new compose files, (d) classifying changes by type, (e) iterating reload/restart/up/down separately.

## Every File That Imports From impact-plan.ts or Uses Impact Types

### Direct import from `impact-plan.ts`:

| File | Line | What it imports |
|------|------|----------------|
| `packages/lib/src/admin/stack-apply-engine.ts` | 15 | `computeImpactFromChanges`, `diffServiceSets`, `type StackImpact` |
| `packages/lib/src/admin/impact-plan.test.ts` | 2 | `computeImpactFromChanges` |

### Files that consume `StackImpact` through `StackApplyResult`:

| File | Lines | How it uses impact |
|------|-------|-------------------|
| `packages/ui/src/routes/stack/apply/+server.ts` | 11-13 | Returns full result including `impact` as JSON |
| `packages/ui/src/routes/command/+server.ts` | 136-137 | `stack.apply` command returns `result` |
| `packages/ui/src/routes/command/+server.ts` | 292 | `setup.complete` command stores `applyResult` |
| `packages/ui/src/routes/setup/complete/+server.ts` | 26, 32 | Returns `apply: applyResult` |
| `packages/ui/src/lib/components/StackEditor.svelte` | 52-57 | Renders `impact.restart`, `impact.reload`, `impact.up` in status message |

### Documentation files referencing impact-plan:

| File | Notes |
|------|-------|
| `packages/lib/docs/specification.md` | Section 7 (Impact Engine), lines 59-62, 839-884, 955 |
| `packages/lib/README.md` | Line 45 mentions `impact-plan.ts` |

## Test Files That Need Updating

### Delete entirely:
- `packages/lib/src/admin/impact-plan.test.ts` -- Tests `computeImpactFromChanges` which is being removed.

### Rewrite substantially:
- `packages/lib/src/admin/stack-apply-engine.test.ts` -- All 7 tests in "applyStack impact detection" describe block (lines 67-213) assert against `result.impact.*`. These need rewriting:
  - "detects no impact when artifacts are unchanged" -> "succeeds with no warnings on unchanged artifacts" (verify `result.ok === true`, `result.caddyReloaded === false`)
  - "detects caddy reload when caddyJson changes" -> "triggers caddy reload when caddy config changes" (verify `result.caddyReloaded === true`)
  - Remove tests that assert per-service restart behavior for system env, gateway env, compose changes -- Docker Compose handles these natively
  - Keep "throws when secrets reference is missing" test (line 176) unchanged
  - Keep "caddy reload path references caddy.json not Caddyfile" test but update assertions

## UI Code That Displays Impact Plan Results

**`packages/ui/src/lib/components/StackEditor.svelte`** (lines 50-57):
```svelte
const impact = r.data?.impact || {};
const parts: string[] = [];
if (impact.restart?.length) parts.push('Restarted: ' + impact.restart.join(', '));
if (impact.reload?.length) parts.push('Reloaded: ' + impact.reload.join(', '));
if (impact.up?.length) parts.push('Started: ' + impact.up.join(', '));
statusMsg = parts.length ? parts.join('. ') : 'Applied (no changes detected).';
```

Replace with simplified status display:
```svelte
let msg = 'Stack applied successfully.';
if (r.data?.caddyReloaded) msg += ' Caddy config reloaded.';
if (r.data?.warnings?.length) msg += ' Warnings: ' + r.data.warnings.join(', ');
statusMsg = msg;
```

---

## Step-by-Step Implementation Order

### Step 1: Update `StackApplyResult` type and simplify `applyStack()`

In `packages/lib/src/admin/stack-apply-engine.ts`:

1. Remove import of impact-plan types (line 15)
2. Remove `composeConfigServicesWithOverride` from compose-runner import (line 7)
3. Change `StackApplyResult`: replace `impact: StackImpact` with `caddyReloaded: boolean`
4. Remove `ExistingArtifacts`, `readIfExists()`, `readExistingArtifacts()`, `restoreArtifacts()`, `enabledChannelServices()`, `deriveImpact()`
5. In `applyStack()`:
   - Before writing artifacts, read only existing `caddyJson` to detect changes
   - Remove `serviceCache` and `deriveImpact` call
   - Replace per-service iteration loop with single `docker compose up -d --remove-orphans` + Caddy reload
   - Update return to `{ ok: true, generated, caddyReloaded, warnings }`

### Step 2: Delete `impact-plan.ts` and its test

- Delete `packages/lib/src/admin/impact-plan.ts`
- Delete `packages/lib/src/admin/impact-plan.test.ts`

### Step 3: Rewrite `stack-apply-engine.test.ts`

- Remove `setComposeConfigServicesOverride` from import (line 10)
- Rewrite "applyStack impact detection" tests to verify simplified behavior
- Update "applyStack rollout modes" and "failure injection" tests for single compose up

### Step 4: Update UI component

In `packages/ui/src/lib/components/StackEditor.svelte`:
- Replace impact display (lines 51-57) with simplified status message

### Step 5: Update API routes (if needed)

The three API routes are passthrough and don't destructure the impact field. The type change propagates naturally. No changes needed.

### Step 6: Update documentation

- `packages/lib/docs/specification.md`: Rewrite Section 7 (Impact Engine, lines 839-884)
- `packages/lib/README.md`: Remove `impact-plan.ts` from file listing (line 45)

### Step 7: Run tests and verify

```bash
bun run typecheck
bun test packages/lib/src/admin/stack-apply-engine.test.ts
bun test
```

## Risk Assessment

**Low risk:** UI changes are cosmetic, API routes are passthrough, `computeServiceConfigHashes` is dead code.

**Medium risk:** The rollback path depends on `existing` artifacts captured before apply. Simplifying requires verifying `.prev` file restore works independently. Safe rollout mode needs rethinking with single `docker compose up -d` instead of per-service iteration.

## Net Impact

- **Files deleted**: 2 (`impact-plan.ts`, `impact-plan.test.ts`)
- **Lines removed**: ~250 (64 impact-plan + 60 deriveImpact + 75 readExistingArtifacts + 50 per-service loop)
- **Lines added**: ~15 (Caddy change detection + reload)
- **Tests rewritten**: 7+ impact detection tests simplified
