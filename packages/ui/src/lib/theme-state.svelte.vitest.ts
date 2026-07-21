import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetThemeForTests, themeService, THEME_STORAGE_KEY } from './theme-state.svelte.js';

describe('theme-state', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.localStorage.clear();
    document.head.innerHTML = `
      <meta name="theme-color" content="#E5E1D5">
      <meta name="color-scheme" content="light">
    `;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    resetThemeForTests();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  test('init applies persisted dark preference on load', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    themeService.init();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#15181B');
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark');
  });

  test('setPreference persists the choice', () => {
    themeService.init();

    themeService.setPreference('dark');

    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(themeService.preference).toBe('dark');
    expect(themeService.resolved).toBe('dark');
  });

  test('system preference resolves from matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    themeService.init();

    expect(themeService.preference).toBe('system');
    expect(themeService.resolved).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
