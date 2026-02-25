# R15: Add Health-Check Failure Tests

## Problem

The Playwright wizard test in `packages/ui/e2e/10-setup-wizard-ui.pw.ts` uses a
`mockHealthCheckAllOk()` helper that stubs the `/setup/health-check` endpoint so every
service returns `ok: true`. This guarantees the "full wizard flow completes successfully"
test reaches the `Everything is ready!` happy path, but it means the entire failure
surface of the Complete step is **never exercised in E2E tests**:

- A service reporting `ok: false` (with or without an `error` message)
- The polling loop timing out after exhausting all attempts
- A mix of healthy and unhealthy services (partial readiness)

These are all real-world scenarios (Docker not running, a container crash-looping, slow
cold-start) and the UI has distinct rendering paths for each. Without tests, regressions
in these paths go undetected.

---

## Current Mock Implementation

```typescript
// packages/ui/e2e/10-setup-wizard-ui.pw.ts, lines 16-32
async function mockHealthCheckAllOk(page: Page) {
    await page.route('**/setup/health-check', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                services: {
                    gateway: { ok: true, time: new Date().toISOString() },
                    assistant: { ok: true, time: new Date().toISOString() },
                    openmemory: { ok: true, time: new Date().toISOString() },
                    admin: { ok: true, time: new Date().toISOString() }
                },
                serviceInstances: { openmemory: '', psql: '', qdrant: '' }
            })
        });
    });
}
```

The mock intercepts **all** requests to `**/setup/health-check` and returns a static
payload where every service is healthy.

---

## Health Check Response Shape

The server endpoint (`packages/ui/src/routes/setup/health-check/+server.ts`) returns:

```typescript
{
    services: {
        gateway:    { ok: boolean; time?: string; error?: string },
        assistant:  { ok: boolean; time?: string; error?: string },
        openmemory: { ok: boolean; time?: string; error?: string },
        admin:      { ok: true;    time: string }   // always ok (it's serving the request)
    },
    serviceInstances: {
        openmemory: string,
        psql:       string,
        qdrant:     string
    }
}
```

The `checkServiceHealth()` function in `packages/ui/src/lib/server/health.ts` uses a
3-second `AbortSignal.timeout` and returns `{ ok: false, error: String(e) }` on any
exception (timeout, network error, etc.).

---

## UI Components That Render Health Status

### 1. `CompleteStep.svelte` (primary target for these tests)

This is the component shown on the final "Complete" wizard step. It runs `pollUntilReady()`
on mount, which polls `/setup/health-check` up to 60 times (1 second apart):

| State | Condition | UI rendering |
|---|---|---|
| **Polling in progress** | `!ready && !timedOut && serviceStatus has entries` | Per-service `<li>` list: green text for `ready`, muted text for `starting...` |
| **All services ready** | `allOk === true` | `statusText = "Everything is ready!"`, primary "Continue to Admin" button |
| **Fast-fail (5 polls)** | No non-admin service has `ok: true` after 5 polls | `timedOut = true`, `statusText = "Some services are still starting."` |
| **Full timeout (60 polls)** | Loop exhausted | Same as fast-fail |
| **Timed-out detail** | `timedOut === true` | `"Some services took too long to start:"` heading, per-service `<li>` list with green/red colors, "not ready" labels, secondary "Continue to Admin" button, help text with `openpalm logs` |

Key selectors and text strings:

| Element | Selector / text |
|---|---|
| Status text | `p.muted` containing `statusText` |
| "Everything is ready!" | `text=Everything is ready!` |
| "Some services took too long to start" | `text=Some services took too long to start` |
| Per-service list items | `li` elements inside the Complete step |
| Service "not ready" label | `text=not ready` |
| Service "ready" label | text `ready` in green `<li>` |
| Primary continue button | `button:has-text("Continue to Admin")` |
| Secondary continue button | `button.btn-secondary:has-text("Continue to Admin")` |
| Help text | `text=openpalm logs` |
| "Finalizing setup" | `text=Finalizing setup` |

### 2. `HealthStep.svelte` (pre-finish health check display)

Shown on the "Health Check" wizard step (before clicking "Finish Setup"). Renders per-service
status with dot indicators:

| Element | Selector |
|---|---|
| Dot indicator (healthy) | `.dot.dot-ok` |
| Dot indicator (error) | `.dot.dot-err` |
| Screen-reader label | `.sr-only` containing "Healthy" or "Error" |
| Service name | `strong` with friendly name (e.g., "Message Router") |
| Status text | `"Healthy"` or the `error` string or `"Unreachable"` |

### 3. `HealthStatus.svelte` (dashboard widget -- out of scope)

Dashboard card with similar dot indicators. Not part of the wizard flow; out of scope for
this recommendation.

---

## Three New Test Cases

All three tests follow the same wizard navigation pattern as the existing
"full wizard flow completes successfully" test but use different health-check mocks. They
should be added to the existing `test.describe('setup wizard browser flow')` block in
`packages/ui/e2e/10-setup-wizard-ui.pw.ts`.

### Test 1: Service returns `ok: false` -- verify error state

**Goal**: When one or more services report `ok: false` indefinitely, the UI must show the
timed-out error state with per-service red/green indicators.

**Mock strategy**: Route handler returns a response where `gateway` and `assistant` are
`ok: false` with error messages, while `admin` and `openmemory` are `ok: true`. The
fast-fail logic (5 polls with no non-admin service up) won't trigger because `openmemory`
is up, so we need the loop to reach 60 iterations. To avoid a 60-second wait, we can
make the mock return `ok: false` for all non-admin services to trigger the fast-fail
at 5 polls instead.

**Revised mock**: All non-admin services return `ok: false` to trigger fast-fail after 5
polls (~5 seconds).

```typescript
test('Complete step shows error state when services report ok:false', async ({ page }) => {
    // Mock: all non-admin services are down → triggers fast-fail after 5 polls
    await page.route('**/setup/health-check', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                services: {
                    gateway:    { ok: false, error: 'status 502' },
                    assistant:  { ok: false, error: 'connection refused' },
                    openmemory: { ok: false, error: 'status 503' },
                    admin:      { ok: true, time: new Date().toISOString() }
                },
                serviceInstances: { openmemory: '', psql: '', qdrant: '' }
            })
        });
    });

    // Also mock setup.complete so we reach the Complete step
    await page.route('**/command', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'setup.complete') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, state: { completed: true } })
            });
        } else {
            await route.continue();
        }
    });

    // Navigate to Complete step
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProvidersStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Health Check');
    await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();

    // Wait for Complete step and the fast-fail timeout (~5s)
    await expect(page.locator('.wizard h2')).toContainText('Complete');
    await expect(page.locator('text=Some services took too long to start')).toBeVisible({
        timeout: 15_000
    });

    // Per-service "not ready" labels are shown
    await expect(page.locator('text=not ready').first()).toBeVisible();

    // "Everything is ready!" must NOT appear
    await expect(page.locator('text=Everything is ready!')).not.toBeVisible();

    // The secondary "Continue to Admin" button (fallback) is shown
    await expect(
        page.locator('button.btn-secondary', { hasText: 'Continue to Admin' })
    ).toBeVisible();

    // Help text is shown
    await expect(page.locator('text=openpalm logs')).toBeVisible();
});
```

### Test 2: Timeout behavior -- verify timeout message

**Goal**: Simulate the full polling timeout (all 60 iterations) where some services come
up but not all. Verify the UI shows the timeout message.

**Mock strategy**: Return a mix where `admin` and `openmemory` are `ok: true` but
`gateway` stays `ok: false`. Because a non-admin service (`openmemory`) IS up, the
fast-fail at 5 polls won't trigger, and the loop must run all 60 iterations. To keep the
test fast, we **reduce the effective timeout** by intercepting the poll calls and counting
them, fulfilling with all-ok after only a few calls to test the transition. However, since
we can't modify the component's `MAX_POLLS` constant, a better approach is to let the
fast-fail logic NOT trigger (because openmemory is up) but only wait a manageable number
of iterations. The actual 60-second wait is too long for CI.

**Practical approach**: Use a counter in the route handler. For the first 60 calls, return
the partial-failure response. The loop will time out at 60 iterations. To keep the test
runtime acceptable (~60s), we mark this test with a generous timeout or, better, we
accept the fast-fail path by ensuring NO non-admin services are ok but one service reports
an error string (which still triggers the same timed-out UI path). Actually, the simplest
approach: We test that the polling counter message appears AND then the timeout message
appears. We can make all non-admin services fail to trigger fast-fail at 5 polls (~5s).

Since Test 1 already covers the "all non-admin down" fast-fail, Test 2 should test the
**full 60-poll timeout**. We accept the ~60s runtime and set a generous Playwright timeout.

```typescript
test('Complete step shows timeout message after polling exhaustion', async ({ page }) => {
    test.setTimeout(90_000); // 60s polling + margin

    // Mock: openmemory is up (prevents fast-fail) but gateway/assistant stay down
    await page.route('**/setup/health-check', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                services: {
                    gateway:    { ok: false, error: 'connection refused' },
                    assistant:  { ok: false, error: 'connection refused' },
                    openmemory: { ok: true, time: new Date().toISOString() },
                    admin:      { ok: true, time: new Date().toISOString() }
                },
                serviceInstances: { openmemory: '', psql: '', qdrant: '' }
            })
        });
    });

    // Mock setup.complete to succeed
    await page.route('**/command', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'setup.complete') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, state: { completed: true } })
            });
        } else {
            await route.continue();
        }
    });

    // Navigate to Complete step
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProvidersStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Health Check');
    await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Complete');

    // During polling, the counter message should be visible
    await expect(page.locator('text=Starting services...')).toBeVisible();

    // After 60 polls (~60s), the timeout message appears
    await expect(page.locator('text=Some services took too long to start')).toBeVisible({
        timeout: 75_000
    });

    // Mixed status: openmemory shows "ready", gateway/assistant show "not ready"
    await expect(page.locator('li', { hasText: /openmemory.*ready/ })).toBeVisible();
    await expect(page.locator('li', { hasText: /gateway.*not ready/ })).toBeVisible();
    await expect(page.locator('li', { hasText: /assistant.*not ready/ })).toBeVisible();

    // Fallback continue button is available
    await expect(
        page.locator('button.btn-secondary', { hasText: 'Continue to Admin' })
    ).toBeVisible();
});
```

**Note on CI time**: This test takes ~60 seconds. If that is unacceptable, an alternative
is to extract `MAX_POLLS` and `POLL_INTERVAL_MS` as component props (with defaults) and
pass shorter values in a test-specific wrapper. See the "Optional: Speed optimization"
section below.

### Test 3: Partial readiness -- verify per-service status rendering

**Goal**: During the polling phase (before timeout or success), verify that the UI renders
individual service statuses with correct labels and visual indicators.

**Mock strategy**: Use a counter. First 2 calls return only `admin` as `ok: true` and
everything else down. Call 3+ returns `admin` and `openmemory` as `ok: true`, `gateway`
as `ok: true`, but `assistant` stays `ok: false`. This tests the live per-service
indicator list that shows during polling (the `!ready && !timedOut` branch). Eventually
all services report ok to end the test cleanly.

```typescript
test('Complete step renders per-service status during polling', async ({ page }) => {
    let callCount = 0;

    await page.route('**/setup/health-check', (route) => {
        callCount++;
        const services: Record<string, { ok: boolean; time?: string; error?: string }> = {
            admin: { ok: true, time: new Date().toISOString() }
        };

        // Phase 1 (calls 1-3): only admin is up
        if (callCount <= 3) {
            services.gateway =    { ok: false, error: 'connection refused' };
            services.assistant =  { ok: false, error: 'connection refused' };
            services.openmemory = { ok: false, error: 'connection refused' };
        }
        // Phase 2 (calls 4-7): gateway comes up, others still down
        else if (callCount <= 7) {
            services.gateway =    { ok: true, time: new Date().toISOString() };
            services.assistant =  { ok: false, error: 'connection refused' };
            services.openmemory = { ok: false, error: 'connection refused' };
        }
        // Phase 3 (calls 8+): all services come up
        else {
            services.gateway =    { ok: true, time: new Date().toISOString() };
            services.assistant =  { ok: true, time: new Date().toISOString() };
            services.openmemory = { ok: true, time: new Date().toISOString() };
        }

        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                services,
                serviceInstances: { openmemory: '', psql: '', qdrant: '' }
            })
        });
    });

    // Mock setup.complete to succeed
    await page.route('**/command', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'setup.complete') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, state: { completed: true } })
            });
        } else {
            await route.continue();
        }
    });

    // Navigate to Complete step
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProvidersStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Health Check');
    await page.locator('.wizard .actions button', { hasText: 'Finish Setup' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Complete');

    // During Phase 2 (calls 4-7), the live per-service list should show:
    // gateway — ready, assistant — starting..., openmemory — starting...
    // We need to wait for at least call 4 to happen (~4s)
    await expect(page.locator('li', { hasText: /gateway.*ready/ })).toBeVisible({
        timeout: 10_000
    });
    await expect(page.locator('li', { hasText: /assistant.*starting/ })).toBeVisible();

    // Eventually all services come up and we reach the success state
    await expect(page.locator('text=Everything is ready!')).toBeVisible({
        timeout: 15_000
    });

    // Primary "Continue to Admin" button (not the secondary fallback)
    const continueBtn = page.locator('button', { hasText: 'Continue to Admin' });
    await expect(continueBtn).toBeVisible();
    // Verify it is NOT the secondary fallback button
    await expect(continueBtn).not.toHaveClass(/btn-secondary/);
});
```

---

## Additional Test: HealthStep.svelte error rendering

The `HealthStep.svelte` component (shown on the "Health Check" wizard step before
"Finish Setup") also renders per-service status. A lightweight additional test can verify
that the Health Check step shows dot indicators and error text when services are down:

```typescript
test('Health Check step shows per-service dot indicators for mixed health', async ({ page }) => {
    await page.route('**/setup/health-check', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                services: {
                    gateway:    { ok: true, time: new Date().toISOString() },
                    assistant:  { ok: false, error: 'connection refused' },
                    openmemory: { ok: false, error: 'status 503' },
                    admin:      { ok: true, time: new Date().toISOString() }
                },
                serviceInstances: { openmemory: '', psql: '', qdrant: '' }
            })
        });
    });

    // Navigate to Health Check step
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProvidersStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Health Check');

    // Healthy services have green dot
    await expect(page.locator('.dot-ok')).toHaveCount(2); // gateway + admin
    // Unhealthy services have red dot
    await expect(page.locator('.dot-err')).toHaveCount(2); // assistant + openmemory

    // Error text is rendered for unhealthy services
    await expect(page.locator('text=connection refused')).toBeVisible();
    await expect(page.locator('text=status 503')).toBeVisible();

    // Healthy services show "Healthy"
    await expect(page.locator('text=Healthy').first()).toBeVisible();
});
```

---

## Where to Place These Tests

All new tests go in the existing file:

```
packages/ui/e2e/10-setup-wizard-ui.pw.ts
```

They should be added inside the existing `test.describe('setup wizard browser flow')` block,
after the existing "Finish Setup shows error and re-enables button when setup.complete
returns 500" test (line 298). This keeps all wizard E2E tests co-located and ensures they
share the same `beforeEach` setup.

---

## Step-by-Step Implementation Instructions

### Step 1: Extract wizard navigation into a shared helper

The test code currently repeats the full wizard navigation sequence (Welcome -> Profile ->
Providers -> Security -> Channels -> Access -> Health Check) in every test that reaches
the Complete step. Extract this into a reusable helper to reduce duplication:

```typescript
/** Navigate through all wizard steps up to (but not including) clicking Finish Setup.
 *  Leaves the wizard on the Health Check step with "Finish Setup" ready to click.
 */
async function navigateToHealthCheckStep(page: Page) {
    await openWizard(page);
    // Welcome -> Next
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // Profile
    await expect(page.locator('.wizard h2')).toContainText('Profile');
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // AI Providers
    await expect(page.locator('.wizard h2')).toContainText('AI Providers');
    await fillProvidersStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // Security
    await expect(page.locator('.wizard h2')).toContainText('Security');
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // Channels
    await expect(page.locator('.wizard h2')).toContainText('Channels');
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // Access
    await expect(page.locator('.wizard h2')).toContainText('Access');
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    // Health Check
    await expect(page.locator('.wizard h2')).toContainText('Health Check');
}
```

### Step 2: Extract `setup.complete` mock into a shared helper

Tests 1, 2, and 3 all need the `setup.complete` command to succeed so the wizard advances
to the Complete step. Extract this:

```typescript
/** Mock setup.complete command to return success so the wizard reaches the Complete step. */
async function mockSetupCompleteOk(page: Page) {
    await page.route('**/command', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'setup.complete') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, state: { completed: true } })
            });
        } else {
            await route.continue();
        }
    });
}
```

### Step 3: Add the four test cases

Add the tests from the outlines above, using the extracted helpers.

### Step 4: Refactor the existing full-flow test (optional)

The existing "full wizard flow completes successfully with all services ready" test can
also benefit from using `navigateToHealthCheckStep()` to reduce its navigation boilerplate,
though this is optional and should not change test behavior.

### Step 5: Consider CI timeout for Test 2

Test 2 (full 60-poll timeout) takes ~60 seconds. Options:

1. **Accept it** -- Mark the test with `test.setTimeout(90_000)` and accept the CI time.
   This is the simplest approach and tests the real behavior.

2. **Skip on CI, run locally** -- Use `test.skip` with an environment variable check:
   ```typescript
   test.skip(!!process.env.CI, 'Skipped on CI: 60s polling timeout too slow');
   ```

3. **Extract polling constants as props** (recommended long-term) -- Make `CompleteStep.svelte`
   accept optional `maxPolls` and `pollIntervalMs` props with defaults of 60 and 1000.
   Tests can pass `maxPolls={3}` and `pollIntervalMs={100}` for sub-second execution.
   This requires a small component change but makes all polling tests fast.

**Recommendation**: Start with option 1 (accept the ~60s test). If CI budget becomes
tight, switch to option 3. Option 2 is the worst because it means the test rarely runs.

---

## Files to Modify

| File | Change |
|---|---|
| `packages/ui/e2e/10-setup-wizard-ui.pw.ts` | Add `navigateToHealthCheckStep()` helper, `mockSetupCompleteOk()` helper, and 4 new test cases |

No new files need to be created. No component changes are required for the basic
implementation. If the optional speed optimization (Step 5, option 3) is pursued later,
`packages/ui/src/lib/components/CompleteStep.svelte` would also need a minor change to
accept `maxPolls` and `pollIntervalMs` props.

---

## Verification Steps

1. **Run the new tests locally**:
   ```bash
   cd packages/ui
   npx playwright test e2e/10-setup-wizard-ui.pw.ts
   ```
   All existing tests must still pass. The four new tests must pass.

2. **Verify Test 1** (service error state):
   - Confirm "Some services took too long to start" appears within ~6s (fast-fail at 5 polls)
   - Confirm "not ready" labels appear for all non-admin services
   - Confirm the secondary "Continue to Admin" button is shown
   - Confirm "Everything is ready!" does NOT appear

3. **Verify Test 2** (timeout behavior):
   - Confirm the polling counter message (`Starting services... (N)`) appears during polling
   - Confirm "Some services took too long to start" appears after ~60s
   - Confirm mixed status: `openmemory` shows "ready", `gateway`/`assistant` show "not ready"
   - Confirm the secondary "Continue to Admin" button is shown

4. **Verify Test 3** (partial readiness / per-service rendering):
   - Confirm the live per-service list renders during polling
   - Confirm services transition from "starting..." to "ready" as the mock phases progress
   - Confirm "Everything is ready!" appears when all services are up
   - Confirm the primary (non-secondary) "Continue to Admin" button appears

5. **Verify Test 4** (HealthStep dot indicators):
   - Confirm `.dot-ok` count matches healthy services
   - Confirm `.dot-err` count matches unhealthy services
   - Confirm error messages from the mock appear in the UI
   - Confirm "Healthy" text appears for healthy services

6. **Screenshot review**: Optionally add `page.screenshot()` calls at key assertions to
   capture visual state for review. These can be placed in the existing
   `e2e/screenshots/` directory.

7. **CI run**: Push the changes and verify the full Playwright suite passes in CI,
   including the ~60s timeout test (Test 2). Monitor total suite duration.
