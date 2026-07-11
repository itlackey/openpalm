/**
 * F7 (review 2026-07-11, UI half) — source "pin" test for +layout.svelte's
 * desktop-notify toggle. The pure logic (`toggleDesktopNotify()`) is
 * unit-tested separately in desktop-notifications-review-fixes.test.ts; this
 * pins that the component actually wires a REACHABLE control to it (same
 * house pattern as layout-markup.test.ts for the theme toggle/reset-cache
 * button).
 *
 * RED until +layout.svelte renders a notify-toggle button wired to
 * toggleDesktopNotify()/desktopNotifyEnabled().
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT_PATH = fileURLToPath(new URL('../src/routes/+layout.svelte', import.meta.url));

function source(): string {
  return readFileSync(LAYOUT_PATH, 'utf8');
}

describe('+layout.svelte — F7 desktop-notify toggle', () => {
  test('imports the toggle logic and the enabled-reader from the desktop-notifications module', () => {
    const src = source();
    expect(src).toContain("from '$lib/desktop-notifications.js'");
    expect(src).toContain('toggleDesktopNotify');
    expect(src).toContain('desktopNotifyEnabled');
  });

  test('renders a reachable button wired to the toggle, with an aria-pressed state', () => {
    const src = source();
    expect(src).toMatch(/aria-pressed=\{/);
    // The onclick handler may call toggleDesktopNotify() directly or through
    // a thin wrapper (e.g. handleToggleDesktopNotify) that itself calls it —
    // either way, an onclick must exist that ultimately reaches it.
    expect(src).toMatch(/onclick=\{[A-Za-z0-9_]*ToggleDesktopNotify\}/);
    expect(src).toMatch(/toggleDesktopNotify\(/);
  });

  test('reads the initial preference on mount so the control reflects stored state', () => {
    const src = source();
    expect(src).toMatch(/desktopNotifyEnabled\(\)/);
  });
});
