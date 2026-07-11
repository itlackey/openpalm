/**
 * Pure theme resolve/cycle logic (review 2026-07-10 §B16), shared by the
 * layout's manual toggle button and mirrored (necessarily duplicated — see
 * app.html's own copy of these constants below) by the pre-hydration boot
 * script in app.html, which cannot import a bundled module: it must apply
 * data-theme before Svelte hydrates, to avoid a flash of the wrong theme.
 *
 * Same storage key and dark/light theme-color values as the host app
 * (`packages/ui/src/lib/theme-state.svelte.ts`), so a browser that uses both
 * surfaces stays on one theme.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'openpalm.theme';

const DARK_THEME_COLOR = '#161c22';
const LIGHT_THEME_COLOR = '#f9fafb';

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Resolve a stored preference to a concrete theme, given the OS's current dark-mode state. */
export function resolvePreference(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

/** Manual toggle cycle: system -> light -> dark -> system. */
export function nextPreference(current: ThemePreference): ThemePreference {
  if (current === 'system') return 'light';
  if (current === 'light') return 'dark';
  return 'system';
}

/** `<meta name="theme-color">` content for a resolved theme. */
export function themeColorFor(resolved: ResolvedTheme): string {
  return resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}
