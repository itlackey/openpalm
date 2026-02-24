# Plan 07: Consolidate Validation

## Problem Statement

Validation logic is duplicated across multiple files. Stack spec validation exists in 3 places. Compose output validation exists in 4 forms. This plan eliminates the redundancy.

## Current State Analysis

### Stack Spec Validation (3 forms)

| Form | File | Lines | Production consumers |
|------|------|-------|---------------------|
| `parseStackSpec()` | `stack-spec.ts:352-383` | ~31 (+ helpers) | Used throughout all spec loading paths |
| `stackSpecSchema` | `schemas/stack-spec.schema.ts:85-123` | 123 | **Test-only** |
| `validateStackSpec()` | `schema-validation.ts:13-24` | 12 | **Test-only** |

### Compose Output Validation (4 forms)

| Form | File | Lines | Production consumers |
|------|------|-------|---------------------|
| `validateComposeSpec()` | `compose-spec-serializer.ts:4-11` | 8 | `stack-generator.ts:566` |
| `validateComposeFile()` | `schema-validation.ts:110-156` | 47 | **Test-only** |
| `composeConfigValidate()` | `compose-runner.ts:126-132` | 7 | `stack-apply-engine.ts` (4 call sites) |
| `validateGeneratedCompose()` | `stack-generator.ts:574-580` | 7 | **Test-only** |

### Key Finding: No Production Consumers Outside Tests

The `schema-validation.ts` module, the `schemas/` directory, and `validateGeneratedCompose()` have **zero production consumers**. They are imported exclusively in test files. The `ajv` and `ajv-formats` packages are listed under `devDependencies`, confirming the JSON Schema is test-only infrastructure.

## Decision: What to Keep

### Single source of truth for input validation
- **`parseStackSpec()`** in `stack-spec.ts:352-383` -- Boundary validator for all user and snippet input. Keep as-is.

### Single source of truth for output validation
- **`composeConfigValidate()` / `composeConfigValidateForFile()`** in `compose-runner.ts:126-132` -- Delegates to `docker compose config`. Keep as-is.

### Serializer function only
- **`stringifyComposeSpec()`** in `compose-spec-serializer.ts:13-15` -- Keep. Remove `validateComposeSpec()` from same file.

### JSON Schemas (demoted to test-only documentation)
- **`schemas/stack-spec.schema.ts`** and **`schemas/caddy-config.schema.ts`** -- Useful for test-time cross-validation. Low cost to keep. Mark as test-only.

## What to Remove

### 1. `validateComposeSpec()` from `compose-spec-serializer.ts`

- **Lines**: 4-11
- **Rationale**: Checks `restart` and `healthcheck` on services the generator always produces. Every renderer hardcodes both.
- **Consumer**: `stack-generator.ts:5` (import) and `stack-generator.ts:566-569` (call + throw)

### 2. `validateGeneratedCompose()` from `stack-generator.ts`

- **Lines**: 574-580
- **Rationale**: String-greps serialized YAML for `"restart: unless-stopped"` and `"healthcheck:"`. Weaker duplicate of above.
- **Consumer**: `stack-generator.test.ts:2` (import) and test at lines 389-393

### 3. Entire `schema-validation.ts` (157 lines)

- **`validateStackSpec()`** -- trivial wrapper around `parseStackSpec()`. Zero production consumers.
- **`validateCaddyConfig()`** -- 74 lines of hand-written structural validation. Zero production consumers. ajv schema does same job.
- **`validateComposeFile()`** -- 47 lines of YAML parsing + allowlist. Zero production consumers. `docker compose config` is authoritative.
- **`ValidationResult` type** -- not imported anywhere else. Disappears with file.

## Test Changes

### `schema-validation.test.ts` -- Restructure

**Tests to relocate** (11 tests → new `schemas/schemas.test.ts`):
- `describe("ajv schema validation of generated output")` (5 tests, lines 66-141)
- `describe("seed caddy.json validation")` (3 tests, lines 259-312)
- `describe("compose helpers")` (3 tests, lines 314-332)

**Tests to remove** (16 tests):
- `describe("runtime validators")` (6 tests, lines 12-63) -- test removed wrappers
- `describe("schema validation edge cases")` (10 tests, lines 143-257) -- test removed functions

### `stack-generator.test.ts` -- Minor change
- Remove `validateGeneratedCompose` import (line 2)
- Remove test `"validates compose guardrails"` (lines 389-393)

### `stack-apply-engine.test.ts` -- No changes needed

---

## Step-by-Step Implementation Order

### Step 1: Create relocated test file

Create `packages/lib/src/admin/schemas/schemas.test.ts`. Move the 11 tests from `schema-validation.test.ts` that test JSON Schemas and seed files. Verify they pass independently.

### Step 2: Remove `validateComposeSpec()` from compose-spec-serializer.ts

1. `compose-spec-serializer.ts`: delete lines 4-11
2. `stack-generator.ts` line 5: change import to `{ stringifyComposeSpec }`
3. `stack-generator.ts` lines 566-569: remove validation call and throw block
4. Run `bun test packages/lib/src/admin/stack-generator.test.ts`

### Step 3: Remove `validateGeneratedCompose()` from stack-generator.ts

1. `stack-generator.ts`: delete lines 574-580
2. `stack-generator.test.ts` line 2: remove from import
3. `stack-generator.test.ts` lines 389-393: delete test
4. Run `bun test packages/lib/src/admin/stack-generator.test.ts`

### Step 4: Delete `schema-validation.ts` and its test

1. Delete `packages/lib/src/admin/schema-validation.ts`
2. Delete `packages/lib/src/admin/schema-validation.test.ts`
3. Run `bun test` to confirm no other imports

### Step 5: Update schema file doc comments

Add "Test-only schema" comments to `schemas/stack-spec.schema.ts` and `schemas/caddy-config.schema.ts`.

### Step 6: Run full test suite

```bash
bun run typecheck
bun test
```

Expected: test count drops by ~17. All remaining tests pass.

## Summary of Changes

| Action | File | Lines |
|--------|------|-------|
| Delete | `schema-validation.ts` | -157 |
| Delete | `schema-validation.test.ts` | -333 |
| Edit | `compose-spec-serializer.ts` | -8 |
| Edit | `stack-generator.ts` | -11 |
| Edit | `stack-generator.test.ts` | -5 |
| Create | `schemas/schemas.test.ts` | +180 (relocated) |

**Net reduction**: ~150 lines. `ajv` devDependency stays (used by relocated tests).

## Risks and Mitigations

**Risk**: Missing `restart`/`healthcheck` on new renderers not caught at runtime.
**Mitigation**: Existing generator tests verify these. `docker compose config` catches structural issues. Optionally make `restart` and `healthcheck` required in `ComposeService` type for compile-time safety.

**Risk**: Unknown compose keys not caught by allowlist.
**Mitigation**: `docker compose config` validates against the actual Compose Specification, which is strictly more comprehensive than a hand-maintained 39-entry allowlist.
