import { expect, test } from '@playwright/test';

const HYDRATION_FAILURE = /hydration_mismatch|Failed to hydrate|HierarchyRequestError/i;

test('public and authenticated routes hydrate without structural failures', async ({ page }) => {
  const failures: string[] = [];

  page.on('console', (message) => {
    if (HYDRATION_FAILURE.test(message.text())) failures.push(message.text());
  });
  page.on('pageerror', (error) => {
    const text = error.stack ?? error.message;
    if (HYDRATION_FAILURE.test(text)) failures.push(text);
  });

  async function load(path: string): Promise<void> {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), path).toBeLessThan(400);
    await page.waitForTimeout(100);
  }

  await load('/login');

  const login = await page.request.post('/api/auth/login', {
    data: { password: process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password' },
  });
  expect(login.ok()).toBe(true);

  await load('/chat');
  await load('/advanced');
  await load('/connections');
  await load('/host');

  const logout = await page.request.post('/api/auth/logout');
  expect(logout.ok()).toBe(true);
  await load('/login');

  expect(failures).toEqual([]);
});
