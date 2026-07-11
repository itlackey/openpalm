/**
 * B16 [LOW->MEDIUM] (review 2026-07-10 §B16) — app.html's theme boot script
 * is a one-shot IIFE: OS-scheduled dark-mode changes (sunset auto-switch)
 * are ignored mid-session because it never subscribes to
 * `matchMedia('(prefers-color-scheme: dark)')`. This test extracts the raw
 * inline `<script>` from app.html and executes it in a small hand-rolled DOM
 * sandbox (packages/client's bun:test harness has no real DOM/jsdom), then
 * drives a simulated OS theme change through the captured `matchMedia`
 * listener and asserts the applied theme actually updates live.
 *
 * app.html cannot import a bundled TS module (it runs before Svelte
 * hydrates, straight off the static HTML shell) — this is a source-level
 * "pin" test for that reason, executing the real script text rather than a
 * ported reimplementation, so it can't drift from what ships.
 *
 * RED until app.html's boot script grows a matchMedia change listener.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_HTML_PATH = fileURLToPath(new URL('../src/app.html', import.meta.url));

/** Extract the inline theme-boot <script>...</script> body (no `src`/type=module attr). */
function extractBootScript(): string {
  const html = readFileSync(APP_HTML_PATH, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('app.html: no inline <script> block found');
  return match[1];
}

type FakeMeta = { attrs: Map<string, string>; setAttribute(name: string, value: string): void };

function fakeMeta(name: string, initialContent: string): FakeMeta {
  const attrs = new Map([['name', name], ['content', initialContent]]);
  return {
    attrs,
    setAttribute(attrName: string, value: string) {
      attrs.set(attrName, value);
    },
  };
}

type MediaQueryStub = {
  matches: boolean;
  addEventListener(type: 'change', cb: () => void): void;
  fireChange(): void;
};

function fakeMediaQuery(initialMatches: boolean): MediaQueryStub {
  let listener: (() => void) | null = null;
  return {
    matches: initialMatches,
    addEventListener(_type, cb) {
      listener = cb;
    },
    fireChange() {
      listener?.();
    },
  };
}

/** Build a minimal window/document/localStorage sandbox and run the boot script in it. */
function runBootScript(options: { stored: string | null; systemPrefersDark: boolean }) {
  const store = new Map<string, string>();
  if (options.stored !== null) store.set('openpalm.theme', options.stored);

  const themeColorMeta = fakeMeta('theme-color', '#ffffff');
  const colorSchemeMeta = fakeMeta('color-scheme', 'light');
  const root = { attrs: new Map<string, string>(), style: { colorScheme: '' } };

  const media = fakeMediaQuery(options.systemPrefersDark);

  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    matchMedia: (query: string) => {
      if (query !== '(prefers-color-scheme: dark)') throw new Error(`unexpected query: ${query}`);
      return media;
    },
  };

  const fakeDocument = {
    documentElement: {
      setAttribute: (n: string, v: string) => root.attrs.set(n, v),
      getAttribute: (n: string) => root.attrs.get(n) ?? null,
      style: root.style,
    },
    querySelector: (selector: string) => {
      if (selector.includes('theme-color')) return themeColorMeta;
      if (selector.includes('color-scheme')) return colorSchemeMeta;
      return null;
    },
  };

  const script = extractBootScript();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the real app.html boot script text against a sandboxed window/document, not arbitrary input
  const fn = new Function('window', 'document', script);
  fn(fakeWindow, fakeDocument);

  return { root, themeColorMeta, colorSchemeMeta, media };
}

describe('app.html theme boot — initial resolve (unchanged behavior)', () => {
  test('resolves "system" from the OS preference at boot', () => {
    const { root, themeColorMeta } = runBootScript({ stored: null, systemPrefersDark: true });
    expect(root.attrs.get('data-theme')).toBe('dark');
    expect(themeColorMeta.attrs.get('content')).toBe('#161c22');
  });

  test('an explicit stored preference wins over the system', () => {
    const { root } = runBootScript({ stored: 'light', systemPrefersDark: true });
    expect(root.attrs.get('data-theme')).toBe('light');
  });
});

describe('app.html theme boot — live system-theme subscription (B16)', () => {
  test('a mid-session OS dark-mode change re-applies the theme when preference is "system"', () => {
    const { root, media, themeColorMeta, colorSchemeMeta } = runBootScript({
      stored: 'system',
      systemPrefersDark: false,
    });
    expect(root.attrs.get('data-theme')).toBe('light');

    // OS flips to dark mid-session (e.g. a sunset auto-switch) — simulate the
    // matchMedia 'change' event the boot script must now be listening for.
    media.matches = true;
    media.fireChange();

    expect(root.attrs.get('data-theme')).toBe('dark');
    expect(themeColorMeta.attrs.get('content')).toBe('#161c22');
    expect(colorSchemeMeta.attrs.get('content')).toBe('dark');
  });

  test('an explicit (non-system) stored preference is NOT overridden by an OS change', () => {
    const { root, media } = runBootScript({ stored: 'dark', systemPrefersDark: false });
    expect(root.attrs.get('data-theme')).toBe('dark');

    media.matches = false; // OS goes light — must not affect an explicit 'dark' choice
    media.fireChange();

    expect(root.attrs.get('data-theme')).toBe('dark');
  });
});
