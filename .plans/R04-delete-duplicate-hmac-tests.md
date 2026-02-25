# R4: Delete Duplicate HMAC Tests

## Problem

HMAC signing/verification is tested **35 times** across three files, all exercising the
same two pure, deterministic functions (`signPayload` and `verifySignature`) from
`packages/lib/src/shared/crypto.ts`. The gateway's `channel-security.ts` is just a
re-export of those same functions:

```typescript
// core/gateway/src/channel-security.ts (entire file)
export { signPayload, verifySignature } from "@openpalm/lib/shared/crypto.ts";
```

This means every test in all three files is ultimately testing the identical code path.

---

## Analysis of Each Test File

### 1. `test/security/hmac.security.test.ts` (25 tests) -- KEEP

Imports from `core/gateway/src/channel-security.ts` (which re-exports from `crypto.ts`).

This is the most comprehensive file, organized into five describe blocks:

| Describe block | Tests | Coverage |
|---|---|---|
| **empty and missing inputs** | 6 | Empty sig, truncated sig, empty secret (verify), both empty, empty secret (sign throws), whitespace-only secret |
| **signature isolation** | 4 | Cross-body rejection, cross-secret rejection, key/body swap, collision resistance (7 variants) |
| **signature format** | 5 | 64-char hex output, lowercase hex, round-trip sign+verify, one-char-short sig, one-char sig |
| **special body content** | 7 | Empty body, Unicode/emoji, newlines/tabs, null bytes, 100KB body, 1MB body, single-char difference |
| **secret variations** | 3 | Long secret (512 chars), special characters in secret, different secrets produce different sigs |

### 2. `packages/lib/src/shared/crypto.test.ts` (7 tests) -- DELETE

Imports directly from `./crypto.ts`.

| Test | Equivalent in hmac.security.test.ts? |
|---|---|
| Consistent hex output for same inputs | Yes -- covered by round-trip test + format tests |
| Different output for different secrets | Yes -- "signature isolation" > cross-secret |
| Different output for different bodies | Yes -- "signature isolation" > cross-body |
| Throws for empty secret | Yes -- "empty and missing inputs" > signPayload throws for empty secret |
| Round-trip sign+verify | Yes -- "signature format" > round-trip |
| Wrong secret rejects | Yes -- "signature isolation" > cross-secret |
| Modified body rejects | Yes -- "signature isolation" > cross-body |
| Tampered signature rejects | Yes -- partially by truncated sig tests; also collision resistance |
| Empty secret in verify | Yes -- "empty and missing inputs" > empty secret verify |
| Empty signature in verify | Yes -- "empty and missing inputs" > empty signature |
| Truncated signature | Yes -- "signature format" > one-char-short sig |

**Conclusion: strict subset.** Every behavior tested in `crypto.test.ts` is covered by at
least one (usually more thorough) test in `hmac.security.test.ts`.

### 3. `core/gateway/src/channel-security.test.ts` (3 tests) -- REDUCE TO 1

Imports from `./channel-security.ts` (re-export).

| Test | Purpose |
|---|---|
| "validates signatures" | Round-trip + bad sig rejection -- duplicated |
| "rejects empty body and empty signatures" | Empty sig, truncated sig -- duplicated |
| "rejects empty shared secrets" | signPayload throws, empty secret verify -- duplicated |

All three tests are fully duplicated by the security suite. However, since
`channel-security.ts` is a re-export module in the gateway workspace, keeping one smoke
test confirms the re-export wiring is intact. If the import path or alias breaks, this
single test catches it without requiring the full security suite.

---

## Files Changed

| File | Action |
|---|---|
| `packages/lib/src/shared/crypto.test.ts` | **Delete** |
| `core/gateway/src/channel-security.test.ts` | **Replace** contents with a single smoke test |
| `test/security/hmac.security.test.ts` | No changes |

No other files reference the test files being deleted. The `crypto.test.ts` file is not
imported anywhere. CI workflows use glob-based test discovery (`bun test`), so no
workflow files need updating.

---

## Step-by-Step Implementation

### Step 1: Delete `packages/lib/src/shared/crypto.test.ts`

Delete the file entirely. It is a strict subset of the security suite and imports from the
same underlying implementation. No other file imports or references it.

```
rm packages/lib/src/shared/crypto.test.ts
```

### Step 2: Replace `core/gateway/src/channel-security.test.ts` with a single smoke test

Replace the entire file contents with a single test that confirms the re-export wiring
works -- sign a payload, verify it succeeds, verify a bad signature fails. This is the
minimum needed to catch a broken re-export without duplicating the security suite.

The new file should contain:

```typescript
import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "./channel-security.ts";

describe("channel security", () => {
  it("re-exports working HMAC sign/verify from @openpalm/lib", () => {
    const body = JSON.stringify({ ok: true });
    const sig = signPayload("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
    expect(verifySignature("secret", body, "bad")).toBe(false);
  });
});
```

This is a single test that:
- Confirms `signPayload` is exported and callable
- Confirms `verifySignature` is exported and callable
- Validates the round-trip (sign then verify)
- Validates rejection of a bad signature

Edge cases (empty secrets, truncated sigs, Unicode bodies, etc.) remain covered by
`test/security/hmac.security.test.ts`.

### Step 3: Verify no references remain

Confirm that no other files import from the deleted test file:

```bash
grep -r "crypto.test" packages/ core/ test/ --include="*.ts" --include="*.js"
```

Expected: no results (or only matches in documentation/review files).

---

## Verification Steps

1. **Run the security suite to confirm it still passes:**
   ```bash
   bun test test/security/hmac.security.test.ts
   ```

2. **Run the gateway tests to confirm the smoke test passes:**
   ```bash
   bun test core/gateway/src/channel-security.test.ts
   ```

3. **Run the full test suite to confirm nothing else broke:**
   ```bash
   bun test
   ```

4. **Confirm the deleted file is gone:**
   ```bash
   ls packages/lib/src/shared/crypto.test.ts  # should fail with "No such file"
   ```

5. **Verify test count reduction:** The total HMAC-related test count should drop from
   35 (25 + 7 + 3) to 26 (25 + 1), eliminating 9 duplicate tests.

---

## Risk Assessment

**Risk: Very low.**

- The deleted tests are a strict subset of a more thorough suite that remains.
- The functions under test are pure and deterministic -- no environment dependency.
- The re-export smoke test catches the only scenario the security suite would miss (a
  broken import path in `channel-security.ts`).
- No production code is modified.
