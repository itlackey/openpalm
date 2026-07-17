import { expect, test, type Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { password: process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password' },
  });
  expect(response.ok()).toBe(true);
}

test.describe('host tab URL navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens direct and diagnostics links without losing chat return context', async ({ page }) => {
    await page.goto(
      `/host?tab=recovery&returnTo=${encodeURIComponent('/chat?session=session-1')}`,
    );

    await expect(page.getByRole('tab', { name: 'Recovery' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('link', { name: 'Back to chat' })).toHaveAttribute(
      'href',
      '/chat?session=session-1',
    );

    await page.goto('/host?tab=diagnostics');
    await expect(page.getByRole('tab', { name: 'Systems' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.goto(
      `/host?tab=overview&returnTo=${encodeURIComponent('https://evil.example/chat')}`,
    );
    await expect(page.getByRole('link', { name: 'Back to chat' })).toHaveAttribute('href', '/chat');
  });

  test('updates tabs without reload and restores them with Back and Forward', async ({ page }) => {
    let loadCount = 0;
    page.on('load', () => {
      loadCount += 1;
    });

    await page.goto(
      `/host?tab=overview&returnTo=${encodeURIComponent('/chat?session=session-1')}`,
    );
    const initialLoadCount = loadCount;

    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('activity');
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/chat?session=session-1');

    await page.getByRole('tab', { name: 'Systems' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('containers');

    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('activity');
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.goForward();
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('containers');
    await expect(page.getByRole('tab', { name: 'Systems' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(loadCount).toBe(initialLoadCount);
  });
});
