# Rec 1: Delete source-scan tests; add rendered component tests for SetupWizard

## Problem

`packages/ui/src/lib/components/setup-wizard.test.ts` (101 lines) reads `SetupWizard.svelte`
as a raw string and asserts that identifier literals like `"finishInProgress"` or
`"password.length < 8"` exist in the source text.  These tests:

- Pass even when the UI is completely broken (the text may be present but unreachable code)
- Fail on any mechanical refactor (rename a variable, extract a function) that does not
  change behaviour
- Run under `bun:test`, which is the wrong runtime for Svelte component tests

The setup already has everything needed for real rendered component tests:
- `vitest-browser-svelte@^2.0.2` is in `devDependencies`
  (`packages/ui/package.json:45`)
- `@vitest/browser-playwright@^4.0.18` is in `devDependencies`
  (`packages/ui/package.json:30`)
- The vitest `client` project watches `**/*.svelte.{test,spec}.{js,ts}` with Chromium in
  headless mode (`packages/ui/vite.config.ts:112–120`)

---

## Solution overview

1. Delete `setup-wizard.test.ts`
2. Create `SetupWizard.svelte.test.ts` in the same directory using `vitest-browser-svelte`
3. Add a `vitest` step to `test-ui.yml` so the new browser tests run in CI

---

## Step 1 — Delete the source-scan test file

```
packages/ui/src/lib/components/setup-wizard.test.ts
```

Simply delete this file. No other file imports it.

---

## Step 2 — Check for packages to install

No new packages are needed. Both `vitest-browser-svelte` and `@vitest/browser-playwright`
are already present:

- `packages/ui/package.json:30` — `"@vitest/browser-playwright": "^4.0.18"`
- `packages/ui/package.json:45` — `"vitest-browser-svelte": "^2.0.2"`

---

## Step 3 — Create the new test file

**Path:** `packages/ui/src/lib/components/SetupWizard.svelte.test.ts`

The file name ending in `.svelte.test.ts` matches the `include` glob in the vitest
`client` project (`vite.config.ts:118`), so vitest will automatically run it in Chromium
browser mode.

### Imports and mocking strategy

`SetupWizard.svelte` imports three SvelteKit modules that do not exist in a test browser
context and must be mocked before the component is imported:

| Module | Reason to mock |
|---|---|
| `$app/environment` | `version` (used by `WelcomeStep`) and `browser` flag (used by `auth.svelte.ts`) |
| `$lib/api` | All network calls (`api('/command', ...)`) must be stubbed |
| `$lib/stores/setup.svelte` | `getWizardStep` / `setWizardStep` drive the current step; must be controllable from tests |

`$lib/stores/auth.svelte` and the child step components (`WelcomeStep`, `ProfileStep`,
etc.) do **not** need to be mocked — they render real markup which is exactly what the
tests should assert against.

### Full test file content

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import SetupWizard from './SetupWizard.svelte';

// --- Module mocks -----------------------------------------------------------

// Mock $app/environment so WelcomeStep can read `version` and
// auth.svelte.ts can check the `browser` flag without crashing.
vi.mock('$app/environment', () => ({
  version: 'test',
  browser: true,
  dev: true,
  building: false,
}));

// Stub all API calls so tests never hit the network.
const mockApi = vi.fn().mockResolvedValue({ ok: true, data: null });
vi.mock('$lib/api', () => ({ api: mockApi }));

// Control which wizard step is active.
let currentStepIndex = 0;
const mockSetWizardStep = vi.fn((n: number) => { currentStepIndex = n; });
vi.mock('$lib/stores/setup.svelte', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/stores/setup.svelte')>();
  return {
    ...original,
    getWizardStep: () => currentStepIndex,
    setWizardStep: mockSetWizardStep,
    getSetupState: () => null,
  };
});

// ---------------------------------------------------------------------------

describe('SetupWizard — rendered component tests', () => {
  beforeEach(() => {
    currentStepIndex = 0;
    mockApi.mockClear();
    mockSetWizardStep.mockClear();
  });

  // -------------------------------------------------------------------------
  // Test 1: renders the Welcome step on first render
  // -------------------------------------------------------------------------
  it('renders the Welcome step initially', async () => {
    render(SetupWizard, { onclose: vi.fn() });

    // The wizard <h2> title for step 0 is "Welcome" (STEP_TITLES[0])
    // SetupWizard.svelte:256
    await expect.element(page.getByRole('heading', { level: 2, name: 'Welcome' }))
      .toBeVisible();

    // WelcomeStep renders a paragraph starting with "Welcome to OpenPalm"
    // WelcomeStep.svelte:5-7
    await expect.element(page.getByText(/Welcome to OpenPalm/))
      .toBeVisible();

    // The "Next" button should be present on step 0 (not the last content step)
    // SetupWizard.svelte:294
    await expect.element(page.getByRole('button', { name: 'Next' }))
      .toBeVisible();

    // The "Back" button should NOT be present on step 0
    // SetupWizard.svelte:286-288
    await expect.element(page.getByRole('button', { name: 'Back' }))
      .not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Test 2: clicking Next on Welcome calls setWizardStep(1)
  // -------------------------------------------------------------------------
  it('advances to the Profile step when Next is clicked on Welcome', async () => {
    render(SetupWizard, { onclose: vi.fn() });

    const nextButton = page.getByRole('button', { name: 'Next' });
    await nextButton.click();

    // wizardNext() for step 'welcome' has no API call — it goes straight to
    // setWizardStep(currentStep + 1)
    // SetupWizard.svelte:179
    expect(mockSetWizardStep).toHaveBeenCalledWith(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: shows an error when the password is shorter than 8 characters
  // -------------------------------------------------------------------------
  it('shows a short-password error on the Profile step', async () => {
    currentStepIndex = 1; // start at Profile step

    render(SetupWizard, { onclose: vi.fn() });

    // Verify we are on the Profile step
    // SetupWizard.svelte:256
    await expect.element(page.getByRole('heading', { level: 2, name: 'Profile' }))
      .toBeVisible();

    // Fill the password field with a 7-character value
    // ProfileStep.svelte:36-41 — input id="wiz-profile-password"
    const passwordInput = page.getByRole('textbox', { name: /Admin password/i });
    await passwordInput.fill('short1');

    // Leave the confirm-password field empty (default)
    await page.getByRole('button', { name: 'Next' }).click();

    // The error banner rendered in SetupWizard.svelte:280-282:
    //   <div class="wiz-error visible">{stepError}</div>
    // SetupWizard.svelte:76: stepError = 'Password must be at least 8 characters.'
    await expect.element(page.getByText('Password must be at least 8 characters.'))
      .toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Test 4: shows an error when the passwords do not match
  // -------------------------------------------------------------------------
  it('shows a mismatch error when the passwords do not match on the Profile step', async () => {
    currentStepIndex = 1; // start at Profile step

    render(SetupWizard, { onclose: vi.fn() });

    // Fill password with a valid-length value
    // ProfileStep.svelte:36-41 — input id="wiz-profile-password"
    const passwordInput = page.getByRole('textbox', { name: /Admin password/i });
    await passwordInput.fill('longpassword1');

    // Fill confirm-password with a different value
    // ProfileStep.svelte:43-49 — input id="wiz-profile-password2"
    const confirmInput = page.getByRole('textbox', { name: /Confirm password/i });
    await confirmInput.fill('longpassword2');

    await page.getByRole('button', { name: 'Next' }).click();

    // SetupWizard.svelte:79-82: stepError = 'Passwords do not match.'
    await expect.element(page.getByText('Passwords do not match.'))
      .toBeVisible();
  });
});
```

### Notes on selectors

The selectors above are grounded in real markup:

| Selector | Source |
|---|---|
| `getByRole('heading', { level: 2, name: 'Welcome' })` | `SetupWizard.svelte:256` — `<h2>{STEP_TITLES[currentStep]}</h2>` |
| `getByText(/Welcome to OpenPalm/)` | `WelcomeStep.svelte:6` — rendered paragraph text |
| `getByRole('button', { name: 'Next' })` | `SetupWizard.svelte:294` — `<button onclick={wizardNext}>Next</button>` |
| `getByRole('button', { name: 'Back' })` | `SetupWizard.svelte:287` — `<button class="btn-secondary" onclick={wizardPrev}>Back</button>` |
| `getByRole('heading', { level: 2, name: 'Profile' })` | same h2, STEP_TITLES[1] = 'Profile' |
| `getByRole('textbox', { name: /Admin password/i })` | `ProfileStep.svelte:35` — `<label for="wiz-profile-password">Admin password</label>` + `<input id="wiz-profile-password" type="password" ...>` |
| `getByRole('textbox', { name: /Confirm password/i })` | `ProfileStep.svelte:43` — `<label for="wiz-profile-password2">Confirm password</label>` |
| `getByText('Password must be at least 8 characters.')` | `SetupWizard.svelte:76` + `SetupWizard.svelte:281` |
| `getByText('Passwords do not match.')` | `SetupWizard.svelte:80` + `SetupWizard.svelte:281` |

> **Note on password input role:** Inputs of `type="password"` are not exposed with
> `role="textbox"` in all browsers. If `getByRole('textbox')` fails, use
> `page.getByLabel(/Admin password/i)` (which resolves the `<label for="...">` →
> `<input id="...">` association) as an equivalent alternative. The label+id pattern is
> present in `ProfileStep.svelte:35–41` and `ProfileStep.svelte:43–49`.

---

## Step 4 — Run the new tests locally

From within `packages/ui`:

```bash
# Run only the browser (client) project — this is what runs SetupWizard.svelte.test.ts
cd packages/ui
bunx vitest --project client --run

# Or run all vitest projects (client + server) once
bun run test:unit -- --run
```

From the repo root:

```bash
# The test:unit filter in the root excludes 'ui', so you must cd into the package
cd packages/ui && bunx vitest --project client --run
```

Chromium is already installed by the `@vitest/browser-playwright` package. If the binary
is missing, install it once:

```bash
cd packages/ui && bunx playwright install chromium
```

---

## Step 5 — Wire into CI

### Current state

`test-ui.yml` currently only runs Playwright e2e tests:

```
.github/workflows/test-ui.yml:27  run: bun run test:ui
```

where `test:ui` resolves to `cd packages/ui && bunx playwright test`
(`package.json:43` in root).

The `test.yml` workflow runs `bun run test:ci` which calls `bun test` (Bun's native
runner). Bun's runner **does not** execute vitest test files.

The new `.svelte.test.ts` files are therefore **not** picked up by any existing CI step
and must be added explicitly.

### Required change to `test-ui.yml`

Add a new job (or a new step inside the existing `playwright` job) that runs vitest.
A separate job is preferable because it can run in parallel with the Playwright job and
has a distinct name in the PR check list.

```yaml
# .github/workflows/test-ui.yml  — add after line 16 (jobs:), before playwright:

  vitest:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
        working-directory: .
      - name: Install Chromium for vitest browser mode
        run: bunx playwright install --with-deps chromium
        working-directory: packages/ui
      - name: Run vitest browser tests
        run: bunx vitest --project client --run
        working-directory: packages/ui
```

This step:
- Reuses the Chromium install already present in the `playwright` job step
  (`test-ui.yml:25-26`)
- Runs only the `client` vitest project (headless Chromium) — the `server` project
  (node environment) is already implicitly covered by `bun test` in `test.yml`
- Is gated by the `test-ui.yml` → called by `release.yml:98` under the `ui` job

No changes are needed to `release.yml`, `test.yml`, or any other workflow file.

---

## File reference summary

| File | Line(s) | Relevance |
|---|---|---|
| `packages/ui/src/lib/components/setup-wizard.test.ts` | 1–101 | **Delete this file** |
| `packages/ui/src/lib/components/SetupWizard.svelte` | 1–299 | Component under test |
| `packages/ui/src/lib/components/SetupWizard.svelte:256` | 256 | `<h2>{STEP_TITLES[currentStep]}</h2>` |
| `packages/ui/src/lib/components/SetupWizard.svelte:261–278` | 261–278 | Step-conditional rendering |
| `packages/ui/src/lib/components/SetupWizard.svelte:280–282` | 280–282 | `wiz-error visible` banner |
| `packages/ui/src/lib/components/SetupWizard.svelte:284–297` | 284–297 | Navigation buttons |
| `packages/ui/src/lib/components/SetupWizard.svelte:75–82` | 75–82 | Password validation errors |
| `packages/ui/src/lib/components/SetupWizard.svelte:179` | 179 | `setWizardStep(currentStep + 1)` |
| `packages/ui/src/lib/components/WelcomeStep.svelte` | 5–7 | "Welcome to OpenPalm" text |
| `packages/ui/src/lib/components/ProfileStep.svelte` | 35–49 | Password input fields and labels |
| `packages/ui/src/lib/stores/setup.svelte.ts` | 53–58 | `getWizardStep` / `setWizardStep` |
| `packages/ui/vite.config.ts` | 108–121 | Vitest project config — `client` project, Chromium |
| `packages/ui/vite.config.ts` | 118 | `include: ['src/**/*.svelte.{test,spec}.{js,ts}']` |
| `packages/ui/package.json` | 15 | `"test:unit": "vitest"` |
| `packages/ui/package.json` | 30 | `"@vitest/browser-playwright": "^4.0.18"` |
| `packages/ui/package.json` | 45 | `"vitest-browser-svelte": "^2.0.2"` |
| `.github/workflows/test-ui.yml` | 1–33 | UI CI workflow — add `vitest` job here |
| `.github/workflows/release.yml` | 97–98 | `ui:` job calls `test-ui.yml` |
| `package.json` | 43 | `"test:ui": "cd packages/ui && bunx playwright test"` |
