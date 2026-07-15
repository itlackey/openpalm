/**
 * A2 [HIGH] (client half) + B16 [LOW->MEDIUM] (review 2026-07-10) — source
 * "pin" test for `+layout.svelte`'s markup wiring. packages/client has no
 * component-render test harness (bun:test only, no vitest-browser-svelte),
 * so behavioral logic for these two findings is unit-tested separately
 * (tests/host-link.test.ts, tests/theme.test.ts, tests/theme-boot.test.ts)
 * and this file pins that the component actually wires that logic into the
 * template rather than leaving it dead code.
 *
 * RED until +layout.svelte renders the conditional host link and the theme
 * toggle button.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT_PATH = fileURLToPath(new URL('../src/routes/+layout.svelte', import.meta.url));

function source(): string {
  return readFileSync(LAYOUT_PATH, 'utf8');
}

describe('+layout.svelte — A2 host link', () => {
  test('renders a host-UI link only when hostUrl is present, opened in a new tab', () => {
    const src = source();
    expect(src).toMatch(/\{#if hostUrl\}/);
    expect(src).toMatch(/target="_blank"/);
    expect(src).toMatch(/rel="noopener noreferrer"/);
  });

  test('reads hostUrl from getClientBoot()', () => {
    const src = source();
    expect(src).toContain('getClientBoot');
    expect(src).toMatch(/hostUrl\s*=\s*boot\.hostUrl/);
  });
});

describe('+layout.svelte — B16 manual theme toggle', () => {
  test('has a theme toggle button wired to the shared theme module', () => {
    const src = source();
    expect(src).toContain('theme-toggle');
    expect(src).toContain("from '$lib/theme.js'");
    expect(src).toMatch(/onclick=\{toggleTheme\}/);
  });

  test('writes the same storage key the app.html boot script reads', () => {
    const src = source();
    expect(src).toContain('THEME_STORAGE_KEY');
  });
});

describe('+layout.svelte — H3 reset app cache', () => {
  test('renders a reset-app-cache action wired to the resetAppCache module', () => {
    const src = source();
    expect(src).toContain("from '$lib/reset-app-cache.js'");
    expect(src).toMatch(/onclick=\{handleResetAppCache\}/);
  });
});

describe('+layout.svelte — client mode navigation', () => {
  test('offers Chat and Advanced links that preserve the current session query', () => {
    const src = source();
    expect(src).toContain('buildChatPath(sessionId)');
    expect(src).toContain('buildAdvancedPath(sessionId)');
    expect(src).toContain('chatRouteState.sessionId');
    expect(src).toMatch(/<span>Advanced<\/span>/);
  });

  test('mode anchors retain native modifier-click behavior', () => {
    const src = source();
    expect(src).not.toContain('navigateToAdvanced');
    expect(src).not.toContain('navigateToChat');
    expect(src).not.toContain('event.preventDefault()');
    expect(src).not.toMatch(/href=\{advancedHref\}[^>]*onclick=/);
  });
});
