/**
 * Setup Wizard — E2E tests
 *
 * Covers the full 7-screen flow of the current wizard:
 *   1. Welcome         (name / email / admin token, validation)
 *   2. Connections Hub (empty state, add/edit/duplicate/remove)
 *   3. Connection Type (Remote vs Local picker)
 *   4. Connection Details (presets, API key, base URL, test connection, cancel, save)
 *   5. Required Models (chat model, embedding model, validation, back/continue)
 *   6. Optional Add-ons (toggle expand, skip, continue)
 *   7. Review & Install (all sections, edit links, export downloads, save)
 *
 * All network calls that would hit real infrastructure are intercepted with
 * page.route() mocks so tests run fully offline.
 *
 * Test IDs used by the wizard:
 *   data-testid="step-welcome"              Screen 1
 *   data-testid="step-connections-hub"      Screen 2
 *   data-testid="step-connection-type"      Screen 3
 *   data-testid="step-add-connection-details" Screen 4
 *   data-testid="step-models"               Screen 5 (inside RequiredModelsScreen)
 *   data-testid="step-optional-addons"      Screen 6 (inside OptionalAddonsScreen)
 *   data-testid="step-review"               Screen 7
 *   data-testid="step-deploying"            Deploy progress screen
 */

import { expect, test, type Page } from '@playwright/test';

// ── Shared mocks ──────────────────────────────────────────────────────────────

/** Intercept the local-provider detection call so Screen 4 (local path) is instant. */
async function mockLocalProviders(page: Page, providers: unknown[] = []) {
  await page.route('**/admin/providers/local', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers }) })
  );
}

/** Intercept connection test to immediately succeed and return a model list. */
async function mockConnectionTest(page: Page) {
  await page.route('**/admin/connections/test', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, models: ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small'] })
      });
    }
    return route.continue();
  });
}

/** Intercept deploy-status to immediately return the "ready" phase. */
async function mockDeployReady(page: Page) {
  await page.route('**/admin/setup/deploy-status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        active: true,
        phase: 'ready',
        message: 'All services are up and running.',
        services: [
          { service: 'caddy', label: 'Caddy', imageReady: true, containerRunning: true },
          { service: 'memory', label: 'Memory', imageReady: true, containerRunning: true },
        ]
      })
    })
  );
}

/** Intercept the final POST /admin/setup to succeed without Docker. */
async function mockInstallSuccess(page: Page) {
  await page.route('**/admin/setup', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, async: true, started: ['caddy', 'memory'], dockerAvailable: true })
      });
    }
    return route.continue();
  });
}

/** Intercept the export endpoints so downloads succeed with fake JSON. */
async function mockExports(page: Page) {
  await page.route('**/admin/connections/export/opencode', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-disposition': 'attachment; filename="opencode.json"' },
      body: JSON.stringify({ model: 'gpt-4o', _nextSteps: [] })
    })
  );
  await page.route('**/admin/connections/export/mem0', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-disposition': 'attachment; filename="mem0-config.json"' },
      body: JSON.stringify({ llm: { provider: 'openai' } })
    })
  );
}

// ── Navigation helpers ────────────────────────────────────────────────────────

/** Fill Screen 1 (Welcome) and click Start. */
async function completeWelcome(
  page: Page,
  opts: { name?: string; email?: string; token?: string } = {}
) {
  await page.locator('#owner-name').fill(opts.name ?? 'Test User');
  if (opts.email) await page.locator('#owner-email').fill(opts.email);
  await page.locator('#admin-token').fill(opts.token ?? 'supersecrettoken');
  await page.getByRole('button', { name: 'Start' }).click();
}

/** From Screen 2 (Connections Hub), add a Remote OpenAI connection and save it. */
async function addRemoteConnection(page: Page, opts: { name?: string; apiKey?: string } = {}) {
  // Screen 2 → "Add your first connection" (empty state) or "Add connection" (step-actions)
  // Scope to the screen container to avoid matching the step-dot nav button "Step 3: Add Connection"
  const hub = page.getByTestId('step-connections-hub');
  await hub.getByRole('button', { name: /Add.*connection/i }).first().click();
  // Screen 3: pick Remote
  await expect(page.getByTestId('step-connection-type')).toBeVisible();
  await page.getByRole('button', { name: /Remote OpenAI/i }).click();
  // Screen 4: connection details
  await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
  // Click OpenAI preset chip to pre-fill name + base URL
  await page.getByRole('button', { name: 'OpenAI' }).first().click();
  if (opts.name) {
    await page.locator('#conn-name').fill(opts.name);
  }
  await page.locator('#conn-api-key').fill(opts.apiKey ?? 'sk-test-e2e-key');
  await page.getByRole('button', { name: 'Save connection' }).click();
  // Should land back on Screen 2 (Connections Hub)
  await expect(page.getByTestId('step-connections-hub')).toBeVisible();
}

/** Navigate from Screen 2 through Screen 5 and Screen 6 to Screen 7 (Review). */
async function navigateToReview(page: Page) {
  // Screen 2 → Continue (connections already added)
  await page.getByRole('button', { name: 'Continue' }).click();
  // Screen 5: Required Models
  await expect(page.getByTestId('step-models')).toBeVisible();
  await page.locator('#system-model').fill('gpt-4o');
  await page.locator('#embedding-model').fill('text-embedding-3-small');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Screen 6: Optional Add-ons
  await expect(page.getByTestId('step-optional-addons')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Screen 7: Review
  await expect(page.getByTestId('step-review')).toBeVisible();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('@mocked Setup Wizard', () => {

  // ── Screen 1: Welcome ───────────────────────────────────────────────────────

  test.describe('Screen 1 — Welcome', () => {
    test('loads wizard and shows Screen 1', async ({ page }) => {
      await page.goto('/setup');
      await expect(page.locator('h1')).toContainText('OpenPalm Setup Wizard');
      await expect(page.getByTestId('step-welcome')).toBeVisible();
      await expect(page.locator('h2')).toHaveText('Welcome');
    });

    test('Start requires name', async ({ page }) => {
      await page.goto('/setup');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Name is required.');
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('Start requires admin token', async ({ page }) => {
      await page.goto('/setup');
      await page.locator('#owner-name').fill('Test User');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Admin token is required.');
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('Start requires token of at least 8 characters', async ({ page }) => {
      await page.goto('/setup');
      await page.locator('#owner-name').fill('Test User');
      await page.locator('#admin-token').fill('short');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('at least 8 characters');
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('Start advances to Screen 2 when form is valid', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });

    test('email field is optional — Start succeeds without it', async ({ page }) => {
      await page.goto('/setup');
      await page.locator('#owner-name').fill('No Email User');
      await page.locator('#admin-token').fill('securetokenok');
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });
  });

  // ── Screen 2: Connections Hub ───────────────────────────────────────────────

  test.describe('Screen 2 — Connections Hub', () => {
    test('shows empty-state CTA when no connections exist', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
      await expect(page.getByText('No connections yet')).toBeVisible();
      await expect(page.getByRole('button', { name: /Add your first connection/i })).toBeVisible();
    });

    test('Continue is disabled until at least one connection is added', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    test('Back returns to Screen 1', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('saved connection appears in the list with Edit/Duplicate/Remove', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
      await expect(page.getByText('OpenAI', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    });

    test('Remove deletes the connection and restores empty state', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Remove' }).click();
      await expect(page.getByText('No connections yet')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    test('Duplicate opens Screen 4 to edit the copy', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Duplicate' }).click();
      // Duplicate opens Screen 4 with the copy pre-filled for editing
      await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
      // Name should have "(copy)" suffix
      await expect(page.locator('#conn-name')).toHaveValue(/copy/i);
    });

    test('Edit opens Screen 4 with that connection pre-filled', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
      // Connection name should be pre-filled (OpenAI preset)
      await expect(page.locator('#conn-name')).not.toHaveValue('');
    });

    test('Add connection button opens Screen 3', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      // Now use the "Add connection" button (not the empty-state CTA)
      await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();
      await expect(page.getByTestId('step-connection-type')).toBeVisible();
    });
  });

  // ── Screen 3: Connection Type ───────────────────────────────────────────────

  test.describe('Screen 3 — Connection Type', () => {
    test('shows correct title and two options', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await page.getByTestId('step-connections-hub').getByRole('button', { name: /Add.*connection/i }).first().click();
      await expect(page.getByTestId('step-connection-type')).toBeVisible();
      await expect(page.locator('h2')).toHaveText('Add a connection');
      await expect(page.getByRole('button', { name: /Remote OpenAI/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Local OpenAI/i })).toBeVisible();
    });

    test('Back returns to Screen 2', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await page.getByTestId('step-connections-hub').getByRole('button', { name: /Add.*connection/i }).first().click();
      await expect(page.getByTestId('step-connection-type')).toBeVisible();
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });

    test('Remote option advances to Screen 4 with cloud connection type', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      await page.getByTestId('step-connections-hub').getByRole('button', { name: /Add.*connection/i }).first().click();
      await page.getByRole('button', { name: /Remote OpenAI/i }).click();
      await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
      // Cloud path shows provider chip picker (e.g., OpenAI, Groq, etc.)
      await expect(page.getByRole('button', { name: 'OpenAI' }).first()).toBeVisible();
    });

    test('Local option advances to Screen 4 with local connection type', async ({ page }) => {
      await mockLocalProviders(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await page.getByTestId('step-connections-hub').getByRole('button', { name: /Add.*connection/i }).first().click();
      await page.getByRole('button', { name: /Local OpenAI/i }).click();
      await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
      // Local path shows base URL with localhost placeholder
      await expect(page.locator('#conn-base-url')).toHaveAttribute('placeholder', /localhost/i);
    });
  });

  // ── Screen 4: Connection Details ───────────────────────────────────────────

  test.describe('Screen 4 — Connection Details', () => {
    async function goToScreen4Cloud(page: Page) {
      await completeWelcome(page);
      await page.getByTestId('step-connections-hub').getByRole('button', { name: /Add.*connection/i }).first().click();
      await page.getByRole('button', { name: /Remote OpenAI/i }).click();
      await expect(page.getByTestId('step-add-connection-details')).toBeVisible();
    }

    test('shows correct title and fields', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await expect(page.locator('h2')).toHaveText('Connection details');
      await expect(page.locator('#conn-name')).toBeVisible();
      await expect(page.locator('#conn-api-key')).toBeVisible();
      await expect(page.locator('#conn-base-url')).toBeVisible();
    });

    test('Save requires a connection name', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await page.locator('#conn-name').fill('');
      await page.getByRole('button', { name: 'Save connection' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Connection name is required.');
    });

    test('provider presets fill name and base URL', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await page.getByRole('button', { name: 'Groq' }).click();
      await expect(page.locator('#conn-name')).toHaveValue('Groq');
      await expect(page.locator('#conn-base-url')).toHaveValue(/groq/i);
    });

    test('Cancel returns to Screen 3 (Connection Type); Back from Screen 3 returns to Screen 2', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      // Cancel on Screen 4 goes back to Screen 3 (Connection Type picker)
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByTestId('step-connection-type')).toBeVisible();
      // Back on Screen 3 returns to Screen 2 (Connections Hub)
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });

    test('Test Connection button calls test endpoint and shows success status', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await page.getByRole('button', { name: 'OpenAI' }).first().click();
      await page.locator('#conn-api-key').fill('sk-test-key');
      await page.getByRole('button', { name: 'Test Connection' }).click();
      await expect(page.locator('[role="status"]')).toBeVisible({ timeout: 5000 });
    });

    test('Test Connection failure shows error alert', async ({ page }) => {
      await page.route('**/admin/connections/test', (route) => {
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'unauthorized', message: 'Invalid API key. The provider rejected the credentials — double-check the key and try again.' })
          });
        }
        return route.continue();
      });
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await page.getByRole('button', { name: 'OpenAI' }).first().click();
      await page.locator('#conn-api-key').fill('sk-bad-key');
      await page.getByRole('button', { name: 'Test Connection' }).click();
      await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 5000 });
    });

    test('URL ending in /v1 shows warning (non-blocking)', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      // Type a URL ending with /v1 to trigger the duplicate-suffix warning.
      await page.locator('#conn-base-url').fill('https://myproxy.example.com/v1');
      await expect(page.getByText(/including \/v1 in this url may cause errors/i)).toBeVisible();
      // Warning should not block Save (name/key validation still applies)
      await page.locator('#conn-name').fill('My Proxy');
      await page.locator('#conn-api-key').fill('sk-test');
      // Should be able to attempt save (warning is informational, not blocking)
      // Just verify the warning text is there — not an error
      await expect(page.locator('.field-warn')).toBeVisible();
    });

    test('Save adds connection and returns to Screen 2', async ({ page }) => {
      await page.goto('/setup');
      await goToScreen4Cloud(page);
      await page.getByRole('button', { name: 'OpenAI' }).first().click();
      await page.locator('#conn-api-key').fill('sk-test-e2e');
      await page.getByRole('button', { name: 'Save connection' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
      await expect(page.getByText('OpenAI', { exact: true }).first()).toBeVisible();
    });
  });

  // ── Screen 5: Required Models ───────────────────────────────────────────────

  test.describe('Screen 5 — Required Models', () => {
    async function goToScreen5(page: Page) {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-models')).toBeVisible();
    }

    test('shows correct title and both model fields', async ({ page }) => {
      await goToScreen5(page);
      await expect(page.locator('h2')).toHaveText('Required models');
      await expect(page.locator('#system-model')).toBeVisible();
      await expect(page.locator('#embedding-model')).toBeVisible();
      await expect(page.locator('#llm-connection option[value=""]')).toHaveText('Select a chat connection');
      await expect(page.locator('#emb-connection option[value=""]')).toHaveText('Select an embedding connection');
    });

    test('Continue requires chat model', async ({ page }) => {
      await goToScreen5(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Chat model is required.');
    });

    test('Continue requires embedding model', async ({ page }) => {
      await goToScreen5(page);
      await page.locator('#system-model').fill('gpt-4o');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Embedding model is required.');
    });

    test('Continue requires selected model connections', async ({ page }) => {
      await goToScreen5(page);
      await page.locator('#system-model').fill('gpt-4o');
      await page.locator('#embedding-model').fill('text-embedding-3-small');
      await page.locator('#llm-connection').evaluate((element) => {
        const select = element as HTMLSelectElement;
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Select a chat connection before continuing.');
    });

    test('Back returns to Screen 2 (Connections Hub)', async ({ page }) => {
      await goToScreen5(page);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });

    test('Continue with valid models advances to Screen 6', async ({ page }) => {
      await goToScreen5(page);
      await page.locator('#system-model').fill('gpt-4o');
      await page.locator('#embedding-model').fill('text-embedding-3-small');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-optional-addons')).toBeVisible();
    });
  });

  // ── Screen 6: Optional Add-ons ─────────────────────────────────────────────

  test.describe('Screen 6 — Optional Add-ons', () => {
    async function goToScreen6(page: Page) {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-models')).toBeVisible();
      await page.locator('#system-model').fill('gpt-4o');
      await page.locator('#embedding-model').fill('text-embedding-3-small');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-optional-addons')).toBeVisible();
    }

    test('shows correct title and three toggles', async ({ page }) => {
      await goToScreen6(page);
      await expect(page.locator('h2')).toHaveText('Optional add-ons');
      await expect(page.getByLabel('Enable reranking')).toBeVisible();
      await expect(page.getByLabel('Enable text-to-speech')).toBeVisible();
      await expect(page.getByLabel('Enable speech-to-text')).toBeVisible();
    });

    test('Back returns to Screen 5 (Required Models)', async ({ page }) => {
      await goToScreen6(page);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-models')).toBeVisible();
    });

    test('Continue advances to Screen 7 (Review)', async ({ page }) => {
      await goToScreen6(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-review')).toBeVisible();
    });

    test('Enable reranking toggle reveals reranker type field', async ({ page }) => {
      await goToScreen6(page);
      await page.getByLabel('Enable reranking').check();
      // Reranker type options should appear
      await expect(page.getByText(/Use an LLM to rerank/i)).toBeVisible();
    });

    test('Enable text-to-speech toggle reveals TTS fields', async ({ page }) => {
      await goToScreen6(page);
      await page.getByLabel('Enable text-to-speech').check();
      await expect(page.getByText(/Connection/i).first()).toBeVisible();
    });

    test('Enable speech-to-text toggle reveals STT fields', async ({ page }) => {
      await goToScreen6(page);
      await page.getByLabel('Enable speech-to-text').check();
      await expect(page.getByText(/Connection/i).first()).toBeVisible();
    });
  });

  // ── Screen 7: Review & Install ─────────────────────────────────────────────

  test.describe('Screen 7 — Review & Install', () => {
    async function goToScreen7(page: Page) {
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page, { name: 'Test User', email: 'test@example.com', token: 'supersecrettoken' });
      await addRemoteConnection(page, { apiKey: 'sk-test-e2e' });
      await navigateToReview(page);
    }

    test('shows correct title and all review sections', async ({ page }) => {
      await goToScreen7(page);
      await expect(page.locator('h2')).toHaveText('Review your setup');
      await expect(page.getByText('Account', { exact: true })).toBeVisible();
      await expect(page.getByText('Connections', { exact: true })).toBeVisible();
      await expect(page.getByText('Required models', { exact: true })).toBeVisible();
      await expect(page.getByText('Optional add-ons', { exact: true })).toBeVisible();
      await expect(page.getByText('Config Exports', { exact: true })).toBeVisible();
    });

    test('Account section shows entered name, email, and masked token', async ({ page }) => {
      await goToScreen7(page);
      await expect(page.getByText('Test User')).toBeVisible();
      await expect(page.getByText('test@example.com')).toBeVisible();
      // Admin Token row shows "Set" — scope to the review-item that contains the "Admin Token" label
      await expect(
        page.locator('.review-item').filter({ hasText: 'Admin Token' }).locator('.review-value')
      ).toHaveText('Set');
    });

    test('Connections section shows the saved connection', async ({ page }) => {
      await goToScreen7(page);
      await expect(page.getByText('Cloud — OpenAI')).toBeVisible();
      await expect(page.getByText('https://api.openai.com')).toBeVisible();
    });

    test('Required Models section shows chat and embedding models', async ({ page }) => {
      await goToScreen7(page);
      await expect(
        page.locator('.review-item').filter({ hasText: 'Chat Model' }).locator('.review-value')
      ).toContainText('gpt-4o');
      await expect(
        page.locator('.review-item').filter({ hasText: 'Embedding Model' }).locator('.review-value')
      ).toContainText('text-embedding-3-small');
    });

    test('Optional Add-ons section shows "None configured" when skipped', async ({ page }) => {
      await goToScreen7(page);
      await expect(page.getByText('None configured')).toBeVisible();
    });

    test('Account Edit link navigates to Screen 1', async ({ page }) => {
      await goToScreen7(page);
      // Click the Edit button next to ACCOUNT section
      const accountSection = page.locator('.review-section-header').filter({ hasText: 'Account' });
      await accountSection.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('Connections Edit link navigates to Screen 2', async ({ page }) => {
      await goToScreen7(page);
      const connectionsSection = page.locator('.review-section-header').filter({ hasText: 'Connections' });
      await connectionsSection.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByTestId('step-connections-hub')).toBeVisible();
    });

    test('Required Models Edit link navigates to Screen 5', async ({ page }) => {
      await goToScreen7(page);
      const modelsSection = page.locator('.review-section-header').filter({ hasText: 'Required models' });
      await modelsSection.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByTestId('step-models')).toBeVisible();
    });

    test('Optional Add-ons Edit link navigates to Screen 6', async ({ page }) => {
      await goToScreen7(page);
      const addonsSection = page.locator('.review-section-header').filter({ hasText: 'Optional add-ons' });
      await addonsSection.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByTestId('step-optional-addons')).toBeVisible();
    });

    test('Back returns to Screen 6 (Optional Add-ons)', async ({ page }) => {
      await goToScreen7(page);
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByTestId('step-optional-addons')).toBeVisible();
    });

    test('Download opencode.json fires export request and shows no error', async ({ page }) => {
      await goToScreen7(page);
      // Track the request
      const [request] = await Promise.all([
        page.waitForRequest('**/admin/connections/export/opencode'),
        page.getByRole('button', { name: 'Download opencode.json' }).click()
      ]);
      expect(request).toBeTruthy();
      // No export error shown
      await expect(page.getByText('Export error')).not.toBeVisible();
    });

    test('Download mem0-config.json fires export request and shows no error', async ({ page }) => {
      await goToScreen7(page);
      const [request] = await Promise.all([
        page.waitForRequest('**/admin/connections/export/mem0'),
        page.getByRole('button', { name: 'Download mem0-config.json' }).click()
      ]);
      expect(request).toBeTruthy();
      await expect(page.getByText('Export error')).not.toBeVisible();
    });

    test('Export sends x-admin-token header via setup token', async ({ page }) => {
      // Override the export mock to capture the request headers
      let capturedToken = '';
      await page.route('**/admin/connections/export/opencode', (route) => {
        capturedToken = route.request().headers()['x-admin-token'] ?? '';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-disposition': 'attachment; filename="opencode.json"' },
          body: JSON.stringify({ model: 'gpt-4o' })
        });
      });
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page, { token: 'supersecrettoken' });
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Download opencode.json' }).click();
      await page.waitForTimeout(300);
      expect(capturedToken).toBeTruthy();
    });

    test('Export auth failure shows error message', async ({ page }) => {
      // Override export to return 401
      await page.route('**/admin/connections/export/opencode', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Missing or invalid x-admin-token' })
        })
      );
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Download opencode.json' }).click();
      await expect(page.getByText('Missing or invalid x-admin-token')).toBeVisible({ timeout: 3000 });
    });

    test('Save POSTs correct body and advances to deploying screen', async ({ page }) => {
      let postedBody: Record<string, unknown> = {};
      let postedHeaders: Record<string, string> = {};
      await mockDeployReady(page);
      await page.route('**/admin/setup', (route) => {
        if (route.request().method() === 'POST') {
          postedBody = JSON.parse(route.request().postData() ?? '{}');
          postedHeaders = route.request().headers();
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, async: true, started: ['caddy', 'memory'], dockerAvailable: true })
          });
        }
        return route.continue();
      });
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page, { name: 'Alice', email: 'alice@example.com', token: 'my-secure-token' });
      await addRemoteConnection(page, { apiKey: 'sk-test-save' });
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });

      // Validate POST body shape
      expect(postedBody.adminToken).toBe('my-secure-token');
      expect(postedBody.ownerName).toBe('Alice');
      expect(postedBody.ownerEmail).toBe('alice@example.com');
      const connections = postedBody.connections as Array<Record<string, unknown>>;
      expect(Array.isArray(connections)).toBe(true);
      expect(connections.length).toBeGreaterThanOrEqual(1);
      expect(connections[0].provider).toBe('openai');
      expect(connections[0].apiKey).toBe('sk-test-save');
      const assignments = postedBody.assignments as Record<string, Record<string, unknown>>;
      expect(assignments.llm.model).toBe('gpt-4o');
      expect(assignments.embeddings.model).toBe('text-embedding-3-small');
      expect(postedBody.memoryUserId).toBeTruthy();
      expect(postedHeaders['x-admin-token']).toBeTruthy();
    });

    test('Save install error stays on review and shows message', async ({ page }) => {
      await page.route('**/admin/setup', (route) => {
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'config_save_failed', message: 'Failed to update secrets.env: file locked' })
          });
        }
        return route.continue();
      });
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Failed to update secrets.env');
      await expect(page.getByTestId('step-review')).toBeVisible();
    });

    test('Docker unavailable shows error on review screen', async ({ page }) => {
      await page.route('**/admin/setup', (route) => {
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'docker_unavailable', message: 'Docker is not available. Install or start Docker and retry.' })
          });
        }
        return route.continue();
      });
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('[role="alert"]')).toContainText('Docker is not available');
    });

    test('Docker Compose failure shows error on deploying screen', async ({ page }) => {
      await page.route('**/admin/setup', (route) => {
        if (route.request().method() === 'POST') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, async: true, started: ['caddy', 'memory'], dockerAvailable: true })
          });
        }
        return route.continue();
      });
      await page.route('**/admin/setup/deploy-status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            active: true,
            phase: 'error',
            error: 'Docker Compose failed: port 5432 already in use',
            services: [
              { service: 'caddy', label: 'Caddy', imageReady: true, containerRunning: false },
            ]
          })
        })
      );
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[role="alert"]')).toContainText('port 5432 already in use', { timeout: 5000 });
    });

    test('Successful deploy shows Go to Console link', async ({ page }) => {
      await mockDeployReady(page);
      await mockInstallSuccess(page);
      await mockConnectionTest(page);
      await mockExports(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await navigateToReview(page);
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('step-deploying')).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('link', { name: 'Go to Console' })).toBeVisible({ timeout: 10000 });
    });
  });

  // ── Step-dot navigation ────────────────────────────────────────────────────

  test.describe('Step dot navigation', () => {
    test('clicking a completed step dot returns to that screen', async ({ page }) => {
      await mockConnectionTest(page);
      await page.goto('/setup');
      await completeWelcome(page);
      await addRemoteConnection(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByTestId('step-models')).toBeVisible();
      // Click dot 1 (Welcome) to jump back
      await page.getByRole('button', { name: /Step 1/ }).click();
      await expect(page.getByTestId('step-welcome')).toBeVisible();
    });

    test('future step dots are disabled until reached', async ({ page }) => {
      await page.goto('/setup');
      await completeWelcome(page);
      // Step 4 (models) should be disabled — not yet reached
      await expect(page.getByRole('button', { name: /Step 4/ })).toBeDisabled();
    });
  });

  // ── API contract tests ─────────────────────────────────────────────────────

  test.describe('Admin API', () => {
    test('GET /admin/setup is accessible without auth', async ({ page }) => {
      const res = await page.request.get('/admin/setup');
      expect(res.ok()).toBeTruthy();
    });

    test('GET /admin/setup returns boolean flags — never raw secret values', async ({ page }) => {
      const res = await page.request.get('/admin/setup');
      const data = await res.json() as Record<string, unknown>;
      expect(data).toHaveProperty('configured');
      for (const val of Object.values(data.configured as Record<string, unknown>)) {
        expect(typeof val).toBe('boolean');
      }
      expect(data).not.toHaveProperty('adminToken');
      expect(data).not.toHaveProperty('openaiApiKey');
    });

    test('GET /admin/setup returns setupComplete as boolean', async ({ page }) => {
      const res = await page.request.get('/admin/setup');
      const data = await res.json() as Record<string, unknown>;
      expect(typeof data.setupComplete).toBe('boolean');
    });

    test('setup page is accessible when ADMIN_TOKEN is not set', async ({ page }) => {
      await page.goto('/setup');
      await expect(page.locator('h1')).toContainText('OpenPalm Setup Wizard');
    });
  });
});
