# UI Testing Improvement Report: Setup Wizard & Install Flow

**Date:** 2025-02-25
**Scope:** Setup wizard, install flow, admin dashboard UI
**Goal:** Achieve high-confidence testing that install and setup work correctly in all scenarios, with strategies for both Docker-available and Docker-unavailable environments.

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Identified Gaps](#2-identified-gaps)
3. [Recommended Testing Architecture](#3-recommended-testing-architecture)
4. [Tier 1: Unit & Component Tests (No Docker)](#4-tier-1-unit--component-tests-no-docker)
5. [Tier 2: Integration Tests with API Mocking (No Docker)](#5-tier-2-integration-tests-with-api-mocking-no-docker)
6. [Tier 3: E2E Browser Tests Against Live Server (No Docker)](#6-tier-3-e2e-browser-tests-against-live-server-no-docker)
7. [Tier 4: Full-Stack Docker Tests (Docker Required)](#7-tier-4-full-stack-docker-tests-docker-required)
8. [Visual Regression Testing](#8-visual-regression-testing)
9. [CI/CD Pipeline Changes](#9-cicd-pipeline-changes)
10. [Implementation Priorities](#10-implementation-priorities)
11. [Test Matrix](#11-test-matrix)

---

## 1. Current State Assessment

### What Exists Today

The project has four testing layers, each with different coverage levels:

#### 1.1 Unit Tests (setup-wizard.test.ts) — Source-Text Scanning

**File:** `packages/ui/src/lib/components/setup-wizard.test.ts`

These tests read the `SetupWizard.svelte` file as raw text and assert that specific strings exist (e.g., `expect(content).toContain("password.length < 8")`). This approach:

- **Does not render the component** — it verifies source code patterns, not runtime behavior.
- **Cannot catch logic bugs** — if the password validation condition is present but unreachable due to a rendering bug, these tests still pass.
- **Breaks on refactors** — renaming a variable or restructuring the template fails the test even if behavior is preserved.
- **Cannot test state transitions** — the wizard's 8-step navigation flow is not exercised.

#### 1.2 SetupManager Unit Tests (setup-manager.test.ts)

**File:** `packages/lib/src/admin/setup-manager.test.ts`

These are well-written unit tests that verify the `SetupManager` class against real temp directories. They cover state persistence, step completion, scope validation, corrupt file handling, and service instance merging. **This is the strongest part of the current test suite.**

#### 1.3 Playwright E2E Tests (10-setup-wizard-ui.pw.ts)

**File:** `packages/ui/e2e/10-setup-wizard-ui.pw.ts`

These run the full SvelteKit app in a test server with stubbed Docker commands (`OPENPALM_COMPOSE_BIN=/usr/bin/true`). They test:

- Wizard overlay visibility
- Step-by-step navigation (Welcome -> Profile -> AI Providers -> Security -> Channels -> Access -> Health Check -> Complete)
- Back button navigation
- Full wizard completion flow

**Gaps in E2E tests:**
- No validation error testing (short password, mismatched passwords, missing API key)
- No error state testing (API failures, network errors)
- No re-entry testing (closing wizard, reopening, resuming from saved state)
- No edge case testing (empty fields, special characters, very long inputs)
- No testing of the health check polling behavior
- No testing of the CompleteStep's service readiness polling
- No cross-browser coverage (only Chromium)

#### 1.4 Docker Stack Tests (docker-stack.docker.ts)

**File:** `test/docker/docker-stack.docker.ts`

These build real Docker images and start containers. They test admin health endpoints, YAML handling, auth, and first-boot setup status. However:

- They don't exercise the wizard UI inside Docker.
- They don't verify that the full install-to-running-assistant path works.
- They are gated behind `OPENPALM_RUN_DOCKER_STACK_TESTS` and rarely run in CI.

#### 1.5 Contract Tests (setup-wizard-gate.contract.test.ts)

**File:** `test/contracts/setup-wizard-gate.contract.test.ts`

These test the setup status API contract (first-boot vs. post-setup auth behavior) against a running admin server. They require the dev stack to be running and are skipped otherwise.

#### 1.6 Setup API E2E Tests (03-setup-api.pw.ts)

**File:** `packages/ui/e2e/03-setup-api.pw.ts`

These exercise every setup API endpoint sequentially via Playwright's `request` API (not the browser). They cover profile save, step marking, service instances, channels, access scope, health check, and setup completion. **This is solid API-level coverage.**

### CI/CD Workflows

- **test.yml**: Runs unit + contract tests on every PR (10min timeout). Does not run Docker tests.
- **test-ui.yml**: Runs Playwright E2E tests on every PR (15min timeout). No Docker tests.
- Docker stack tests are effectively manual-only.

---

## 2. Identified Gaps

### Gap 1: No Real Component Rendering Tests

The `setup-wizard.test.ts` file uses source-code string matching instead of rendering components with Vitest Browser Mode. This means:

- UI rendering bugs are invisible to the test suite.
- State management bugs (Svelte 5 runes, `$derived`, `$state`) are untested.
- User interaction sequences (fill form -> click Next -> see error) are untested at the component level.

### Gap 2: No Validation Error Path Testing

The wizard has validation logic for:
- Password minimum length (8 chars)
- Password confirmation match
- Required Anthropic API key
- API call failures for profile save, service instances, access scope

None of these error paths are tested in the Playwright E2E suite. The only coverage is the source-text scan in `setup-wizard.test.ts`.

### Gap 3: No API Failure Simulation

The E2E tests run against a real server. When `api('/command', ...)` is called, it either succeeds or the test hangs. There is no mechanism to simulate:
- Network errors (`fetch` throws)
- Server 500 responses
- Timeout scenarios
- Partial failures (channels save succeeds, but setup.complete fails)

### Gap 4: No Wizard State Persistence / Resume Testing

The wizard saves state via API calls. If a user completes steps 1-4, closes the browser, and returns, they should be able to resume. This flow is untested.

### Gap 5: No Health Check Polling Tests

The `HealthStep` and `CompleteStep` components poll `/setup/health-check` repeatedly. The polling behavior (retry logic, timeout handling, partial readiness display) is completely untested.

### Gap 6: No Cross-Browser Testing

Only Chromium is tested. The wizard may have rendering or behavior differences in Firefox and WebKit (Safari).

### Gap 7: No Visual Regression Testing

UI changes (CSS, layout, component structure) are not caught by any automated test. A broken wizard layout would ship undetected.

### Gap 8: Docker Stack Tests Are Not in CI

The most realistic test environment (actual Docker containers) is manual-only. There is no scheduled CI run that validates the full containerized setup flow.

### Gap 9: No Install CLI -> Wizard -> Running System End-to-End

The CLI install command, the wizard UI, and the containerized services are tested in isolation. Nobody tests: "run `openpalm install` -> complete the wizard -> verify the assistant responds."

---

## 3. Recommended Testing Architecture

The recommended approach uses a **four-tier testing pyramid** where each tier catches different classes of bugs:

```
                    +--------------------------+
                    |  Tier 4: Docker Stack    |  (Weekly CI / Pre-release)
                    |  Full system E2E         |
                    +-----------+--------------+
                                |
                   +------------+-------------+
                   |  Tier 3: Playwright E2E   |  (Every PR)
                   |  Browser + live server    |
                   +------------+--------------+
                                |
              +-----------------+----------------+
              |  Tier 2: Component Integration    |  (Every PR)
              |  Rendered components + MSW mocks  |
              +-----------------+----------------+
                                |
         +----------------------+---------------------+
         |  Tier 1: Pure Unit Tests                    |  (Every PR)
         |  SetupManager, validators, state logic      |
         +---------------------------------------------+
```

**Key principle:** Tiers 1-3 require **no Docker** and run in CI on every PR. Tier 4 requires Docker and runs on a schedule or before releases.

---

## 4. Tier 1: Unit & Component Tests (No Docker)

### 4.1 Replace Source-Text Scanning with Rendered Component Tests

**Problem:** `setup-wizard.test.ts` reads `.svelte` files as strings.

**Solution:** Use **Vitest Browser Mode** with `vitest-browser-svelte` to render components in a real Chromium browser and test actual behavior.

The project already has the correct dependencies configured in `vite.config.ts`:

```ts
// Already in packages/ui/vite.config.ts
browser: {
    enabled: true,
    provider: playwright(),
    instances: [{ browser: 'chromium', headless: true }]
}
```

**New test file:** `packages/ui/src/lib/components/SetupWizard.svelte.test.ts`

Note the `.svelte.test.ts` extension — this enables Svelte 5 rune support in tests.

```ts
// packages/ui/src/lib/components/SetupWizard.svelte.test.ts
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import SetupWizard from './SetupWizard.svelte';

describe('SetupWizard - rendered component', () => {
    it('renders Welcome step on initial load', async () => {
        render(SetupWizard, { props: { onclose: () => {} } });
        await expect.element(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
    });

    it('navigates to Profile step on Next click', async () => {
        render(SetupWizard, { props: { onclose: () => {} } });
        await page.getByRole('button', { name: 'Next' }).click();
        await expect.element(page.getByRole('heading', { name: /profile/i })).toBeVisible();
    });

    it('shows password validation error for short passwords', async () => {
        render(SetupWizard, { props: { onclose: () => {} } });
        // Navigate to profile step
        await page.getByRole('button', { name: 'Next' }).click();
        // Enter short password
        await page.getByLabel(/admin password/i).fill('short');
        await page.getByLabel(/confirm password/i).fill('short');
        await page.getByRole('button', { name: 'Next' }).click();
        // Verify error message
        await expect.element(page.getByText('Password must be at least 8 characters')).toBeVisible();
    });

    it('shows mismatch error when passwords differ', async () => {
        render(SetupWizard, { props: { onclose: () => {} } });
        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByLabel(/admin password/i).fill('validpassword123');
        await page.getByLabel(/confirm password/i).fill('differentpassword');
        await page.getByRole('button', { name: 'Next' }).click();
        await expect.element(page.getByText('Passwords do not match')).toBeVisible();
    });
});
```

**What this catches that source-text scanning cannot:**
- Rendering failures (broken imports, Svelte compilation errors)
- State management bugs (`$state`, `$derived` not working as expected)
- DOM event handling bugs (click handlers not wired up)
- Conditional rendering bugs (`{#if}` blocks evaluating wrong)
- CSS/visibility issues (element exists but is hidden)

### 4.2 Test Each Wizard Step Component Individually

Create component tests for each step to verify props, rendering, and form behavior:

| Component | Key behaviors to test |
|---|---|
| `WelcomeStep` | Renders welcome text |
| `ProfileStep` | Shows error prop, renders all 4 fields, populates from setup state |
| `ProvidersStep` | Shows error prop, renders Anthropic key field, expandable advanced section |
| `SecurityStep` | Renders without error prop (informational step) |
| `ChannelsStep` | Renders channel checkboxes from BUILTIN_CHANNELS, shows/hides config fields |
| `AccessStep` | Renders radio buttons for host/lan, shows error prop, tracks checked state |
| `HealthStep` | Shows loading state, displays service health after API response |
| `CompleteStep` | Shows polling status, renders "Continue to Admin" when ready, handles timeout |

### 4.3 Keep SetupManager Tests (Already Strong)

The existing `setup-manager.test.ts` is well-written. Add these edge cases:

- `setProfile` with empty strings
- `setEnabledChannels` deduplication
- `completeSetup` idempotency (calling twice)
- State file with extra/unknown fields (forward compatibility)
- Concurrent `save()` calls (race condition simulation)

---

## 5. Tier 2: Integration Tests with API Mocking (No Docker)

### 5.1 Use MSW (Mock Service Worker) for API Layer Testing

MSW intercepts `fetch` calls at the network level, allowing component tests to exercise real API call paths without a server.

**Setup:**

```ts
// packages/ui/src/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

// Default handlers: simulate a fresh install
export const handlers = [
    http.get('*/setup/status', () => {
        return HttpResponse.json({
            completed: false,
            firstBoot: true,
            steps: {
                welcome: false, profile: false, accessScope: false,
                serviceInstances: false, healthCheck: false,
                security: false, channels: false, extensions: false
            }
        });
    }),

    http.post('*/command', async ({ request }) => {
        const body = await request.json() as { type: string; payload: unknown };
        // Simulate successful command responses
        return HttpResponse.json({ ok: true, data: { profile: body.payload } });
    }),

    http.get('*/setup/health-check', () => {
        return HttpResponse.json({
            services: {
                admin: { ok: true, time: new Date().toISOString() },
                gateway: { ok: true, time: new Date().toISOString() },
                assistant: { ok: false, error: 'starting' },
                openmemory: { ok: true, time: new Date().toISOString() }
            }
        });
    })
];
```

```ts
// packages/ui/src/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
export const server = setupServer(...handlers);
```

```ts
// packages/ui/vitest.setup.ts (add to server project config)
import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './src/mocks/server';
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### 5.2 Test Error Scenarios with Handler Overrides

This is the biggest gap in the current test suite. MSW lets you override handlers per-test to simulate failures:

```ts
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';

describe('SetupWizard - API error handling', () => {
    it('shows error when profile save returns 500', async () => {
        // Override just for this test
        server.use(
            http.post('*/command', () => {
                return HttpResponse.json(
                    { ok: false, error: 'Internal server error' },
                    { status: 500 }
                );
            })
        );

        render(SetupWizard, { props: { onclose: () => {} } });
        // Navigate to profile, fill valid data, click Next
        // ...
        await expect.element(
            page.getByText('Could not save your profile')
        ).toBeVisible();
    });

    it('shows error when network is unreachable', async () => {
        server.use(
            http.post('*/command', () => {
                return HttpResponse.error(); // Simulates network failure
            })
        );
        // ...
    });

    it('handles partial failure in finishSetup', async () => {
        let callCount = 0;
        server.use(
            http.post('*/command', async ({ request }) => {
                const body = await request.json() as { type: string };
                callCount++;
                // Channels save succeeds, but setup.complete fails
                if (body.type === 'setup.complete') {
                    return HttpResponse.json(
                        { ok: false, error: 'Docker daemon not running' },
                        { status: 500 }
                    );
                }
                return HttpResponse.json({ ok: true, data: {} });
            })
        );
        // Navigate to health check step, click Finish Setup
        // Verify the specific "Setup failed:" error message appears
        // Verify the retry button is enabled
    });
});
```

### 5.3 Test Health Check Polling

The `CompleteStep` polls up to 120 times with 1-second intervals. Test this with MSW:

```ts
describe('CompleteStep - polling behavior', () => {
    it('shows "ready" when all services report ok', async () => {
        server.use(
            http.get('*/setup/health-check', () => {
                return HttpResponse.json({
                    services: {
                        admin: { ok: true },
                        gateway: { ok: true },
                        assistant: { ok: true },
                        openmemory: { ok: true }
                    }
                });
            })
        );
        render(CompleteStep, { props: { oncontinue: () => {} } });
        await expect.element(page.getByText('Everything is ready!')).toBeVisible();
    });

    it('shows timeout state when services never become ready', async () => {
        // Use fake timers to skip the 120-second timeout
        vi.useFakeTimers();
        server.use(
            http.get('*/setup/health-check', () => {
                return HttpResponse.json({
                    services: {
                        admin: { ok: true },
                        assistant: { ok: false, error: 'not started' }
                    }
                });
            })
        );
        render(CompleteStep, { props: { oncontinue: () => {} } });
        // Fast-forward through all polling cycles
        await vi.advanceTimersByTimeAsync(121_000);
        await expect.element(page.getByText('Some services are still starting')).toBeVisible();
        vi.useRealTimers();
    });
});
```

---

## 6. Tier 3: E2E Browser Tests Against Live Server (No Docker)

### 6.1 Expand Existing Playwright Tests

The current `10-setup-wizard-ui.pw.ts` should be expanded with these test scenarios:

#### Validation Error Tests

```ts
test('profile step rejects short password', async ({ page }) => {
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await page.locator('#wiz-profile-password').fill('short');
    await page.locator('#wiz-profile-password2').fill('short');
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await expect(page.locator('.wiz-error')).toContainText('at least 8 characters');
    // Verify we're still on the Profile step
    await expect(page.locator('.wizard h2')).toContainText('Profile');
});

test('profile step rejects mismatched passwords', async ({ page }) => {
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await page.locator('#wiz-profile-password').fill('validpassword1');
    await page.locator('#wiz-profile-password2').fill('differentpassword');
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await expect(page.locator('.wiz-error')).toContainText('Passwords do not match');
});

test('providers step requires Anthropic API key', async ({ page }) => {
    await openWizard(page);
    // Navigate to providers step (through Welcome and Profile)
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    // Try to proceed without filling Anthropic key
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await expect(page.locator('.wiz-error')).toContainText('Anthropic API key is required');
});
```

#### Wizard State Persistence Tests

```ts
test('wizard preserves progress after page reload', async ({ page }) => {
    await openWizard(page);
    // Complete Welcome step
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Profile');

    // Reload the page
    await page.reload();
    await page.evaluate((token) => localStorage.setItem('op_admin', token), ADMIN_TOKEN);
    await page.reload();

    // Reopen wizard and verify state
    await openWizard(page);
    // Should show welcome step completed in the step indicator
});
```

#### Accessibility Tests

```ts
test('wizard is keyboard navigable', async ({ page }) => {
    await openWizard(page);
    // Tab to Next button and press Enter
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.wizard h2')).toContainText('Profile');
});

test('wizard has correct ARIA attributes', async ({ page }) => {
    await openWizard(page);
    await expect(page.locator('.wizard-overlay')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('.wizard-overlay')).toHaveAttribute('aria-modal', 'true');
});
```

### 6.2 Add Route Interception for Error Simulation in Playwright

Playwright can intercept network requests without MSW:

```ts
test('shows error when profile API fails', async ({ page }) => {
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);

    // Intercept the command API call
    await page.route('**/command', (route) => {
        route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'Server error' })
        });
    });

    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wiz-error')).toContainText('Could not save your profile');
});

test('finishSetup shows Docker error when complete fails', async ({ page }) => {
    // Navigate to health check step first
    // ...

    // Intercept only setup.complete calls
    await page.route('**/command', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        if (body.type === 'setup.complete') {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ ok: false, error: 'Docker daemon not running' })
            });
        } else {
            await route.continue();
        }
    });

    await page.locator('button', { hasText: 'Finish Setup' }).click();
    await expect(page.locator('.wiz-error')).toContainText('Setup failed:');
    // Verify button is re-enabled for retry
    await expect(page.locator('button', { hasText: 'Finish Setup' })).toBeEnabled();
});
```

### 6.3 Add Cross-Browser Testing

Update `playwright.config.ts` to test Firefox and WebKit:

```ts
projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Mobile viewports
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 12'] } },
]
```

---

## 7. Tier 4: Full-Stack Docker Tests (Docker Required)

### 7.1 Add Setup Wizard E2E in Docker

Create a new test that exercises the complete wizard flow against real containers:

**File:** `test/docker/setup-wizard-e2e.docker.ts`

```ts
describe.skipIf(!runDockerStackTests)('docker stack: wizard E2E', () => {
    it('completes the full setup wizard against real containers', async () => {
        // 1. Verify first-boot state
        const status = await api(ADMIN_PORT, '/setup/status');
        const statusBody = await status.json();
        expect(statusBody.firstBoot).toBe(true);

        // 2. Save profile with password
        const profileRes = await cmd(ADMIN_PORT, 'setup.profile', {
            name: 'Test User',
            email: 'test@example.com',
            password: ADMIN_TOKEN
        });
        expect(profileRes.ok).toBe(true);

        // 3. Configure service instances
        const svcRes = await cmd(ADMIN_PORT, 'setup.service_instances', {
            openmemory: '', psql: '', qdrant: '',
            anthropicApiKey: 'sk-ant-test-key'
        });
        expect(svcRes.ok).toBe(true);

        // 4. Set access scope
        const scopeRes = await cmd(ADMIN_PORT, 'setup.access_scope', {
            scope: 'host'
        });
        expect(scopeRes.ok).toBe(true);

        // 5. Enable channels
        const chRes = await cmd(ADMIN_PORT, 'setup.channels', {
            channels: ['channel-chat'],
            channelConfigs: {}
        });
        expect(chRes.ok).toBe(true);

        // 6. Mark all steps complete
        for (const step of ['welcome', 'profile', 'serviceInstances', 'security',
                            'channels', 'accessScope', 'healthCheck']) {
            await cmd(ADMIN_PORT, 'setup.step', { step });
        }

        // 7. Complete setup
        const completeRes = await cmd(ADMIN_PORT, 'setup.complete', {});
        expect(completeRes.ok).toBe(true);

        // 8. Verify post-setup state
        const finalStatus = await authedJson(ADMIN_PORT, '/setup/status');
        expect(finalStatus.data.completed).toBe(true);
        expect(finalStatus.data.firstBoot).toBe(false);

        // 9. Verify auth is now required
        const unauthResp = await api(ADMIN_PORT, '/setup/status');
        expect(unauthResp.status).toBe(401);
    });
});
```

### 7.2 Add Playwright Tests Against Docker Stack

For the most realistic testing, run Playwright browser tests against the Docker-hosted admin UI:

**File:** `test/docker/setup-wizard-browser.docker.ts`

This test would:
1. Build and start the Docker stack.
2. Launch a Playwright browser pointing at the admin container's exposed port.
3. Exercise the complete wizard UI flow in the browser.
4. Verify that services actually start and become healthy.

This is the only test that would catch issues like:
- Caddy proxy misconfiguration
- Container networking issues
- Volume mount permission problems
- Image build failures that affect the UI bundle

### 7.3 Use Testcontainers for Programmatic Docker Management

Instead of manually managing Docker Compose in tests, use the `testcontainers` npm package for more reliable container lifecycle management:

```ts
import { GenericContainer, Wait } from 'testcontainers';

const adminContainer = await new GenericContainer('openpalm/admin:test')
    .withExposedPorts(8100)
    .withWaitStrategy(Wait.forHttp('/health', 8100))
    .withStartupTimeout(120_000)
    .start();

const adminPort = adminContainer.getMappedPort(8100);
// Run tests against http://localhost:${adminPort}
```

Benefits over raw Docker Compose in tests:
- Automatic cleanup on test failure
- Dynamic port allocation (no conflicts)
- Built-in health check waiting
- Better error messages

---

## 8. Visual Regression Testing

### 8.1 Add Playwright Screenshot Assertions

Use Playwright's built-in `toHaveScreenshot()` for visual regression testing of each wizard step:

```ts
test.describe('wizard visual regression', () => {
    test('Welcome step matches baseline', async ({ page }) => {
        await openWizard(page);
        await expect(page.locator('.wizard')).toHaveScreenshot('wizard-welcome.png');
    });

    test('Profile step matches baseline', async ({ page }) => {
        await openWizard(page);
        await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
        await expect(page.locator('.wizard')).toHaveScreenshot('wizard-profile.png');
    });

    test('Profile step with error matches baseline', async ({ page }) => {
        await openWizard(page);
        await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
        await page.locator('#wiz-profile-password').fill('short');
        await page.locator('#wiz-profile-password2').fill('short');
        await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
        await expect(page.locator('.wizard')).toHaveScreenshot('wizard-profile-error.png', {
            maxDiffPixelRatio: 0.01  // Allow 1% pixel variance for anti-aliasing
        });
    });

    // ... one test per wizard step
});
```

**Best practices for stable visual tests:**
- Scope screenshots to `.wizard` element, not full page (avoids nav/footer changes)
- Use `maxDiffPixelRatio: 0.01` to tolerate minor anti-aliasing differences
- Mask dynamic content (timestamps, service health status text)
- Store baselines in git, update via `npx playwright test --update-snapshots`
- Run visual tests only in CI on Linux for consistency (different OS = different rendering)

### 8.2 CI Workflow for Visual Tests

Add a dedicated visual regression step that runs on Linux only:

```yaml
# .github/workflows/test-visual.yml
name: visual-regression
on:
  pull_request:
jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
        working-directory: packages/ui
      - run: bun run test:visual
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-diff
          path: packages/ui/test-results/
```

---

## 9. CI/CD Pipeline Changes

### 9.1 Current Pipeline

```
PR opened/pushed → test.yml (unit/contract) → test-ui.yml (Playwright E2E)
                                              → (Docker tests: manual only)
```

### 9.2 Proposed Pipeline

```
PR opened/pushed:
├─ test.yml (unit/contract tests)                    [~3 min]
├─ test-ui.yml (Playwright E2E + validation errors)  [~5 min]
├─ test-components.yml (Vitest browser mode)          [~3 min]  ← NEW
└─ test-visual.yml (screenshot regression)            [~4 min]  ← NEW

Nightly schedule:
└─ test-docker.yml (full Docker stack + wizard E2E)   [~10 min] ← NEW

Pre-release (tag push):
└─ test-docker-full.yml (multi-arch Docker build      [~20 min] ← NEW
   + wizard E2E + health checks)
```

### 9.3 New CI Workflow: Nightly Docker Tests

```yaml
# .github/workflows/test-docker-nightly.yml
name: docker-stack-nightly
on:
  schedule:
    - cron: '0 6 * * *'  # 6 AM UTC daily
  workflow_dispatch:       # Manual trigger

jobs:
  docker-stack:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Run Docker stack tests
        run: bun run test:docker
        env:
          OPENPALM_RUN_DOCKER_STACK_TESTS: '1'
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: docker-test-logs
          path: /tmp/openpalm-docker-test-*/
```

### 9.4 New CI Workflow: Component Tests

```yaml
# .github/workflows/test-components.yml
name: component-tests
on:
  pull_request:
  push:
    branches: [main]

jobs:
  vitest-browser:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
        working-directory: packages/ui
      - run: bun run --filter @openpalm/ui vitest run --project client
        working-directory: packages/ui
```

---

## 10. Implementation Priorities

### Phase 1: Quick Wins (1-2 days)

**Impact: High | Effort: Low**

1. **Add validation error tests to `10-setup-wizard-ui.pw.ts`** — Test password validation, password mismatch, and required Anthropic key. These use existing infrastructure and catch the most common regression (broken validation = broken setup).

2. **Add Playwright route interception tests for API failures** — Test the "Could not save your profile" and "Setup failed:" error paths. Uses existing Playwright setup, no new dependencies.

3. **Add cross-browser projects to `playwright.config.ts`** — Add Firefox and WebKit. Requires installing additional browsers in CI but catches browser-specific bugs immediately.

### Phase 2: Component Testing Layer (3-5 days)

**Impact: High | Effort: Medium**

4. **Create real Vitest browser-mode component tests** — Replace the source-text scanning in `setup-wizard.test.ts` with rendered component tests using `vitest-browser-svelte`. This is the single biggest improvement to test quality.

5. **Add MSW for API mocking** — Install `msw`, create handler files, and integrate with Vitest setup. This enables testing all error paths at the component level.

6. **Test HealthStep and CompleteStep polling** — Use MSW + fake timers to test the health check polling, timeout behavior, and partial readiness display.

### Phase 3: Visual & Docker (1-2 weeks)

**Impact: Medium | Effort: Medium-High**

7. **Add Playwright visual regression tests** — Screenshot each wizard step and each error state. Store baselines in git.

8. **Enable Docker stack tests in nightly CI** — Add the `test-docker-nightly.yml` workflow. This catches containerization regressions before they reach users.

9. **Add wizard API E2E in Docker tests** — Exercise the complete setup wizard flow against real Docker containers.

### Phase 4: Full Confidence (Ongoing)

10. **Add Playwright tests against Docker-hosted UI** — The most realistic test: browser + real containers.
11. **Add CLI install -> wizard -> verify E2E** — The ultimate test: run the install command, complete setup, verify the assistant works.

---

## 11. Test Matrix

The following matrix shows what each test tier covers for the setup wizard:

| Scenario | Tier 1 (Unit) | Tier 2 (MSW) | Tier 3 (E2E) | Tier 4 (Docker) |
|---|:---:|:---:|:---:|:---:|
| Component renders correctly | | x | x | |
| Step navigation (Next/Back) | | x | x | |
| Password validation (<8 chars) | | x | x | |
| Password mismatch error | | x | x | |
| Required Anthropic key | | x | x | |
| Profile API save success | | x | x | x |
| Profile API save failure | | x | x | |
| Service instances save | | x | x | x |
| Channel selection/config | | x | x | x |
| Access scope persistence | | x | x | x |
| Health check polling (success) | | x | | x |
| Health check polling (timeout) | | x | | |
| Health check polling (partial) | | x | | |
| finishSetup error handling | | x | x | |
| finishSetup button disabled during op | | x | x | |
| Setup complete -> auth required | | | x | x |
| First boot -> no auth needed | | | x | x |
| Wizard state persistence | x | x | x | |
| SetupManager file operations | x | | | |
| Corrupt state file recovery | x | | | |
| Cross-browser rendering | | | x | |
| Visual regression | | | x | |
| Docker container health | | | | x |
| YAML serialization in container | | | | x |
| Volume mount correctness | | | | x |
| Multi-arch image build | | | | x |
| Network error handling | | x | x | |
| Keyboard accessibility | | | x | |

### Coverage Summary

| Tier | Docker Required | Runs In CI | Catches |
|---|:---:|:---:|---|
| 1: Unit | No | Every PR | State logic bugs, data validation, persistence |
| 2: Component + MSW | No | Every PR | Rendering bugs, API error handling, polling logic, state management |
| 3: Playwright E2E | No | Every PR | Full user flows, validation UX, cross-browser, visual regression |
| 4: Docker Stack | Yes | Nightly/Pre-release | Container build, networking, volume mounts, real service integration |

**With all four tiers implemented, the only scenarios NOT covered by automated tests are:**
- Hardware-specific issues (ARM vs x86 rendering differences)
- Real third-party API integration (actual Anthropic key validation)
- OS-specific Docker socket behavior (Linux vs macOS vs Windows)

These remaining scenarios require manual testing as part of the release process but should be rare sources of regression.

---

## Summary

The current testing strategy has a solid foundation (SetupManager unit tests, Playwright E2E framework, Docker stack infrastructure) but has critical gaps in **component-level rendering tests**, **error path coverage**, and **automated Docker testing**. The source-text scanning approach in `setup-wizard.test.ts` provides a false sense of security — it verifies that code strings exist but not that they work.

The recommended changes, prioritized for maximum impact:

1. **Replace source-text tests with Vitest browser-mode component tests** — catches rendering and state bugs
2. **Add validation and error path tests to Playwright E2E** — catches the most user-visible regressions
3. **Integrate MSW for API failure simulation** — enables testing every error branch without a server
4. **Enable nightly Docker stack tests in CI** — catches containerization regressions before release
5. **Add visual regression testing** — catches layout and styling regressions

This layered approach ensures that Docker-free environments (CI, development machines) catch 90%+ of bugs through Tiers 1-3, while Docker-based environments (nightly CI, pre-release) validate the remaining real-world integration concerns.
