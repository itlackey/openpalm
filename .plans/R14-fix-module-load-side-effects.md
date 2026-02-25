# R14: Fix module-load side effects in `automations.ts`

## Summary

The `automations.ts` module in `packages/lib/src/admin/` reads `Bun.env.CRON_DIR` via lazy getter functions at call time. While the current code already uses functions (not top-level constants) for directory resolution, the test file still uses a `?cron=${Date.now()}` cache-busting hack on its dynamic `import()` to force a fresh module evaluation per test. This hack exists because Bun's module cache means that once the module is loaded, subsequent `import()` calls return the cached module -- and if a test changes `Bun.env.CRON_DIR` after the first import, the module's lazy getters will pick up the new value, but the test author apparently did not trust this (or an earlier version of the module did have true module-level side effects).

The real architectural problem is that the module's behavior depends on ambient environment state (`Bun.env.CRON_DIR`) rather than explicit configuration passed as a parameter. This makes the module:
1. **Hard to test** -- requires env var manipulation and cache-busting imports
2. **Tightly coupled to environment** -- callers must set `process.env.CRON_DIR` before importing (see `init.ts` line 73)
3. **Non-deterministic** -- behavior depends on when env vars are set relative to function calls

The fix: refactor all exported functions to accept a `cronDir` parameter (or a config object), eliminating the need to read `Bun.env` at all.

## Current module-level side effects

File: `packages/lib/src/admin/automations.ts`

| Line(s) | Code | Issue |
|---------|------|-------|
| 8 | `const log = createLogger("admin");` | Minor: creates a logger at module load. Acceptable side effect but could be parameterized. |
| 11 | `function cronDir(): string { return Bun.env.CRON_DIR ?? "/state/automations"; }` | Reads `Bun.env.CRON_DIR` on every call. Not a module-load side effect per se, but couples all functions to ambient env state. |
| 12-18 | `scriptsDir()`, `logDir()`, `lockDir()`, `cronEnabledDir()`, `cronDisabledDir()`, `combinedSchedulePath()`, `runnerPath()` | All derive from `cronDir()`, inheriting the env coupling. |

The module does NOT have true top-level const side effects -- the directory functions are lazy. However, the coupling to `Bun.env` is the core problem.

## The cache-busting hack in the test

File: `packages/lib/src/admin/automations.test.ts`

**Line 23:**
```typescript
const { ensureCronDirs, syncAutomations } = await import(`./automations.ts?cron=${Date.now()}`);
```

This dynamic import with a unique query string forces Bun to treat each import as a distinct module, bypassing the module cache. The test does this because:

1. `beforeEach` (lines 11-13) sets `Bun.env.CRON_DIR` to a fresh temp directory
2. The test author wanted to ensure the module picks up the new env var value
3. The `?cron=${Date.now()}` query string makes each import URL unique, forcing a fresh module evaluation

This hack is fragile, non-standard, and masks the real design issue: the module should accept its configuration explicitly.

## Callers that need updating

### Direct callers of `syncAutomations`

| File | Line | Functions used |
|------|------|----------------|
| `packages/ui/src/lib/server/init.ts` | 77, 92-93 | `ensureCronDirs`, `syncAutomations` |
| `packages/ui/src/routes/command/+server.ts` | 40, 355, 454, 463 | `syncAutomations`, `triggerAutomation` |
| `packages/ui/src/routes/stack/apply/+server.ts` | 5, 28 | `syncAutomations` |
| `packages/ui/src/routes/setup/complete/+server.ts` | 7, 41 | `syncAutomations` |
| `packages/ui/src/routes/automations/+server.ts` | 5, 40 | `syncAutomations` |
| `packages/ui/src/routes/automations/update/+server.ts` | 4, 24 | `syncAutomations` |
| `packages/ui/src/routes/automations/delete/+server.ts` | 3, 14 | `syncAutomations` |
| `packages/ui/src/routes/automations/trigger/+server.ts` | 3, 13 | `triggerAutomation` |

### Env var propagation

| File | Line | Code |
|------|------|------|
| `packages/ui/src/lib/server/init.ts` | 72-73 | `// Propagate CRON_DIR so @openpalm/lib/admin/automations reads it at module scope` / `process.env.CRON_DIR = CRON_DIR;` |
| `packages/ui/src/lib/server/config.ts` | 43-45 | Defines `CRON_DIR` from env or defaults |

## Proposed refactored API

### Option A: Add `cronDir` parameter to each exported function (recommended)

This is the simplest change with the least disruption to callers. Each exported function gains an explicit `cronDir` parameter:

```typescript
// packages/lib/src/admin/automations.ts

// Private helpers derive paths from the explicit cronDir parameter
function scriptsDir(cronDir: string): string { return join(cronDir, "scripts"); }
function logDir(cronDir: string): string { return join(cronDir, "log"); }
function lockDir(cronDir: string): string { return join(cronDir, "lock"); }
function cronEnabledDir(cronDir: string): string { return join(cronDir, "cron.d.enabled"); }
function cronDisabledDir(cronDir: string): string { return join(cronDir, "cron.d.disabled"); }
function combinedSchedulePath(cronDir: string): string { return join(cronDir, "cron.schedule"); }
function runnerPath(cronDir: string): string { return join(cronDir, "run-automation"); }

// Public API -- cronDir is now an explicit parameter
export function ensureCronDirs(cronDir: string): void { ... }
export function syncAutomations(cronDir: string, automations: StackAutomation[]): void { ... }
export function triggerAutomation(cronDir: string, idRaw: string): Promise<{ ok: boolean; error?: string }> { ... }
```

### Why not a config object or factory?

A factory pattern (`createAutomationManager(cronDir)`) would be more OOP but would require all callers to manage an instance. Since the callers already have `CRON_DIR` available (from `$lib/server/config`), passing it as a simple string parameter is the minimal change.

## Step-by-step implementation

### Step 1: Refactor `automations.ts` internal helpers

**File:** `packages/lib/src/admin/automations.ts`

1. Remove the `cronDir()` function that reads `Bun.env.CRON_DIR`
2. Update all private helper functions (`scriptsDir`, `logDir`, `lockDir`, `cronEnabledDir`, `cronDisabledDir`, `combinedSchedulePath`, `runnerPath`) to accept a `cronDir: string` parameter
3. Update `ensureCronDirs` signature to `ensureCronDirs(cronDir: string): void`
4. Update `syncAutomations` signature to `syncAutomations(cronDir: string, automations: StackAutomation[]): void`
5. Update `triggerAutomation` signature to `triggerAutomation(cronDir: string, idRaw: string): Promise<...>`
6. Update `writeRunner` to accept `cronDir: string` and pass it through to path helpers
7. Thread `cronDir` through all internal calls

**Before (lines 10-18):**
```typescript
function cronDir(): string { return Bun.env.CRON_DIR ?? "/state/automations"; }
function scriptsDir(): string { return join(cronDir(), "scripts"); }
function logDir(): string { return join(cronDir(), "log"); }
function lockDir(): string { return join(cronDir(), "lock"); }
function cronEnabledDir(): string { return join(cronDir(), "cron.d.enabled"); }
function cronDisabledDir(): string { return join(cronDir(), "cron.d.disabled"); }
function combinedSchedulePath(): string { return join(cronDir(), "cron.schedule"); }
function runnerPath(): string { return join(cronDir(), "run-automation"); }
```

**After:**
```typescript
function scriptsDir(cronDir: string): string { return join(cronDir, "scripts"); }
function logDir(cronDir: string): string { return join(cronDir, "log"); }
function lockDir(cronDir: string): string { return join(cronDir, "lock"); }
function cronEnabledDir(cronDir: string): string { return join(cronDir, "cron.d.enabled"); }
function cronDisabledDir(cronDir: string): string { return join(cronDir, "cron.d.disabled"); }
function combinedSchedulePath(cronDir: string): string { return join(cronDir, "cron.schedule"); }
function runnerPath(cronDir: string): string { return join(cronDir, "run-automation"); }
```

### Step 2: Update `ensureCronDirs`

**Before (lines 35-40):**
```typescript
export function ensureCronDirs(): void {
  for (const dir of [cronDir(), scriptsDir(), logDir(), lockDir(), cronEnabledDir(), cronDisabledDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  writeRunner();
}
```

**After:**
```typescript
export function ensureCronDirs(cronDir: string): void {
  for (const dir of [cronDir, scriptsDir(cronDir), logDir(cronDir), lockDir(cronDir), cronEnabledDir(cronDir), cronDisabledDir(cronDir)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeRunner(cronDir);
}
```

### Step 3: Update `syncAutomations`

**Before (line 42):**
```typescript
export function syncAutomations(automations: StackAutomation[]): void {
```

**After:**
```typescript
export function syncAutomations(cronDir: string, automations: StackAutomation[]): void {
```

Then update all internal calls within this function to pass `cronDir`:
- `ensureCronDirs()` -> `ensureCronDirs(cronDir)`
- `scriptsDir()` -> `scriptsDir(cronDir)`
- `runnerPath()` -> `runnerPath(cronDir)`
- `cronEnabledDir()` -> `cronEnabledDir(cronDir)`
- `cronDisabledDir()` -> `cronDisabledDir(cronDir)`
- `combinedSchedulePath()` -> `combinedSchedulePath(cronDir)`

### Step 4: Update `triggerAutomation`

**Before (line 102):**
```typescript
export function triggerAutomation(idRaw: string): Promise<{ ok: boolean; error?: string }> {
```

**After:**
```typescript
export function triggerAutomation(cronDir: string, idRaw: string): Promise<{ ok: boolean; error?: string }> {
```

Then update `runnerPath()` -> `runnerPath(cronDir)` on line 105.

### Step 5: Update `writeRunner`

**Before (line 120):**
```typescript
function writeRunner(): void {
```

**After:**
```typescript
function writeRunner(cronDir: string): void {
```

Update `scriptsDir()`, `logDir()`, `lockDir()`, `runnerPath()` calls within the function to pass `cronDir`.

### Step 6: Update `init.ts` -- remove env propagation

**File:** `packages/ui/src/lib/server/init.ts`

1. Remove line 73: `process.env.CRON_DIR = CRON_DIR;`
2. Remove the comment on line 72
3. Update line 92: `ensureCronDirs()` -> `ensureCronDirs(CRON_DIR)`
4. Update line 93: `syncAutomations(sm.listAutomations())` -> `syncAutomations(CRON_DIR, sm.listAutomations())`

### Step 7: Update all UI route callers

For each caller, import `CRON_DIR` from `$lib/server/config` (if not already imported) and pass it as the first argument.

**`packages/ui/src/routes/command/+server.ts`:**
- Add `CRON_DIR` to the existing import from `$lib/server/config` (line 43)
- Line 355: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`
- Line 454: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`
- Line 463: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`
- Line 588: `triggerAutomation(id)` -> `triggerAutomation(CRON_DIR, id)`

**`packages/ui/src/routes/stack/apply/+server.ts`:**
- Add import: `import { CRON_DIR } from '$lib/server/config';`
- Line 28: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`

**`packages/ui/src/routes/setup/complete/+server.ts`:**
- Add `CRON_DIR` to the existing import from `$lib/server/config` (line 12)
- Line 41: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`

**`packages/ui/src/routes/automations/+server.ts`:**
- Add import: `import { CRON_DIR } from '$lib/server/config';`
- Line 40: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`

**`packages/ui/src/routes/automations/update/+server.ts`:**
- Add import: `import { CRON_DIR } from '$lib/server/config';`
- Line 24: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`

**`packages/ui/src/routes/automations/delete/+server.ts`:**
- Add import: `import { CRON_DIR } from '$lib/server/config';`
- Line 14: `syncAutomations(stackManager.listAutomations())` -> `syncAutomations(CRON_DIR, stackManager.listAutomations())`

**`packages/ui/src/routes/automations/trigger/+server.ts`:**
- Add import: `import { CRON_DIR } from '$lib/server/config';`
- Line 13: `triggerAutomation(body.id)` -> `triggerAutomation(CRON_DIR, body.id)`

### Step 8: Update the test

**File:** `packages/lib/src/admin/automations.test.ts`

**Before:**
```typescript
let cronDir = "";
let savedCronDir: string | undefined;

describe("automations sync", () => {
  beforeEach(() => {
    savedCronDir = Bun.env.CRON_DIR;
    cronDir = mkdtempSync(join(tmpdir(), "openpalm-automations-"));
    Bun.env.CRON_DIR = cronDir;
  });

  afterEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
    if (savedCronDir !== undefined) Bun.env.CRON_DIR = savedCronDir;
    else delete Bun.env.CRON_DIR;
  });

  it("writes enabled and disabled cron entries to separate directories", async () => {
    const { ensureCronDirs, syncAutomations } = await import(`./automations.ts?cron=${Date.now()}`);
    ensureCronDirs();
    syncAutomations([...]);
    ...
  });
});
```

**After:**
```typescript
import { ensureCronDirs, syncAutomations } from "./automations.ts";

let cronDir = "";

describe("automations sync", () => {
  beforeEach(() => {
    cronDir = mkdtempSync(join(tmpdir(), "openpalm-automations-"));
  });

  afterEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
  });

  it("writes enabled and disabled cron entries to separate directories", () => {
    ensureCronDirs(cronDir);
    syncAutomations(cronDir, [...]);
    ...
  });
});
```

Key improvements:
- **No dynamic import** -- standard static import, no cache-busting hack
- **No env var manipulation** -- no `savedCronDir`, no `Bun.env.CRON_DIR` save/restore
- **No async test** -- the `await import(...)` is gone, test can be synchronous
- **Simpler beforeEach/afterEach** -- only temp dir creation/cleanup remains

## Files to modify

| File | Change type |
|------|------------|
| `packages/lib/src/admin/automations.ts` | Core refactor: add `cronDir` parameter to all exported and internal functions |
| `packages/lib/src/admin/automations.test.ts` | Simplify: remove cache-busting import, env var manipulation |
| `packages/ui/src/lib/server/init.ts` | Remove env propagation; pass `CRON_DIR` to function calls |
| `packages/ui/src/routes/command/+server.ts` | Pass `CRON_DIR` to `syncAutomations` and `triggerAutomation` |
| `packages/ui/src/routes/stack/apply/+server.ts` | Pass `CRON_DIR` to `syncAutomations` |
| `packages/ui/src/routes/setup/complete/+server.ts` | Pass `CRON_DIR` to `syncAutomations` |
| `packages/ui/src/routes/automations/+server.ts` | Pass `CRON_DIR` to `syncAutomations` |
| `packages/ui/src/routes/automations/update/+server.ts` | Pass `CRON_DIR` to `syncAutomations` |
| `packages/ui/src/routes/automations/delete/+server.ts` | Pass `CRON_DIR` to `syncAutomations` |
| `packages/ui/src/routes/automations/trigger/+server.ts` | Pass `CRON_DIR` to `triggerAutomation` |

## Verification steps

1. **Run the automations test:**
   ```bash
   bun test packages/lib/src/admin/automations.test.ts
   ```
   Verify it passes without the `?cron=` hack.

2. **Run full lib test suite:**
   ```bash
   cd packages/lib && bun test
   ```

3. **Run type checking:**
   ```bash
   bun run typecheck
   ```
   Ensures all callers pass the new `cronDir` argument correctly.

4. **Grep for remaining env coupling:**
   ```bash
   grep -rn "Bun.env.CRON_DIR" packages/lib/src/
   grep -rn "process.env.CRON_DIR" packages/
   ```
   Should return zero results in `automations.ts` and zero `process.env.CRON_DIR` propagation in `init.ts`.

5. **Grep for remaining cache-busting hacks:**
   ```bash
   grep -rn "cron=\${Date.now()}" packages/
   grep -rn "?cron=" packages/
   ```
   Should return zero results.

6. **Run full test suite:**
   ```bash
   bun test
   ```

7. **Dev stack smoke test (if available):**
   ```bash
   bun run dev:build && bun run dev:up
   ```
   Verify automations sync works via the admin UI by creating, enabling, and triggering an automation.
