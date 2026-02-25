# R9: Add a `resetServerState()` Utility

## Summary

Create a `resetServerState(tmpDir)` function that resets an OpenPalm state directory
to first-boot condition. The function writes a fresh `setup-state.json` with
`completed: false` and all steps `false`, then removes all generated artifacts
(`docker-compose.yml`, `caddy.json`, service `.env` files, etc.). This utility is
callable in `beforeAll` for any test group that needs first-boot state, eliminating
ad-hoc state reset patterns scattered across the test suite.

**Source**: `dev/docs/testing-architecture-review.md`, lines 454-469 (R9) and
lines 584-599 (Section 8.2 State Reset Procedure).

## Current State Structure

### `SetupState` type (from `packages/lib/src/admin/setup-manager.ts`)

```typescript
type SetupState = {
  completed: boolean;
  completedAt?: string;
  accessScope: "host" | "lan" | "public";
  serviceInstances: {
    openmemory: string;
    psql: string;
    qdrant: string;
  };
  smallModel: {
    endpoint: string;
    modelId: string;
  };
  profile: {
    name: string;
    email: string;
  };
  steps: {
    welcome: boolean;
    profile: boolean;
    accessScope: boolean;
    serviceInstances: boolean;
    healthCheck: boolean;
    security: boolean;
    channels: boolean;
    extensions: boolean;
  };
  enabledChannels: string[];
  installedExtensions: string[];
};
```

The `DEFAULT_STATE` constant in `setup-manager.ts` (lines 37-65) defines the
canonical first-boot state. The `SetupManager` constructor places `setup-state.json`
at `${dataDir}/setup-state.json`. When the file does not exist, `getState()` returns a
`structuredClone(DEFAULT_STATE)`, and `isFirstBoot()` returns `true`.

### Directory Layout

The state directory follows this structure (derived from `packages/ui/e2e/env.ts` and
`packages/lib/src/admin/stack-manager.ts`):

```
<tmpDir>/
  data/
    admin/
      setup-state.json          <-- wizard progress state
    assistant/
      .config/opencode/
        opencode.json           <-- plugin config
  config/
    openpalm.yaml               <-- stack spec
    secrets.env                 <-- user secrets
  state/
    .env                        <-- runtime env (compose interpolation vars)
    system.env                  <-- system env vars
    docker-compose.yml          <-- generated compose file
    docker-compose.yml.next     <-- temp file from applyStack validation
    caddy.json                  <-- generated Caddy config
    render-report.json          <-- last render report
    gateway/
      .env                      <-- gateway env
    openmemory/
      .env                      <-- openmemory env
    postgres/
      .env                      <-- postgres env
    qdrant/
      .env                      <-- qdrant env
    assistant/
      .env                      <-- assistant env
    <channel-name>/
      .env                      <-- per-channel env (dynamic)
    <service-name>/
      .env                      <-- per-service env (dynamic)
  cron/                         <-- automation cron files
```

### Generated Artifacts to Remove

Based on `StackManager.renderArtifacts()` (lines 462-511 of `stack-manager.ts`) and
the testing architecture review Section 8.2, these files are generated during setup:

| File | Location | Source |
|------|----------|--------|
| `setup-state.json` | `data/admin/` | `SetupManager.save()` |
| `docker-compose.yml` | `state/` | `StackManager.renderArtifacts()` |
| `docker-compose.yml.next` | `state/` | `applyStack()` temp file |
| `caddy.json` | `state/` | `StackManager.renderArtifacts()` |
| `render-report.json` | `state/` | `StackManager.renderArtifacts()` |
| `system.env` | `state/` | `StackManager.renderArtifacts()` |
| `.env` (runtime) | `state/` | `StackManager.renderArtifacts()` |
| `gateway/.env` | `state/gateway/` | `StackManager.renderArtifacts()` |
| `openmemory/.env` | `state/openmemory/` | `StackManager.renderArtifacts()` |
| `postgres/.env` | `state/postgres/` | `StackManager.renderArtifacts()` |
| `qdrant/.env` | `state/qdrant/` | `StackManager.renderArtifacts()` |
| `assistant/.env` | `state/assistant/` | `StackManager.renderArtifacts()` |
| `<channel>/.env` | `state/<channel>/` | `StackManager.renderArtifacts()` per channel |
| `<service>/.env` | `state/<service>/` | `StackManager.renderArtifacts()` per service |
| `openpalm.yaml` | `config/` | `StackManager.setSpec()` |
| `secrets.env` | `config/` | `StackManager.upsertSecret()` |

## Existing Patterns in the Codebase

### 1. `withTempDir` in `setup-manager.test.ts`

```typescript
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-manager-"));
  try { fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
```

Creates isolated temp dirs per test. Good for unit tests but does not reset to a
known state within a persistent directory.

### 2. `createTempDir()` in `packages/ui/e2e/env.ts`

Creates a full directory tree with empty seed files. This is a "create from scratch"
approach that seeds required directories and empty files. It does not handle resetting
an already-populated directory.

### 3. `dev/reset-wizard-state.sh`

Shell script that resets `.dev/data/admin/setup-state.json` and clears
`.dev/state/.env`. Only handles the wizard state file and runtime env -- does not
clean generated compose/Caddy/service artifacts.

### 4. `setup-wizard-gate.contract.test.ts` save/restore

Saves the current state file content, manipulates it, then restores in `afterAll`.
Fragile and only handles `setup-state.json`.

## Proposed Implementation

### File Location

**`packages/lib/src/admin/test-utils.ts`**

This is the right location because:
- `packages/lib` is the shared source of truth (per `AGENTS.md`)
- The utility depends on `SetupState` and `DEFAULT_STATE` from `setup-manager.ts` (same package)
- Both `packages/ui/e2e/` tests, `test/contracts/` tests, and future test suites can import it
- It follows the existing pattern of admin utilities in `packages/lib/src/admin/`

### Export `DEFAULT_STATE` from `setup-manager.ts`

Currently `DEFAULT_STATE` is a module-private `const`. The utility needs to reference
it to write a correct first-boot state. Two options:

- **Option A (recommended):** Export `DEFAULT_STATE` from `setup-manager.ts` so
  `test-utils.ts` can import and use the canonical source of truth. This avoids
  duplicating the default state shape.
- **Option B:** Duplicate the default state object in `test-utils.ts`. This is fragile
  and will drift if `SetupState` is extended.

### Function Signature

```typescript
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STATE } from "./setup-manager.ts";

/**
 * Layout descriptor matching the directory conventions used by StackManager
 * and the E2E test harness. All paths are relative to `tmpDir`.
 */
export type ServerDirLayout = {
  dataAdmin: string;       // "data/admin"
  stateRoot: string;       // "state"
  config: string;          // "config"
};

const DEFAULT_LAYOUT: ServerDirLayout = {
  dataAdmin: "data/admin",
  stateRoot: "state",
  config: "config",
};

/**
 * Generated artifacts that are removed during reset.
 * Relative to stateRoot unless noted otherwise.
 */
const STATE_ARTIFACTS = [
  "docker-compose.yml",
  "docker-compose.yml.next",
  "caddy.json",
  "render-report.json",
  "system.env",
  ".env",
] as const;

/**
 * Known service subdirectories under stateRoot that contain generated .env files.
 */
const SERVICE_ENV_DIRS = [
  "gateway",
  "openmemory",
  "postgres",
  "qdrant",
  "assistant",
] as const;

/**
 * Resets the server state directory to first-boot condition.
 *
 * - Writes a fresh `setup-state.json` with `completed: false` and all steps `false`
 * - Removes generated artifacts (docker-compose.yml, caddy.json, service .env files, etc.)
 * - Removes the stack spec (openpalm.yaml) and secrets.env
 * - Preserves the directory structure itself (directories are not removed)
 *
 * Callable in `beforeAll` for any test group that needs first-boot state.
 *
 * @param tmpDir - Root of the test directory tree
 * @param layout - Optional layout override (defaults match E2E conventions)
 */
export function resetServerState(
  tmpDir: string,
  layout: Partial<ServerDirLayout> = {},
): void {
  const dirs = { ...DEFAULT_LAYOUT, ...layout };

  const dataAdminDir = join(tmpDir, dirs.dataAdmin);
  const stateRootDir = join(tmpDir, dirs.stateRoot);
  const configDir = join(tmpDir, dirs.config);

  // 1. Write fresh first-boot setup-state.json
  mkdirSync(dataAdminDir, { recursive: true });
  writeFileSync(
    join(dataAdminDir, "setup-state.json"),
    JSON.stringify(structuredClone(DEFAULT_STATE), null, 2),
    "utf8",
  );

  // 2. Remove generated state artifacts
  for (const artifact of STATE_ARTIFACTS) {
    rmSync(join(stateRootDir, artifact), { force: true });
  }

  // 3. Remove known service .env files
  for (const svcDir of SERVICE_ENV_DIRS) {
    rmSync(join(stateRootDir, svcDir, ".env"), { force: true });
  }

  // 4. Remove dynamically-generated channel/service .env files
  //    Any subdirectory of stateRoot not in SERVICE_ENV_DIRS that contains a .env
  if (existsSync(stateRootDir)) {
    for (const entry of readdirSync(stateRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if ((SERVICE_ENV_DIRS as readonly string[]).includes(entry.name)) continue;
      rmSync(join(stateRootDir, entry.name, ".env"), { force: true });
    }
  }

  // 5. Remove config artifacts (stack spec and secrets)
  rmSync(join(configDir, "openpalm.yaml"), { force: true });
  rmSync(join(configDir, "secrets.env"), { force: true });
}
```

### Companion: `createTestDirLayout()`

For tests that also need the initial directory scaffolding (not just reset), provide a
companion helper that mirrors what `packages/ui/e2e/env.ts` does today. This is
optional for R9 but prevents duplication across test suites.

```typescript
/**
 * Creates a fresh temp directory with the full OpenPalm directory layout,
 * seeded with empty files where required. Returns the root path.
 *
 * The caller is responsible for cleanup (e.g. in afterAll with rmSync).
 */
export function createTestDirLayout(prefix = "openpalm-test-"): string {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));

  const dataAdmin = join(tmpDir, "data", "admin");
  const stateRoot = join(tmpDir, "state");
  const configDir = join(tmpDir, "config");
  const cronDir = join(tmpDir, "cron");
  const opencodeDir = join(tmpDir, "data", "assistant", ".config", "opencode");

  for (const svc of SERVICE_ENV_DIRS) {
    mkdirSync(join(stateRoot, svc), { recursive: true });
  }
  for (const d of [dataAdmin, configDir, cronDir, opencodeDir]) {
    mkdirSync(d, { recursive: true });
  }

  // Seed empty files that services expect to exist
  writeFileSync(join(configDir, "secrets.env"), "", "utf8");
  writeFileSync(join(stateRoot, ".env"), "", "utf8");
  writeFileSync(join(stateRoot, "system.env"), "", "utf8");
  for (const svc of SERVICE_ENV_DIRS) {
    writeFileSync(join(stateRoot, svc, ".env"), "", "utf8");
  }
  writeFileSync(join(opencodeDir, "opencode.json"), '{\n  "plugin": []\n}\n', "utf8");

  return tmpDir;
}
```

## Step-by-Step Implementation Instructions

### Step 1: Export `DEFAULT_STATE` from `setup-manager.ts`

**File:** `packages/lib/src/admin/setup-manager.ts`

Change line 37 from:
```typescript
const DEFAULT_STATE: SetupState = {
```
to:
```typescript
export const DEFAULT_STATE: SetupState = {
```

This is a backward-compatible change. No existing code depends on `DEFAULT_STATE`
being private. The `SetupManager` class uses it internally via `structuredClone()`,
which is safe regardless of the export.

### Step 2: Create `packages/lib/src/admin/test-utils.ts`

Create the file with:
- `resetServerState(tmpDir, layout?)` -- the primary utility from R9
- `createTestDirLayout(prefix?)` -- optional companion for creating fresh temp dirs
- `ServerDirLayout` type export
- Constants for `STATE_ARTIFACTS` and `SERVICE_ENV_DIRS`

Use the implementation shown in the "Function Signature" section above.

### Step 3: Create `packages/lib/src/admin/test-utils.test.ts`

Write tests that verify:

1. **`resetServerState` writes a correct first-boot `setup-state.json`:**
   - Create a temp dir with a completed setup-state.json
   - Call `resetServerState(tmpDir)`
   - Read `setup-state.json`, parse it, verify `completed === false` and all steps are
     `false`

2. **`resetServerState` removes generated artifacts:**
   - Create a temp dir with dummy `docker-compose.yml`, `caddy.json`,
     `render-report.json`, `system.env`, `.env`, and `docker-compose.yml.next` in the
     `state/` directory
   - Call `resetServerState(tmpDir)`
   - Verify all those files no longer exist

3. **`resetServerState` removes service .env files:**
   - Create `.env` files in `state/gateway/`, `state/openmemory/`, `state/postgres/`,
     `state/qdrant/`, `state/assistant/`
   - Call `resetServerState(tmpDir)`
   - Verify all `.env` files are gone

4. **`resetServerState` removes dynamically generated channel .env files:**
   - Create `state/channel-discord/.env` and `state/service-custom/.env`
   - Call `resetServerState(tmpDir)`
   - Verify those `.env` files are gone
   - Verify the directories themselves still exist (only files are removed)

5. **`resetServerState` removes config artifacts:**
   - Create `config/openpalm.yaml` and `config/secrets.env`
   - Call `resetServerState(tmpDir)`
   - Verify both files are gone

6. **`resetServerState` is idempotent:**
   - Call `resetServerState(tmpDir)` twice on the same directory
   - No errors on the second call

7. **`resetServerState` works on an empty directory:**
   - Create a bare temp dir (no subdirectories)
   - Call `resetServerState(tmpDir)`
   - Verify `setup-state.json` was created at the correct location

8. **`createTestDirLayout` creates the expected directory tree:**
   - Call `createTestDirLayout()`
   - Verify all expected directories exist
   - Verify all seed files exist with expected content

Test file structure:
```typescript
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetServerState, createTestDirLayout } from "./test-utils.ts";
import { DEFAULT_STATE } from "./setup-manager.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-test-utils-"));
  try { fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("resetServerState", () => {
  // ... tests as described above
});

describe("createTestDirLayout", () => {
  // ... tests as described above
});
```

### Step 4: Export from package entry point (if needed)

Check whether `packages/lib` has a barrel export for admin modules. If so, add
`test-utils.ts` exports. If not (most likely), consumers will import directly:

```typescript
import { resetServerState, createTestDirLayout } from "@openpalm/lib/admin/test-utils";
```

or with relative paths:

```typescript
import { resetServerState } from "../../packages/lib/src/admin/test-utils.ts";
```

### Step 5: Migrate existing ad-hoc reset patterns (follow-up)

Once the utility exists, these files can be updated to use it. This is **not part of
R9 itself** but is the expected follow-up:

| File | Current pattern | Migration |
|------|----------------|-----------|
| `test/contracts/setup-wizard-gate.contract.test.ts` | Manual save/restore of `setup-state.json` | Use `resetServerState()` in `beforeAll` (note: this test talks to a live server, so it needs the `.dev/` directory, not a temp dir -- R2 addresses this separately) |
| `packages/ui/e2e/env.ts` | `createTempDir()` inline | Replace with `createTestDirLayout()` + `resetServerState()` |
| `dev/reset-wizard-state.sh` | Shell script for manual resets | Keep for manual use but note that `resetServerState()` is the programmatic equivalent |

## Integration with Existing Test Infrastructure

### How tests will use `resetServerState()`

**Pattern 1: Unit/integration tests with `mkdtempSync`**

```typescript
import { resetServerState, createTestDirLayout } from "@openpalm/lib/admin/test-utils";

let tmpDir: string;

beforeAll(() => {
  tmpDir = createTestDirLayout("my-test-");
  // ... run setup operations that populate state ...
});

beforeEach(() => {
  // Reset to first-boot between test cases
  resetServerState(tmpDir);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Pattern 2: Playwright E2E tests**

```typescript
import { resetServerState } from "@openpalm/lib/admin/test-utils";
import { TMP_DIR } from "./env";

test.beforeAll(async () => {
  resetServerState(TMP_DIR);
  // Verify clean state
  const status = await fetch(`${BASE_URL}/setup/status`);
  const body = await status.json();
  expect(body.firstBoot).toBe(true);
});
```

**Pattern 3: Contract tests with live server**

For tests that operate against the dev stack's `.dev/` directory, `resetServerState()`
would be called with the repo root's `.dev/` as `tmpDir`, using a layout override:

```typescript
resetServerState(repoRoot, {
  dataAdmin: ".dev/data/admin",
  stateRoot: ".dev/state",
  config: ".dev/config",
});
```

### Relationship to `SetupManager`

`resetServerState()` is intentionally a standalone function, not a method on
`SetupManager`. The `SetupManager` manages wizard state for a running server; the
test utility operates at a lower level, cleaning file-system state that spans
multiple managers (`SetupManager`, `StackManager`, secrets, cron). This separation
keeps the production code clean and the test utility focused.

## Verification Steps

After implementation, verify:

1. **`bun test packages/lib/src/admin/test-utils.test.ts`** -- all tests pass
2. **`bun test packages/lib`** -- no regressions in existing admin tests
3. **`bun run typecheck`** -- no type errors from the new export of `DEFAULT_STATE`
4. **Manual verification**: In a node REPL or throwaway script, call
   `resetServerState()` on a populated `.dev/` directory and confirm:
   - `setup-state.json` has `completed: false` and all steps `false`
   - `docker-compose.yml`, `caddy.json`, and service `.env` files are gone
   - `openpalm.yaml` and `secrets.env` are gone
   - Directory structure is preserved
5. **Import check**: Verify that `import { resetServerState } from "@openpalm/lib/admin/test-utils"` resolves correctly from both `packages/ui/e2e/` and `test/contracts/`

## Files Changed

| File | Change |
|------|--------|
| `packages/lib/src/admin/setup-manager.ts` | Export `DEFAULT_STATE` |
| `packages/lib/src/admin/test-utils.ts` | **New file** -- `resetServerState()`, `createTestDirLayout()`, types |
| `packages/lib/src/admin/test-utils.test.ts` | **New file** -- tests for the utilities |

## Estimated Effort

1-2 hours. The implementation is straightforward file-system operations with no
external dependencies. The bulk of the work is writing thorough tests.
