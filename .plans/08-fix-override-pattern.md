# Plan: Replace Override Pattern with Dependency Injection (Finding 08)

## Executive Summary

The file `packages/lib/src/admin/compose-runner.ts` (lines 99-358) contains **5 mutable module-level override registries**, **5 setter functions**, and **5 `*WithOverride` wrapper functions** -- a total of 15 exports that exist solely for test mockability. This pattern has three problems: (1) it leaks test infrastructure into production code, (2) it requires careful manual cleanup in every test (miss one and you get cross-test contamination), and (3) it scales linearly -- every new compose operation needs a new trio of override/setter/wrapper.

The fix: define a `ComposeRunner` interface, pass it as a parameter where needed (dependency injection), and provide a `createMockRunner()` helper for tests. This eliminates all 15 override-related exports and the mutable module-level state.

## Scope Note (Relationship to Plan 01)

Plan 01 ("Merge Compose Runners") already designs a `ComposeClient` class that subsumes both the override elimination and the runner merge. **Plan 08 is a strict subset of Plan 01** -- it establishes the interface and DI pattern first, making the full merge in Plan 01 a smaller subsequent step. If Plan 01 is executed first, Plan 08 is unnecessary. If they are executed sequentially as intended (08 then 01), Plan 08 does the DI refactor in place within `admin/compose-runner.ts`, and Plan 01 then moves the result into a new `compose-client.ts` and merges with the CLI runner.

## Current State: The 5 Override Registries

Located in `packages/lib/src/admin/compose-runner.ts`:

**Registry 1: `composeConfigServicesOverride` (lines 100-110)**
```typescript
let composeConfigServicesOverride: ComposeConfigServicesFn | null = null;
export function setComposeConfigServicesOverride(next: ComposeConfigServicesFn | null): void { ... }
export async function composeConfigServicesWithOverride(composeFileOverride?: string): Promise<string[]> { ... }
```
- Used by: `allowedServiceSet()` (line 113), `deriveImpact()` in stack-apply-engine.ts (lines 192-194)
- Set in tests: stack-apply-engine.test.ts (14 call sites)

**Registry 2: `composeListOverride` (lines 138-148)**
```typescript
let composeListOverride: ComposeListFn | null = null;
export function setComposeListOverride(next: ComposeListFn | null): void { ... }
export async function composeListWithOverride(): Promise<ComposeResult> { ... }
```
- Used by: `computeDriftReport()` (line 161)
- Set in tests: stack-apply-engine.test.ts (15 call sites)

**Registry 3: `composePsOverride` (lines 228-238)**
```typescript
let composePsOverride: ComposePsFn | null = null;
export function setComposePsOverride(next: ComposePsFn | null): void { ... }
export async function composePsWithOverride(): Promise<...> { ... }
```
- Used by: `pollUntilHealthy()` in health-gate.ts (line 56)
- Set in tests: health-gate.test.ts (4 call sites), stack-apply-engine.test.ts (2 call sites)

**Registry 4: `composeOverrides` (lines 304-316)**
```typescript
let composeOverrides: ComposeRunnerOverrides = {};
export function setComposeRunnerOverrides(next: ComposeRunnerOverrides): void { ... }
```
Bundles 5 operations: `composeAction`, `composeExec`, `composeActionForFile`, `composeConfigValidateForFile`, `composeConfigValidate`. Each has its own `*WithOverride` wrapper (lines 330-358).
- Used by: stack-apply-engine.ts (all orchestration calls)
- Set in tests: stack-apply-engine.test.ts (11 call sites)

**Registry 5: `composeArtifactOverrides` (lines 318-328)**
```typescript
let composeArtifactOverrides: ComposeRunnerArtifactOverrides = {};
export function setComposeRunnerArtifactOverrides(next: ComposeRunnerArtifactOverrides): void { ... }
```
- Used by: `computeDriftReport()` (lines 178-179, 200), `persistDriftReport()` (line 200)
- Set in tests: stack-apply-engine.test.ts (11 call sites)

## The `ComposeRunner` Interface

```typescript
export interface ComposeRunner {
  /** Run compose action (up/stop/restart) for services using the default compose file */
  action(action: "up" | "stop" | "restart", service: string | string[]): Promise<ComposeResult>;

  /** Run compose action for a specific compose file */
  actionForFile(action: "up" | "stop" | "restart", service: string | string[], composeFile: string, envFile?: string): Promise<ComposeResult>;

  /** Run compose exec on a service */
  exec(service: string, args: string[]): Promise<ComposeResult>;

  /** List containers (ps --format json) */
  list(): Promise<ComposeResult>;

  /** Get service health states (ps parsed) */
  ps(): Promise<{ ok: boolean; services: ServiceHealthState[]; stderr: string }>;

  /** Get service names from compose config */
  configServices(composeFileOverride?: string): Promise<string[]>;

  /** Validate compose file */
  configValidate(): Promise<ComposeResult>;

  /** Validate a specific compose file */
  configValidateForFile(composeFile: string, envFile?: string): Promise<ComposeResult>;

  /** Pull images for a service */
  pull(service?: string): Promise<ComposeResult>;

  /** Get logs for a service */
  logs(service: string, tail?: number): Promise<ComposeResult>;

  /** docker compose down --remove-orphans */
  stackDown(): Promise<ComposeResult>;
}
```

**Artifact path overrides** (`composeArtifactOverrides`) are NOT compose operations. They should be handled by making `computeDriftReport` accept explicit paths as parameters instead of reading from module-level overrides.

## Factory Functions

```typescript
/** Create the real ComposeRunner from environment variables */
export function createComposeRunner(): ComposeRunner {
  return {
    action: composeAction,
    actionForFile: composeActionForFile,
    exec: composeExec,
    list: composeList,
    ps: composePs,
    configServices: composeConfigServices,
    configValidate: composeConfigValidate,
    configValidateForFile: composeConfigValidateForFile,
    pull: composePull,
    logs: composeLogs,
    stackDown: composeStackDown,
  };
}

/** Create a mock ComposeRunner for tests -- all methods return success by default */
export function createMockRunner(overrides?: Partial<ComposeRunner>): ComposeRunner {
  const ok: ComposeResult = { ok: true, stdout: "", stderr: "" };
  return {
    action: async () => ok,
    actionForFile: async () => ok,
    exec: async () => ok,
    list: async () => ({ ...ok, stdout: "[]" }),
    ps: async () => ({ ok: true, services: [], stderr: "" }),
    configServices: async () => [],
    configValidate: async () => ok,
    configValidateForFile: async () => ok,
    pull: async () => ok,
    logs: async () => ok,
    stackDown: async () => ok,
    ...overrides,
  };
}
```

## Detailed Changes: File by File

### 1. `packages/lib/src/admin/compose-runner.ts` (359 lines)

**Lines to add** (interface + factories): ~50 lines

- Add `ComposeRunner` interface definition
- Add `createComposeRunner()` factory
- Add `createMockRunner()` test helper
- Export all three

**Lines to delete** (override infrastructure): ~60 lines

| Lines | Export | Action |
|-------|--------|--------|
| 100-101 | `composeConfigServicesOverride` variable | Delete |
| 103-105 | `setComposeConfigServicesOverride()` | Delete |
| 107-110 | `composeConfigServicesWithOverride()` | Delete |
| 138-139 | `composeListOverride` variable | Delete |
| 141-143 | `setComposeListOverride()` | Delete |
| 145-148 | `composeListWithOverride()` | Delete |
| 228-229 | `composePsOverride` variable | Delete |
| 231-233 | `setComposePsOverride()` | Delete |
| 235-238 | `composePsWithOverride()` | Delete |
| 304-316 | `ComposeRunnerOverrides` type, `composeOverrides` variable, `setComposeRunnerOverrides()` | Delete |
| 318-328 | `ComposeRunnerArtifactOverrides` type, `composeArtifactOverrides` variable, `setComposeRunnerArtifactOverrides()` | Delete |
| 330-333 | `composeActionWithOverride()` | Delete |
| 335-338 | `composeExecWithOverride()` | Delete |
| 340-348 | `composeActionForFileWithOverride()` | Delete |
| 350-353 | `composeConfigValidateForFileWithOverride()` | Delete |
| 355-358 | `composeConfigValidateWithOverride()` | Delete |

**Lines to modify**:
- Line 113 (`allowedServiceSet`): Add optional `runner?: ComposeRunner` parameter, use `runner.configServices()` instead of `composeConfigServicesWithOverride()`
- Line 157 (`computeDriftReport`): Add `runner?: ComposeRunner` parameter, use `runner.list()`. Also accept explicit `composeFilePath` and `caddyJsonPath` parameters to replace `composeArtifactOverrides`
- Line 198-203 (`persistDriftReport`): Accept explicit `reportPath` parameter, remove fallback to `composeArtifactOverrides.driftReportPath`

**Functions kept as-is** (real implementations, exposed via the factory):
- `composeAction`, `composeActionForFile`, `composeExec`, `composeList`, `composePs`
- `composeConfigServices`, `composeConfigValidate`, `composeConfigValidateForFile`
- `composePull`, `composeLogs`, `composeStackDown`
- `composeLogsValidateTail` (pure function), `filterUiManagedServices` (pure function)
- `CoreServices`, `UiManagedServiceExclusions` (constants)

### 2. `packages/lib/src/admin/stack-apply-engine.ts` (422 lines)

**Import changes** (lines 1-14):
- Remove: `composeActionWithOverride`, `composeActionForFileWithOverride`, `composeConfigServicesWithOverride`, `composeConfigValidateForFileWithOverride`, `composeExecWithOverride`
- Add: `type ComposeRunner`, `createComposeRunner`

**Function signature change**:
- `applyStack(manager, options?)` gains `runner?: ComposeRunner` in options
- At top of function: `const runner = options?.runner ?? createComposeRunner();`

**Replace all ~17 `*WithOverride` calls** with `runner.*` calls:

| Line | Current | Replacement |
|------|---------|-------------|
| 128 | `composeConfigValidateForFileWithOverride(...)` | `runner.configValidateForFile(...)` |
| 131 | `composeActionForFileWithOverride("up", "admin", ...)` | `runner.actionForFile("up", "admin", ...)` |
| 192 | `composeConfigServicesWithOverride(...)` | `runner.configServices(...)` |
| 257 | `composeConfigValidateForFileWithOverride(...)` | `runner.configValidateForFile(...)` |
| 270 | `composeActionWithOverride("up", [])` | `runner.action("up", [])` |
| 274 | `composeActionWithOverride("up", service)` | `runner.action("up", service)` |
| 284 | `composeActionWithOverride("restart", service)` | `runner.action("restart", service)` |
| 294 | `composeExecWithOverride("caddy", [...])` | `runner.exec("caddy", [...])` |
| etc. | All remaining `*WithOverride` calls | Corresponding `runner.*` calls |

Also pass `runner` to internal functions: `deriveImpact`, `fallbackToAdminAndCaddy`, `selfTestFallbackBundle`, `pollUntilHealthy`, `computeDriftReport`, `runApplyPreflight`.

### 3. `packages/lib/src/admin/health-gate.ts` (72 lines)

- Remove import of `composePsWithOverride`
- Add import of `type ComposeRunner`
- `pollUntilHealthy(config, runner: ComposeRunner)` -- add `runner` parameter
- Line 56: `await composePsWithOverride()` becomes `await runner.ps()`

### 4. `packages/lib/src/admin/preflight-checks.ts` (113 lines)

- Remove import of `composePull`
- Add import of `type ComposeRunner`
- `runApplyPreflight(args)` gains `runner: ComposeRunner` in args
- `checkImageAvailability(services, runner)` gains `runner` parameter
- Line 89: `await composePull(service)` becomes `await runner.pull(service)`

### 5. `packages/lib/src/admin/stack-apply-engine.test.ts` (471 lines)

**Import changes** (line 10):
- Remove: `setComposeConfigServicesOverride`, `setComposeListOverride`, `setComposePsOverride`, `setComposeRunnerArtifactOverrides`, `setComposeRunnerOverrides`
- Add: `createMockRunner`, `type ComposeRunner`

**Pattern replacement** for each test:

**Before**:
```typescript
setComposeRunnerOverrides({
  composeAction: async () => ({ ok: true, stdout: "", stderr: "" }),
  composeExec: async () => ({ ok: true, stdout: "", stderr: "" }),
});
setComposeListOverride(async () => ({ ok: true, stdout: "[]", stderr: "" }));
setComposeConfigServicesOverride(async () => []);
setComposePsOverride(async () => ({ ok: true, services: [...], stderr: "" }));
setComposeRunnerArtifactOverrides({
  composeFilePath: join(dir, "docker-compose.yml"),
});
// ... test body ...
// Must manually clean up:
setComposePsOverride(null);
setComposeRunnerOverrides({});
setComposeListOverride(null);
setComposeConfigServicesOverride(null);
setComposeRunnerArtifactOverrides({});
```

**After**:
```typescript
const mockRunner = createMockRunner({
  ps: async () => ({ ok: true, services: [...], stderr: "" }),
});
const result = await applyStack(manager, { apply: true, runner: mockRunner });
// No cleanup needed
```

Tests affected: 7 test blocks with ~57 total set/cleanup call sites eliminated.

### 6. `packages/lib/src/admin/health-gate.test.ts` (38 lines)

- Remove `setComposePsOverride` import
- Add `createMockRunner` import
- Replace `setComposePsOverride(mockFn)` with `createMockRunner({ ps: mockFn })`
- Pass runner to `pollUntilHealthy({ ... }, runner)`
- Remove `beforeEach`/`afterEach` cleanup

### 7. UI Routes -- No changes needed

UI routes import the real functions (`composeAction`, `composeList`, etc.) -- NOT the `*WithOverride` variants. They don't use any setters. No changes needed for Plan 08.

**Exception**: `allowedServiceSet` gains an optional `runner` parameter with default `createComposeRunner()`, so existing callers continue working without changes.

---

## Step-by-Step Implementation Order

### Step 1: Define interface and factories in compose-runner.ts
- Add `ComposeRunner` interface, `createComposeRunner()`, `createMockRunner()`
- Export all three
- Run: `bun run typecheck` (this step only adds exports, breaks nothing)

### Step 2: Add `runner` parameter to `allowedServiceSet` and `composeServiceNames`
- Make optional with default `createComposeRunner()`
- Replace internal `composeConfigServicesWithOverride()` with `runner.configServices()`
- Run: `bun test packages/lib/src/admin/compose-runner.test.ts`

### Step 3: Add `runner` parameter to `computeDriftReport` and `persistDriftReport`
- Add explicit `composeFilePath` and `caddyJsonPath` parameters
- Replace `composeListWithOverride()` with `runner.list()`
- Remove references to `composeArtifactOverrides`
- Run: `bun test packages/lib/src/admin/compose-runner.test.ts`

### Step 4: Update `health-gate.ts`
- Add `runner: ComposeRunner` to `pollUntilHealthy()`
- Replace `composePsWithOverride()` with `runner.ps()`

### Step 5: Update `health-gate.test.ts`
- Replace `setComposePsOverride` usage with `createMockRunner()`
- Run: `bun test packages/lib/src/admin/health-gate.test.ts`

### Step 6: Update `preflight-checks.ts`
- Add `runner: ComposeRunner` to function signatures
- Replace `composePull()` with `runner.pull()`

### Step 7: Update `stack-apply-engine.ts`
- Add `runner?: ComposeRunner` to `applyStack` options
- Resolve runner at top, pass through to all internal functions
- Replace all 17 `*WithOverride` calls with `runner.*` calls
- Run: `bun run typecheck`

### Step 8: Update `stack-apply-engine.test.ts`
- Replace all `set*Override` calls with `createMockRunner()` passed via options
- Remove all manual cleanup lines
- Run: `bun test packages/lib/src/admin/stack-apply-engine.test.ts`

### Step 9: Delete override infrastructure from compose-runner.ts
- Delete the 5 mutable variables, 5 setter functions, 5 `*WithOverride` functions
- Delete `ComposeRunnerOverrides` and `ComposeRunnerArtifactOverrides` types
- Run: `bun run typecheck` then `bun test`

### Step 10: Final verification
```bash
bun run typecheck
bun test
```

## Risk Assessment

**Risk 1: Breaking UI routes that import from compose-runner**
- Mitigation: UI routes import real functions, not override variants. `allowedServiceSet` gets an optional parameter with default, so it's backward-compatible.

**Risk 2: Test cross-contamination during migration**
- Mitigation: Steps are ordered so each function's tests are updated immediately after the signature changes.

**Risk 3: `computeDriftReport` uses artifact overrides for file paths**
- Mitigation: Artifact overrides are test-only. We add explicit parameters with defaults matching current env-based behavior.

## Lines of Code Impact

| Category | Lines |
|----------|-------|
| New code (interface, factories, mock helper) | ~60 |
| Deleted code (5 variables, 5 setters, 5 WithOverride, 2 types) | ~70 |
| Modified code (function signatures gaining `runner` param) | ~40 |
| Test code rewritten (set/cleanup → DI) | ~120 removed, ~60 added |
| **Net reduction** | **~70 lines** |
