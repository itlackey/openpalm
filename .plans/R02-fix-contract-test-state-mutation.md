# R2: Fix `setup-wizard-gate.contract.test.ts` State Mutation

## Summary

The contract test `test/contracts/setup-wizard-gate.contract.test.ts` reads and writes
directly to `.dev/data/admin/setup-state.json` -- the same state file used by the
running dev stack's admin container. This creates two problems:

1. **Shared mutable state**: The test deletes and overwrites the real setup state file
   on the host, which is bind-mounted into the admin container. If the test crashes or
   is interrupted before `afterAll` runs, the dev environment's setup state is
   permanently corrupted.

2. **Save/restore fragility**: The `beforeAll`/`afterAll` save-and-restore pattern
   (lines 19-31) is a best-effort guard. It does not protect against process signals,
   test timeouts, or partial writes. It also introduces a race condition if the admin
   container reads or writes the file between the test's delete and restore.

The recommendation is to use `mkdtempSync` to create an isolated temporary directory
for each test run, following the pattern already established in
`packages/lib/src/admin/setup-manager.test.ts`.

**However**, there is an important nuance: this is a *contract test* that makes HTTP
requests to a running admin server at `http://localhost:8100`. The admin server reads
its state from the bind-mounted `.dev/data/admin/` directory -- NOT from a temp
directory the test controls. Therefore, the fix must address the fact that the test
needs to manipulate the file the server actually reads, while minimizing risk to the
dev environment.

## Current Problematic Code

**File**: `test/contracts/setup-wizard-gate.contract.test.ts`

### Lines 9-16: Shared state file path and save variable
```typescript
const repoRoot = resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim(), "..");
const STATE_FILE_HOST = resolve(repoRoot, ".dev/data/admin/setup-state.json");

const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

let savedState: string | null = null;
```

### Lines 18-32: Fragile save/restore in beforeAll/afterAll
```typescript
describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    if (existsSync(STATE_FILE_HOST)) {
      savedState = readFileSync(STATE_FILE_HOST, "utf8");
    }
  });

  afterAll(() => {
    if (savedState !== null) {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(STATE_FILE_HOST, savedState, "utf8");
    } else if (existsSync(STATE_FILE_HOST)) {
      rmSync(STATE_FILE_HOST);
    }
  });
```

### Lines 34-36: Direct deletion of the real state file
```typescript
  describe("first boot (no state file)", () => {
    beforeAll(() => {
      if (existsSync(STATE_FILE_HOST)) rmSync(STATE_FILE_HOST);
    });
```

### Lines 73-94: Direct write to the real state file
```typescript
  describe("after setup is complete", () => {
    beforeAll(() => {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(
        STATE_FILE_HOST,
        JSON.stringify({
          completed: true,
          completedAt: new Date().toISOString(),
          // ... full state object ...
        }),
        "utf8"
      );
    });
```

## Pattern to Follow

**File**: `packages/lib/src/admin/setup-manager.test.ts`, lines 1-16

```typescript
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Helper: create a temp directory, run the test body, then clean up regardless
// of success or failure.
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-setup-manager-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Key properties of this pattern:
- Each test gets its own fresh, isolated directory via `mkdtempSync`
- Cleanup happens in a `finally` block, so it runs even on test failure
- No shared mutable state between tests or with the dev environment
- The temp directory prefix makes it easy to identify orphaned dirs

## Implementation Approach

Because this is a **contract test** that exercises a running admin server via HTTP, and
the admin server reads state from the bind-mounted `.dev/data/admin/` path, we cannot
simply redirect the test to a temp directory that the server never sees. The approach
must be:

1. **Keep the host-path writes** (the server must see them), but wrap them in a robust
   `withSavedState` helper that uses `try/finally` to guarantee restoration.
2. **Use `mkdtempSync` for the backup**, not an in-memory variable. This way the
   original state survives even if the test process is killed, because the backup is a
   file on disk in a temp directory.

This gives us the isolation and safety benefits of the `mkdtempSync` pattern while
preserving the contract test's need to manipulate the file the server actually reads.

## Step-by-Step Implementation

### Step 1: Add the `withSavedState` helper

Add a helper function at the top of the test file (after imports) that:
- Creates a temp directory with `mkdtempSync`
- If the real state file exists, copies it into the temp directory as a backup
- Runs the provided test setup/teardown function
- In a `finally` block: restores the backup (or removes the state file if none existed)
  and cleans up the temp directory

### Step 2: Remove the module-level `savedState` variable

The `let savedState: string | null = null;` variable on line 16 is replaced by the
file-based backup inside the `withSavedState` helper.

### Step 3: Replace the outer `beforeAll`/`afterAll` with the helper

Replace the save/restore logic in the outer `describe` block with the new helper
wrapping each inner `describe` block's `beforeAll`.

### Step 4: Verify the test still passes

Run the contract test with `OPENPALM_INTEGRATION=1` to confirm the server still
receives the correct state file mutations and responds as expected.

## Files to Modify

### `test/contracts/setup-wizard-gate.contract.test.ts`

This is the only file that needs changes.

#### Change 1: Update imports (line 2)

**Old:**
```typescript
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
```

**New:**
```typescript
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
```

#### Change 2: Remove module-level `savedState` variable (line 16)

**Remove:**
```typescript
let savedState: string | null = null;
```

#### Change 3: Add the `withSavedState` helper (after line 14, before the describe)

**Add:**
```typescript
// Helper: back up the real state file before a contract test mutates it, and
// guarantee restoration afterward -- even if the test throws. The backup lives
// in a mkdtempSync directory so it survives process crashes better than an
// in-memory variable.
function withSavedState(fn: () => void): void {
  const backupDir = mkdtempSync(join(tmpdir(), "openpalm-contract-setup-"));
  const backupFile = join(backupDir, "setup-state.json.bak");
  const hadFile = existsSync(STATE_FILE_HOST);
  if (hadFile) {
    copyFileSync(STATE_FILE_HOST, backupFile);
  }
  try {
    fn();
  } finally {
    if (hadFile) {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      copyFileSync(backupFile, STATE_FILE_HOST);
    } else if (existsSync(STATE_FILE_HOST)) {
      rmSync(STATE_FILE_HOST);
    }
    rmSync(backupDir, { recursive: true, force: true });
  }
}
```

#### Change 4: Remove the outer `beforeAll`/`afterAll` save-restore block (lines 19-32)

**Old:**
```typescript
describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    if (existsSync(STATE_FILE_HOST)) {
      savedState = readFileSync(STATE_FILE_HOST, "utf8");
    }
  });

  afterAll(() => {
    if (savedState !== null) {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(STATE_FILE_HOST, savedState, "utf8");
    } else if (existsSync(STATE_FILE_HOST)) {
      rmSync(STATE_FILE_HOST);
    }
  });
```

**New:**
```typescript
describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
```

#### Change 5: Wrap the "first boot" `beforeAll` with `withSavedState` (lines 34-36)

**Old:**
```typescript
  describe("first boot (no state file)", () => {
    beforeAll(() => {
      if (existsSync(STATE_FILE_HOST)) rmSync(STATE_FILE_HOST);
    });
```

**New:**
```typescript
  describe("first boot (no state file)", () => {
    beforeAll(() => {
      withSavedState(() => {
        if (existsSync(STATE_FILE_HOST)) rmSync(STATE_FILE_HOST);
      });
    });
```

Wait -- this will not work as intended. `withSavedState` would restore the file
immediately after the `fn()` call returns, before the actual test `it()` blocks run.
The `beforeAll` just sets up state; the tests run later.

**Revised approach**: Use `beforeAll` / `afterAll` pairs that leverage the temp-dir
backup, but keep the structure compatible with bun:test's async lifecycle.

#### Revised Change 3: Add a backup/restore pair helper

Instead of a single wrapping function, provide a pair of functions that `beforeAll`
and `afterAll` call respectively:

```typescript
// Backup/restore helpers for the real state file. The backup is stored in a
// mkdtempSync directory so it persists on disk (safer than an in-memory variable
// if the process is killed). Each describe block that mutates STATE_FILE_HOST
// should call backupState() in beforeAll and restoreState() in afterAll.
let _backupDir: string | null = null;
let _hadFile = false;

function backupState(): void {
  _backupDir = mkdtempSync(join(tmpdir(), "openpalm-contract-setup-"));
  _hadFile = existsSync(STATE_FILE_HOST);
  if (_hadFile) {
    copyFileSync(STATE_FILE_HOST, join(_backupDir, "setup-state.json.bak"));
  }
}

function restoreState(): void {
  if (!_backupDir) return;
  const backupFile = join(_backupDir, "setup-state.json.bak");
  if (_hadFile && existsSync(backupFile)) {
    mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
    copyFileSync(backupFile, STATE_FILE_HOST);
  } else if (existsSync(STATE_FILE_HOST)) {
    rmSync(STATE_FILE_HOST);
  }
  rmSync(_backupDir, { recursive: true, force: true });
  _backupDir = null;
}
```

#### Revised Change 4: Replace outer beforeAll/afterAll (lines 18-32)

**Old:**
```typescript
describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    if (existsSync(STATE_FILE_HOST)) {
      savedState = readFileSync(STATE_FILE_HOST, "utf8");
    }
  });

  afterAll(() => {
    if (savedState !== null) {
      mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
      writeFileSync(STATE_FILE_HOST, savedState, "utf8");
    } else if (existsSync(STATE_FILE_HOST)) {
      rmSync(STATE_FILE_HOST);
    }
  });
```

**New:**
```typescript
describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    backupState();
  });

  afterAll(() => {
    restoreState();
  });
```

The inner `describe` blocks (`"first boot"` and `"after setup is complete"`) remain
unchanged -- they still mutate `STATE_FILE_HOST` directly because the admin server
needs to see those mutations. The key improvement is that the backup is now a file on
disk in a temp directory, not an in-memory string variable.

#### No changes needed to inner describe blocks

Lines 34-36 ("first boot") and lines 73-94 ("after setup is complete") remain as-is.
They still mutate the real state file, which is required for the contract test to work.

## Final File After Changes

The complete modified file should look like:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";

const repoRoot = resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim(), "..");
const STATE_FILE_HOST = resolve(repoRoot, ".dev/data/admin/setup-state.json");

const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

// Backup/restore helpers for the real state file. The backup is stored in a
// mkdtempSync directory so it persists on disk (safer than an in-memory variable
// if the process is killed). The outer describe block calls backupState() in
// beforeAll and restoreState() in afterAll.
let _backupDir: string | null = null;
let _hadFile = false;

function backupState(): void {
  _backupDir = mkdtempSync(join(tmpdir(), "openpalm-contract-setup-"));
  _hadFile = existsSync(STATE_FILE_HOST);
  if (_hadFile) {
    copyFileSync(STATE_FILE_HOST, join(_backupDir, "setup-state.json.bak"));
  }
}

function restoreState(): void {
  if (!_backupDir) return;
  const backupFile = join(_backupDir, "setup-state.json.bak");
  if (_hadFile && existsSync(backupFile)) {
    mkdirSync(dirname(STATE_FILE_HOST), { recursive: true });
    copyFileSync(backupFile, STATE_FILE_HOST);
  } else if (existsSync(STATE_FILE_HOST)) {
    rmSync(STATE_FILE_HOST);
  }
  rmSync(_backupDir, { recursive: true, force: true });
  _backupDir = null;
}

describe.skipIf(!stackAvailable)("contract: setup wizard gate", () => {
  beforeAll(() => {
    backupState();
  });

  afterAll(() => {
    restoreState();
  });

  // ... rest of the file unchanged (inner describe blocks, it blocks, etc.) ...
});
```

## Verification Steps

1. **Type check**: Run `bun run typecheck` from the repo root and confirm no new errors.

2. **Unit tests pass**: Run `bun test` from the repo root. The contract test will be
   skipped (it requires `OPENPALM_INTEGRATION=1`), but ensure no import errors.

3. **Contract test passes with stack**: Start the dev stack (`bun run dev:up`), then run:
   ```bash
   OPENPALM_INTEGRATION=1 bun test test/contracts/setup-wizard-gate.contract.test.ts
   ```
   All assertions should pass.

4. **State file restored after test**: After the contract test completes, verify that
   `.dev/data/admin/setup-state.json` has the same content it had before the test ran
   (or is absent if it was absent before).

5. **State file restored after failure**: Temporarily break one of the test assertions
   to force a failure, run the contract test, and verify the state file is still
   properly restored.

6. **No orphaned temp dirs**: After running the test, check `/tmp/` for
   `openpalm-contract-setup-*` directories. There should be none (cleanup succeeded).

## Changes Summary

| What | Where | Description |
|---|---|---|
| Update imports | Line 2-3 | Add `copyFileSync`, `mkdtempSync`; add `tmpdir` from `node:os`; add `join` from `node:path`; remove `readFileSync` |
| Remove `savedState` variable | Line 16 | No longer needed; backup is file-based |
| Add `backupState`/`restoreState` helpers | After line 14 | File-based backup using `mkdtempSync` |
| Simplify outer `beforeAll`/`afterAll` | Lines 19-32 | Call `backupState()` and `restoreState()` |
| Inner describe blocks | Lines 34-128 | No changes needed |
