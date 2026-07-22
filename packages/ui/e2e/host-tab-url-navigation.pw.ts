import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

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
    const toolbar = page.locator('.surface-toolbar');
    await expect(toolbar.locator('a, button')).toHaveCount(4);
    await expect(toolbar).toHaveCSS('height', '52px');
    await expect(page.getByRole('link', { name: 'Back to chat' })).toHaveCount(0);
    const currentHost = toolbar.getByRole('link', { name: 'Open host console' });
    await expect(currentHost).toHaveAttribute('aria-current', 'page');
    await expect(currentHost).toHaveClass(/selected/);
    await expect(toolbar.getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current', 'page');
    await expect(toolbar.getByRole('link', { name: 'Advanced' })).not.toHaveAttribute('aria-current', 'page');
    await toolbar.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/chat\?session=session-1$/);

    await page.goto(
      `/host?tab=overview&returnTo=${encodeURIComponent('/advanced?session=session-2')}`,
    );
    await expect(page.getByRole('link', { name: 'Advanced' })).not.toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: 'Advanced' }).click();
    await expect(page).toHaveURL(/\/advanced\?session=session-2$/);

    await page.goto('/host?tab=diagnostics');
    await expect(page.getByRole('tab', { name: 'Systems' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.goto(
      `/host?tab=overview&returnTo=${encodeURIComponent('https://evil.example/chat')}`,
    );
    await expect(page.getByRole('link', { name: 'Open host console' })).toHaveAttribute('aria-current', 'page');
  });

  test('uses the same four-action toolbar on device settings', async ({ page }) => {
    await page.goto(
      `/connections?returnTo=${encodeURIComponent('/advanced?session=session-3')}`,
    );

    const toolbar = page.locator('.surface-toolbar');
    await expect(toolbar.locator('a, button')).toHaveCount(4);
    await expect(toolbar).toHaveCSS('height', '52px');
    await expect(toolbar.getByRole('link', { name: 'Advanced' })).not.toHaveAttribute('aria-current', 'page');
    const currentSettings = toolbar.getByRole('link', { name: 'Open settings' });
    await expect(currentSettings).toHaveAttribute('aria-current', 'page');
    await expect(currentSettings).toHaveClass(/selected/);
    await expect(page.getByRole('link', { name: 'Return to conversation' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'General' })).toBeVisible();
    expect((await page.getByRole('tab', { name: 'General' }).boundingBox())?.x).toBe(24);

    await page.setViewportSize({ width: 375, height: 700 });
    await expect(page.getByLabel('Settings page')).toBeVisible();

    await toolbar.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/chat\?session=session-3$/);
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
