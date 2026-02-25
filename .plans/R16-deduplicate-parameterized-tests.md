# R16: Deduplicate Parameterized Tests

## Problem

Across the test suite, there are approximately 45-50 individual test cases that follow
near-identical patterns -- only differing by input values and expected outputs. Each
copy-pasted test adds maintenance burden, makes it harder to add new cases, and obscures
the actual behavior being verified. These should be collapsed into parameterized loops
using `for...of` or table-driven patterns.

The codebase already demonstrates the correct approach in
`packages/cli/test/management-commands.test.ts` (lines 171-194), where a `for...of` loop
iterates over six command files to verify a shared assertion. This plan extends that
pattern to all remaining repetitive test groups.

---

## Inventory of Repetitive Test Patterns

### Pattern 1: `setAccessScope` scope persistence (HIGH value)

**File:** `packages/lib/src/admin/setup-manager.test.ts`, lines 73-97

Three identical tests that only differ by scope value (`"host"`, `"lan"`, `"public"`):

```typescript
// Current: 3 separate tests, each 6 lines
it('persists the "host" scope', () => {
  withTempDir((dir) => {
    const manager = new SetupManager(dir);
    manager.setAccessScope("host");
    expect(manager.getState().accessScope).toBe("host");
  });
});
// ...repeated for "lan" and "public"
```

**Tests collapsed:** 3 -> 1 parameterized loop

---

### Pattern 2: `completeStep` hardcoded step list (MEDIUM value)

**File:** `packages/lib/src/admin/setup-manager.test.ts`, lines 56-70

The test hardcodes all 8 step names inline. If a step is added or renamed, this test
silently becomes stale.

```typescript
// Current: 8 hardcoded expect calls
expect(state.steps.welcome).toBe(false);
expect(state.steps.profile).toBe(false);
// ...6 more
```

**Tests collapsed:** Not a loop candidate per se, but should derive step names from a
constant or `Object.keys()` to avoid hardcoding.

---

### Pattern 3: CLI help/version flag variants (HIGH value)

**File:** `packages/cli/test/main.test.ts`, lines 39-62 and 64-76, 175-188

**Group A -- Help flags:** Four tests for `(no args)`, `--help`, `help`, `-h` all assert
`exitCode === 0` and `stdout` contains `"Usage:"` and `"Commands:"`.

**Group B -- Version flags:** Three tests for `version`, `--version`, `-v` all assert
`exitCode === 0` and `stdout` contains `CliVersion`.

```typescript
// Current: 4 help tests and 3 version tests, each ~5 lines
it("prints help with --help flag", async () => {
  const { stdout, exitCode } = await runCli("--help");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage:");
  expect(stdout).toContain("Commands:");
});
// ...repeated for "help", "-h", no-args
```

**Tests collapsed:** 7 -> 2 parameterized loops

---

### Pattern 4: CLI subcommand validation (HIGH value)

**File:** `packages/cli/test/main.test.ts`, lines 134-174

Five tests for commands (`ext`, `dev`, `service`, `channel`, `automation`) that each
check `exitCode !== 0` and `stderr.contains("Missing subcommand")`:

```typescript
it("supports ext as alias for extensions", async () => {
  const { stderr, exitCode } = await runCli("ext");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Missing subcommand");
});
// ...repeated for dev, service, channel, automation
```

**Tests collapsed:** 5 -> 1 parameterized loop

---

### Pattern 5: Management commands `loadComposeConfig` import (ALREADY DONE)

**File:** `packages/cli/test/management-commands.test.ts`, lines 171-194

Already uses `for...of` -- good reference implementation. However, the individual
`describe` blocks (lines 42-169) each repeat the same
`"imports loadComposeConfig from shared module"` test. This is partially addressed by
the shared loop at line 171, making the individual `it` blocks redundant.

**Tests collapsed:** 6 individual `it` blocks could be removed since the shared loop at
line 171 already covers them. Net reduction: 6 tests.

---

### Pattern 6: `safeRequestId` invalid-input tests (MEDIUM value)

**File:** `core/gateway/src/server.test.ts`, lines 23-41

Four tests check that invalid inputs (`>64 chars`, `special characters`, `null`,
`empty string`) all produce a UUID-format result:

```typescript
it(">64 chars -> returns UUID", () => {
  const long = "a".repeat(65);
  const result = safeRequestId(long);
  expect(result).not.toBe(long);
  expect(result).toMatch(/^[0-9a-f]{8}-/);
});
// ...repeated for special chars, null, empty string
```

**Tests collapsed:** 4 -> 1 parameterized loop (with a table of `[label, input]` pairs)

---

### Pattern 7: `validatePayload` missing/invalid field tests (MEDIUM value)

**File:** `core/gateway/src/server.test.ts`, lines 59-93

Eight tests follow the pattern `validatePayload({...valid, field: badValue}) === false`:

```typescript
it("missing userId -> false", () => {
  expect(validatePayload({ ...valid, userId: undefined })).toBe(false);
});
// ...repeated for empty userId, missing text, empty text, >10000 text,
//    missing nonce, missing timestamp, non-number timestamp
```

**Tests collapsed:** 8 -> 1 parameterized loop (keeping the positive test and the
`"non-empty arbitrary channel"` test separate since they assert `true`).

---

### Pattern 8: Missing text field tests (HIGH value)

**File:** `test/security/input-bounds.security.test.ts`, lines 121-158

Six tests all follow the exact same pattern:

```typescript
it("rejects body with no text property", async () => {
  const h = handler();
  const resp = await h(postChat(JSON.stringify({})));
  expect(resp.status).toBe(400);
});
// ...repeated for text:null, text:"", text:false, text:0, unrelated-fields-only
```

**Tests collapsed:** 6 -> 1 parameterized loop

---

### Pattern 9: Malformed request body tests (MEDIUM value)

**File:** `test/security/input-bounds.security.test.ts`, lines 163-227

Five tests follow the same try/catch pattern asserting `status !== 200`:

```typescript
it("throws or returns non-200 for invalid JSON", async () => {
  const h = handler();
  let status: number;
  try {
    const resp = await h(postChat("not-json"));
    status = resp.status;
  } catch {
    status = 500;
  }
  expect(status).not.toBe(200);
});
// ...repeated for truncated JSON, empty body, JSON array, plain string
```

**Tests collapsed:** 5 -> 1 parameterized loop (extract the try/catch into a helper)

---

### Pattern 10: `parseCustomCommands` invalid-input tests (MEDIUM value)

**File:** `channels/discord/server.test.ts`, lines 429-444

Four tests check that various invalid inputs return `[]`:

```typescript
it("returns empty array for undefined", () => {
  expect(parseCustomCommands(undefined)).toEqual([]);
});
// ...repeated for "", "{invalid", '{"name":"test"}'
```

**Tests collapsed:** 4 -> 1 parameterized loop

---

### Pattern 11: `validateCron` out-of-range tests (MEDIUM value)

**File:** `packages/lib/src/admin/cron.test.ts`, lines 24-45

Four separate `it` blocks each assert `validateCron(expr)` contains `"out of range"` for
different cron fields:

```typescript
it("rejects out-of-range minute values", () => {
  expect(validateCron("60 * * * *")).toContain("out of range");
  expect(validateCron("-1 * * * *")).not.toBeNull();
});
// ...repeated for hours, day-of-month, month, day-of-week
```

**Tests collapsed:** 4 -> 1 parameterized loop. Note: the minute test also checks `-1`
with a weaker assertion (`not.toBeNull()`), which should be unified.

---

### Pattern 12: HMAC special body content tests (LOW value)

**File:** `test/security/hmac.security.test.ts`, lines 130-166

Six tests follow `sign -> verify -> true` with different body strings. Some have
additional assertions (e.g. signature length for the 100KB test), which makes pure
parameterization slightly less clean:

```typescript
it("handles a body with Unicode / emoji characters", () => {
  const body = JSON.stringify({ text: "Hello, \u4e16\u754c! \uD83D\uDE80" });
  const sig = sign("secret", body);
  expect(verifySignature("secret", body, sig)).toBe(true);
});
// ...repeated for newlines/tabs, null bytes, 100KB, 1MB
```

**Tests collapsed:** 5 of 7 can be parameterized (keeping the single-char-difference
test and the 100KB length-check test separate). Net: 5 -> 1 loop + 2 individual.

---

## Summary Table

| # | File | Lines | Tests Before | Tests After | Reduction |
|---|---|---|---|---|---|
| 1 | `setup-manager.test.ts` | 73-97 | 3 | 1 | -2 |
| 2 | `setup-manager.test.ts` | 56-70 | 1 (8 asserts) | 1 (dynamic) | 0 (maintainability) |
| 3 | `main.test.ts` | 39-62, 64-76, 175-188 | 7 | 2 | -5 |
| 4 | `main.test.ts` | 134-174 | 5 | 1 | -4 |
| 5 | `management-commands.test.ts` | 42-169 | 6 (redundant) | 0 | -6 |
| 6 | `server.test.ts` | 23-41 | 4 | 1 | -3 |
| 7 | `server.test.ts` | 59-93 | 8 | 1 | -7 |
| 8 | `input-bounds.security.test.ts` | 121-158 | 6 | 1 | -5 |
| 9 | `input-bounds.security.test.ts` | 163-227 | 5 | 1 | -4 |
| 10 | `discord/server.test.ts` | 429-444 | 4 | 1 | -3 |
| 11 | `cron.test.ts` | 24-45 | 4 | 1 | -3 |
| 12 | `hmac.security.test.ts` | 130-166 | 7 | 3 | -4 |
| **Total** | | | **~60** | **~14** | **~46** |

---

## Proposed Parameterized Replacements

### Pattern 1: `setAccessScope`

```typescript
describe("SetupManager.setAccessScope", () => {
  for (const scope of ["host", "lan", "public"] as const) {
    it(`persists the "${scope}" scope`, () => {
      withTempDir((dir) => {
        const manager = new SetupManager(dir);
        manager.setAccessScope(scope);
        expect(manager.getState().accessScope).toBe(scope);
      });
    });
  }
});
```

### Pattern 2: `completeStep` dynamic step list

```typescript
it("only marks the targeted step; all others remain false", () => {
  withTempDir((dir) => {
    const manager = new SetupManager(dir);
    manager.completeStep("accessScope");
    const state = manager.getState();
    expect(state.steps.accessScope).toBe(true);
    const otherSteps = Object.keys(state.steps).filter((k) => k !== "accessScope");
    for (const step of otherSteps) {
      expect(state.steps[step as keyof typeof state.steps]).toBe(false);
    }
  });
});
```

### Pattern 3: CLI help/version flags

```typescript
describe("help output", () => {
  for (const args of [[], ["--help"], ["help"], ["-h"]]) {
    const label = args.length ? args.join(" ") : "(no args)";
    it(`prints help with ${label}`, async () => {
      const { stdout, exitCode } = await runCli(...args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("Commands:");
    });
  }
});

describe("version output", () => {
  for (const arg of ["version", "--version", "-v"]) {
    it(`prints version with ${arg}`, async () => {
      const { stdout, exitCode } = await runCli(arg);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(CliVersion);
    });
  }
});
```

### Pattern 4: CLI subcommand validation

```typescript
describe("commands requiring subcommands", () => {
  for (const cmd of ["ext", "dev", "service", "channel", "automation"]) {
    it(`${cmd} without subcommand exits with error`, async () => {
      const { stderr, exitCode } = await runCli(cmd);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Missing subcommand");
    });
  }
});
```

### Pattern 5: Remove redundant `loadComposeConfig` tests

Remove the individual `"imports loadComposeConfig from shared module"` test from each of
the 6 `describe` blocks (update, start, stop, restart, logs, status) since the shared
loop at line 171 already covers this assertion for all commands.

### Pattern 6: `safeRequestId` invalid inputs

```typescript
describe("safeRequestId", () => {
  it("valid alphanumeric header -> returns it", () => {
    expect(safeRequestId("abc123")).toBe("abc123");
  });

  it("dashes/underscores -> returns it", () => {
    expect(safeRequestId("req-id_01")).toBe("req-id_01");
  });

  const invalidCases: [string, string | null][] = [
    [">64 chars", "a".repeat(65)],
    ["special characters", "req id!@#"],
    ["null", null],
    ["empty string", ""],
  ];

  for (const [label, input] of invalidCases) {
    it(`${label} -> returns UUID`, () => {
      const result = safeRequestId(input);
      expect(result).toMatch(/^[0-9a-f]{8}-/);
    });
  }
});
```

### Pattern 7: `validatePayload` invalid fields

```typescript
describe("validatePayload", () => {
  const valid = {
    userId: "user1",
    channel: "chat",
    text: "hello",
    nonce: "nonce-1",
    timestamp: Date.now(),
  };

  it("valid complete payload -> true", () => {
    expect(validatePayload(valid)).toBe(true);
  });

  it("non-empty arbitrary channel -> true", () => {
    expect(validatePayload({ ...valid, channel: "smoke-signal" })).toBe(true);
  });

  const invalidCases: [string, Record<string, unknown>][] = [
    ["missing userId", { userId: undefined }],
    ["empty userId", { userId: "  " }],
    ["missing text", { text: undefined }],
    ["empty text", { text: "   " }],
    ["text >10000 chars", { text: "x".repeat(10_001) }],
    ["missing nonce", { nonce: undefined }],
    ["missing timestamp", { timestamp: undefined }],
    ["non-number timestamp", { timestamp: "not-a-number" }],
  ];

  for (const [label, overrides] of invalidCases) {
    it(`${label} -> false`, () => {
      expect(validatePayload({ ...valid, ...overrides })).toBe(false);
    });
  }
});
```

### Pattern 8: Missing text field

```typescript
describe("security: input bounds -- missing text field", () => {
  const cases: [string, string][] = [
    ["no text property", JSON.stringify({})],
    ["text is null", JSON.stringify({ text: null })],
    ["text is empty string", JSON.stringify({ text: "" })],
    ["text is false", JSON.stringify({ text: false })],
    ["text is 0", JSON.stringify({ text: 0 })],
    ["only unrelated fields", JSON.stringify({ userId: "u1", metadata: {} })],
  ];

  for (const [label, body] of cases) {
    it(`rejects body where ${label}`, async () => {
      const h = handler();
      const resp = await h(postChat(body));
      expect(resp.status).toBe(400);
    });
  }
});
```

### Pattern 9: Malformed request body

```typescript
describe("security: input bounds -- malformed request body", () => {
  const cases: [string, string][] = [
    ["invalid JSON", "not-json"],
    ["truncated JSON body", '{"text":"hi"'],
    ["empty body", ""],
    ["JSON array body", JSON.stringify([{ text: "hi" }])],
    ["plain string JSON body", JSON.stringify("just a string")],
  ];

  async function expectNon200(body: string) {
    const h = handler();
    let status: number;
    try {
      const resp = await h(postChat(body));
      status = resp.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  }

  for (const [label, body] of cases) {
    it(`throws or returns non-200 for ${label}`, async () => {
      await expectNon200(body);
    });
  }
});
```

### Pattern 10: `parseCustomCommands` invalid inputs

```typescript
describe("parseCustomCommands", () => {
  const emptyCases: [string, string | undefined][] = [
    ["undefined", undefined],
    ["empty string", ""],
    ["invalid JSON", "{invalid"],
    ["non-array JSON", '{"name":"test"}'],
  ];

  for (const [label, input] of emptyCases) {
    it(`returns empty array for ${label}`, () => {
      expect(parseCustomCommands(input)).toEqual([]);
    });
  }

  // Keep individual tests for valid parsing, builtin conflicts, invalid names
});
```

### Pattern 11: `validateCron` out-of-range

```typescript
const outOfRangeCases: [string, string[]][] = [
  ["minute", ["60 * * * *"]],
  ["hour", ["* 24 * * *"]],
  ["day-of-month", ["* * 0 * *", "* * 32 * *"]],
  ["month", ["* * * 0 *", "* * * 13 *"]],
  ["day-of-week", ["* * * * 8"]],
];

for (const [field, expressions] of outOfRangeCases) {
  it(`rejects out-of-range ${field} values`, () => {
    for (const expr of expressions) {
      expect(validateCron(expr)).toContain("out of range");
    }
  });
}

// Keep the "-1 * * * *" assertion separate or add it to the minute case
// with the correct assertion (toContain("out of range") instead of not.toBeNull())
```

### Pattern 12: HMAC special body content

```typescript
describe("special body content", () => {
  const roundTripCases: [string, string, string][] = [
    ["empty body string", "secret", ""],
    ["Unicode / emoji characters", "secret", JSON.stringify({ text: "Hello, \u4e16\u754c! \uD83D\uDE80" })],
    ["embedded newlines and tabs", "secret", "line1\nline2\r\n\ttabbed"],
    ["null bytes", "secret", "before\x00after"],
    ["very long body (1 MB)", "long-secret", JSON.stringify({ data: "z".repeat(1_000_000) })],
  ];

  for (const [label, secret, body] of roundTripCases) {
    it(`handles ${label} without throwing`, () => {
      const sig = sign(secret, body);
      expect(verifySignature(secret, body, sig)).toBe(true);
    });
  }

  // Keep these as individual tests (they have unique assertions):
  it("handles a very long body (100 KB) without errors", () => {
    const body = "x".repeat(100_000);
    const sig = sign("secret", body);
    expect(sig).toHaveLength(64); // unique assertion
    expect(verifySignature("secret", body, sig)).toBe(true);
  });

  it("a single-character difference in body produces a different signature", () => {
    const base = '{"text":"hello"}';
    const mutated = '{"text":"hellO"}';
    expect(sign("s", base)).not.toBe(sign("s", mutated));
  });
});
```

---

## Step-by-Step Implementation

### Phase 1: Setup Manager (low risk, start here)

1. Open `packages/lib/src/admin/setup-manager.test.ts`
2. Replace lines 73-97 (`setAccessScope` describe block) with the parameterized
   `for...of` loop from Pattern 1 above
3. Replace lines 56-70 (`completeStep` test) with the dynamic `Object.keys()` approach
   from Pattern 2 above
4. Run: `bun test packages/lib/src/admin/setup-manager.test.ts`
5. Verify same number of test cases pass (test names will change but count should match)

### Phase 2: CLI Tests (medium risk, tests spawn subprocesses)

1. Open `packages/cli/test/main.test.ts`
2. Replace the 4 help tests (lines 39-62, 182-188) with the parameterized loop from
   Pattern 3
3. Replace the 3 version tests (lines 64-76, 175-180) with the parameterized loop from
   Pattern 3
4. Replace the 5 subcommand-validation tests (lines 134-174) with the loop from Pattern 4
5. Run: `bun test packages/cli/test/main.test.ts`

6. Open `packages/cli/test/management-commands.test.ts`
7. Remove the redundant `"imports loadComposeConfig from shared module"` test from each
   individual `describe` block (update, start, stop, restart, logs, status) -- the shared
   loop at line 171 already covers this
8. Run: `bun test packages/cli/test/management-commands.test.ts`

### Phase 3: Gateway Server Tests (low risk, pure functions)

1. Open `core/gateway/src/server.test.ts`
2. Replace lines 23-41 (`safeRequestId` invalid tests) with the parameterized loop from
   Pattern 6
3. Replace lines 59-93 (`validatePayload` invalid tests) with the parameterized loop
   from Pattern 7, keeping the two positive-assertion tests separate
4. Run: `bun test core/gateway/src/server.test.ts`

### Phase 4: Security Tests (medium risk, async handlers)

1. Open `test/security/input-bounds.security.test.ts`
2. Replace lines 121-158 with the parameterized loop from Pattern 8
3. Replace lines 163-227 with the parameterized loop + helper from Pattern 9
4. Run: `bun test test/security/input-bounds.security.test.ts`

5. Open `test/security/hmac.security.test.ts`
6. Replace lines 130-166 with the parameterized loop from Pattern 12, keeping the two
   individual tests that have unique assertions
7. Run: `bun test test/security/hmac.security.test.ts`

### Phase 5: Channel and Lib Tests (low risk)

1. Open `channels/discord/server.test.ts`
2. Replace lines 429-444 with the parameterized loop from Pattern 10
3. Run: `bun test channels/discord/server.test.ts`

4. Open `packages/lib/src/admin/cron.test.ts`
5. Replace lines 24-45 with the parameterized loop from Pattern 11
6. Run: `bun test packages/lib/src/admin/cron.test.ts`

### Phase 6: Final Verification

1. Run the full test suite: `bun test`
2. Verify total test count is roughly the same (parameterized loops generate one `it` per
   case, so the count should stay similar)
3. Verify no test regressions

---

## Files to Modify

| File | Patterns Applied |
|---|---|
| `packages/lib/src/admin/setup-manager.test.ts` | 1, 2 |
| `packages/cli/test/main.test.ts` | 3, 4 |
| `packages/cli/test/management-commands.test.ts` | 5 |
| `core/gateway/src/server.test.ts` | 6, 7 |
| `test/security/input-bounds.security.test.ts` | 8, 9 |
| `test/security/hmac.security.test.ts` | 12 |
| `channels/discord/server.test.ts` | 10 |
| `packages/lib/src/admin/cron.test.ts` | 11 |

**Total files modified:** 8

---

## Verification Steps

1. **Per-file smoke test:** After each file edit, run `bun test <file>` and confirm all
   tests pass
2. **Full suite:** Run `bun test` at the project root and confirm no regressions
3. **Test count audit:** Compare `bun test` output before and after. The total `it` count
   should remain approximately the same (parameterized loops still generate one `it` per
   case). What changes is the source line count, not the runtime test count.
4. **Review test names:** Parameterized tests should produce descriptive names via string
   interpolation (e.g., `persists the "host" scope`) so that failures are easy to
   diagnose
5. **CI pipeline:** Ensure the PR passes all CI gates, especially the `publish-cli`
   workflow which runs CLI tests on a fresh runner

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Dynamic test names break CI log parsing | Use descriptive interpolated labels |
| `for...of` loops in test files confuse coverage tools | Bun's test runner handles this correctly |
| Removing "redundant" management-commands tests loses coverage | The shared loop at line 171 already covers the assertion; verify before removing |
| Pattern 2 (dynamic `Object.keys`) breaks if step shape changes | This is actually the point -- the test adapts automatically |
| Async parameterized tests (Patterns 8, 9) may have ordering issues | `for...of` in `describe` registers tests synchronously; execution order is deterministic |

---

## Priority

**Medium.** This is a code quality / maintainability improvement. It does not fix bugs or
add features. However, it reduces ~200 lines of duplicated test code and makes it trivial
to add new test cases (just add a row to the table).

Recommended to implement after higher-priority recommendations (R1-R5, R10) are complete.
