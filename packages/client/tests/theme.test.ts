/**
 * B16 [LOW->MEDIUM] (review 2026-07-10 §B16) — theme resolution/toggle pure
 * logic. `app.html`'s boot script is a one-shot IIFE with no live
 * `prefers-color-scheme` subscription and the layout has no manual toggle.
 * This pins the pure resolve/cycle logic the layout's toggle button and the
 * (separately pinned) app.html boot-script listener both build on.
 *
 * RED until packages/client/src/lib/theme.ts exists.
 */
import { describe, expect, test } from 'bun:test';

async function loadThemeModule() {
  return import('../src/lib/theme.ts');
}

describe('isThemePreference', () => {
  test('accepts light/dark/system, rejects anything else', async () => {
    const { isThemePreference } = await loadThemeModule();
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

describe('resolvePreference', () => {
  test('light/dark preferences resolve to themselves regardless of the system', async () => {
    const { resolvePreference } = await loadThemeModule();
    expect(resolvePreference('light', true)).toBe('light');
    expect(resolvePreference('dark', false)).toBe('dark');
  });

  test('"system" resolves from the OS preference', async () => {
    const { resolvePreference } = await loadThemeModule();
    expect(resolvePreference('system', true)).toBe('dark');
    expect(resolvePreference('system', false)).toBe('light');
  });
});

describe('nextPreference — manual toggle cycle', () => {
  test('cycles system -> light -> dark -> system', async () => {
    const { nextPreference } = await loadThemeModule();
    expect(nextPreference('system')).toBe('light');
    expect(nextPreference('light')).toBe('dark');
    expect(nextPreference('dark')).toBe('system');
  });
});

describe('themeColorFor', () => {
  test('maps resolved theme to the matching <meta theme-color> value', async () => {
    const { themeColorFor } = await loadThemeModule();
    expect(themeColorFor('dark')).toBe('#161c22');
    expect(themeColorFor('light')).toBe('#f9fafb');
  });
});
