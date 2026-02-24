# Plan: Slim the StackManager God Class (Finding 09)

## Current State Analysis

The `StackManager` class at `packages/lib/src/admin/stack-manager.ts` (510 lines) is a god class handling seven distinct responsibility groups:

**Group A -- Spec CRUD (core, keep):**
- `getSpec()` (line 74-76)
- `setSpec()` (lines 78-83)
- `writeStackSpecAtomically()` (lines 475-479) -- private

**Group B -- Channel CRUD (core, keep):**
- `getChannelAccess()` (lines 85-89)
- `getChannelConfig()` (lines 91-95)
- `setChannelAccess()` (lines 97-104)
- `setChannelConfig()` (lines 106-125)
- `setAccessScope()` (lines 127-132)
- `listChannelNames()` (lines 444-446)
- `enabledChannelServiceNames()` (lines 449-454)
- `listServiceNames()` (lines 458-459)
- `enabledServiceNames()` (lines 462-467)

**Group C -- Automation CRUD (core, keep):**
- `listAutomations()` (lines 396-398)
- `getAutomation()` (lines 400-404)
- `upsertAutomation()` (lines 406-429)
- `deleteAutomation()` (lines 431-441)

**Group D -- Secret Management (core, keep -- see rationale):**
- `upsertSecret()` (lines 377-384)
- `deleteSecret()` (lines 386-394)
- `listSecretManagerState()` (lines 323-375)
- `validateReferencedSecrets()` (lines 300-321)
- `readSecretsEnv()` (lines 482-491) -- private
- `updateSecretsEnv()` (lines 493-497) -- private
- `isValidSecretName()` (lines 499-501) -- private

**Group E -- Artifact Rendering (core, keep):**
- `renderPreview()` (line 134-136)
- `renderArtifacts()` (lines 166-218)
- `writeArtifact()` (lines 469-473) -- private

**Group F -- Artifact Staging with temp/promote/rollback (remove per Plan 02/03):**
- `renderArtifactsToTemp()` (lines 220-298)
- `buildFallbackCompose()` (lines 507-509) -- private
- `buildFallbackCaddyJson()` (lines 504-506) -- private

**Group G -- Drift Detection (remove per Plan 05):**
- `computeDriftReport()` (lines 138-164)

## What the Review Recommends

The review (Finding 09) says: "After removing the over-engineering identified in Findings 2-5, StackManager naturally shrinks to: spec CRUD + artifact rendering + secrets read/write. That is a reasonable scope for one class."

This is the key insight. Finding 09 is largely a **consequence** of implementing Findings 02, 03, 04, 05, and 10.

## Responsibility Disposition

| Group | Responsibility | Lines | Action | Dependency |
|-------|---------------|-------|--------|------------|
| A | Spec CRUD | ~20 | **Keep in StackManager** | None |
| B | Channel/Service CRUD | ~60 | **Keep in StackManager** | None |
| C | Automation CRUD | ~50 | **Keep in StackManager** | None |
| D | Secret Management | ~80 | **Keep in StackManager** (see rationale) | Plan 10 simplifies `listSecretManagerState()` |
| E | Artifact Rendering | ~60 | **Keep in StackManager** | None |
| F | Artifact Staging | ~85 | **Remove** from StackManager | Plan 02, Plan 03 |
| G | Drift Detection | ~30 | **Remove** from StackManager | Plan 05 |
| - | Fallback bundle seeding | ~25 | **Remove** from StackManager | Plan 03 |
| - | `StackManagerPaths` fields for fallback | ~5 | **Remove** | Plan 03 |

## Rationale: Keep Secrets in StackManager

Extracting secrets into a separate class was considered, but secrets are deeply intertwined with the stack spec:
1. `upsertSecret()` calls `this.renderArtifacts()` (line 383)
2. `deleteSecret()` calls `this.listSecretManagerState()` which calls `this.getSpec()` (lines 390-391)
3. `validateReferencedSecrets()` reads both the spec and secrets to cross-reference
4. `renderPreview()` calls `this.readSecretsEnv()` to pass secrets to the generator

Extracting secrets would require either passing a StackManager reference into the secret manager (circular dependency) or duplicating spec-reading logic. The coupling is intrinsic to the domain: secrets are resolved into channel/service configs. Keeping them together in one class is the simpler design.

## Net Effect on StackManager After All Plans Execute

| Before | After |
|--------|-------|
| 510 lines | ~310 lines |
| 7 responsibility groups | 5 responsibility groups (A-E) |
| 20 public methods + 7 private methods | 16 public methods + 4 private methods |
| 31-line `StackManagerPaths` type | 26-line `StackManagerPaths` type (5 fields removed) |

The class drops to a focused "spec CRUD + artifact rendering + secrets" scope.

## Dependency Graph Between Plans

```
Plan 03 (remove three-tier recovery) ───┐
Plan 04 (remove impact planning) ───────┤
Plan 05 (simplify drift detection) ─────┼──> Plan 09 (slim StackManager)
Plan 10 (simplify secret state) ────────┘
Plan 02 (simplify apply engine) ────────┘
```

**Implementation order**: Plans 03, 05, 10 can be done in any order. Plan 04 can be done independently. Plan 02 depends on 03 and 04. **Plan 09 should be executed last** as a final cleanup pass.

---

## Step-by-Step Implementation

### Step 1: Remove `computeDriftReport()` (after Plan 05)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines**: 138-164

Delete the entire method.

**Consumers to update** (handled by Plan 05):
- `packages/ui/src/routes/stack/drift/+server.ts` (line 9) -- switches to `composePs()`
- `packages/ui/src/routes/command/+server.ts` (lines 597-601) -- switches to `composePs()`
- `packages/lib/src/admin/stack-apply-engine.ts` (lines 234-239) -- removed entirely

### Step 2: Remove fallback bundle seeding from `renderArtifacts()` (after Plan 03)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines to remove**: 192-212

This block seeds `docker-compose-fallback.yml` and `caddy-fallback.json` on disk.

Also remove:
- `import { validateFallbackBundle } from "./fallback-bundle.ts"` (line 6)
- `buildFallbackCompose()` private method (lines 507-509)
- `buildFallbackCaddyJson()` private method (lines 504-506)
- `resolveEmbeddedStatePath()` helper function (lines 52-65) -- only used by fallback seeding

### Step 3: Remove `renderArtifactsToTemp()` entirely (after Plan 02/03)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines to remove**: 220-298

Only called by `applyStack()` in `stack-apply-engine.ts`. After Plan 02 simplifies `applyStack()`, this is no longer needed.

**Consumer update** (handled by Plan 02):
- `stack-apply-engine.ts` changes from `manager.renderArtifactsToTemp(generated)` to `manager.renderArtifacts(generated)`

### Step 4: Remove fallback path fields from `StackManagerPaths` (after Plan 03)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines to remove from type**: 28-30 (`fallbackComposeFilePath`, `fallbackCaddyJsonPath`, `applyLockPath`)

**Consumers to update:**
- `packages/ui/src/lib/server/init.ts` lines 57-60 -- remove fallback path assignments
- `packages/lib/src/admin/stack-apply-engine.test.ts` lines 62-63 -- remove from test helper

### Step 5: Simplify `listSecretManagerState()` (Plan 10)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines to change**: 363-373

Remove `purpose`, `constraints`, and `rotation` fields. This is a 5-line change detailed in Plan 10.

## Complete File-Level Change Map

| File | Changes | Plan(s) |
|------|---------|---------|
| `packages/lib/src/admin/stack-manager.ts` | Remove `computeDriftReport()`, fallback seeding, `renderArtifactsToTemp()`, fallback methods, `resolveEmbeddedStatePath()`, simplify `listSecretManagerState()`, remove fallback fields from `StackManagerPaths` | 09 + 03 + 05 + 10 |
| `packages/lib/src/admin/stack-manager.test.ts` | Remove fallback file assertions (lines 49-50) | 09 + 03 |
| `packages/lib/src/admin/stack-apply-engine.ts` | Replace `renderArtifactsToTemp()` with `renderArtifacts()`, remove drift/impact/recovery/fallback | 02 + 03 + 04 + 05 |
| `packages/ui/src/lib/server/init.ts` | Remove fallback path fields from constructor | 03 + 09 |
| `packages/ui/src/routes/stack/drift/+server.ts` | Switch from `manager.computeDriftReport()` to `composePs()` | 05 |
| `packages/ui/src/routes/command/+server.ts` | Update `service.drift` handler | 05 |

## Methods That Remain After Slimming

**Public API (16 methods):**
1. `getPaths()` -- returns path configuration
2. `getSpec()` -- reads stack spec from disk
3. `setSpec()` -- validates, writes spec, re-renders artifacts
4. `getChannelAccess()` -- reads channel exposure setting
5. `getChannelConfig()` -- reads channel config values
6. `setChannelAccess()` -- updates channel exposure, re-renders
7. `setChannelConfig()` -- updates channel config values, re-renders
8. `setAccessScope()` -- updates access scope, re-renders
9. `renderPreview()` -- generates artifacts without writing
10. `renderArtifacts()` -- generates and writes all artifacts
11. `validateReferencedSecrets()` -- checks secret references exist
12. `listSecretManagerState()` -- simplified `{ name, configured, usedBy }` list
13. `upsertSecret()` -- creates/updates a secret, re-renders
14. `deleteSecret()` -- removes a secret with usage check
15. `listAutomations()` / `getAutomation()` / `upsertAutomation()` / `deleteAutomation()` -- automation CRUD

**Private methods (5):**
1. `writeArtifact()` -- writes file if content changed
2. `writeStackSpecAtomically()` -- atomic write via temp + rename
3. `readSecretsEnv()` -- reads secrets.env + data.env
4. `updateSecretsEnv()` -- updates secrets.env
5. `isValidSecretName()` -- regex validation

## Risk Assessment

**Risk: Low.** The changes to StackManager in this plan are entirely subtractive. No new functionality is being added, no interfaces are changing, and no method signatures are modified for the kept methods.

**Mitigation**:
- Execute Plan 09 last, after all other plans are implemented
- After each plan, run `bun run typecheck && bun test` to verify StackManager still works
- The test file at `stack-manager.test.ts` covers the kept methods thoroughly (18 tests) and does not test any of the methods being removed

**Breaking change risk**: None. All removed methods are internal to `@openpalm/lib` and consumed only by modules that the dependent plans update simultaneously.

## Verification Checklist

After all removals:

```bash
# Verify no stale references
grep -r "computeDriftReport" packages/lib/src/admin/stack-manager.ts   # Should return 0
grep -r "renderArtifactsToTemp" packages/lib/src/admin/               # Should return 0
grep -r "fallbackCompose" packages/lib/src/admin/stack-manager.ts     # Should return 0

# Verify type soundness
bun run typecheck

# Verify all tests pass
bun test packages/lib/src/admin/stack-manager.test.ts
bun test

# Verify line count reduction
wc -l packages/lib/src/admin/stack-manager.ts  # Target: ~310 lines (down from 510)
```
