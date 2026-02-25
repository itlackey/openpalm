# Implementation Plan: Rec 2 — Playwright Validation-Error and API-Failure Tests

## Problem

`packages/ui/e2e/10-setup-wizard-ui.pw.ts` (lines 32–98) contains four tests that
only exercise the happy path. There is zero coverage of:

- Profile step: password too short (< 8 chars) → stays on step, error shown
- Profile step: passwords mismatched → stays on step, error shown
- Providers step: Anthropic key left blank → stays on step, error shown
- Finish Setup: `setup.complete` command returns 500 → "Setup failed:" shown, button re-enabled

All four of these branches are reachable today via client-side guards and the
`finishSetup()` error handler in `SetupWizard.svelte`. They are the most common
user-facing failures and none are tested.

---

## Key file references

| File | Relevant lines | Role |
|---|---|---|
| `packages/ui/e2e/10-setup-wizard-ui.pw.ts` | 1–99 | **Target file** — all four new tests go here |
| `packages/ui/e2e/helpers.ts` | 3 | `ADMIN_TOKEN = 'test-token-e2e'` |
| `packages/ui/e2e/env.ts` | 16, 100 | `PORT = 13456`, `OPENPALM_TEST_MODE=1` |
| `packages/ui/playwright.config.ts` | 1–24 | Single Chromium worker, `baseURL = http://localhost:13456` |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 62–96 | Profile validation (password length, match) |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 114–118 | Providers validation (missing Anthropic key) |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 186–246 | `finishSetup()` — `setup.complete` error handler |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 280–282 | `<div class="wiz-error visible">` — error display element |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 289–291 | `<button disabled={finishInProgress}>Finish Setup</button>` |
| `packages/ui/src/lib/components/ProfileStep.svelte` | 36–41 | `#wiz-profile-password` input |
| `packages/ui/src/lib/components/ProfileStep.svelte` | 43–48 | `#wiz-profile-password2` input |
| `packages/ui/src/lib/components/ProvidersStep.svelte` | 38 | `#wiz-anthropic-key` input |
| `packages/ui/src/lib/api.ts` | 19 | `url = \`${base}${path}\`` — `base` is empty string in test mode, so calls go to `/command` |
| `.github/workflows/test-ui.yml` | 1–33 | Existing CI workflow — **no changes needed** |

---

## Selector inventory

All selectors are grounded in the actual Svelte markup. No guessing required.

| Purpose | Playwright locator |
|---|---|
| Wizard overlay | `page.locator('.wizard-overlay')` |
| Wizard heading | `page.locator('.wizard h2')` |
| Next button | `page.locator('.wizard .actions button', { hasText: 'Next' })` |
| Finish Setup button | `page.locator('.wizard .actions button', { hasText: 'Finish Setup' })` (also: `page.locator('button', { hasText: 'Finish Setup' })`) |
| Password field | `page.locator('#wiz-profile-password')` |
| Confirm password field | `page.locator('#wiz-profile-password2')` |
| Anthropic key field | `page.locator('#wiz-anthropic-key')` |
| Step-level error div | `page.locator('.wiz-error.visible')` |

The error text node lives in two places depending on the step:
1. Inside `ProfileStep.svelte` (line 14–16): rendered within `.body` when `error` prop is set
2. In `SetupWizard.svelte` (line 281): outside `.body`, between `.body` and `.actions`

Both use `.wiz-error.visible` as the CSS class. The locator `.wiz-error.visible` will
find either one. For the API-failure test, the relevant error is the one at the wizard
level (line 281), not inside a step component — both still use the same class.

The `Finish Setup` button becomes re-enabled when `finishInProgress` returns to `false`
(SetupWizard.svelte line 290). After the `setup.complete` 500 intercept, the `finally`
block (line 243) resets `finishInProgress = false`, so `disabled={finishInProgress}`
becomes `false` and the button is interactive again.

---

## API interception: what URL to intercept

All API calls from the component use `$lib/api.ts` → `fetch(url, ...)` where
`url = \`${base}${path}\`` and `base` is `''` during tests (SvelteKit adapter-node with
no base path configured).

The `setup.complete` command is posted as:
```
POST /command
body: { "type": "setup.complete", "payload": {} }
```

For the API-failure test, intercept using `page.route()` with a **request body filter**
so only the `setup.complete` POST is stubbed and not all `/command` calls (which are
also used by the preceding `setup.channels` and `setup.step` calls in `finishSetup()`).

```typescript
await page.route('**/command', async (route) => {
  const body = route.request().postDataJSON();
  if (body?.type === 'setup.complete') {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'docker daemon not running' })
    });
  } else {
    await route.continue();
  }
});
```

The `route.request().postDataJSON()` call parses the JSON body sent by `api()` in
`SetupWizard.svelte` (line 233). `route.continue()` passes all other `/command` POSTs
through to the real test server so channel and step-complete calls still succeed.

The `page.route()` call is scoped to the test and is automatically removed after the
test ends (Playwright clears routes per test).

---

## New test blocks to add

All four tests go into the existing `test.describe('setup wizard browser flow', ...)` block
in `packages/ui/e2e/10-setup-wizard-ui.pw.ts` after line 98 (after the closing `}`
of `'full wizard flow reaches Complete step'`).

### Test 1: Profile step rejects short password

```typescript
test('profile step rejects password shorter than 8 characters', async ({ page }) => {
  await openWizard(page);
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
  await expect(page.locator('.wizard h2')).toContainText('Profile');

  await page.locator('#wiz-profile-password').fill('short');
  await page.locator('#wiz-profile-password2').fill('short');
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // Wizard must stay on Profile — heading unchanged
  await expect(page.locator('.wizard h2')).toContainText('Profile');
  // Error message must be visible
  await expect(page.locator('.wiz-error.visible')).toContainText(
    'Password must be at least 8 characters.'
  );
});
```

**Why this works:** `SetupWizard.svelte` line 75–78 — `if (password.length < 8)` sets
`stepError` and `return`s before calling the API or advancing the step.

### Test 2: Profile step rejects mismatched passwords

```typescript
test('profile step rejects mismatched passwords', async ({ page }) => {
  await openWizard(page);
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
  await expect(page.locator('.wizard h2')).toContainText('Profile');

  await page.locator('#wiz-profile-password').fill('password-one');
  await page.locator('#wiz-profile-password2').fill('password-two');
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  await expect(page.locator('.wizard h2')).toContainText('Profile');
  await expect(page.locator('.wiz-error.visible')).toContainText('Passwords do not match.');
});
```

**Why this works:** `SetupWizard.svelte` line 79–82 — `if (password !== password2)` sets
`stepError` and `return`s.

### Test 3: Providers step rejects missing Anthropic key

To navigate to the Providers step, a valid Profile step must be completed first. Use the
existing `fillProfileStep()` helper.

```typescript
test('providers step rejects missing Anthropic key', async ({ page }) => {
  await openWizard(page);

  // Advance through Welcome
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
  await expect(page.locator('.wizard h2')).toContainText('Profile');

  // Complete Profile step with valid credentials
  await fillProfileStep(page);
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
  await expect(page.locator('.wizard h2')).toContainText('AI Providers');

  // Leave Anthropic key blank (default) and try to advance
  // The field starts empty — no fill needed; just click Next
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  await expect(page.locator('.wizard h2')).toContainText('AI Providers');
  await expect(page.locator('.wiz-error.visible')).toContainText(
    'An Anthropic API key is required.'
  );
});
```

**Why this works:** `SetupWizard.svelte` line 115–118 — `if (!anthropicApiKey.trim())`
sets `stepError` and `return`s. The field (`#wiz-anthropic-key`) defaults to `value=""`
in `ProvidersStep.svelte` line 38, so no clearing is needed.

### Test 4: setup.complete 500 → error shown, Finish button re-enabled

This test runs the wizard to the Health Check step (step index 6, the `isLastContentStep`
= true step where `Finish Setup` appears). It intercepts only `setup.complete` and lets
all preceding `/command` calls pass through.

```typescript
test('setup.complete failure shows error and re-enables Finish Setup button', async ({
  page
}) => {
  // Intercept only setup.complete; let all other /command calls through
  await page.route('**/command', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === 'setup.complete') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'docker daemon not running' })
      });
    } else {
      await route.continue();
    }
  });

  await openWizard(page);

  // Welcome → Profile
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();
  await expect(page.locator('.wizard h2')).toContainText('Profile');
  await fillProfileStep(page);
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // Profile → AI Providers
  await expect(page.locator('.wizard h2')).toContainText('AI Providers');
  await fillProvidersStep(page);
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // AI Providers → Security
  await expect(page.locator('.wizard h2')).toContainText('Security');
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // Security → Channels
  await expect(page.locator('.wizard h2')).toContainText('Channels');
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // Channels → Access
  await expect(page.locator('.wizard h2')).toContainText('Access');
  await page.locator('.wizard .actions button', { hasText: 'Next' }).click();

  // Access → Health Check (this is isLastContentStep — Finish Setup appears)
  await expect(page.locator('.wizard h2')).toContainText('Health Check');
  const finishBtn = page.locator('.wizard .actions button', { hasText: 'Finish Setup' });
  await expect(finishBtn).toBeEnabled();

  await finishBtn.click();

  // Button should be disabled while in progress
  // (finishInProgress = true, button gets disabled={true})
  // Then setup.complete 500 fires and finishInProgress resets to false
  await expect(finishBtn).toBeEnabled();

  // Error must be shown
  await expect(page.locator('.wiz-error.visible')).toContainText('Setup failed:');
  await expect(page.locator('.wiz-error.visible')).toContainText('docker daemon not running');

  // Wizard must NOT advance to Complete step
  await expect(page.locator('.wizard h2')).toContainText('Health Check');
});
```

**Why this works:**
- `SetupWizard.svelte` lines 232–240: `setup.complete` failure sets `stepError` to
  `"Setup failed: ${errorMsg}. Check that Docker..."` and `return`s without calling
  `setWizardStep`.
- `SetupWizard.svelte` line 243: `finally { finishInProgress = false }` runs unconditionally,
  re-enabling the button.
- `SetupWizard.svelte` lines 280–282: `{#if stepError && !isComplete}` renders
  `<div class="wiz-error visible">` at the wizard level.
- All preceding `/command` types (`setup.profile`, `setup.service_instances`,
  `setup.access_scope`, `setup.channels`, `setup.step`, `service.up`) are passed through
  to the real test server via `route.continue()`, so the test exercises real state
  transitions up to the point of failure.

---

## Placement in the file

Insert all four tests inside the existing `test.describe('setup wizard browser flow', ...)`
block, after the closing brace of `'full wizard flow reaches Complete step'` (currently
line 98). The final brace of the `describe` block (currently line 99) moves to after
the last new test.

No new imports are needed — `page.route()` is part of the `Page` type already imported
on line 1. No new helpers are needed.

---

## How to run the new tests locally

```bash
# From the repo root
cd packages/ui
bunx playwright test e2e/10-setup-wizard-ui.pw.ts

# Run only the new error tests by name substring
bunx playwright test e2e/10-setup-wizard-ui.pw.ts --grep "rejects|failure"

# Run with UI mode for visual debugging
bunx playwright test e2e/10-setup-wizard-ui.pw.ts --ui
```

The webServer (`e2e/start-webserver.cjs`) is started automatically by Playwright config.
`OPENPALM_TEST_MODE=1` is already set in `env.ts` line 100, which prevents real Docker
calls from running during the API-failure test's `route.continue()` path.

---

## CI changes needed

**None.** The existing `.github/workflows/test-ui.yml` (lines 1–33) runs
`bun run test:ui` which invokes `bunx playwright test` against all `*.pw.ts` files in
`e2e/`. The new tests will be picked up automatically because they live in the same file
(`10-setup-wizard-ui.pw.ts`) and match `**/*.pw.ts` (playwright.config.ts line 9).

No new dependencies, no new config files, no workflow changes.
