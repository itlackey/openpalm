/**
 * G3 [MEDIUM] (review 2026-07-10) — ui-kit's Drawer imported
 * `$lib/actions/focus-trap.js`, an app-provided contract (like
 * theme-state/notifications/error-messages): whichever app's Vite/SvelteKit
 * pipeline compiles Drawer.svelte resolves `$lib` against ITS OWN
 * `src/lib`, so the import only works for an app that happens to ship a
 * `src/lib/actions/focus-trap.js` of its own. packages/ui does; packages/client
 * does not — so the kit's only accessible-dialog primitive was unusable from
 * the client, which also blocked the B14 small-screen sessions drawer.
 *
 * Fix: promote focus-trap into ui-kit as a REAL export — a kit-internal
 * module at `src/lib/actions/focus-trap.ts`, referenced from Drawer.svelte by
 * a relative import (not `$lib`), and exposed to consumers via a
 * `./actions/*` package.json subpath (mirroring the existing
 * `./components/*` / `./theme/*` pattern) so `@openpalm/ui-kit/actions/
 * focus-trap.js` resolves from ANY consuming app, including packages/client.
 *
 * Source-level test (reads files, not a rendered DOM) — the invariant is
 * about the module graph / package contract, and Drawer's actual focus
 * behavior already has full browser-test coverage in
 * Drawer.svelte.vitest.ts.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PKG_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const DRAWER_SVELTE = fileURLToPath(
  new URL('../src/lib/components/common/Drawer.svelte', import.meta.url)
);
const FOCUS_TRAP_TS = fileURLToPath(new URL('../src/lib/actions/focus-trap.ts', import.meta.url));

describe('G3 — focus-trap is a real ui-kit export, not an app-provided $lib contract', () => {
  test('package.json exposes an ./actions/* subpath export', () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf-8')) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports?.['./actions/*']).toBeDefined();
  });

  test('src/lib/actions/focus-trap.ts exists inside ui-kit (kit-internal, not app-provided)', () => {
    expect(existsSync(FOCUS_TRAP_TS)).toBe(true);
  });

  test('the kit-internal focus-trap module exports createFocusTrap and handleTrapKeydown', async () => {
    expect(existsSync(FOCUS_TRAP_TS)).toBe(true);
    const mod = (await import(FOCUS_TRAP_TS)) as Record<string, unknown>;
    expect(typeof mod.createFocusTrap).toBe('function');
    expect(typeof mod.handleTrapKeydown).toBe('function');
  });

  test('Drawer.svelte no longer imports the app-provided $lib/actions/focus-trap.js contract', () => {
    const src = readFileSync(DRAWER_SVELTE, 'utf-8');
    expect(src).not.toMatch(/\$lib\/actions\/focus-trap/);
  });

  test('Drawer.svelte imports focus-trap from within the kit (relative import)', () => {
    const src = readFileSync(DRAWER_SVELTE, 'utf-8');
    expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/actions\/focus-trap\.js['"]/);
  });
});
