# R6: Eliminate Silent Test Passes

## Summary

Recommendation 6 targets the pattern where tests silently pass by returning early when a
precondition is not met, rather than using `describe.skipIf` / `it.skipIf` to make the
skip visible in test output. A silent `if (!condition) return;` inside a test body exits
with a green check mark, giving false confidence that the test logic actually ran.

After an exhaustive audit of all 67+ test files in the project, **no instances of the
silent guard anti-pattern were found**. The codebase already uses proper `skipIf` guards
everywhere that environment-dependent skipping is needed. This plan documents the audit
results, classifies every `if` statement found in test files, and establishes a
regression-prevention mechanism.

---

## Audit Scope

Every `.test.ts`, `.test.js`, `.docker.ts`, and `.pw.ts` file in the repository was read
and inspected for the following patterns inside `it()` / `test()` callbacks:

- `if (!condition) return;` -- silent skip (anti-pattern)
- `if (condition) return;` -- silent skip (anti-pattern)
- `if (!condition) { return; }` -- silent skip with braces (anti-pattern)

The audit also checked for any `return` statements in test bodies that are not preceded
by an assertion, which could indicate an early exit that masks missing coverage.

---

## Results: No Violations Found

### Existing `skipIf` usage (5 instances, all correct)

| File | Line | Guard |
|---|---|---|
| `test/integration/container-health.integration.test.ts` | 11 | `describe.skipIf(!stackAvailable)` |
| `test/integration/admin-auth.integration.test.ts` | 20 | `describe.skipIf(!stackAvailable)` |
| `test/integration/admin-health-check.integration.test.ts` | 12 | `describe.skipIf(!stackAvailable)` |
| `test/contracts/setup-wizard-gate.contract.test.ts` | 18 | `describe.skipIf(!stackAvailable)` |
| `packages/cli/test/main.test.ts` | 190 | `it.skipIf(!openpalmInstalled)` |

All five use the `skipIf` API, which produces a visible "skip" line in test output. None
use the silent `if/return` pattern.

Note: The three integration test `skipIf` guards use a fetch-probe to determine
`stackAvailable`, which creates a separate problem (false CI gate) addressed in the
companion plan `rec6-integration-silent-skip.md`. The guards themselves are correctly
structured -- they skip visibly, not silently.

### `if` statements in test files -- all classified as safe

Every `if` statement found in test files was manually classified. None are silent guards:

| Category | Example file(s) | Pattern | Why it is safe |
|---|---|---|---|
| **Assertion helpers / validators** | `channel-message.contract.test.ts:5` | `if (typeof value !== "object") return false` | Inside a helper function that returns a boolean, not a test body |
| **Error logging before assertion** | `schemas/schemas.test.ts:21,41,54,64,81,99` | `if (!valid) { console.error(...) }` followed by `expect(valid).toBe(true)` | Logs diagnostic info before the assertion that fails -- does not skip the test |
| **Mock / test infrastructure** | `compose.test.ts:91` | `if (options.signal.aborted) return reject(...)` | Inside a mock function simulating abort behavior |
| **Environment save/restore** | `detect-providers.test.ts`, `paths.test.ts`, `compose-runner.test.ts`, `openmemory-http.test.ts`, `automations.test.ts` | `if (original !== undefined) Bun.env.X = original; else delete Bun.env.X;` | In `afterEach` / `finally` blocks restoring env state |
| **Data parsing / iteration** | `stack-manager.test.ts:33` | `if (!line \|\| line.startsWith("#")) continue` | Inside a helper function parsing `.env` files |
| **Source code content assertions** | `uninstall-extensions.test.ts` | `expect(source).toContain("if (!options.yes)")` | Asserting that source code contains a specific string -- the `if` is inside a string literal |
| **Conditional result extraction** | `install.test.ts:143` | `if (coreServicesMatch) { ... }` | After an assertion, extracting additional data for further checks |
| **Server routing** | `server.test.ts` (gateway) | `if (url.pathname === ...)` | Inside a mock server handler |
| **Test data generation** | `quick-links.test.ts` | `if (link.href)` | Iterating over test data to verify properties |

### Test files with no `if` statements at all

The majority of test files contain no `if` statements whatsoever. These include all
security tests, most contract tests, most CLI tests, and all UI component tests.

---

## Relationship to rec6-integration-silent-skip.md

The companion plan `rec6-integration-silent-skip.md` addresses a related but distinct
problem: three integration test files use `describe.skipIf(!stackAvailable)` where
`stackAvailable` is determined by a runtime fetch probe. The **guard mechanism** is
correct (visible skip via `skipIf`), but the **CI job structure** creates a false gate
because the `integration` job in `release.yml` always exits 0 with all tests skipped.

That plan's solution -- replacing the fetch probe with an env-var guard and removing the
vacuous `integration` job from the release `needs:` array -- is orthogonal to this audit.
Both plans together ensure:

1. No test body silently passes via early return (this plan -- confirmed clean)
2. No CI job misrepresents skipped tests as a passing gate (rec6 plan)

---

## Regression Prevention

### Grep-based verification command

Run this command to detect any future introductions of the silent guard pattern in test
bodies:

```bash
rg --type ts -g '*.test.ts' -g '*.docker.ts' -n 'if\s*\(\s*!' --context 2 \
  | rg -v '(expect|assert|throw|console\.|return false|return reject|continue|\.env|afterEach|afterAll|finally|beforeAll|beforeEach|function |const |=>)'
```

This searches for `if (!...)` patterns in test files while excluding known-safe patterns
(assertions, mock internals, env restore, helper functions). Any remaining matches
warrant manual inspection.

A simpler focused check for the exact anti-pattern:

```bash
rg --type ts -g '*.test.ts' -g '*.docker.ts' -n '^\s*if\s*\(.*\)\s*return\s*;' test/ packages/ core/ channels/
```

This matches lines where `if (condition) return;` appears as a standalone statement --
the exact silent guard pattern. Expected output: zero matches.

### CI enforcement (optional, future)

If desired, add a step to the `unit-tests` job in `release.yml`:

```yaml
- name: Check for silent test guards
  run: |
    matches=$(rg --type ts -g '*.test.ts' -g '*.docker.ts' -c '^\s*if\s*\(.*\)\s*return\s*;' test/ packages/ core/ channels/ 2>/dev/null || true)
    if [ -n "$matches" ]; then
      echo "::error::Found silent test guards (if/return pattern in test files):"
      rg --type ts -g '*.test.ts' -g '*.docker.ts' -n '^\s*if\s*\(.*\)\s*return\s*;' test/ packages/ core/ channels/
      exit 1
    fi
```

This is optional -- the project's current discipline is strong, and the grep command
above is sufficient for manual checks during code review.

---

## Existing Best Practices (already documented)

The project already documents the correct patterns in `dev/docs/release-quality-gates.md`,
which was written after the v0.4.0 release failure. Key rules already established:

- Use `skipIf` with a descriptive guard variable, not inline boolean expressions
- Guard `docker compose` calls with `openpalmInstalled`, not just `dockerAvailable`
- Test command routing separately from compose execution
- Check for skipped tests in CI output before releasing

---

## Implementation Steps

**No code changes required.** The audit found zero violations.

### Step 1: Verify current state (completed)

All 67+ test files have been read and classified. No silent guard patterns exist.

### Step 2: Run verification command

```bash
rg --type ts -g '*.test.ts' -g '*.docker.ts' -n '^\s*if\s*\(.*\)\s*return\s*;' test/ packages/ core/ channels/
```

Expected: zero matches.

### Step 3 (optional): Add CI check

Add the grep-based check to `release.yml` as described in the "CI enforcement" section
above. This prevents future regressions but is not strictly necessary given the project's
current code review practices.

---

## File References

| File | Relevance |
|---|---|
| `dev/docs/release-quality-gates.md` | Existing documentation of CI-safe test rules |
| `.plans/rec6-integration-silent-skip.md` | Companion plan addressing the CI false-gate problem |
| `test/integration/container-health.integration.test.ts` | Uses `describe.skipIf` correctly |
| `test/integration/admin-auth.integration.test.ts` | Uses `describe.skipIf` correctly |
| `test/integration/admin-health-check.integration.test.ts` | Uses `describe.skipIf` correctly |
| `test/contracts/setup-wizard-gate.contract.test.ts` | Uses `describe.skipIf` correctly |
| `packages/cli/test/main.test.ts` | Uses `it.skipIf` correctly |

---

## Conclusion

The codebase is clean. No silent test passes exist. The project's existing `skipIf`
usage is correct and well-documented. The only actionable follow-up is the optional CI
enforcement step, which guards against future regressions. The companion plan
(`rec6-integration-silent-skip.md`) addresses the related CI false-gate problem
separately.
