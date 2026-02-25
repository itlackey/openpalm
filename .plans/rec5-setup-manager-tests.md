# Rec 5 — Add SetupManager edge-case unit tests

## Problem summary

`packages/lib/src/admin/setup-manager.test.ts` (251 lines) has no coverage for three
behaviours:

1. `setEnabledChannels` — the method exists at
   `packages/lib/src/admin/setup-manager.ts:166–171` but has zero test coverage.
2. `completeSetup` idempotency — the two existing tests
   (`setup-manager.test.ts:197–220`) only verify the happy path (single call). A second
   call overwrites `completedAt` with a new timestamp and could in principle clear other
   state; this is unverified.
3. Forward-compatibility with unknown fields — `isValidSetupState`
   (`setup-manager.ts:67–81`) returns the raw parsed object when it passes validation.
   If a future version adds a field to the state file and an older binary reads it, the
   extra field should be silently ignored and all known fields should still carry their
   correct values. This path is untested.

## No new dependencies required

All three tests use only:
- `bun:test` (already imported, line 1)
- `node:fs` helpers `mkdtempSync`, `rmSync`, `writeFileSync` (already imported, lines 2–3)
- `node:os` `tmpdir` (already imported, line 4)
- `node:path` `join` (already imported, line 4)
- `SetupManager` (already imported, line 5)

Nothing new needs to be added to `package.json`.

---

## Where to insert each test

### Test A — `setEnabledChannels` deduplication

**Describe block:** Add a new `describe("SetupManager.setEnabledChannels", ...)` block.

**Insert after:** line 251 (end of file), immediately after the closing `});` of
`describe("SetupManager.setProfile", ...)`.

**Rationale:** `setProfile` is the last describe block in the file. Appending here
groups the new coverage naturally by method name, consistent with the file's existing
structure.

---

### Test B — `completeSetup` idempotency

**Describe block:** Inside the existing `describe("SetupManager.completeSetup", ...)`
block that starts at line 196.

**Insert after:** the closing `});` of the second `it` block at line 219, before the
closing `});` of the describe block at line 220.

**Rationale:** This is directly related to `completeSetup` behaviour — it belongs
alongside the existing two tests for that method.

---

### Test C — forward-compatibility with unknown fields

**Describe block:** Add a new `describe("getState forward-compatibility", ...)` block.

**Insert after:** line 163, immediately after the closing `});` of
`describe("getState validation (corrupt file handling)", ...)`.

**Rationale:** This is a `getState` validation concern, so it fits directly after the
existing corrupt-file and scope-handling validation suites.

---

## Detailed test specifications

### Test A — `setEnabledChannels` deduplicates

**File:** `packages/lib/src/admin/setup-manager.test.ts`
**After line:** 251

**What to test:**  
`setEnabledChannels` (implementation: `setup-manager.ts:166–171`) spreads its input
through `new Set(channels)` before storing. Passing a list with duplicates must produce
a deduplicated array in state, and the result must be persisted to disk.

**Setup:**
- `withTempDir` — fresh temp directory, no pre-existing state file.
- Construct `new SetupManager(dir)`.

**Action:**
```
manager.setEnabledChannels(["discord", "telegram", "discord", "chat", "telegram"])
```

**Assertions:**

1. The return value of `setEnabledChannels` (`state`) has
   `state.enabledChannels` equal to `["discord", "telegram", "chat"]`
   (order of first occurrence preserved, duplicates removed).
2. `manager.getState().enabledChannels` equals the same deduplicated array
   (confirms the value was written to disk and read back correctly).

**Why these assertions:**  
`setEnabledChannels` returns the mutated `SetupState` directly; checking both the
return value and the reloaded state confirms both the in-memory result and persistence.
The `Set` constructor preserves insertion order in V8/Bun, so the expected order is
deterministic.

---

### Test B — `completeSetup` idempotency

**File:** `packages/lib/src/admin/setup-manager.test.ts`
**After line:** 219 (inside `describe("SetupManager.completeSetup", ...)`)

**What to test:**  
Calling `completeSetup` a second time must not throw, must not reset `completed` to
false, and must not erase other state that was set before the second call.

**Setup:**
- `withTempDir` — fresh temp directory.
- Construct `new SetupManager(dir)`.
- Call `manager.completeStep("welcome")` to establish a non-default step value that
  must survive the second `completeSetup` call.
- Call `manager.completeSetup()` (first call).

**Action:**
```
const second = manager.completeSetup()   // second call
```

**Assertions:**

1. No exception is thrown (implicit — if `completeSetup` threw, the test would fail).
2. `second.completed` is `true`.
3. `second.completedAt` is a string (the second ISO timestamp).
4. `manager.getState().completed` is `true` (persisted after second call).
5. `manager.getState().steps.welcome` is `true` (previously set step not cleared).

**Why these assertions:**  
`completeSetup` (`setup-manager.ts:151–157`) does `getState()` → mutate → `save()`.
A second call will re-read the file (which now has `completed: true`) and write it
again. Assertion 5 is the critical one: it confirms the idempotent call does not
accidentally replace persisted state with a default snapshot.

---

### Test C — forward-compatibility: unknown extra field is ignored

**File:** `packages/lib/src/admin/setup-manager.test.ts`
**After line:** 163 (after `describe("getState validation (corrupt file handling)", ...)`)

**What to test:**  
If a state file produced by a newer version of OpenPalm contains an extra field that
the current `SetupState` type does not know about (e.g. `"futureFeature": true`), the
file still passes `isValidSetupState` (because the validator only checks the fields it
knows about — `setup-manager.ts:67–81`). `getState()` should return the raw parsed
object, which means all known fields carry their correct persisted values, and the
extra field is present on the returned object but does not cause an error.

**Setup:**
- `withTempDir` — fresh temp directory.
- Build a valid state JSON object that includes all required known fields **plus** one
  unknown field:

```json
{
  "completed": true,
  "accessScope": "lan",
  "serviceInstances": { "openmemory": "", "psql": "", "qdrant": "" },
  "smallModel": { "endpoint": "", "modelId": "" },
  "profile": { "name": "", "email": "" },
  "steps": {
    "welcome": true,
    "profile": false,
    "accessScope": false,
    "serviceInstances": false,
    "healthCheck": false,
    "security": false,
    "channels": false,
    "extensions": false
  },
  "enabledChannels": ["discord"],
  "installedExtensions": [],
  "futureFeature": true
}
```

- Write this JSON to `join(dir, "setup-state.json")` using `writeFileSync`.
- Construct `new SetupManager(dir)`.

**Action:**
```
const state = manager.getState()
```

**Assertions:**

1. `state.completed` is `true` (known field, non-default value preserved).
2. `state.accessScope` is `"lan"` (known field, non-default value preserved).
3. `state.steps.welcome` is `true` (known nested field preserved).
4. `state.enabledChannels` equals `["discord"]` (known array preserved).
5. The call does not throw (implicit).

The test does **not** assert the value or presence of `futureFeature` — its handling
is intentionally unspecified (callers must not rely on it). The point is purely that
known fields are unaffected.

**Why these assertions:**  
`isValidSetupState` checks only the fields it knows. An object with extra keys still
satisfies the guard and is returned as-is (`setup-manager.ts:95–96`). Asserting known
field values confirms that the normalisation path was not accidentally triggered by the
presence of an unknown key.

---

## How to run the tests locally

```bash
# From the repo root — run the full lib test suite
bun test packages/lib/src/admin/setup-manager.test.ts

# Or, run via workspace
cd packages/lib && bun test src/admin/setup-manager.test.ts

# Run only the new describe blocks by pattern
bun test --testNamePattern "setEnabledChannels|idempotent|forward-compat" packages/lib/src/admin/setup-manager.test.ts
```

All three tests are synchronous and use only the OS temp directory, so they work on any
machine without any pre-installed state.

---

## File references

| File | Lines | Note |
|------|-------|------|
| `packages/lib/src/admin/setup-manager.test.ts` | 1–5 | Existing imports (no changes needed) |
| `packages/lib/src/admin/setup-manager.test.ts` | 196–220 | Existing `completeSetup` describe — Test B appended inside here |
| `packages/lib/src/admin/setup-manager.test.ts` | 138–163 | Existing corrupt-file describe — Test C appended after line 163 |
| `packages/lib/src/admin/setup-manager.test.ts` | 251 | End of file — Test A `describe` block appended here |
| `packages/lib/src/admin/setup-manager.ts` | 67–81 | `isValidSetupState` — explains why unknown fields pass through |
| `packages/lib/src/admin/setup-manager.ts` | 91–100 | `getState` — the read/validate/default path under test |
| `packages/lib/src/admin/setup-manager.ts` | 151–157 | `completeSetup` — the idempotency path under test |
| `packages/lib/src/admin/setup-manager.ts` | 166–171 | `setEnabledChannels` — the deduplication path under test |
