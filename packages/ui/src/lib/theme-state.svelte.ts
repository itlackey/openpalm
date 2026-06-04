export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'openpalm.theme';

const THEME_ATTR = 'data-theme';
const DARK_THEME_COLOR = '#161c22';
const LIGHT_THEME_COLOR = '#f9fafb';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

class ThemeService {
  preference = $state<ThemePreference>('system');
  resolved = $state<ResolvedTheme>('light');
  initialized = $state(false);

  #mediaQuery: MediaQueryList | null = null;
  #mediaChangeHandler = () => {
    if (this.preference !== 'system') return;
    this.resolved = this.#resolvePreference('system');
    this.#applyResolvedTheme();
  };

  init(): void {
    if (typeof window === 'undefined' || this.initialized) return;

    this.preference = this.#readStoredPreference();
    this.resolved = this.#resolvePreference(this.preference);
    this.#subscribeToSystemTheme();
    this.#applyResolvedTheme();
    this.initialized = true;
  }

  setPreference(preference: ThemePreference): void {
    this.preference = preference;
    this.resolved = this.#resolvePreference(preference);
    this.#writeStoredPreference(preference);
    this.#applyResolvedTheme();
  }

  toggle(): void {
    this.setPreference(this.resolved === 'dark' ? 'light' : 'dark');
  }

  dispose(): void {
    if (this.#mediaQuery) {
      if (typeof this.#mediaQuery.removeEventListener === 'function') {
        this.#mediaQuery.removeEventListener('change', this.#mediaChangeHandler);
      } else {
        this.#mediaQuery.removeListener(this.#mediaChangeHandler);
      }
    }
    this.#mediaQuery = null;
    this.initialized = false;
  }

  #readStoredPreference(): ThemePreference {
    if (typeof window === 'undefined') return 'system';
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      return isThemePreference(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  }

  #writeStoredPreference(preference: ThemePreference): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore storage failures; the in-memory selection still applies.
    }
  }

  #resolvePreference(preference: ThemePreference): ResolvedTheme {
    if (preference === 'light' || preference === 'dark') return preference;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  #subscribeToSystemTheme(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const nextQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (this.#mediaQuery === nextQuery) return;

    if (this.#mediaQuery) {
      if (typeof this.#mediaQuery.removeEventListener === 'function') {
        this.#mediaQuery.removeEventListener('change', this.#mediaChangeHandler);
      } else {
        this.#mediaQuery.removeListener(this.#mediaChangeHandler);
      }
    }

    this.#mediaQuery = nextQuery;
    if (typeof nextQuery.addEventListener === 'function') {
      nextQuery.addEventListener('change', this.#mediaChangeHandler);
    } else {
      nextQuery.addListener(this.#mediaChangeHandler);
    }
  }

  #applyResolvedTheme(): void {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    root.setAttribute(THEME_ATTR, this.resolved);
    root.style.colorScheme = this.resolved;

    const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.content = this.resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
    }

    const colorSchemeMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (colorSchemeMeta) {
      colorSchemeMeta.content = this.resolved;
    }
  }
}

export const themeService = new ThemeService();

export function resetThemeForTests(): void {
  themeService.dispose();
  themeService.preference = 'system';
  themeService.resolved = 'light';

  if (typeof document !== 'undefined') {
    document.documentElement.removeAttribute(THEME_ATTR);
    document.documentElement.style.colorScheme = '';
  }
}
