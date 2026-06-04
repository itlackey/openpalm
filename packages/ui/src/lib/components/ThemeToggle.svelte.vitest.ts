import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';
import ThemeToggle from './ThemeToggle.svelte';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

describe('ThemeToggle', () => {
  beforeEach(() => {
    resetThemeForTests();
    themeService.init();
  });

  afterEach(() => {
    resetThemeForTests();
  });

  test('is keyboard operable', async () => {
    render(ThemeToggle);

    const toggle = page.getByRole('button', { name: /switch to dark mode/i });
    await expect.element(toggle).toBeVisible();
    await userEvent.keyboard('{Tab}');
    await expect.element(toggle).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
