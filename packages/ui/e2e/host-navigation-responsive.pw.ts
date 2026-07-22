import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { password: process.env.OP_UI_LOGIN_PASSWORD ?? 'e2e-mocked-password' },
  });
  expect(response.ok()).toBe(true);
}

test.describe('host navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('reflows into one complete mobile navigator at 320px and 375px', async ({ page }) => {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/host');

      const mobileNavigation = page.getByRole('combobox', { name: 'Admin page' });
      await expect(mobileNavigation).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Sections' })).toBeHidden();
      await expect(page.getByRole('tablist', { name: 'Health tabs' })).toBeHidden();

      const box = await mobileNavigation.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? width) + (box?.width ?? 1)).toBeLessThanOrEqual(width);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      await expect(mobileNavigation.locator('option')).toHaveCount(13);
    }

    const mobileNavigation = page.getByRole('combobox', { name: 'Admin page' });
    await mobileNavigation.selectOption('host-sharing');
    await expect(mobileNavigation).toHaveValue('host-sharing');
  });

  test('keeps desktop tabs keyboard operable with roving focus and 44px targets', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto('/host');

    const sections = page.getByRole('tablist', { name: 'Sections' });
    const health = sections.getByRole('tab', { name: 'Health' });
    const mind = sections.getByRole('tab', { name: 'Mind', exact: true });

    await expect(health).toHaveAttribute('aria-selected', 'true');
    await expect(health).toHaveAttribute('tabindex', '0');
    await expect(mind).toHaveAttribute('tabindex', '-1');
    expect((await health.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await health.focus();
    await health.press('ArrowRight');
    await expect(mind).toBeFocused();
    await expect(mind).toHaveAttribute('aria-selected', 'false');
    await expect
      .poll(() => mind.evaluate((element) => getComputedStyle(element).outlineStyle))
      .toBe('solid');

    await mind.press('Enter');
    await expect(mind).toHaveAttribute('aria-selected', 'true');

    await mind.press('ArrowLeft');
    await expect(health).toBeFocused();
    await health.press('Enter');

    const healthTabs = page.getByRole('tablist', { name: 'Health tabs' });
    const overview = healthTabs.getByRole('tab', { name: 'Overview' });
    const activity = healthTabs.getByRole('tab', { name: 'Activity' });
    await expect(overview).toHaveAttribute('tabindex', '0');
    await expect(activity).toHaveAttribute('tabindex', '-1');

    await overview.focus();
    await overview.press('ArrowRight');
    await expect(activity).toBeFocused();
    await expect(activity).toHaveAttribute('aria-selected', 'false');
    await activity.press('Enter');
    await expect(activity).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps desktop navigation within the viewport above the mobile breakpoint', async ({ page }) => {
    for (const width of [641, 700, 720]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/host');

      await expect(page.getByRole('tablist', { name: 'Sections' })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Health tabs' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
});
