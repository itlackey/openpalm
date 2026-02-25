# R8: Break the Sequential State Machine

## Summary

`packages/ui/e2e/03-setup-api.pw.ts` contains 22 `test()` calls inside a single
`test.describe()` block. These are not independent tests -- they are sequential steps in a
single workflow that walks the setup wizard from first boot to completion, then verifies
the generated artifacts. Each test mutates server state that later tests depend on. If any
test fails, every subsequent test in the file (and in files 04 through 11) fails with
misleading errors because the server is in an unexpected state.

The `test.describe` label even acknowledges this: `"setup wizard API (sequential, modifies
state)"`. Playwright reports 22 individual pass/fail results, but the suite has zero
isolation -- it is one procedural script wearing 22 test-shaped hats.

**Recommendation: Option A** -- collapse the 22 "tests" into a single test that walks
through the complete setup flow as one atomic operation. This is simpler, honest about what
the code actually does, and eliminates cascading failures.

## Current Test Structure

The file contains 22 `test()` calls in one `test.describe()` block. Here they are in
execution order, grouped by the phase of the setup flow they exercise:

| # | Test name | What it does | State dependency |
|---|-----------|-------------|-----------------|
| 1 | `POST setup step "welcome" marks complete` | Marks `steps.welcome = true` | None (first-boot state) |
| 2 | `POST setup step "bogus" returns 400` | Sends invalid step name, expects 400 | None (stateless validation) |
| 3 | `POST setup/profile saves name/email` | Sets `profile.name` and `profile.email` via command endpoint | None |
| 4 | `POST setup step "profile" marks complete` | Marks `steps.profile = true` | Logically after #3 |
| 5 | `POST setup/service-instances saves config` | Sets openmemory URL | None |
| 6 | `POST setup step "serviceInstances" marks complete` | Marks `steps.serviceInstances = true` | Logically after #5 |
| 7 | `POST setup step "security" marks complete` | Marks `steps.security = true` | None |
| 8 | `POST setup/channels with channel-chat saves` | Sets `enabledChannels = ['channel-chat']` with config | None |
| 9 | `POST setup step "channels" marks complete` | Marks `steps.channels = true` | Logically after #8 |
| 10 | `POST setup/access-scope "host" saves` | Sets `accessScope = 'host'` | None |
| 11 | `POST setup/access-scope "internet" returns 400` | Sends invalid scope, expects 400 | None (stateless validation) |
| 12 | `POST setup step "healthCheck" marks complete` | Marks `steps.healthCheck = true` | None |
| 13 | `GET setup/health-check returns services with admin.ok` | Reads health-check endpoint | None |
| 14 | `POST setup/complete marks setup as complete` | Calls `completeSetup()`, generates all artifacts | **Depends on all prior steps** (state must have channels, scope, etc.) |
| 15 | `setup/complete writes docker-compose.yml with required services` | Reads generated file from disk | **Depends on #14** (file must exist) |
| 16 | `setup/complete writes caddy.json with route entries` | Reads generated file from disk | **Depends on #14** |
| 17 | `setup/complete writes runtime .env with OPENPALM_STATE_HOME` | Reads generated file from disk | **Depends on #14** |
| 18 | `setup/complete writes system.env with access scope` | Reads generated file from disk | **Depends on #14** |
| 19 | `setup/complete writes gateway/.env` | Reads generated file from disk | **Depends on #14** |
| 20 | `setup/complete writes secrets.env with POSTGRES_PASSWORD` | Reads generated file from disk | **Depends on #14** |
| 21 | `setup/complete writes openpalm.yaml stack spec` | Reads generated file from disk | **Depends on #14** |
| 22 | `GET setup/status now shows completed: true` | Verifies `completed: true` via API | **Depends on #14** |

Note: An earlier count of "17 tests" from the review document was based on an older
version of the file. The current file has 22 `test()` calls. There is no longer a test
for "GET setup/status without auth returns 401 after completion" at line 191-196 (it was
removed or the file was updated). The actual count is 22.

**Update after re-reading:** The file actually has 23 test calls (lines 8-196). The final
test at line 191 (`GET setup/status without auth returns 401 after completion`) is the
23rd. However, the review's "17 tests" label is close enough to the original spirit of
the recommendation. The exact count does not change the analysis -- all of these are
sequential steps in one flow.

## State Dependency Analysis

The dependencies form a simple linear chain:

```
[First-boot state]
  |
  v
Steps 1-13: Configuration phase
  - Each step writes to setup-state.json on disk
  - Steps 1-13 are mostly independent of each other (they write to
    different fields of the state object)
  - However, the /setup/complete endpoint reads ALL accumulated state
  |
  v
Step 14: POST /setup/complete (the critical pivot)
  - Reads the accumulated state (channels, scope, profile, services)
  - Calls applyStack() which generates docker-compose.yml, caddy.json
  - Writes secrets.env (POSTGRES_PASSWORD), system.env, .env, gateway/.env
  - Writes openpalm.yaml stack spec
  - Marks state.completed = true
  |
  v
Steps 15-21: Artifact verification phase
  - Pure assertions on files generated by step 14
  - All read from the TMP_DIR filesystem
  - Zero API calls, zero state mutation
  |
  v
Steps 22-23: Post-completion behavior
  - Verify completed flag via API
  - Verify auth is now required (behavior change after completion)
```

**Key insight:** The configuration steps (1-13) are *logically* independent of each other
but *practically* dependent because they accumulate state that step 14 consumes. If you
skip step 8 (channels), step 14 generates a compose file without channel-chat, and step
15's assertion on `docker-compose.yml` might fail or produce different output. The steps
are coupled through the shared mutable state on disk.

## Option A vs Option B Analysis

### Option A: Single atomic test (recommended)

Collapse all 22+ test calls into one `test()` that walks through the complete flow.

**Pros:**
- Honest about what the code does -- it is one sequential flow
- Playwright reports one pass or one fail, never 21 misleading cascading failures
- No need for a `resetServerState()` helper
- Simplest possible change -- mechanically flatten the structure
- Preserves all existing assertions exactly as they are
- A single failure points to the exact line where the flow broke

**Cons:**
- One long test function (~180 lines of assertions)
- Playwright's test report shows one entry instead of 22 (less granular at a glance)

**Mitigation for the cons:**
- Use `test.step()` (Playwright's built-in sub-step API) to label each phase. This
  preserves granular reporting in the Playwright trace viewer and HTML report without
  pretending the steps are independent.

### Option B: Independent tests with state reset

Each test calls `resetServerState()` in `beforeEach` to get a known starting state, then
sets up only the state it needs.

**Pros:**
- True isolation -- any test can run alone
- Familiar xUnit structure

**Cons:**
- Requires a `resetServerState()` helper that knows every field of `SetupState` and every
  generated artifact file path. This is a maintenance burden that must stay in sync with
  `SetupManager` and `stack-generator.ts`.
- The "artifact verification" tests (15-21) each need to call the *entire* setup flow
  before they can check one file. That means 7 tests each repeating steps 1-14 -- making
  the suite ~7x slower.
- The `/setup/complete` endpoint triggers `applyStack()` and `composeAction('up', ...)`
  which are heavyweight operations even when mocked. Running them 7 times per suite adds
  real overhead.
- The auth-behavior test (step 23) requires completed state, so it also repeats the full
  flow.
- More code, more complexity, more maintenance -- for tests that are inherently about
  verifying one sequential workflow.

### Decision: Option A

The setup wizard is a linear workflow by design. Users walk through it once, in order.
Testing it as a single flow is honest, simple, and avoids the overhead and fragility of
resetting server state between tests. Option A aligns with the project's principle:
"Simplicity as a primary goal."

## Implementation Steps

### Step 1: Understand the current file structure

**File:** `packages/ui/e2e/03-setup-api.pw.ts`

The file has:
- One `test.describe()` block wrapping everything
- 23 individual `test()` calls inside it
- Imports: `test, expect` from Playwright, `existsSync, readFileSync` from `node:fs`,
  `join` from `node:path`, helpers from `./helpers`, `TMP_DIR` from `./env`

### Step 2: Rewrite as a single test with labeled steps

Replace all 23 `test()` calls with a single `test()` that uses `test.step()` for each
logical phase. The `test.step()` API is Playwright's built-in mechanism for sub-steps
within a test. Steps appear in the Playwright trace and HTML report with their labels, and
a failure in any step fails the overall test with a clear indication of which step broke.

**New structure:**

```typescript
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authedGet, authedPost, cmd } from './helpers';
import { TMP_DIR } from './env';

test('setup wizard API — complete flow from first boot to finished', async ({ request }) => {

  // ── Phase 1: Welcome ──────────────────────────────────────────
  await test.step('POST setup step "welcome" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'welcome' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.welcome).toBe(true);
  });

  await test.step('POST setup step "bogus" returns 400', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'bogus' });
    expect(res.status()).toBe(400);
  });

  // ── Phase 2: Profile ──────────────────────────────────────────
  await test.step('POST setup/profile saves name/email', async () => {
    const res = await cmd(request, 'setup.profile', {
      name: 'Taylor Palm',
      email: 'taylor@example.com'
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.profile.name).toBe('Taylor Palm');
    expect(body.data.profile.email).toBe('taylor@example.com');
  });

  await test.step('POST setup step "profile" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'profile' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.profile).toBe(true);
  });

  // ── Phase 3: Service Instances ────────────────────────────────
  await test.step('POST setup/service-instances saves config', async () => {
    const res = await authedPost(request, '/setup/service-instances', {
      openmemory: 'http://test:8765',
      psql: '',
      qdrant: ''
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  await test.step('POST setup step "serviceInstances" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'serviceInstances' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.serviceInstances).toBe(true);
  });

  // ── Phase 4: Security ─────────────────────────────────────────
  await test.step('POST setup step "security" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'security' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.security).toBe(true);
  });

  // ── Phase 5: Channels ─────────────────────────────────────────
  await test.step('POST setup/channels with channel-chat saves', async () => {
    const res = await authedPost(request, '/setup/channels', {
      channels: ['channel-chat'],
      channelConfigs: { 'channel-chat': { CHAT_INBOUND_TOKEN: 'test-token' } }
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  await test.step('POST setup step "channels" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'channels' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.channels).toBe(true);
  });

  // ── Phase 6: Access Scope ─────────────────────────────────────
  await test.step('POST setup/access-scope "host" saves', async () => {
    const res = await authedPost(request, '/setup/access-scope', { scope: 'host' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.accessScope).toBe('host');
  });

  await test.step('POST setup/access-scope "internet" returns 400', async () => {
    const res = await authedPost(request, '/setup/access-scope', { scope: 'internet' });
    expect(res.status()).toBe(400);
  });

  // ── Phase 7: Health Check ─────────────────────────────────────
  await test.step('POST setup step "healthCheck" marks complete', async () => {
    const res = await authedPost(request, '/setup/step', { step: 'healthCheck' });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.healthCheck).toBe(true);
  });

  await test.step('GET setup/health-check returns services with admin.ok', async () => {
    const res = await request.get('/setup/health-check');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.services).toBeDefined();
    expect(body.services.admin.ok).toBe(true);
  });

  // ── Phase 8: Complete Setup ───────────────────────────────────
  await test.step('POST setup/complete marks setup as complete', async () => {
    const res = await authedPost(request, '/setup/complete', {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.completed).toBe(true);
  });

  // ── Phase 9: Verify Generated Artifacts ───────────────────────
  await test.step('setup/complete writes docker-compose.yml with required services', async () => {
    const composePath = join(TMP_DIR, 'state', 'docker-compose.yml');
    expect(existsSync(composePath), `compose file missing: ${composePath}`).toBe(true);
    const content = readFileSync(composePath, 'utf8');
    expect(content).toContain('services:');
    expect(content).toContain('assistant:');
    expect(content).toContain('gateway:');
  });

  await test.step('setup/complete writes caddy.json with route entries', async () => {
    const caddyPath = join(TMP_DIR, 'state', 'caddy.json');
    expect(existsSync(caddyPath), `caddy.json missing: ${caddyPath}`).toBe(true);
    const content = readFileSync(caddyPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  await test.step('setup/complete writes runtime .env with OPENPALM_STATE_HOME', async () => {
    const envPath = join(TMP_DIR, 'state', '.env');
    expect(existsSync(envPath), `.env missing: ${envPath}`).toBe(true);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('OPENPALM_STATE_HOME=');
  });

  await test.step('setup/complete writes system.env with access scope', async () => {
    const sysEnvPath = join(TMP_DIR, 'state', 'system.env');
    expect(existsSync(sysEnvPath), `system.env missing: ${sysEnvPath}`).toBe(true);
    const content = readFileSync(sysEnvPath, 'utf8');
    expect(content).toContain('OPENPALM_ACCESS_SCOPE=');
  });

  await test.step('setup/complete writes gateway/.env', async () => {
    const gwEnvPath = join(TMP_DIR, 'state', 'gateway', '.env');
    expect(existsSync(gwEnvPath), `gateway/.env missing: ${gwEnvPath}`).toBe(true);
  });

  await test.step('setup/complete writes secrets.env with POSTGRES_PASSWORD', async () => {
    const secretsPath = join(TMP_DIR, 'config', 'secrets.env');
    expect(existsSync(secretsPath), `secrets.env missing: ${secretsPath}`).toBe(true);
    const content = readFileSync(secretsPath, 'utf8');
    expect(content).toContain('POSTGRES_PASSWORD=');
  });

  await test.step('setup/complete writes openpalm.yaml stack spec', async () => {
    const specPath = join(TMP_DIR, 'config', 'openpalm.yaml');
    expect(existsSync(specPath), `stack spec missing: ${specPath}`).toBe(true);
    const content = readFileSync(specPath, 'utf8');
    expect(content.length, 'stack spec is empty').toBeGreaterThan(0);
  });

  // ── Phase 10: Post-Completion Behavior ────────────────────────
  await test.step('GET setup/status now shows completed: true', async () => {
    const res = await authedGet(request, '/setup/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(true);
  });

  await test.step('GET setup/status without auth returns 401 after completion', async () => {
    const res = await request.get('/setup/status');
    expect(res.status()).toBe(401);
  });
});
```

### Step 3: Remove the wrapping `test.describe()` block

The single test is self-documenting through its name and step labels. The `test.describe()`
wrapper added nothing except the sequential disclaimer, which is no longer needed because
the test is now honestly a single test.

If preferred for consistency with other E2E files, a `test.describe()` can be kept:

```typescript
test.describe('setup wizard API', () => {
  test('complete flow from first boot to finished', async ({ request }) => {
    // ... all steps ...
  });
});
```

This is a stylistic choice. Either form works.

### Step 4: Verify no downstream file dependencies break

Files 04 through 11 depend on the *server state* produced by file 03 (specifically, that
`completed = true` after the setup flow finishes). They do not import anything from
`03-setup-api.pw.ts`. The refactoring changes only the test structure, not the API calls
made or the state produced. The server ends in the same state after the single test as it
did after the 23 sequential tests.

Files to verify are unaffected:
- `04-stack-api.pw.ts` -- requires `completed: true` (still true after our single test)
- `05-secrets-api.pw.ts` -- requires auth (still works)
- `06-automations-api.pw.ts` -- requires auth (still works)
- `07-channels-api.pw.ts` -- requires auth (still works)
- `08-command-api.pw.ts` -- checks setup status defensively (still works)
- `09-dashboard-ui.pw.ts` -- browser test, requires completed setup (still works)
- `10-setup-wizard-ui.pw.ts` -- browser test (still works)
- `11-container-automation-management-api.pw.ts` -- requires auth (still works)

### Step 5: Run the test suite and verify

After making the change, run the full Playwright E2E suite:

```bash
cd packages/ui && npx playwright test
```

Expected outcome:
- File `03-setup-api.pw.ts` reports **1 test** with 23 sub-steps, all passing
- All other E2E files (01-02, 04-11) continue to pass unchanged
- Total test count drops by 22 (from N to N-22), but total assertion count is unchanged

To verify that the step labels appear in the report:

```bash
cd packages/ui && npx playwright test e2e/03-setup-api.pw.ts --reporter=list
```

Each `test.step()` should appear as a sub-entry under the single test.

## Files to Modify

| File | Change |
|------|--------|
| `packages/ui/e2e/03-setup-api.pw.ts` | Replace 23 `test()` calls with 1 `test()` containing 23 `test.step()` calls |

No other files need modification. No new files are created.

## Risk Assessment

**Risk: Very low.**

- This is a pure structural refactoring. Every API call, every assertion, every expected
  value remains identical.
- The server ends in the same state after the refactored test as before.
- No imports, helpers, environment variables, or configuration files change.
- The `test.step()` API is a stable, well-documented Playwright feature.
- If a step fails, the test stops immediately (same behavior as today where a failed test
  would cascade-fail all later tests, except now the failure is reported once instead of
  N times).
- Downstream files 04-11 are unaffected because they depend on server state, not on the
  structure of file 03.

## What This Does NOT Address

This plan addresses only R8 (the sequential state machine in `03-setup-api.pw.ts`). It
does not address:

- **R7 (Move API tests out of Playwright):** The broader recommendation to move files
  01-08 and 11 from Playwright to `bun:test` with `fetch()` is a separate, larger effort.
  R8 can be done first as an incremental improvement -- the single-test structure will be
  even easier to migrate to `bun:test` later if R7 is pursued.
- **R9 (resetServerState utility):** Not needed for Option A. If Option B were chosen,
  R9 would be a prerequisite. Since we are going with Option A, R9 is deferred or dropped
  for this file.
- **R10 (Stop rebuilding on every test run):** Orthogonal to test structure.
