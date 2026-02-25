# Testing Architecture Review

**Date:** 2026-02-25
**Status:** Action Required
**Scope:** Full monorepo test suite — unit, integration, contract, security, E2E

---

## Executive Summary

The test suite has grown by accretion with no unifying architecture. The result is five incompatible test runners, a sequential E2E pipeline disguised as independent tests, significant duplication, permanently dead integration tests in CI, and a category of "contract" tests that validate documentation strings rather than API behavior. Roughly 40% of the test suite provides no meaningful safety net.

The good news: the gateway server tests, stack manager tests, setup manager edge-case tests, and channel adapter tests are genuinely high-value. The architecture isn't uniformly broken — it has a strong core buried under layers of accidental complexity.

---

## Table of Contents

1. [Acceptance Criteria & Success Definition](#1-acceptance-criteria--success-definition)
2. [Findings: Critical Architectural Issues](#2-findings-critical-architectural-issues)
3. [Findings: High-Severity Issues](#3-findings-high-severity-issues)
4. [Findings: Medium-Severity Issues](#4-findings-medium-severity-issues)
5. [Findings: Low-Severity Issues](#5-findings-low-severity-issues)
6. [Test Value Assessment](#6-test-value-assessment)
7. [Recommendations](#7-recommendations)
8. [Stabilization Loop: Wizard Fix Protocol](#8-stabilization-loop-wizard-fix-protocol)
9. [Relationship to Existing testing-todos.md](#9-relationship-to-existing-testing-todosmd)

---

## 1. Acceptance Criteria & Success Definition

### What "Done" Means

This work is **not done** when automated tests pass. It is done when:

1. **The setup wizard can be completed manually using Chrome DevTools** — every step, from Welcome through the final Complete step — in a clean test environment, **three consecutive times**, with state fully reset between each run.
2. **A Playwright test proves the wizard works end-to-end** by walking through every step in a real browser, without mocking health checks or service responses. The test must interact with real services.
3. **The final step verifies generated artifacts are correct:**
   - `openpalm.yaml` (stack spec) exists and is valid YAML with expected structure
   - `docker-compose.yml` exists and is valid YAML with required services
   - `caddy.json` exists and is valid JSON with required routes
   - `secrets.env` exists and contains expected secret references
   - `.env` files for services exist and contain expected variables
4. **Services must actually respond.** The test **must fail** if:
   - The "services took too long to start" message is displayed
   - Any service is labeled with a "not ready" status on the Complete step
   - The health check endpoint reports any service as `ok: false`
5. **Screenshots of the completed wizard are saved** as proof of success — saved to a persistent location (not `.gitignore`'d proof artifacts), demonstrating the wizard reached "Everything is ready!" with all services green.

### Hard Rules

- **Change whatever is necessary** to make this work smoothly, repeatedly, and provably. No file, config, or test is sacred.
- **No cheating.** Tests must be as real-world as possible. No mocking health checks to return all-ok. No `OPENPALM_COMPOSE_BIN: '/usr/bin/true'` for the acceptance test. No `OPENPALM_MOCK_COMPOSE`. If the wizard says services are ready, services must actually be ready.
- **State must be fully reset between test runs.** Each run must start from a clean first-boot state. No leftover artifacts, no stale `setup-state.json`, no residual Docker containers. The reset must be automated and reliable.
- **The system must be in working order.** Passing the test means the stack is genuinely functional — not that assertions were gamed to pass.

### Environment Variables: Consolidation Required

The current env var situation is a significant contributor to brittleness. As part of this work:

- Audit and consolidate all environment variables used across test harness files (`env.ts`, `start-webserver.cjs`, `docker-compose.dev.yml`, individual test files)
- Remove redundant or conflicting variables (e.g., reconcile `OPENPALM_COMPOSE_BIN` vs `OPENPALM_MOCK_COMPOSE`)
- Document every env var that tests depend on, with its purpose and default value
- Ensure the same env var names and semantics are used consistently across all test runners

---

## 2. Findings: Critical Architectural Issues

### 2.1The E2E Suite Is a Sequential State Machine, Not Independent Tests

**Files:** `packages/ui/e2e/01-*.pw.ts` through `packages/ui/e2e/11-*.pw.ts`

The entire Playwright suite is 11 numbered files that must execute in exact order (`workers: 1`, `fullyParallel: false`). Each test depends on state mutated by the prior test. This is a procedural script masquerading as a test suite.

**Consequences:**
- A single failure in `03-setup-api.pw.ts` test 7 cascades to fail tests 8–17 and every subsequent file (04–11), producing a wall of misleading errors.
- No test file can be run in isolation. Running just `10-setup-wizard-ui.pw.ts` fails because it depends on state from file 03.
- No state reset between files or between individual tests.
- Debugging requires re-running the entire 11-file pipeline to reproduce a failure.

**Evidence — test 08 is defensively coded against its own brittleness:**

```typescript
// packages/ui/e2e/08-command-api.pw.ts
test('setup commands allow unauthenticated local requests before setup is complete', async ({
    request
}) => {
    const status = await request.get('/setup/status');
    if (status.status() === 401) {
        // ... three different test.skip() bailout paths
        test.skip(true, 'Instance is already configured; setup status requires auth.');
    }
```

This test contains three `test.skip()` paths because it doesn't know what state the server is in.

### 2.2Playwright Used as a Glorified HTTP Client

**Files:** `packages/ui/e2e/01-*.pw.ts` through `packages/ui/e2e/08-*.pw.ts`, `11-*.pw.ts`

8 of 11 Playwright test files never open a browser. They use `request` (Playwright's API client) to make HTTP calls. This adds browser-launch overhead, forces single-threaded execution, and prevents these tests from being parallelized — all for no benefit over `bun:test` with `fetch()`.

Only files `09-dashboard-ui.pw.ts` and `10-setup-wizard-ui.pw.ts` actually test browser behavior.

### 2.3`setup-wizard-gate.contract.test.ts` Mutates Real Dev State

**File:** `test/contracts/setup-wizard-gate.contract.test.ts`

```typescript
const repoRoot = resolve(execSync("git rev-parse --git-common-dir", ...).trim(), "..");
const STATE_FILE_HOST = resolve(repoRoot, ".dev/data/admin/setup-state.json");
```

This test reads and writes `.dev/data/admin/setup-state.json` — the **actual running dev stack's state file**. It saves/restores in `beforeAll`/`afterAll`, but:
- Running this while `dev:up` is active can corrupt live dev state
- If the test crashes before `afterAll`, the file is left in a mutated state
- The `execSync("git rev-parse")` call fails without `git` on PATH and resolves differently in worktrees

### 2.4Integration Tests Are Permanently Dead in CI

**Files:** `test/integration/*.integration.test.ts`

Every integration test guards itself with:

```typescript
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";
describe.skipIf(!stackAvailable)("integration: ...", () => { ... });
```

`OPENPALM_INTEGRATION` is **never set in any CI workflow**. The `test:ci` script (`bun run typecheck && bun test`) runs these files, they silently skip, and CI reports green. These tests contribute zero signal in CI while inflating the test count.

Additionally, `container-health.integration.test.ts` hardcodes `localhost:8100` and `localhost:4096` — ports that must be running locally.

### 2.5`bun test` Is a Landmine

**File:** `package.json`

The default `"test"` script runs `bun test`, which discovers **everything** — integration tests needing Docker, contract tests needing specific CWD, security tests that duplicate unit tests. The `--filter` flags used in `test:unit` are **name-based filters on test descriptions**, not file-path filters. They cannot reliably exclude files.

A developer running `bun test` from the repo root gets failures unless the Docker stack is up. But `test:ci` also runs `bun test`. This is contradictory.

---

## 3. Findings: High-Severity Issues

### 3.1The E2E Test Harness Is a Four-File Rube Goldberg Machine

**Files:** `packages/ui/e2e/env.ts`, `start-webserver.cjs`, `start-webserver-for-ci.mjs`, `global-teardown.ts`

The startup chain:
1. `playwright.config.ts` → `webServer.command: node e2e/start-webserver.cjs`
2. `start-webserver.cjs` (CommonJS) → runs `bun run build` synchronously → spawns `bun build/index.js`
3. `start-webserver-for-ci.mjs` (ESM, appears to be dead code — not referenced anywhere)
4. `env.ts` creates a temp directory tree **as a module-load side effect**, persists the path to `.e2e-state.json` on disk
5. `global-teardown.ts` reads `.e2e-state.json` to find and delete the temp directory

This is four files to do what should be a single function. The `.e2e-state.json` file is a workaround for `env.ts` having a side effect that gets re-executed when Playwright re-imports the config. If the process crashes before teardown, temp directories accumulate in `/tmp`.

### 3.2Every E2E Run Triggers a Full Production Build

**File:** `packages/ui/e2e/start-webserver.cjs`

```javascript
const buildResult = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
```

Every `npx playwright test` invocation rebuilds the entire SvelteKit app. Build errors surface as "webServer failed to start" with the actual error buried in output. The feedback loop is: build time + server startup + test execution.

### 3.3Environment Scaffolding Duplicates Application Knowledge

**File:** `packages/ui/e2e/env.ts` (lines 30–61)

The E2E env setup manually creates 10+ directories and 8+ empty seed files that mirror the XDG directory layout. This is a hardcoded replica of what `dev-setup.sh` and the application's initialization code do. Every time the application adds a required directory or seed file, this test scaffolding must be updated in lockstep.

Two independent Docker-avoidance mechanisms exist (`OPENPALM_COMPOSE_BIN: '/usr/bin/true'` and `OPENPALM_MOCK_COMPOSE`), suggesting they evolved independently and were never reconciled.

### 3.4Docker Test Teardown Is Not Crash-Safe

**Files:** `test/docker/docker-stack.docker.ts`, `test/install-e2e/happy-path.docker.ts`

```typescript
afterAll(async () => {
  if (!runDockerStackTests || !tmpDir) return;
  await composeRun("down", "--remove-orphans", "--timeout", "5");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}, 30_000);
```

If `beforeAll` throws before `tmpDir` is assigned, `afterAll` skips cleanup. Docker containers started before the crash are orphaned. There is no `try/finally` around the `beforeAll` body.

### 3.5Runtime Artifacts Committed to Repo

**Files:**
- `packages/ui/e2e/.e2e-state.json` — orphaned state file from a crashed test run
- `packages/ui/e2e/screenshots/*.png` — test-generated screenshots overwritten every run

These create noisy diffs, bloat repo history, and cause unpredictable behavior. They should be in `.gitignore`.

### 3.6Five Incompatible Test Runners

| Runner | Config | Purpose |
|---|---|---|
| Bun unit tests | `bunfig.toml` | All non-UI tests |
| Vitest (browser) | `vite.config.ts` | Svelte component tests |
| Playwright E2E | `playwright.config.ts` | Full UI flows |
| Docker-backed Bun | `beforeAll` in test file | Container integration |
| Live-stack integration | `bun test --filter integration` | Against running `dev:up` |

These have **no shared configuration**, **no shared timeout policy**, and **no shared skip/guard strategy**.

---

## 4. Findings: Medium-Severity Issues

### 4.1Massive Test Duplication

HMAC signing/verification is tested **35 times** across three files for two pure, deterministic functions:

| File | Test Count | Value |
|---|---|---|
| `packages/lib/src/shared/crypto.test.ts` | 7 | Strict subset of security test |
| `core/gateway/src/channel-security.test.ts` | 3 | Duplicated by security test |
| `test/security/hmac.security.test.ts` | ~25 | Most thorough, keep this one |

Similarly, `test/security/input-bounds.security.test.ts` and `channels/chat/server.test.ts` both test the chat adapter's auth rejection, payload validation, and HMAC signing. The security file has ~35 tests already covered by the adapter's own test plus the integration test.

**Practical consequence:** Changing the chat adapter requires updating tests in three separate files.

### 4.2Global `Bun.spawn` Monkey-Patching

**File:** `packages/lib/src/admin/compose-runner.test.ts`

```typescript
beforeEach(() => {
  originalSpawn = Bun.spawn;
  Bun.spawn = spawnMock as unknown as typeof Bun.spawn;
});
```

Global mutation of `Bun.spawn` leaks if any test throws before `afterEach`. The root cause is that `composeAction`/`composeExec` call `Bun.spawn` directly rather than accepting a spawn function as a dependency. The `createMockRunner` pattern used in `stack-apply-engine.test.ts` is the better approach — the runner itself needs constructor injection.

### 4.3The `automations.test.ts` Cache-Busting Hack

**File:** `packages/lib/src/admin/automations.test.ts`

```typescript
const { ensureCronDirs, syncAutomations } = await import(`./automations.ts?cron=${Date.now()}`);
```

The `?cron=${Date.now()}` query string forces Bun to re-import the module fresh because `automations.ts` has environment dependencies baked in at module-load time. This is a workaround for a source code design problem, not a testing pattern.

### 4.4Repetitive Tests at Wrong Granularity

**File:** `packages/lib/src/admin/setup-manager.test.ts`

Three near-identical tests for `setAccessScope`:

```typescript
it('persists the "host" scope', () => { ... });
it('persists the "lan" scope', () => { ... });
it('persists the "public" scope', () => { ... });
```

One parameterized test would suffice. Similarly, `completeStep` tests hardcode the complete step list and break whenever a new step is added.

### 4.5Docker Tests Hand-Coordinate Ports

**Files:** `test/docker/docker-stack.docker.ts`, `test/install-e2e/happy-path.docker.ts`

```typescript
// docker-stack.docker.ts
const ADMIN_PORT = 18200;
const GATEWAY_PORT = 18280;

// happy-path.docker.ts
const ADMIN_PORT = 18300;
```

No dynamic port allocation. Adding a third Docker test file requires manually inspecting all existing files to avoid collisions.

### 4.6`OPENPALM_COMPOSE_BIN: '/usr/bin/true'` Is Unix-Only

**File:** `packages/ui/e2e/env.ts`

This path doesn't exist on Windows. Any compose call silently succeeds (no-op). This is undocumented — a test author might write a test asserting Docker side effects and it will silently pass.

### 4.7Cross-Test Shared Mutables

**File:** `packages/ui/e2e/06-automations-api.pw.ts`

```typescript
let createdId: string;
// Set by "creates new automation" test, consumed by "updates" and "deletes" tests
```

If the create test is skipped or fails, subsequent tests operate on undefined. The guard (`if (!nonCore) return;`) silently passes the test with zero assertions — false confidence.

---

## 5. Findings: Low-Severity Issues

### 5.1"Contract" Tests Don't Test Contracts

**File:** `test/contracts/admin-api.contract.test.ts`

```typescript
it("documents current admin endpoints in api-reference.md", () => {
  const docs = readFileSync("dev/docs/api-reference.md", "utf8");
  expect(docs.includes("/setup/status")).toBe(true);
  expect(docs.includes("/connections")).toBe(false);
```

This test asserts that strings exist in a markdown documentation file. It doesn't hit any API endpoint, doesn't validate response shapes, and passes even if every endpoint is broken. The expectations that certain strings are **absent** from docs will break the moment anyone documents those routes.

Uses a relative path — works from repo root, fails from any subdirectory.

### 5.2`readme-no-npx.test.ts` Is a Linting Rule

**File:** `test/contracts/readme-no-npx.test.ts`

Asserts that `README.md` doesn't contain `"npx "`. This belongs in a pre-commit hook, not the test suite.

### 5.3The Wizard UI Test Mocks Away the Most Critical Part

**File:** `packages/ui/e2e/10-setup-wizard-ui.pw.ts`

```typescript
async function mockHealthCheckAllOk(page: Page) {
  await page.route('**/setup/health-check', (route) => {
    route.fulfill({ ... services all ok ... });
  });
}
```

The health check step — the part most likely to have edge-case bugs due to conditional rendering — is mocked to always succeed. No tests for: partial service failure, timeout behavior, polling interval, service returning `ok: false`.

### 5.4`admin-health-check.integration.test.ts` Makes Redundant Requests

**File:** `test/integration/admin-health-check.integration.test.ts`

Four separate `it()` blocks each fetch the same `/setup/health-check` endpoint and parse JSON independently. That's three extra HTTP round-trips to assert properties of the same response.

### 5.5The Wizard UI Test Re-Tests What File 03 Already Tested

**File:** `packages/ui/e2e/10-setup-wizard-ui.pw.ts` (lines 156–195)

The file-existence assertions (`openpalm.yaml`, `docker-compose.yml`, `caddy.json`, `secrets.env`) are identical to those in `03-setup-api.pw.ts` (lines 132–176). The browser test re-tests the API layer instead of focusing on UI-specific concerns.

---

## 6. Test Value Assessment

### Tests to Preserve (High Value)

| File | Why |
|---|---|
| `core/gateway/src/server.test.ts` | Real Bun.serve mock, full request pipeline, no Docker needed |
| `packages/lib/src/admin/stack-manager.test.ts` | Real filesystem ops against real temp dirs, catches real bugs |
| `packages/lib/src/admin/setup-manager.test.ts` | Solid state management with good edge cases |
| Channel `server.test.ts` files | Each tests the real handler with mock fetch |
| `packages/lib/src/admin/stack-apply-engine.test.ts` | Proper dependency injection via `createMockRunner` |
| `test/security/hmac.security.test.ts` | Most thorough HMAC coverage (consolidation target) |
| `packages/ui/e2e/10-setup-wizard-ui.pw.ts` (browser parts) | Real browser wizard walkthrough with artifact checks |

### Tests to Delete or Merge (Low/Zero Value)

| File | Issue | Action |
|---|---|---|
| `packages/lib/src/shared/crypto.test.ts` | Strict subset of `hmac.security.test.ts` | Delete |
| `core/gateway/src/channel-security.test.ts` | 3 tests duplicated by security suite | Reduce to 1 smoke test |
| `test/contracts/admin-api.contract.test.ts` | Tests markdown text, not API behavior | Delete; move to pre-commit hook |
| `test/contracts/readme-no-npx.test.ts` | Linting rule, not a test | Delete; move to pre-commit hook |
| `test/contracts/channel-message.contract.test.ts` | Tests a helper defined inside the test file | Rewrite to validate real types |

### Tests That Need Fundamental Rework

| File | Issue | Action |
|---|---|---|
| `packages/ui/e2e/01-08, 11-*.pw.ts` | Playwright used as HTTP client | Extract to `bun:test` |
| `packages/ui/e2e/03-setup-api.pw.ts` | Sequential state machine | Break into isolated groups with state reset |
| `test/integration/*.integration.test.ts` | Always skipped in CI | Either run in CI or convert to mock-server pattern |
| `test/contracts/setup-wizard-gate.contract.test.ts` | Mutates real dev state | Use temp directory |

---

## 7. Recommendations

### Priority 1: Stop the Bleeding (1–2 days)

#### R1. Add runtime artifacts to `.gitignore`

```gitignore
# E2E runtime artifacts
packages/ui/e2e/.e2e-state.json
packages/ui/e2e/screenshots/
```

Delete the committed files after adding the ignore rules.

#### R2. Fix the `setup-wizard-gate.contract.test.ts` state mutation

Use `mkdtempSync` for an isolated temp directory instead of reading/writing `.dev/data/admin/setup-state.json`. Pattern already exists in `setup-manager.test.ts`.

#### R3. Fix the relative path in `admin-api.contract.test.ts`

```typescript
// Before (CWD-dependent):
const docs = readFileSync("dev/docs/api-reference.md", "utf8");

// After (anchored to file location):
const docs = readFileSync(join(import.meta.dir, "../../dev/docs/api-reference.md"), "utf8");
```

### Priority 2: Reduce Noise and Duplication (2–3 days)

#### R4. Delete duplicate HMAC tests

Keep `test/security/hmac.security.test.ts` (most thorough). Delete `packages/lib/src/shared/crypto.test.ts`. Reduce `core/gateway/src/channel-security.test.ts` to a single smoke test.

#### R5. Delete fake contract tests

Move `admin-api.contract.test.ts` doc-string checks and `readme-no-npx.test.ts` to a pre-commit hook or a dedicated lint script. Replace `admin-api.contract.test.ts` with an actual contract test that starts a server and validates endpoint status codes and response shapes.

#### R6. Eliminate silent test passes

Every `if (!condition) return;` guard in a test body must be replaced with either:
- `test.skip(condition, 'reason')` — so skip is visible in output
- Or restructured so the test has a real precondition check in `beforeAll`

### Priority 3: Fix the E2E Architecture (3–5 days)

#### R7. Extract API tests from Playwright into `bun:test`

Move files `01-health-meta`, `02-auth-api`, `03-setup-api`, `04-stack-api`, `05-secrets-api`, `06-automations-api`, `07-channels-api`, `08-command-api`, `11-container-automation-management-api` out of Playwright into `bun:test` integration tests.

Each test group should:
- Start its own SvelteKit server programmatically (or use a shared helper)
- Get its own temp directory with fresh state
- Be independently runnable
- Use `fetch()` directly instead of Playwright's `request`

Keep only files `09-dashboard-ui.pw.ts` and `10-setup-wizard-ui.pw.ts` in Playwright.

#### R8. Break the sequential state machine

The setup wizard API tests (`03-setup-api.pw.ts`) should either:
- **Option A:** Be a single test that walks through the complete flow as one atomic operation (honest about what it is)
- **Option B:** Be multiple independent tests, each starting from a known state via a `resetServerState()` helper

Option A is simpler and more honest. The 17 "tests" are really 17 steps in one test.

#### R9. Add a `resetServerState()` utility

```typescript
export function resetServerState(tmpDir: string): void {
  writeFileSync(join(tmpDir, 'data/admin/setup-state.json'), JSON.stringify({
    completed: false,
    steps: { welcome: false, profile: false, /* ... */ }
  }));
  // Remove generated artifacts
  for (const f of ['state/docker-compose.yml', 'state/caddy.json', ...]) {
    rmSync(join(tmpDir, f), { force: true });
  }
}
```

Callable in `beforeAll` for any test group that needs first-boot state.

#### R10. Stop rebuilding on every test run

The E2E server should use a pre-built artifact or run in dev mode:
- **Option A:** Run `bun run build` once in CI before the Playwright job, pass the build dir
- **Option B:** Use `vite dev` mode for local test runs (faster feedback)
- **Option C:** Cache the build and only rebuild on source changes

### Priority 4: Fix Integration Test Strategy (3–5 days)

#### R11. Make integration tests run in CI

Either:
- **Option A:** Add `OPENPALM_INTEGRATION=1` to the CI workflow and use Docker service containers to provide the stack
- **Option B:** Convert integration tests to the in-process mock server pattern from `server.test.ts` (no Docker needed)

Option B is strongly preferred — it makes tests hermetic and fast.

#### R12. Fix `bun test` discovery

Restructure so `bun test` (the default) only finds tests that can run without Docker or a live stack:

```toml
# bunfig.toml
[test]
root = "."
# Only discover tests in these directories by default
include = ["packages/*/src/**/*.test.ts", "core/*/src/**/*.test.ts", "channels/*/src/**/*.test.ts"]
# Exclude tests that need external deps
exclude = ["test/integration/**", "test/docker/**", "test/install-e2e/**"]
```

Or move Docker/integration tests to a naming convention (`*.docker.ts`, `*.integration.ts`) and exclude them from the default pattern.

### Priority 5: Design Improvements (Ongoing)

#### R13. Inject dependencies instead of monkey-patching globals

`compose-runner.ts` should accept a spawn function:

```typescript
type SpawnFn = typeof Bun.spawn;

export function createComposeRunner(spawn: SpawnFn = Bun.spawn) {
  // All internal functions close over spawn
}
```

Tests pass in a mock spawn without touching the global.

#### R14. Fix module-load side effects in `automations.ts`

The `?cron=${Date.now()}` import hack exists because the module reads env vars at load time. Refactor to accept config as a parameter.

#### R15. Add health-check failure tests

The Playwright wizard test mocks `healthCheckAllOk`. Add at minimum:
- One test where a service returns `ok: false` — verify the UI shows an error state
- One test for timeout behavior — verify the UI shows a timeout message
- One test for partial readiness — verify per-service status rendering

#### R16. Deduplicate parameterized tests

Replace patterns like:

```typescript
it('persists the "host" scope', () => { ... });
it('persists the "lan" scope', () => { ... });
it('persists the "public" scope', () => { ... });
```

With:

```typescript
for (const scope of ["host", "lan", "public"] as const) {
  it(`persists "${scope}" scope`, () => { ... });
}
```

#### R17. Dynamic port allocation for Docker tests

Replace hardcoded ports (`18200`, `18300`) with OS-assigned ports or a port allocator to prevent collisions.

---

## 8. Stabilization Loop: Wizard Fix Protocol

This section defines the iterative process for making the setup wizard reliably testable. This is not a one-shot task — it is a loop that repeats until the acceptance criteria in Section 1 are met.

### 8.1 The Loop

```
┌─────────────────────────────────────────────────────────┐
│  REPEAT UNTIL: 3 consecutive clean runs pass            │
│                                                         │
│  1. RESET state (clean first-boot)                      │
│  2. BUILD the stack (fix any build errors)              │
│  3. START the stack                                     │
│  4. EXPLORE the wizard manually via Chrome DevTools     │
│     - Walk through every step                           │
│     - Record any issues (UI bugs, API errors, state     │
│       problems, env var issues)                         │
│  5. FIX all issues found                                │
│  6. WRITE/UPDATE Playwright tests based on exploration  │
│  7. RUN the Playwright test                             │
│     - If it fails: go to step 5                         │
│     - If it passes: increment the pass counter          │
│  8. RESET state and go to step 3                        │
│                                                         │
│  Pass counter must reach 3 without any manual           │
│  intervention between runs.                             │
└─────────────────────────────────────────────────────────┘
```

### 8.2 State Reset Procedure

Before each test run, the following must be automated and reliable:

1. **Stop all containers:** `docker compose down --remove-orphans --timeout 5`
2. **Delete all generated state:**
   - `setup-state.json` (wizard progress)
   - `openpalm.yaml` (stack spec)
   - `docker-compose.yml` (generated compose)
   - `caddy.json` (generated Caddy config)
   - `secrets.env` (generated secrets)
   - All service-specific `.env` files
3. **Reset to first-boot state:** Write a fresh `setup-state.json` with `completed: false` and all steps `false`
4. **Verify clean state:** Assert `GET /setup/status` returns `firstBoot: true` and `completed: false`

This must be a single callable function (`resetToFirstBoot()`) usable from both manual scripts and Playwright `beforeAll`.

### 8.3 Environment Variable Consolidation

As part of each loop iteration, track and prune environment variables:

**Current problem:** The test harness uses 22+ environment variables in `env.ts`, many of which duplicate or conflict with variables in `docker-compose.dev.yml`, `.env.example`, and individual service configs. Two independent Docker-mock mechanisms (`OPENPALM_COMPOSE_BIN` and `OPENPALM_MOCK_COMPOSE`) coexist.

**Required actions:**
- Create a single `packages/ui/e2e/test-env.ts` that is the sole source of truth for all test environment variables
- Remove `OPENPALM_MOCK_COMPOSE` — use only `OPENPALM_COMPOSE_BIN` for controlling compose behavior
- Remove `OPENPALM_TEST_MODE` if it exists solely to disable side effects that should be controlled by the compose binary path
- Document each variable with: name, purpose, default value, which tests use it

### 8.4 What the Final Playwright Test Must Do

The acceptance test (not a mock-based test — this is the real thing) must:

```typescript
test.describe('Setup Wizard: Full Flow (real services)', () => {
  test.beforeAll(async () => {
    await resetToFirstBoot();
    // Verify clean state
    const status = await fetch(`${BASE_URL}/setup/status`);
    const body = await status.json();
    expect(body.firstBoot).toBe(true);
    expect(body.completed).toBe(false);
  });

  test('completes the full wizard and verifies system health', async ({ page }) => {
    // Step 1: Welcome
    await page.goto('/');
    // ... click through Welcome step

    // Step 2: Profile
    // ... fill in name, email, password (real values, not empty strings)

    // Step 3: Providers / Service Instances
    // ... configure Anthropic API key (real or test key)

    // Step 4: Security
    // ... configure security settings

    // Step 5: Channels
    // ... enable at least one channel

    // Step 6: Access Scope
    // ... set access scope

    // Step 7: Health Check / Complete
    // ... click Complete/Finish
    // DO NOT mock the health check endpoint
    // WAIT for real services to respond

    // FAIL CONDITIONS (any of these = test failure):
    await expect(page.locator('text=services took too long')).not.toBeVisible();
    await expect(page.locator('[data-status="not-ready"]')).toHaveCount(0);
    // Or whatever selector indicates a service is not ready

    // SUCCESS CONDITIONS:
    await expect(page.locator('text=Everything is ready')).toBeVisible();
    // All services show green/ready status

    // SCREENSHOT: Save proof of completion
    await page.screenshot({
      path: 'packages/ui/e2e/proof/wizard-complete.png',
      fullPage: true
    });

    // ARTIFACT VERIFICATION: Check generated files
    // These must exist AND be valid
    const stackSpec = readFileSync(join(STATE_DIR, 'openpalm.yaml'), 'utf8');
    expect(() => YAML.parse(stackSpec)).not.toThrow();
    expect(stackSpec).toContain('channels:');

    const compose = readFileSync(join(STATE_DIR, 'docker-compose.yml'), 'utf8');
    expect(() => YAML.parse(compose)).not.toThrow();
    expect(compose).toContain('services:');

    const caddy = readFileSync(join(STATE_DIR, 'caddy.json'), 'utf8');
    expect(() => JSON.parse(caddy)).not.toThrow();

    const secrets = readFileSync(join(STATE_DIR, 'secrets.env'), 'utf8');
    expect(secrets.length).toBeGreaterThan(0);

    // Verify the setup status API confirms completion
    const finalStatus = await page.request.get('/setup/status');
    const finalBody = await finalStatus.json();
    expect(finalBody.completed).toBe(true);
    expect(finalBody.firstBoot).toBe(false);
  });
});
```

### 8.5 Three-Run Consistency Requirement

The test must pass three consecutive times with full state reset between runs. This can be enforced with a wrapper script:

```bash
#!/bin/bash
# run-wizard-acceptance.sh
PASS_COUNT=0
REQUIRED=3

for i in $(seq 1 $REQUIRED); do
  echo "=== Run $i of $REQUIRED ==="

  # Reset state
  ./dev/reset-wizard-state.sh

  # Run the acceptance test
  cd packages/ui && npx playwright test e2e/wizard-acceptance.pw.ts
  if [ $? -ne 0 ]; then
    echo "FAIL on run $i"
    exit 1
  fi

  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS ($PASS_COUNT/$REQUIRED)"
done

echo "=== ALL $REQUIRED RUNS PASSED ==="
```

### 8.6 Issue Tracking During Loop

During each iteration, issues discovered via Chrome DevTools exploration must be recorded in a structured format before fixing. Create `dev/docs/wizard-stabilization-log.md`:

```markdown
## Issue Log

### Run N, Date

| # | Step | Issue | Root Cause | Fix |
|---|------|-------|------------|-----|
| 1 | Profile | Password field doesn't validate on blur | Missing event handler | Added onblur handler in ProfileStep.svelte |
| 2 | Complete | Health check times out after 60s | Gateway not receiving env vars | Fixed env_file path in compose generation |
```

This log serves as both a debugging aid and a regression test source — every issue found should eventually have a corresponding test assertion.

### 8.7 What to Simplify During the Loop

Each loop iteration is an opportunity to simplify the configuration. Targets:

- **Remove `start-webserver-for-ci.mjs`** — it appears to be dead code
- **Collapse `start-webserver.cjs` + `env.ts` + `global-teardown.ts`** into a single `test-setup.ts` module
- **Remove the `.e2e-state.json` persistence mechanism** — use Playwright's built-in `globalSetup`/`globalTeardown` with proper return values instead of writing state to disk
- **Remove `OPENPALM_TEST_MODE`** if it exists only to skip compose operations — the acceptance test must NOT skip compose operations
- **Consolidate the two Docker-mock flags** into one clear mechanism (or eliminate mocking entirely for the acceptance test)
- **Eliminate the 22-variable `webServerEnv()` function** — derive paths from a single `OPENPALM_ROOT` or `OPENPALM_STATE_HOME` variable, matching how the application itself resolves paths

---

## 9. Relationship to Existing `testing-todos.md`

The existing `testing-todos.md` is a forward-looking plan that describes what **should be built**. This review identifies what is **currently broken** and must be fixed before building forward.

Key gaps in `testing-todos.md` that this review addresses:

| This Review Finding | testing-todos.md Coverage |
|---|---|
| Sequential state machine in E2E | Not addressed — todos add more tests to the same broken pipeline |
| Playwright misused as HTTP client | Not addressed |
| Contract tests that test markdown | Not addressed |
| Integration tests dead in CI | Mentioned in P1-A but no concrete resolution |
| `bun test` discovery landmine | Not addressed |
| HMAC test duplication (35 tests) | Not addressed |
| Global `Bun.spawn` monkey-patching | Mentioned as known bug, no fix plan |
| Real dev state mutation | Not addressed |
| Runtime artifacts in repo | Not addressed |

**Recommendation:** The priorities in this review (P1–P5) should be completed **before** resuming the phased plan in `testing-todos.md`. The existing plan adds complexity to an architecture that needs simplification first.

---

## Appendix: Commands for Verification

```bash
# Count HMAC tests across all files
bun test --match "hmac|sign|verify" 2>&1 | grep -c "✓\|✗"

# Find all tests that silently skip
grep -rn "test.skip\|describe.skipIf\|if.*return;" test/ packages/ui/e2e/ --include="*.ts"

# Find all hardcoded localhost ports in tests
grep -rn "localhost:[0-9]" test/ --include="*.ts"

# Find all relative readFileSync in tests
grep -rn 'readFileSync("[^/]' test/ --include="*.ts"

# List all test scripts
grep -E '"test' package.json
```
