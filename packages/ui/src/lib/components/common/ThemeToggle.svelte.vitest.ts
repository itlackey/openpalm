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

  test('cycles system → light → dark and is keyboard operable', async () => {
    render(ThemeToggle);

    const toggle = page.getByRole('button', { name: /theme:/i });
    await expect.element(toggle).toBeVisible();
    await userEvent.keyboard('{Tab}');
    await expect.element(toggle).toHaveFocus();

    // system → light
    await userEvent.keyboard('{Enter}');
    expect(themeService.preference).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // light → dark
    await userEvent.keyboard('{Enter}');
    expect(themeService.preference).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
