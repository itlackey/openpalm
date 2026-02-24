# Plan: Remove String-Grep Validation (`validateGeneratedCompose`)

## Summary

There are two redundant validation layers that check for `restart` and `healthcheck` properties on compose services that the generator itself always produces:

1. **`validateGeneratedCompose()`** in `stack-generator.ts` (lines 574-580) -- string-greps the serialized YAML for `"restart: unless-stopped"` and `"healthcheck:"`.
2. **`validateComposeSpec()`** in `compose-spec-serializer.ts` (lines 4-11) -- iterates the typed `ComposeSpec` object checking each service for `restart` and `healthcheck`.

Both are redundant because every service renderer function (10 total across `stack-generator.ts` and `core-services.ts`) hardcodes `restart: "unless-stopped"` and a `healthcheck` block. The tool validates its own deterministic output.

## Functions to Remove

### 1. `validateGeneratedCompose()` -- full removal

- **File**: `packages/lib/src/admin/stack-generator.ts`
- **Lines**: 574-580
- **What it does**: Calls `renderFullComposeFile(spec)` (wastefully re-rendering the entire compose file just to grep it), then string-matches for `"restart: unless-stopped"` and `"healthcheck:"`.
- **Why redundant**: Every renderer hardcodes both properties. `validateComposeSpec()` (the typed check) would already catch omissions first. Furthermore, `validateGeneratedCompose` calls `renderFullComposeFile` a second time -- doubling the rendering work for no benefit.
- **Callers**: Only one external caller, in tests.

### 2. `validateComposeSpec()` -- full removal

- **File**: `packages/lib/src/admin/compose-spec-serializer.ts`
- **Lines**: 4-11
- **What it does**: Iterates `spec.services` and checks each service has `restart` and `healthcheck`.
- **Why redundant**: Same reasoning -- every renderer hardcodes both. Validates the tool's own deterministic output at the typed-object level.
- **Callers**: Only `renderFullComposeFile()` at line 566 of `stack-generator.ts`.

## Callers That Need Updating

| File | Line(s) | Change Required |
|------|---------|-----------------|
| `packages/lib/src/admin/stack-generator.ts` | 5 | Remove `validateComposeSpec` from the import. Keep `stringifyComposeSpec`. |
| `packages/lib/src/admin/stack-generator.ts` | 566-569 | Remove the `validateComposeSpec` call and the `if (violations.length > 0) throw` block inside `renderFullComposeFile()`. |
| `packages/lib/src/admin/stack-generator.ts` | 574-580 | Delete the entire `validateGeneratedCompose()` function. |
| `packages/lib/src/admin/stack-generator.test.ts` | 2 | Remove `validateGeneratedCompose` from the import. |
| `packages/lib/src/admin/stack-generator.test.ts` | 389-393 | Delete the `"validates compose guardrails"` test case entirely. |
| `packages/lib/src/admin/compose-spec-serializer.ts` | 4-11 | Delete the `validateComposeSpec()` function. |

No other files import or reference either function.

## Optional Type-Safety Improvement

To preserve the invariant at compile time instead of runtime, make `restart` and `healthcheck` required in the `ComposeService` type:

In `packages/lib/src/admin/compose-spec.ts`:
- Line 9: change `restart?: string` to `restart: string`
- Line 17: change `healthcheck?: ComposeHealthcheck` to `healthcheck: ComposeHealthcheck`

This causes a TypeScript compilation error if any future renderer omits these fields. Optional and can be a separate follow-up.

## Test Changes

| Test file | Line(s) | Action |
|-----------|---------|--------|
| `packages/lib/src/admin/stack-generator.test.ts` | 2 | Remove `validateGeneratedCompose` from import |
| `packages/lib/src/admin/stack-generator.test.ts` | 389-393 | Delete the `"validates compose guardrails"` test block |

All other tests are unaffected. There are no direct tests for `validateComposeSpec`.

---

## Step-by-Step Implementation Order

### Step 1: Remove from test file

Edit `packages/lib/src/admin/stack-generator.test.ts`:
- Line 2: Remove `validateGeneratedCompose` from the import.
- Lines 389-393: Delete the `"validates compose guardrails"` test.

### Step 2: Remove `validateGeneratedCompose` from source

Edit `packages/lib/src/admin/stack-generator.ts`:
- Lines 574-580: Delete the entire function.

### Step 3: Remove `validateComposeSpec` call from `renderFullComposeFile`

Edit `packages/lib/src/admin/stack-generator.ts`:
- Line 5: Remove `validateComposeSpec` from import.
- Lines 566-569: Delete the validation call and throw block.

### Step 4: Remove `validateComposeSpec` from serializer

Edit `packages/lib/src/admin/compose-spec-serializer.ts`:
- Lines 4-11: Delete the function. File retains only `stringifyComposeSpec`.

### Step 5: Run tests

```bash
bun test packages/lib/src/admin/stack-generator.test.ts
bun run typecheck
bun test
```

## Risk Assessment

**Risk: Near zero.** Both functions validate invariants guaranteed by deterministic renderers. No observable behavior change.

## Net Impact

- **Lines removed**: ~20 source, ~5 test
- **Functions removed**: 2
- **Tests removed**: 1
- **Performance**: Eliminates redundant `renderFullComposeFile` call in test path
