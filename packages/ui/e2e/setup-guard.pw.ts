/**
 * Completed-setup guard contract against playwright.config.ts's isolated,
 * setup-complete OP_HOME. Genuine pre-setup browser coverage remains in
 * setup-wizard-browser.stack.ts, whose fixture deliberately clears and restores
 * the setup marker around its tests.
 */
import { expect, test } from './fixtures.js';

const PASSWORD = 'e2e-mocked-password';

test.describe('Setup guard after setup is complete (mocked-lib)', () => {
  test('unauthenticated setup rerun redirects to login with its destination intact', async ({ page }) => {
    await page.goto('/setup?rerun=1');
    await expect(page).toHaveURL('/login?redirectTo=%2Fsetup%3Frerun%3D1');
    await expect(page).toHaveTitle(/Sign in/);
  });

  test('authenticated setup rerun loads the real wizard', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { password: PASSWORD } });
    expect(login.status()).toBe(200);

    await page.route('**/api/setup/system-check', (route) =>
      route.fulfill({
        json: {
          ok: true,
          docker: { ok: false, error: 'docker unavailable in mocked E2E' },
          compose: { ok: false, error: 'compose unavailable in mocked E2E' },
          portCheckReliable: false,
          ports: [],
          platform: 'linux',
        },
      }),
    );
    await page.goto('/setup?rerun=1');

    await expect(page).toHaveURL('/setup?rerun=1');
    await expect(page).toHaveTitle('OpenPalm Setup');
    await expect(page.getByText('Updating existing installation')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'System Check' })).toBeVisible();
  });

  test('completed setup protects setup APIs with a JSON 401', async ({ request }) => {
    const response = await request.get('/api/setup/system-check');
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('setup status stays public and reports the completed fixture', async ({ request }) => {
    const response = await request.get('/api/setup/status');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, setupComplete: true });
  });
});
