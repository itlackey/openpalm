# UI Testing Improvement Report: Setup Wizard & Install Flow

**Date:** 2026-02-25
**Scope:** Setup wizard, install flow, admin dashboard UI
**Goal:** Achieve high-confidence testing that install and setup work correctly in all scenarios, with strategies for both Docker-available and Docker-unavailable environments.

**Related documents:**
- `dev/docs/testing-plan.md` — Test tier definitions and merge-time checks
- `dev/docs/setup-wizard-e2e-test-strategy.md` — Release-critical E2E gate strategy with detection weights
- `dev/docs/manual-install-setup-review.md` — Manual CLI install review findings
- `dev/docs/manual-setup-readiness-review.md` — Manual setup readiness review findings

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Identified Gaps](#2-identified-gaps)
3. [Recommended Testing Architecture](#3-recommended-testing-architecture)
4. [Tier 1: Unit & Component Tests (No Docker)](#4-tier-1-unit--component-tests-no-docker)
5. [Tier 2: Integration Tests with API Mocking (No Docker)](#5-tier-2-integration-tests-with-api-mocking-no-docker)
6. [Tier 3: E2E Browser Tests Against Live Server (No Docker)](#6-tier-3-e2e-browser-tests-against-live-server-no-docker)
7. [Tier 4: Full-Stack Docker Tests (Docker Required)](#7-tier-4-full-stack-docker-tests-docker-required)
8. [Failure-Matrix Scenarios](#8-failure-matrix-scenarios)
9. [Artifact & Compose Contract Validation](#9-artifact--compose-contract-validation)
10. [Regression Replay Test Pack](#10-regression-replay-test-pack)
11. [Visual Regression Testing](#11-visual-regression-testing)
12. [CI/CD Pipeline Changes](#12-cicd-pipeline-changes)
13. [Release Gate Policy](#13-release-gate-policy)
14. [Implementation Priorities](#14-implementation-priorities)
15. [Test Matrix](#15-test-matrix)

---

## 1. Current State Assessment

### What Exists Today

The project has four testing layers, each with different coverage levels. The existing testing plan (`dev/docs/testing-plan.md`) defines three tiers: Tier 1 (hermetic unit/contract, `bun run test:ci`), Tier 2 (UI E2E under Bun with Playwright, `bun run test:ui`), and Tier 3 (Docker stack integration, `bun run test:docker`). This report aligns with that structure and extends it.

#### 1.1 Unit Tests (setup-wizard.test.ts) — Source-Text Scanning

**File:** `packages/ui/src/lib/components/setup-wizard.test.ts`

These tests read the `SetupWizard.svelte` file as raw text and assert that specific strings exist (e.g., `expect(content).toContain("password.length < 8")`). This approach:

- **Does not render the component** — it verifies source code patterns, not runtime behavior.
- **Cannot catch logic bugs** — if the password validation condition is present but unreachable due to a rendering bug, these tests still pass.
- **Breaks on refactors** — renaming a variable or restructuring the template fails the test even if behavior is preserved.
- **Cannot test state transitions** — the wizard's 8-step navigation flow is not exercised.

This aligns with the gap analysis in `dev/docs/setup-wizard-e2e-test-strategy.md`, which notes: *"setup-wizard.test.ts is mostly source-string assertions"* providing *"low confidence that real wizard completion works against runtime + compose."*

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

As noted in the E2E strategy doc: *"Does not prove full install + wizard completion end-to-end."*

#### 1.5 Contract Tests (setup-wizard-gate.contract.test.ts)

**File:** `test/contracts/setup-wizard-gate.contract.test.ts`

These test the setup status API contract (first-boot vs. post-setup auth behavior) against a running admin server. They require the dev stack to be running and are skipped otherwise. The strategy doc identifies: *"Gate validates auth behavior, but not install/setup orchestration on clean CI hosts."*

#### 1.6 Setup API E2E Tests (03-setup-api.pw.ts)

**File:** `packages/ui/e2e/03-setup-api.pw.ts`

These exercise every setup API endpoint sequentially via Playwright's `request` API (not the browser). They cover profile save, step marking, service instances, channels, access scope, health check, and setup completion. **This is solid API-level coverage.**

#### 1.7 Test-Mode Masking Risk

A critical concern from the E2E strategy: `setup.complete` performs real apply/startup only when `OPENPALM_TEST_MODE !== 1`. Since the Playwright E2E tests run with `OPENPALM_TEST_MODE=1` (via `packages/ui/e2e/env.ts`), they bypass the actual compose/apply path. This means **test-mode can mask runtime/apply failures** that only happen with real Docker Compose.

### CI/CD Workflows

- **test.yml**: Runs unit + contract tests on every PR (10min timeout). Does not run Docker tests.
- **test-ui.yml**: Runs Playwright E2E tests on every PR (15min timeout). No Docker tests.
- **release.yml**: Runs unit/integration/contracts/security/UI and Docker image build gates, but **no wizard completion E2E gate**.
- Docker stack tests are effectively manual-only.

### Findings from Manual Reviews

The manual install/setup reviews (`dev/docs/manual-install-setup-review.md`, `dev/docs/manual-setup-readiness-review.md`) identified several issues that automated tests should cover:

1. **Forced `--runtime docker` error message was too vague** when the daemon is unavailable (improved in recent patch, needs regression test)
2. **Checksum verification warning** appears during normal install flow (security concern)
3. **PATH guidance friction** after install to `~/.local/bin`
4. **`install --help` was executing install** instead of showing help (fixed, needs regression test)
5. **Dev preflight passes but `dev:build` fails** on missing Docker (misleading)

---

## 2. Identified Gaps

### Gap 1: No Real Component Rendering Tests

The `setup-wizard.test.ts` file uses source-code string matching instead of rendering components with Vitest Browser Mode. UI rendering bugs, state management bugs (Svelte 5 runes), and user interaction sequences are invisible.

### Gap 2: No Validation Error Path Testing

Password validation, password mismatch, required Anthropic key, and API call failure paths have no E2E test coverage. The only coverage is source-text scanning.

### Gap 3: No API Failure Simulation

No mechanism to simulate network errors, server 500 responses, timeout scenarios, or partial failures (channels save succeeds but `setup.complete` fails).

### Gap 4: No Wizard State Persistence / Resume Testing

If a user completes steps 1-4, closes the browser, and returns, the resume flow is untested.

### Gap 5: No Health Check Polling Tests

The `HealthStep` and `CompleteStep` polling behavior (retry logic, timeout handling, partial readiness) is completely untested.

### Gap 6: No Cross-Browser Testing

Only Chromium is tested.

### Gap 7: No Visual Regression Testing

UI layout and styling changes are not caught by any automated test.

### Gap 8: Docker Stack Tests Are Not in CI

No scheduled or release-gated CI run validates the full containerized setup flow.

### Gap 9: No Install -> Wizard -> Running System End-to-End

The CLI install, wizard UI, and containerized services are tested in isolation. The E2E strategy notes the release workflow *"does not run a Docker-backed setup wizard completion gate."*

### Gap 10: No Failure-Handling Tests for Common First-Run Blockers

Per the E2E strategy: *"Many setup incidents are not happy-path bugs; they are failure-handling bugs where users get stuck."* No tests for missing API keys, port conflicts, daemon unavailable, invalid channel config, or partial/interrupted setup retry.

### Gap 11: No Regression Replay Pack

No system to convert historical setup failure reports into permanent reproducible tests.

---

## 3. Recommended Testing Architecture

The recommended approach uses a **four-tier testing pyramid** aligned with the existing `dev/docs/testing-plan.md` tier definitions, extended with cross-cutting concerns from the E2E strategy:

```
                    +--------------------------+
                    |  Tier 4: Docker Stack    |  (Pre-release gate)
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

Cross-cutting (all tiers):
  - Failure-matrix scenarios (common first-run blockers)
  - Artifact/compose contract validation
  - Regression replay test pack
```

**Key principles:**
- Tiers 1-3 require **no Docker** and run in CI on every PR.
- Tier 4 requires Docker and runs as a **required release gate** (via `release.yml`) or via `workflow_dispatch`.
- Failure-matrix scenarios are tested at the appropriate tier (validation errors in Tier 2/3, Docker failures in Tier 4).
- Every setup bug fix must include a replay test (policy from E2E strategy).

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
        await page.getByRole('button', { name: 'Next' }).click();
        await page.getByLabel(/admin password/i).fill('short');
        await page.getByLabel(/confirm password/i).fill('short');
        await page.getByRole('button', { name: 'Next' }).click();
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

### 4.4 Add Install CLI Regression Tests

Based on findings from the manual reviews, add tests for:

```ts
describe('install command --help', () => {
    it('prints help and exits 0 without triggering runtime checks', () => {
        // Regression: install --help previously ran the install flow
    });
});

describe('install command --runtime docker', () => {
    it('shows explicit daemon-unavailable error with issue link when Docker is not running', () => {
        // Covers the improved error messaging from manual review
    });
});
```

---

## 5. Tier 2: Integration Tests with API Mocking (No Docker)

### 5.1 Use MSW (Mock Service Worker) for API Layer Testing

MSW intercepts `fetch` calls at the network level, allowing component tests to exercise real API call paths without a server. MSW v2 uses the `http` and `HttpResponse` API (not the deprecated v1 `rest` API).

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
        // Verify "Server unreachable" message
    });

    it('handles partial failure in finishSetup', async () => {
        server.use(
            http.post('*/command', async ({ request }) => {
                const body = await request.json() as { type: string };
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
        // Verify "Setup failed:" error appears
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
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

    await expect(page.locator('.wiz-error')).toContainText('Anthropic API key is required');
});
```

#### Route Interception for Error Simulation

Playwright can intercept network requests without MSW:

```ts
test('shows error when profile API fails', async ({ page }) => {
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await fillProfileStep(page);

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
    // Navigate to health check step first...

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
    await expect(page.locator('button', { hasText: 'Finish Setup' })).toBeEnabled();
});
```

#### Wizard State Persistence Tests

```ts
test('wizard preserves progress after page reload', async ({ page }) => {
    await openWizard(page);
    await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
    await expect(page.locator('.wizard h2')).toContainText('Profile');

    await page.reload();
    await page.evaluate((token) => localStorage.setItem('op_admin', token), ADMIN_TOKEN);
    await page.reload();

    await openWizard(page);
    // Should show welcome step completed in the step indicator
});
```

#### Accessibility Tests

```ts
test('wizard has correct ARIA attributes', async ({ page }) => {
    await openWizard(page);
    await expect(page.locator('.wizard-overlay')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('.wizard-overlay')).toHaveAttribute('aria-modal', 'true');
});
```

### 6.2 Add Cross-Browser Testing

Update `playwright.config.ts` to test Firefox and WebKit:

```ts
projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
]
```

---

## 7. Tier 4: Full-Stack Docker Tests (Docker Required)

Per the E2E strategy doc, this tier provides **35% of the overall detection weight** — the single most valuable investment for catching real setup breakage.

### 7.1 Docker-Backed Full Wizard Happy-Path E2E Gate

**File:** `test/install-e2e/happy-path.docker.ts`

This is the highest-priority new test. It runs against real Docker Compose with `OPENPALM_TEST_MODE` **off**, ensuring the real apply/startup path is exercised:

```ts
describe.skipIf(!runDockerStackTests)('docker stack: wizard E2E', () => {
    it('completes full install -> wizard -> healthy runtime path', async () => {
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

        // 7. Complete setup (real compose apply, NOT test-mode)
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

### 7.2 Playwright Tests Against Docker Stack

For the most realistic testing, run Playwright browser tests against the Docker-hosted admin UI. This test would:

1. Build and start the Docker stack.
2. Launch a Playwright browser pointing at the admin container's exposed port.
3. Exercise the complete wizard UI flow in the browser.
4. Verify that services actually start and become healthy.

This is the only test that catches:
- Caddy proxy misconfiguration
- Container networking issues
- Volume mount permission problems
- Image build failures that affect the UI bundle

### 7.3 Use Testcontainers for Programmatic Docker Management

Instead of manually managing Docker Compose in tests, consider the `testcontainers` npm package for more reliable container lifecycle management:

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

### 7.4 Scenario Isolation Requirements

Per the E2E strategy doc's recommendation:

- Use unique project names per test run (`openpalm-test-<uuid>`)
- Use unique ports via dynamic allocation (never hardcode)
- Use unique DATA/STATE/CONFIG roots (temp directories)
- Explicitly block tests from using existing `.dev` state to avoid false positives

---

## 8. Failure-Matrix Scenarios

The E2E strategy assigns **25% detection weight** to failure-matrix testing. These are *not* happy-path bugs — they are failure-handling bugs where users get stuck.

### 8.1 Required Negative Scenarios

Add scenario tests that intentionally trigger high-frequency setup failures and assert actionable error messages and safe state:

| Scenario | Tier | What to Assert |
|---|---|---|
| Short password (<8 chars) | 2, 3 | Error visible, stays on Profile step, no API call made |
| Mismatched passwords | 2, 3 | Error visible, stays on Profile step |
| Missing Anthropic API key | 2, 3 | Error visible, stays on Providers step |
| Profile API returns 500 | 2, 3 | "Could not save your profile" shown, retry possible |
| Service instances API returns 500 | 2, 3 | "Could not save service settings" shown, retry possible |
| `setup.complete` fails (Docker unavailable) | 2, 3, 4 | "Setup failed:" with actionable message, Finish button re-enabled |
| Channel start fails (non-fatal) | 2, 3 | Warning logged, wizard continues to completion |
| Network unreachable (fetch throws) | 2 | "Server unreachable" message shown |
| Partial setup then retry | 3 | State preserved, wizard resumes from correct step |
| Invalid channel config in payload | 3, 4 | API returns 400, error shown to user |
| Port conflict during service startup | 4 | Clear error message, no orphaned containers |
| Docker daemon stops mid-setup | 4 | Actionable error, state not corrupted |

### 8.2 Release Policy for Failure Scenarios

- At least the top 5 highest-frequency negative scenarios must pass before any release.
- New failure scenarios are added when support issues reveal gaps.

---

## 9. Artifact & Compose Contract Validation

The E2E strategy assigns **15% detection weight** to artifact validation. Wizard failures often originate from generated artifacts being subtly wrong.

### 9.1 Assertion Helpers for Generated Artifacts

Create assertion helpers that run in Docker E2E tests before and after `setup.complete`:

```ts
async function validateGeneratedArtifacts(stateDir: string) {
    // 1. docker compose config passes
    const configResult = await composeRun('config');
    expect(configResult.exitCode).toBe(0);

    // 2. Generated compose includes required core services
    const composeYaml = readFileSync(join(stateDir, 'docker-compose.yml'), 'utf8');
    expect(composeYaml).toContain('admin');
    expect(composeYaml).toContain('gateway');

    // 3. Generated caddy.json is valid JSON with required routes
    const caddyJson = JSON.parse(readFileSync(join(stateDir, 'caddy.json'), 'utf8'));
    expect(caddyJson).toHaveProperty('apps.http.servers');

    // 4. Scoped env files include only referenced secrets
    const gatewayEnv = readFileSync(join(stateDir, 'gateway/.env'), 'utf8');
    // Should not contain secrets from other services
}
```

### 9.2 Artifact Bundle on Failure

When any Docker E2E test fails, upload a diagnostic artifact bundle containing:

- Command transcript
- `docker compose config` output
- `docker compose ps` output
- `docker compose logs`
- `setup-state.json` snapshot
- Generated env, caddy, and compose files

This is enforced via the `actions/upload-artifact` step in CI workflows.

---

## 10. Regression Replay Test Pack

The E2E strategy assigns **15% detection weight** to replay tests. This prevents bugs that already escaped once from regressing.

### 10.1 Structure

```
test/regressions/
    README.md           # Policy and instructions
    ISSUE-2.test.ts     # Password in profile step (migrate from source scan)
    ISSUE-9.test.ts     # finishSetup error handling (migrate from source scan)
    ISSUE-NNN.test.ts   # Future: each setup bug gets a replay test
```

### 10.2 Policy

Codified in `AGENTS.md` and PR template:

- **Any setup bug fix must include a replay test in the same PR.**
- Each test maps to an issue: `issue-id -> scenario-id`.
- Tests reproduce the minimal trigger condition and assert correct behavior.
- The existing source-text tests for ISSUE-2 and ISSUE-9 should be migrated to real rendered component tests.

### 10.3 Example: Converting ISSUE-9 from Source Scan to Behavior Test

Current (source scan):
```ts
it("has a finishInProgress state guard", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("finishInProgress");
});
```

Proposed (behavior test):
```ts
it("prevents double-click on Finish Setup", async () => {
    // Navigate to health check step
    // Click Finish Setup
    // Verify button shows "Finishing..." and is disabled
    // Verify a second click is ignored
    // Verify button re-enables after completion or failure
});
```

---

## 11. Visual Regression Testing

### 11.1 Add Playwright Screenshot Assertions

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
            maxDiffPixelRatio: 0.01
        });
    });
});
```

**Best practices for stable visual tests:**
- Scope screenshots to `.wizard` element, not full page
- Use `maxDiffPixelRatio: 0.01` to tolerate minor anti-aliasing differences
- Mask dynamic content (timestamps, service health status text)
- Store baselines in git, update via `npx playwright test --update-snapshots`
- Run visual tests only in CI on Linux for consistency (different OS = different font rendering)

### 11.2 CI Workflow for Visual Tests

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

## 12. CI/CD Pipeline Changes

### 12.1 Current Pipeline

```
PR opened/pushed --> test.yml (unit/contract) --> test-ui.yml (Playwright E2E)
                                               --> (Docker tests: manual only)
```

### 12.2 Proposed Pipeline

```
PR opened/pushed:
+-- test.yml (unit/contract tests)                    [~3 min]
+-- test-ui.yml (Playwright E2E + validation errors)  [~5 min]
+-- test-components.yml (Vitest browser mode)          [~3 min]  <-- NEW
+-- test-visual.yml (screenshot regression)            [~4 min]  <-- NEW

Pre-release (release.yml or workflow_dispatch):
+-- setup-wizard-e2e (Docker stack + wizard E2E gate)  [~10 min] <-- NEW
    (added as a required job in release.yml)
```

Docker stack tests run as part of the release workflow or via manual `workflow_dispatch`, not as a nightly scheduled job. This avoids the need for an upgraded Docker Hub account while still gating releases on real Docker validation.

### 12.3 New CI Workflow: Component Tests

```yaml
# .github/workflows/test-components.yml
name: component-tests
on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: test-components-${{ github.ref }}
  cancel-in-progress: true

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

### 12.4 Release Workflow Addition

Add a `setup-wizard-e2e` job to `release.yml` as a required gate:

```yaml
# Addition to .github/workflows/release.yml
setup-wizard-e2e:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  needs: [unit, ui]
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install --frozen-lockfile
    - name: Run setup wizard E2E against Docker
      run: bun run test:docker
      env:
        OPENPALM_RUN_DOCKER_STACK_TESTS: '1'
    - uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: docker-e2e-logs
        path: /tmp/openpalm-docker-test-*/
```

### 12.5 Lightweight Local Developer Command

Per the E2E strategy recommendation, provide a one-command pre-PR setup validation:

```bash
bun run test:install:smoke
```

This runs the happy-path Docker E2E locally so engineers can validate setup before merge. Keep runtime under ~10 minutes.

---

## 13. Release Gate Policy

Aligned with the E2E strategy's minimal acceptance bar:

### A release is not eligible unless:

1. **All Tier 1-3 tests pass** (unit, component, Playwright E2E) — enforced by CI on every PR.
2. **Docker-backed happy-path wizard E2E passes** — enforced as a required job in `release.yml`.
3. **Top 5 failure-matrix scenarios pass** in at least Tier 3 (Playwright with route interception).
4. **No unresolved P0/P1 setup bug without a replay test** — enforced via PR checklist.
5. **Failure artifacts are available** for any failed Docker E2E scenario — enforced by CI upload step.

### Flake Accounting

Per the E2E strategy recommendation:
- Label test failures as `product_regression` vs `test_flake` in CI summary.
- Maximum 1 retry per test. Report both first-fail and final status.
- Track flake rate separately from product failure rate.

---

## 14. Implementation Priorities

### Phase 1: Quick Wins (1-2 days)

**Impact: High | Effort: Low**

1. **Add validation error tests to `10-setup-wizard-ui.pw.ts`** — Test password validation, password mismatch, and required Anthropic key. Uses existing infrastructure.

2. **Add Playwright route interception tests for API failures** — Test "Could not save your profile" and "Setup failed:" error paths. No new dependencies.

3. **Add cross-browser projects to `playwright.config.ts`** — Add Firefox and WebKit.

### Phase 2: Component Testing Layer (3-5 days)

**Impact: High | Effort: Medium**

4. **Create real Vitest browser-mode component tests** — Replace source-text scanning in `setup-wizard.test.ts` with rendered component tests using `vitest-browser-svelte`.

5. **Add MSW for API mocking** — Install `msw`, create handler files, integrate with Vitest setup.

6. **Test HealthStep and CompleteStep polling** — Use MSW + fake timers.

7. **Migrate ISSUE-2 and ISSUE-9 source-scan tests to behavior tests** — Convert existing regression tests from string matching to rendered component assertions.

### Phase 3: Docker & Visual (1-2 weeks)

**Impact: High | Effort: Medium-High**

8. **Add Docker-backed happy-path wizard E2E** (`test/install-e2e/happy-path.docker.ts`) — The single highest-value Docker test. Exercise the full install->wizard->apply->healthy path with `OPENPALM_TEST_MODE` off.

9. **Add wizard E2E as a required gate in `release.yml`** — Blocks releases on setup wizard completion.

10. **Add Playwright visual regression tests** — Screenshot each wizard step and error state.

11. **Add artifact/compose contract validation** — Assert generated compose, caddy, and env files are valid.

### Phase 4: Full Confidence (Ongoing)

12. **Build regression replay test pack** — Codify the "bug -> scenario" policy.
13. **Add failure-matrix scenarios for Docker-specific failures** — Port conflicts, daemon unavailable mid-setup, partial container startup.
14. **Add CLI install -> wizard -> verify E2E** — The ultimate test.
15. **Add `bun run test:install:smoke`** for local developer pre-PR validation.

---

## 15. Test Matrix

### Per-Scenario Coverage

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
| Wizard state persistence / resume | x | x | x | |
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
| Compose config valid after apply | | | | x |
| Caddy JSON valid after apply | | | | x |
| Scoped env files correct | | | | x |
| Real compose apply (test mode off) | | | | x |
| Port conflict handling | | | | x |
| Docker daemon unavailable mid-setup | | | | x |
| Partial setup then retry | | x | x | x |
| Install CLI --help shows help | x | | | |
| Install CLI --runtime docker error msg | x | | | |

### Coverage by Detection Weight (from E2E strategy)

| Area | Detection Weight | Status |
|---|---:|---|
| Docker-backed wizard happy-path E2E | 35% | **Not implemented** — Phase 3, item 8 |
| Failure-matrix scenarios | 25% | **Not implemented** — Phase 1-3 cover Tiers 2-3; Phase 4 item 13 covers Tier 4 |
| Artifact/compose contract validation | 15% | **Not implemented** — Phase 3, item 11 |
| Regression replay test pack | 15% | **Partially exists** (ISSUE-2, ISSUE-9 as source scans) — Phase 2, item 7 |
| Multi-platform installer smoke | 10% | **Not implemented** — Phase 4, item 14 |

### Coverage Summary

| Tier | Docker Required | Runs In CI | Catches |
|---|:---:|:---:|---|
| 1: Unit | No | Every PR | State logic bugs, data validation, persistence, CLI regressions |
| 2: Component + MSW | No | Every PR | Rendering bugs, API error handling, polling logic, state management |
| 3: Playwright E2E | No | Every PR | Full user flows, validation UX, cross-browser, visual regression |
| 4: Docker Stack | Yes | Pre-release gate | Container build, networking, volumes, real compose apply, artifact correctness |

**With all four tiers implemented, the only scenarios NOT covered by automated tests are:**
- Hardware-specific issues (ARM vs x86 rendering differences)
- Real third-party API integration (actual Anthropic key validation)
- OS-specific Docker socket behavior (Linux vs macOS vs Windows)
- Multi-platform installer behavior (Linux vs macOS shell differences)

These remaining scenarios require manual testing as part of the release process (see `dev/docs/manual-install-setup-review.md` and `dev/docs/manual-setup-readiness-review.md` for templates).
