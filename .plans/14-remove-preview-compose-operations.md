# Plan: Remove `previewComposeOperations()` (Finding 14)

## Is This Function Used?

**No. It is completely unused outside of its own definition and its own test.**

Exhaustive search found exactly four files referencing `previewComposeOperations`:

| File | Nature of Reference |
|------|-------------------|
| `packages/lib/src/admin/stack-apply-engine.ts` (line 396) | The function definition itself |
| `packages/lib/src/admin/stack-apply-engine.test.ts` (lines 9, 451, 461) | Import and test |
| `REVIEW-docker-compose-overengineering.md` (line 320) | Documentation reference |
| `docs/compose-improvements-tasks.json` (line 1075) | Task tracker reference |

No UI route, no API endpoint, no CLI command, and no other library module imports or calls it. Specifically:
- `packages/ui/src/routes/command/+server.ts` imports `applyStack` but NOT `previewComposeOperations`
- `packages/ui/src/routes/stack/apply/+server.ts` imports `applyStack` but NOT it
- No file in `packages/cli/`, `core/`, or `channels/` references it
- Not re-exported from any barrel or index file

## Recommendation: Delete Entirely

The three pieces of data it returns are all unused or available through better paths:

- **`services`**: Callers use `composeServiceNames()` directly from `compose-runner.ts`
- **`logTailLimit`**: Callers use `composeLogsValidateTail()` directly from `compose-runner.ts`
- **`reloadSemantics`**: Static metadata that duplicates knowledge in `applyStack()` itself. No consumer ever reads it.

## Files That Need Changes

### A. `packages/lib/src/admin/stack-apply-engine.ts`
- **Lines 10-11**: Remove `composeServiceNames` and `composeLogsValidateTail` from the import block (only used by `previewComposeOperations` in this file)
- **Lines 396-422**: Delete the entire `previewComposeOperations` function

### B. `packages/lib/src/admin/stack-apply-engine.test.ts`
- **Line 9**: Remove `previewComposeOperations` from the import statement (keep `applyStack`)
- **Lines 451-471**: Delete the entire `describe("previewComposeOperations", ...)` test block

### C. (Optional) `docs/compose-improvements-tasks.json`
- **Lines 1074-1081**: Update task status or delete the entry

## Test Changes

- **Delete**: The `describe("previewComposeOperations", ...)` block at lines 451-471
- **No other test affected**: No other test file imports or references it
- **No new tests needed**: Dead code removal

---

## Step-by-Step Implementation Order

### Step 1: Remove the function from `stack-apply-engine.ts`

1. Delete lines 396-422 (the entire function)
2. Remove `composeServiceNames,` from line 10 of the import block
3. Remove `composeLogsValidateTail,` from line 11 of the import block

### Step 2: Remove the test from `stack-apply-engine.test.ts`

1. Line 9: Change `import { applyStack, previewComposeOperations }` to `import { applyStack }`
2. Delete lines 451-471 (the entire describe block)

### Step 3: Run tests

```bash
bun test packages/lib/src/admin/stack-apply-engine.test.ts
bun run typecheck
bun test
```

## Risk Assessment

**Risk: None.** Clean deletion of dead code. The two helper functions it imports (`composeServiceNames`, `composeLogsValidateTail`) remain available in `compose-runner.ts` for existing consumers that already import them directly.

## Net Impact

- **Lines removed**: ~27 source + ~21 test = ~48 lines
- **Functions removed**: 1
- **Tests removed**: 1 describe block (2 test cases)
