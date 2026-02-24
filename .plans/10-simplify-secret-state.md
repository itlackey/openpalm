# Plan 10: Simplify `listSecretManagerState()` Return Type

## Problem

`StackManager.listSecretManagerState()` in `packages/lib/src/admin/stack-manager.ts` (lines 323-375) returns three speculative fields on each secret entry that are never consumed by any UI component, API consumer, or test:

- **`purpose`** -- Inferred from naming patterns (`"credential_or_shared_secret"` if name contains TOKEN/KEY/SECRET, else `"runtime_config"`). This is a guess, not stored metadata.
- **`constraints`** -- `{ min_length: 32 }` only if name contains "SECRET". No validation enforces this; it is purely decorative.
- **`rotation`** -- `{ recommendedDays: 90, lastRotated: null }`. `lastRotated` is always `null` because rotation tracking does not exist. The 90-day recommendation is hardcoded with no backing system.

None of these fields are referenced anywhere in the UI, tests, or internal code.

## Simplified Return Type

### Current return shape (lines 360-374)

```typescript
{
  available: string[],
  requiredCore: typeof CoreSecretRequirements,
  secrets: Array<{
    name: string,
    configured: boolean,
    usedBy: string[],
    purpose: "credential_or_shared_secret" | "runtime_config",    // REMOVE
    constraints: { min_length: number } | undefined,               // REMOVE
    rotation: { recommendedDays: number, lastRotated: null },      // REMOVE
  }>
}
```

### New return shape

```typescript
{
  available: string[],
  requiredCore: typeof CoreSecretRequirements,
  secrets: Array<{
    name: string,
    configured: boolean,
    usedBy: string[],
  }>
}
```

## Fields to Remove and Why

| Field | Lines | Reason for Removal |
|-------|-------|--------------------|
| `purpose` | 367 | Guessed from naming convention, never displayed or acted upon. Zero references in UI or tests. |
| `constraints` | 368 | Only applies `min_length: 32` to names containing "SECRET". No validation uses it; no UI displays it. |
| `rotation` | 369-372 | `lastRotated` is always `null`. No rotation tracking system exists. `recommendedDays: 90` is hardcoded with no backing implementation. |

## All Consumers of `listSecretManagerState()`

### 1. Internal caller: `deleteSecret()` (same file, line 390)

```typescript
const usedByReferences = this.listSecretManagerState().secrets.some(
  (item) => item.name === name && item.usedBy.length > 0
);
```

Accesses only `.secrets[].name` and `.secrets[].usedBy`. No impact.

### 2. API endpoint: `GET /state` (line 14)

**File**: `packages/ui/src/routes/state/+server.ts`

Returns the full object as `data.secrets` in the response body. No frontend component accesses `purpose`, `rotation`, or `constraints`.

### 3. API endpoint: `GET /secrets` (line 8)

**File**: `packages/ui/src/routes/secrets/+server.ts`

Spreads the return value into the response. No downstream consumer uses the removed fields.

### 4. Unit test (line 395)

**File**: `packages/lib/src/admin/stack-manager.test.ts`

Accesses only `name`, `configured`, and `usedBy`. No assertions on removed fields.

### 5. E2E test (line 22)

**File**: `packages/ui/e2e/04-stack-api.pw.ts`

Only asserts that the `secrets` key exists. Does not inspect individual fields.

## UI Components That Display These Fields

**None.** Confirmed by searching `packages/ui/src` for `purpose`, `rotation`, `constraints`, `recommendedDays`, `lastRotated`, `min_length`, `credential_or_shared_secret`, `runtime_config` -- zero matches.

The `SecretsEditor.svelte` component uses a completely different endpoint (`/secrets/raw`) and does not consume `listSecretManagerState()`.

## Type Definitions That Need Updating

The return type is **inferred** by TypeScript -- there is no explicit interface. Removing the three fields from the `.map()` callback at lines 367-372 will automatically narrow the inferred type. No separate type definition needs updating.

## Test Changes Needed

### Unit tests: No changes required

The test at line 395 only asserts on `name`, `configured`, and `usedBy`.

### E2E tests: No changes required

The Playwright test only checks `body.data.secrets` is defined.

---

## Step-by-Step Implementation Order

### Step 1: Modify `listSecretManagerState()` (single file change)

**File**: `packages/lib/src/admin/stack-manager.ts`
**Lines to change**: 363-373

Replace:

```typescript
// BEFORE (lines 363-373)
secrets: uniqueNames.map((name) => ({
  name,
  configured: Boolean(secretValues[name]),
  usedBy: usedBy.get(name) ?? [],
  purpose: name.includes("TOKEN") || name.includes("KEY") || name.includes("SECRET") ? "credential_or_shared_secret" : "runtime_config",
  constraints: name.includes("SECRET") ? { min_length: 32 } : undefined,
  rotation: {
    recommendedDays: 90,
    lastRotated: null,
  },
})),
```

With:

```typescript
// AFTER
secrets: uniqueNames.map((name) => ({
  name,
  configured: Boolean(secretValues[name]),
  usedBy: usedBy.get(name) ?? [],
})),
```

This is the **only code change** required.

### Step 2: Run typecheck

```bash
bun run typecheck
```

### Step 3: Run unit tests

```bash
bun test packages/lib/src/admin/stack-manager.test.ts
```

### Step 4: Run full test suite

```bash
bun test
```

## Risk Assessment

**Risk: Extremely low.**

- The removed fields are dead data -- computed but never consumed.
- No UI component, test, or internal method reads `purpose`, `constraints`, or `rotation`.
- The change is purely subtractive (deleting 5 lines from one function).
- Both API endpoints will return a smaller response payload, which is strictly better.
