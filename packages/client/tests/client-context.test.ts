/**
 * #511 (D8 consumer) — packages/client/src/lib/client-context.ts:
 * detectClientDisplayMode(). A 5-line twin of packages/ui/src/lib/client-context.ts
 * (packages/client never imports packages/ui — purity gate), used by the
 * layout to stamp `document.documentElement.dataset.displayMode` and by the
 * connections page to gate the "install as an app" hint.
 *
 * Idiom: Object.defineProperty stubbing of window/navigator (pwa-config.test.ts
 * withLocationOrigin).
 *
 * RED reason (every test): packages/client/src/lib/client-context.ts does not
 * exist yet — the dynamic import fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';

async function loadClientContextModule() {
  return import('../src/lib/client-context.ts');
}

const originalWindow = (globalThis as { window?: unknown }).window;
const originalNavigator = globalThis.navigator;

function stubWindow(matchMediaMatches: boolean): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes('standalone') ? matchMediaMatches : false,
      }),
    },
  });
}

function stubNavigator(userAgent: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent },
  });
}

function clearGlobals(): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
});

describe('detectClientDisplayMode (#511)', () => {
  test("resolves 'standalone-pwa' when matchMedia display-mode: standalone matches", async () => {
    const { detectClientDisplayMode } = await loadClientContextModule();
    stubWindow(true);
    stubNavigator('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120');
    expect(detectClientDisplayMode()).toBe('standalone-pwa');
  });

  test("resolves 'electron' when the user agent contains Electron (checked before matchMedia)", async () => {
    const { detectClientDisplayMode } = await loadClientContextModule();
    stubWindow(true); // even if matchMedia would say standalone, Electron wins
    stubNavigator('Mozilla/5.0 OpenPalm/1.0.0 Chrome/120 Electron/30.0.0 Safari/537.36');
    expect(detectClientDisplayMode()).toBe('electron');
  });

  test("resolves 'browser' otherwise", async () => {
    const { detectClientDisplayMode } = await loadClientContextModule();
    stubWindow(false);
    stubNavigator('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15');
    expect(detectClientDisplayMode()).toBe('browser');
  });

  test("resolves 'browser' when window/navigator are undefined (SSR/prerender safety), never throws", async () => {
    const { detectClientDisplayMode } = await loadClientContextModule();
    clearGlobals();
    expect(() => detectClientDisplayMode()).not.toThrow();
    expect(detectClientDisplayMode()).toBe('browser');
  });
});
