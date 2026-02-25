# R13: Inject Dependencies Instead of Monkey-Patching Globals

## Summary of the Problem

Two test files monkey-patch `Bun.spawn` to control subprocess behavior during tests:

1. **`packages/lib/src/admin/compose-runner.test.ts`** (lines 13-40) -- saves `Bun.spawn`, replaces it with a mock, and restores it in `afterEach`. Tests the admin-level compose runner convenience functions (`composeConfigServices`, `allowedServiceSet`, `composeAction`, `composeExec`, `composeServiceNames`) and the shared `runCompose` error classification.

2. **`packages/cli/test/compose.test.ts`** (lines 47-56) -- same pattern. Tests `composeExec` from `packages/lib/src/compose.ts` and verifies argument passing and timeout behavior.

Monkey-patching `Bun.spawn` is fragile:
- Tests can leak global state if `afterEach` fails to run (exceptions, test runner crashes).
- Parallel test execution is impossible because the global is shared.
- The pattern is explicitly called out in `AGENTS.md` as an anti-pattern: "Dependency injection over module globals."

Meanwhile, `stack-apply-engine.test.ts` already demonstrates the correct pattern: it uses `createMockRunner()` from `compose-runner.ts` (line 10) and passes the mock runner through the `options.runner` parameter (lines 100, 126). No globals are touched, tests are isolated, and the production code accepts the dependency via its interface.

## Current Code Structure

### The Spawn Chain

There are two layers of compose execution:

```
UI/CLI callers
    |
    v
packages/lib/src/admin/compose-runner.ts    <-- Admin-level ComposeRunner interface
    |  (convenience functions call createComposeRunner() internally)
    |  (createComposeRunner() calls execCompose() which calls...)
    v
packages/lib/src/compose-runner.ts          <-- Shared low-level runner
    |  (runCompose() calls runComposeOnce() which calls...)
    v
Bun.spawn(...)                              <-- The global being monkey-patched
```

### File: `packages/lib/src/compose-runner.ts` (shared low-level runner)

- **Line 27-74**: `runComposeOnce()` -- builds args, calls `Bun.spawn` directly (line 48).
- **Line 76-88**: `runCompose()` -- retry wrapper around `runComposeOnce()`.
- The function has no spawn injection point. `Bun.spawn` is called as a hard-coded global.

### File: `packages/lib/src/admin/compose-runner.ts` (admin-level runner)

- **Line 1**: Imports `runCompose` from the shared runner.
- **Line 73-91**: `createComposeRunner(envFile?)` -- factory that creates a `ComposeRunner` using `execCompose()` internally.
- **Line 93-108**: `createMockRunner(overrides?)` -- already exists. Returns a `ComposeRunner` with all methods stubbed to return success. Accepts partial overrides. This is the good pattern.
- **Line 110-131**: `execCompose()` -- delegates to the shared `runCompose`.
- **Lines 214-273**: Standalone convenience functions (`composeAction`, `composePs`, `composePull`, etc.) -- each calls `createComposeRunner()` internally with no way to inject a mock.

### File: `packages/lib/src/compose.ts` (CLI-level compose helpers)

- **Line 2**: Imports `runCompose` from the shared runner.
- **Lines 14-164**: CLI-level functions (`composeExec`, `composeUp`, `composeDown`, etc.) -- all call `runCompose` directly. No injection point.

### Test: `packages/lib/src/admin/compose-runner.test.ts`

- **Lines 13-40**: `beforeEach`/`afterEach` save and restore `Bun.spawn`.
- **Line 19-33**: Creates a mock spawn that returns a configurable stdout stream.
- **Line 34**: `Bun.spawn = spawnMock as unknown as typeof Bun.spawn` -- the monkey-patch.
- **Lines 42-88**: Tests call the standalone convenience functions (`composeConfigServices`, `allowedServiceSet`, etc.) which internally create a real `ComposeRunner` that calls `execCompose` -> `runCompose` -> `Bun.spawn`. The mock intercepts at the `Bun.spawn` level.
- **Lines 95-109**: Tests `runCompose` directly for daemon error classification, also via the `Bun.spawn` mock.

### Test: `packages/cli/test/compose.test.ts`

- **Lines 47-56**: Same `Bun.spawn` monkey-patch pattern.
- **Lines 58-83**: Tests that `composeExec` passes correct args to spawn.
- **Lines 85-115**: Tests timeout behavior by mocking spawn to hang.

### Good pattern: `packages/lib/src/admin/stack-apply-engine.test.ts`

- **Line 10**: `import { createMockRunner } from "./compose-runner.ts";`
- **Line 100-107**: Creates a mock runner with a custom `configValidateForFile` override.
- **Line 109**: Passes it via `applyStack(manager, { apply: true, runner })`.
- No globals touched. Fully isolated. Easy to understand.

## Proposed Refactored API

### Step 1: Add a `SpawnFn` type to the shared runner

```typescript
// packages/lib/src/compose-runner.ts

export type SpawnFn = typeof Bun.spawn;
```

### Step 2: Add spawn injection to `runCompose`

```typescript
// packages/lib/src/compose-runner.ts

export type ComposeRunOptions = {
  bin: string;
  subcommand?: string;
  composeFile: string;
  envFile?: string;
  cwd?: string;
  timeoutMs?: number;
  stream?: boolean;
  retries?: number;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;                              // <-- NEW
};
```

Inside `runComposeOnce()`, use `options.spawn ?? Bun.spawn` instead of the hard-coded `Bun.spawn`:

```typescript
async function runComposeOnce(args: string[], options: ComposeRunOptions): Promise<ComposeRunResult> {
  const spawn = options.spawn ?? Bun.spawn;
  // ... existing code ...
  proc = spawn([options.bin, ...composeArgs], spawnOptions);
  // ...
}
```

### Step 3: Thread spawn through the admin compose runner

```typescript
// packages/lib/src/admin/compose-runner.ts

export function createComposeRunner(envFile?: string, spawn?: SpawnFn): ComposeRunner {
  const resolvedEnvFile = envFile ?? `${composeProjectPath()}/.env`;
  const run: RunFn = (args, composeFileOverride, stream) =>
    execCompose(args, composeFileOverride, resolvedEnvFile, stream, spawn);
  // ... rest unchanged ...
}
```

Update `execCompose` to accept and forward the spawn function:

```typescript
async function execCompose(
  args: string[],
  composeFileOverride?: string,
  envFile?: string,
  stream?: boolean,
  spawn?: SpawnFn
): Promise<ComposeResult> {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runComposeShared(args, {
    bin: composeBin(),
    subcommand: composeSubcommand(),
    composeFile,
    envFile,
    cwd: composeProjectPath(),
    env: {
      DOCKER_HOST: containerSocketUri(),
      CONTAINER_HOST: containerSocketUri(),
    },
    stream,
    spawn,         // <-- forwarded
  });
  // ...
}
```

### Step 4: Thread spawn through CLI-level compose helpers

```typescript
// packages/lib/src/compose.ts

export async function composeExec(
  config: ComposeConfig,
  args: string[],
  options?: { stream?: boolean; timeout?: number; spawn?: SpawnFn }
): Promise<{ exitCode: number; stdout: string; stderr: string; code: string }> {
  const result = await runCompose(args, {
    bin: config.bin,
    subcommand: config.subcommand,
    envFile: config.envFile,
    composeFile: config.composeFile,
    stream: options?.stream,
    timeoutMs: options?.timeout,
    spawn: options?.spawn,          // <-- forwarded
  });
  // ...
}
```

### Step 5: Rewrite tests to use injection

**`compose-runner.test.ts`** -- Use `createComposeRunner` with a mock spawn, or use `createMockRunner` where the test is about the `ComposeRunner` interface behavior:

```typescript
// For tests that need to verify spawn args / error classification:
import type { SpawnFn } from "../compose-runner.ts";

function createTestSpawn(output: (args: string[]) => string): SpawnFn {
  return ((args: string[]) => ({
    exited: Promise.resolve(0),
    exitCode: 0,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output(args)));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) { controller.close(); },
    }),
  })) as unknown as SpawnFn;
}

// Then in tests:
it("composeConfigServices parses service names from stdout", async () => {
  const spawn = createTestSpawn(() => "admin\nchannel-chat\n");
  const runner = createComposeRunner(undefined, spawn);
  const services = await runner.configServices("/state/docker-compose.yml");
  expect(services).toEqual(["admin", "channel-chat"]);
});
```

**`compose.test.ts`** -- Pass spawn via the options parameter:

```typescript
it("passes env-file and compose file args", async () => {
  let capturedArgs: string[] = [];
  const spawn = ((args: string[]) => {
    capturedArgs = args;
    return { exited: Promise.resolve(0), exitCode: 0, stdout: /*...*/, stderr: /*...*/ };
  }) as unknown as SpawnFn;

  await composeExec(config, ["ps"], { spawn });
  expect(capturedArgs).toContain("--env-file");
});
```

## All Callers That Need Updating

### Direct callers of `Bun.spawn` in compose path (the core change)

| File | Line | What to change |
|------|------|----------------|
| `packages/lib/src/compose-runner.ts` | 48 | Use `options.spawn ?? Bun.spawn` instead of `Bun.spawn` |

### Functions that need spawn threading (internal plumbing)

| File | Line(s) | Function | Change |
|------|---------|----------|--------|
| `packages/lib/src/compose-runner.ts` | 27 | `runComposeOnce` | Read `spawn` from `options` |
| `packages/lib/src/admin/compose-runner.ts` | 73 | `createComposeRunner` | Accept optional `spawn` param |
| `packages/lib/src/admin/compose-runner.ts` | 110 | `execCompose` | Accept and forward `spawn` param |
| `packages/lib/src/compose.ts` | 14 | `composeExec` | Accept optional `spawn` in options |

### Standalone convenience functions (admin compose-runner)

These functions all internally call `createComposeRunner()`. They are called from UI route handlers. They do NOT need a spawn parameter because they are production-only entry points. Their tests should use `createComposeRunner(envFile, mockSpawn)` or `createMockRunner()` instead.

| Function | File | Line |
|----------|------|------|
| `allowedServiceSet` | `packages/lib/src/admin/compose-runner.ts` | 216 |
| `composeConfigServices` | `packages/lib/src/admin/compose-runner.ts` | 223 |
| `composeConfigValidate` | `packages/lib/src/admin/compose-runner.ts` | 227 |
| `composeConfigValidateForFile` | `packages/lib/src/admin/compose-runner.ts` | 231 |
| `composeList` | `packages/lib/src/admin/compose-runner.ts` | 235 |
| `composePs` | `packages/lib/src/admin/compose-runner.ts` | 239 |
| `composePull` | `packages/lib/src/admin/compose-runner.ts` | 243 |
| `composeLogs` | `packages/lib/src/admin/compose-runner.ts` | 251 |
| `composeServiceNames` | `packages/lib/src/admin/compose-runner.ts` | 255 |
| `composeAction` | `packages/lib/src/admin/compose-runner.ts` | 264 |
| `composeStackDown` | `packages/lib/src/admin/compose-runner.ts` | 268 |
| `composeExec` (admin) | `packages/lib/src/admin/compose-runner.ts` | 272 |

These remain unchanged in signature. They are called by UI routes which never need to inject a mock spawn (they run in production only).

### UI route handlers (NO changes needed)

These call the standalone convenience functions or `applyStack` which already supports runner injection. They are production code that always uses the real `Bun.spawn`:

| File | Functions used |
|------|----------------|
| `packages/ui/src/routes/command/+server.ts` | `composeAction`, `composeList`, `composeLogs`, `composePull`, `allowedServiceSet`, `composePs`, `composeLogsValidateTail`, `applyStack` |
| `packages/ui/src/routes/stack/apply/+server.ts` | `composeAction`, `composeExec`, `applyStack` |
| `packages/ui/src/routes/setup/complete/+server.ts` | `composeAction`, `applyStack` |
| `packages/ui/src/routes/containers/+server.ts` | `composeList`, `composePull` |
| `packages/ui/src/routes/containers/update/+server.ts` | `composeAction`, `composePull` |
| `packages/ui/src/routes/containers/service-logs/+server.ts` | `composeLogs`, `composeLogsValidateTail` |
| `packages/ui/src/routes/containers/stop/+server.ts` | `composeAction` |
| `packages/ui/src/routes/containers/up/+server.ts` | `composeAction` |
| `packages/ui/src/routes/containers/restart/+server.ts` | `composeAction` |
| `packages/ui/src/routes/setup/access-scope/+server.ts` | `composeAction` |
| `packages/ui/src/routes/stack/drift/+server.ts` | `composePs` |

### Test files to rewrite (the primary goal)

| File | Lines | Change |
|------|-------|--------|
| `packages/lib/src/admin/compose-runner.test.ts` | 13-40, 96-99 | Remove all `Bun.spawn` monkey-patching. Use `createComposeRunner(envFile, mockSpawn)` or `createMockRunner()`. |
| `packages/cli/test/compose.test.ts` | 47-56, 73, 110 | Remove all `Bun.spawn` monkey-patching. Pass `spawn` via `composeExec` options. |

## Step-by-Step Implementation Instructions

### Phase 1: Add `spawn` injection to the shared runner

1. **Edit `packages/lib/src/types.ts`**:
   - Add `SpawnFn` type export: `export type SpawnFn = typeof Bun.spawn;`
   - Add `spawn?: SpawnFn` to the `ComposeRunOptions` type (after `env`).

2. **Edit `packages/lib/src/compose-runner.ts`**:
   - In `runComposeOnce` (line 27), extract spawn: `const spawn = options.spawn ?? Bun.spawn;`
   - On line 32, change `Parameters<typeof Bun.spawn>[1]` to `Parameters<SpawnFn>[1]` (or keep as is since the type is the same).
   - On line 48, change `Bun.spawn(...)` to `spawn(...)`.
   - On line 46, change `ReturnType<typeof Bun.spawn>` to `ReturnType<SpawnFn>`.
   - Import `SpawnFn` from types.

3. **Run existing tests** to confirm nothing breaks (the `spawn` param is optional, defaults to `Bun.spawn`).

### Phase 2: Thread spawn through the admin compose runner

4. **Edit `packages/lib/src/admin/compose-runner.ts`**:
   - Import `SpawnFn` from types.
   - Change `createComposeRunner(envFile?: string)` signature to `createComposeRunner(envFile?: string, spawn?: SpawnFn)`.
   - Update `execCompose` to accept an optional `spawn` parameter and forward it in the options to `runComposeShared`.
   - Update the `run` lambda inside `createComposeRunner` to pass `spawn` through to `execCompose`.
   - The `configValidateForFile` method also calls `execCompose` directly -- update that call too.

5. **Run existing tests** to confirm nothing breaks.

### Phase 3: Thread spawn through CLI-level compose helpers

6. **Edit `packages/lib/src/compose.ts`**:
   - Import `SpawnFn` from types.
   - Add `spawn?: SpawnFn` to the `options` parameter of `composeExec`.
   - Forward `spawn` in the `runCompose` options.
   - Optionally add `spawn` to other CLI functions (`composeUp`, `composeDown`, etc.) for symmetry. These are less urgent since they have no tests that monkey-patch, but for consistency it is worth doing.

7. **Run existing tests** to confirm nothing breaks.

### Phase 4: Rewrite `compose-runner.test.ts`

8. **Rewrite `packages/lib/src/admin/compose-runner.test.ts`**:
   - Remove `originalSpawn`, `beforeEach`, and `afterEach` blocks entirely.
   - Create a helper function `createTestSpawn(output)` that returns a mock `SpawnFn`.
   - For tests that exercise `ComposeRunner` methods (`composeConfigServices`, `allowedServiceSet`, `composeAction`, `composeExec`):
     - Use `createComposeRunner(undefined, mockSpawn)` to get a runner with injected spawn.
     - Call methods on the runner instance instead of standalone convenience functions.
   - For the `runCompose` daemon error test (lines 95-109):
     - Import `runCompose` from `../compose-runner.ts`.
     - Pass `spawn` in the options: `runCompose(["ps"], { ..., spawn: throwingSpawn })`.
   - Remove all `Bun.spawn =` assignments.
   - Remove all `mock.restore()` calls that were for spawn cleanup.

9. **Run the rewritten tests** to verify they pass.

### Phase 5: Rewrite `compose.test.ts`

10. **Rewrite `packages/cli/test/compose.test.ts`**:
    - Remove `originalSpawn`, `beforeEach`, and `afterEach` blocks.
    - For the "passes env-file and compose file args" test:
      - Create a mock spawn that captures args.
      - Pass it via `composeExec(config, ["ps"], { spawn: mockSpawn })`.
    - For the "returns timeout error code" test:
      - Create a hanging mock spawn.
      - Pass it via `composeExec(config, ["ps"], { timeout: 1, spawn: hangingSpawn })`.
    - Remove all `Bun.spawn =` assignments.

11. **Run the rewritten tests** to verify they pass.

### Phase 6: Re-export the type

12. **Edit `packages/lib/src/compose-runner.ts`** line 3:
    - The file already re-exports types: `export type { ComposeErrorCode, ComposeRunOptions, ComposeRunResult };`
    - Add `SpawnFn` to this re-export so consumers can import it from either location.

## Files to Modify

| File | Nature of change |
|------|-----------------|
| `packages/lib/src/types.ts` | Add `SpawnFn` type, add `spawn?` field to `ComposeRunOptions` |
| `packages/lib/src/compose-runner.ts` | Use `options.spawn ?? Bun.spawn` instead of hard-coded `Bun.spawn`; re-export `SpawnFn` |
| `packages/lib/src/admin/compose-runner.ts` | Add `spawn?` parameter to `createComposeRunner` and `execCompose` |
| `packages/lib/src/compose.ts` | Add `spawn?` to `composeExec` options and forward it |
| `packages/lib/src/admin/compose-runner.test.ts` | Full rewrite: remove monkey-patching, use DI |
| `packages/cli/test/compose.test.ts` | Full rewrite: remove monkey-patching, use DI |

## Verification Steps

1. **Run all tests in the lib package**:
   ```bash
   cd packages/lib && bun test
   ```
   Confirm all tests pass, especially `compose-runner.test.ts` and `stack-apply-engine.test.ts`.

2. **Run CLI tests**:
   ```bash
   cd packages/cli && bun test
   ```
   Confirm `compose.test.ts` passes.

3. **Run full test suite**:
   ```bash
   bun test
   ```

4. **Search for remaining monkey-patches**:
   ```bash
   grep -rn "Bun\.spawn\s*=" packages/
   ```
   This should return zero results in test files after the refactor. (It may still appear in non-test files if other modules use `Bun.spawn` directly for non-compose purposes, e.g., `preflight.ts` and `runtime.ts` -- those are out of scope for this recommendation.)

5. **Type-check**:
   ```bash
   bun run typecheck
   ```
   Confirm no type errors were introduced.

6. **Verify no test leaks state**: Run compose-runner tests in isolation and as part of the full suite. Results should be identical, confirming no global state dependency.

## Notes

- The `createMockRunner` function in `compose-runner.ts` (line 93) already exists and is the correct abstraction for tests that need a `ComposeRunner` instance. It does not need changes.
- The standalone convenience functions (`composeAction`, `composePull`, etc.) intentionally do NOT gain a `spawn` parameter. They are production-only sugar that always uses the real spawn. Tests that need to verify compose behavior should work at the `ComposeRunner` or `runCompose` level where injection is available.
- The `SpawnFn` type is added to `types.ts` (the central types file) rather than to `compose-runner.ts` to keep it co-located with `ComposeRunOptions` where it is referenced.
- This change is fully backward-compatible. All new parameters are optional with defaults matching current behavior.
