# R3: Fix Relative Path in `admin-api.contract.test.ts`

## Problem Summary

`test/contracts/admin-api.contract.test.ts` uses a bare relative path (`"dev/docs/api-reference.md"`) in its `readFileSync` call. This path is resolved relative to the **current working directory** at runtime, not relative to the test file's location on disk. The test only passes when `bun test` is invoked from the repository root.

This is fragile because:
- Running `bun test test/contracts/admin-api.contract.test.ts` from a subdirectory will fail with `ENOENT`.
- CI jobs that change `cwd` before running tests will break this test silently.
- It violates the pattern used by every other test file in the project, all of which anchor paths to `import.meta.dir`.

The fix is a one-line change: anchor the path to the test file's directory using `join(import.meta.dir, ...)`, matching the established convention.

## Scope

**Files to modify:** 1

This is the only test file in the codebase with a CWD-dependent bare relative path. All other test files already use `import.meta.dir`:

| File | Path anchoring | Status |
|------|---------------|--------|
| `test/contracts/admin-api.contract.test.ts` | `readFileSync("dev/docs/api-reference.md", ...)` | **Broken** (CWD-dependent) |
| `test/contracts/readme-no-npx.test.ts` | `join(import.meta.dir, "..", "..", "README.md")` | OK |
| `test/contracts/setup-wizard-gate.contract.test.ts` | `resolve(execSync("git rev-parse ..."), "..")` | OK (git-root anchored) |
| `packages/cli/test/main.test.ts` | `join(import.meta.dir, "../../..")` | OK |
| `packages/cli/test/install-methods.test.ts` | `join(import.meta.dir, "../../..")` | OK |
| `packages/cli/test/domain-commands.test.ts` | `join(import.meta.dir, "../src/commands")` | OK |
| `packages/cli/test/management-commands.test.ts` | `join(import.meta.dir, "../src")` | OK |
| `packages/cli/test/install.test.ts` | `join(import.meta.dir, "../src/commands/install.ts")` | OK |
| `packages/cli/test/admin-command.test.ts` | `join(import.meta.dir, "../src/commands/admin.ts")` | OK |
| `packages/cli/test/uninstall-extensions.test.ts` | `join(import.meta.dir, "../src/commands")` | OK |
| `packages/cli/test/runtime.test.ts` | `join(import.meta.dir, "..", "..", "lib", "src", ...)` | OK |

## Current Code

**File:** `test/contracts/admin-api.contract.test.ts`

```typescript
// Line 1-2:
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Line 8 (inside the test body):
const docs = readFileSync("dev/docs/api-reference.md", "utf8");
```

The path `"dev/docs/api-reference.md"` is resolved relative to `process.cwd()`. The actual relationship between the test file and the target file is:

```
test/contracts/admin-api.contract.test.ts  (test file)
     ../../dev/docs/api-reference.md       (target, relative to test file)
```

## Implementation Steps

### Step 1: Add `join` import from `node:path`

**File:** `test/contracts/admin-api.contract.test.ts`
**Line 2**

Change:
```typescript
import { readFileSync } from "node:fs";
```

To:
```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

### Step 2: Replace bare relative path with `import.meta.dir`-anchored path

**File:** `test/contracts/admin-api.contract.test.ts`
**Line 8**

Change:
```typescript
    const docs = readFileSync("dev/docs/api-reference.md", "utf8");
```

To:
```typescript
    const docs = readFileSync(join(import.meta.dir, "../../dev/docs/api-reference.md"), "utf8");
```

### Final State

The complete file after both changes:

```typescript
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("admin API documentation parity", () => {
  // NOTE: This is a docs-parity test, not a behavioral contract test.
  // It verifies that key endpoints are documented, not that they work.
  it("documents current admin endpoints in api-reference.md", () => {
    const docs = readFileSync(join(import.meta.dir, "../../dev/docs/api-reference.md"), "utf8");
    expect(docs.includes("/setup/status")).toBe(true);
    expect(docs.includes("/command")).toBe(true);
    expect(docs.includes("/state")).toBe(true);
    expect(docs.includes("/plugins/install")).toBe(true);
    expect(docs.includes("/secrets")).toBe(true);
    expect(docs.includes("/connections")).toBe(false);
    expect(docs.includes("/automations")).toBe(true);
    expect(docs.includes("/providers")).toBe(false);
    expect(docs.includes("/stack/spec")).toBe(false);
  });
});
```

## Verification Steps

1. **Run the test from the repo root** (should pass, same as before):
   ```bash
   bun test test/contracts/admin-api.contract.test.ts
   ```

2. **Run the test from a subdirectory** (should now pass; would have failed before):
   ```bash
   cd test/contracts && bun test admin-api.contract.test.ts
   ```

3. **Run all contract tests together** to confirm no regressions:
   ```bash
   bun test test/contracts/
   ```

4. **Run the full test suite** to confirm nothing else is affected:
   ```bash
   bun test
   ```

## Risk Assessment

**Risk: None.** This is a two-line change (one new import, one path string replacement) in a single test file. The behavior of the test is identical when run from the repo root. The only difference is that it now also works correctly when run from any other directory.
