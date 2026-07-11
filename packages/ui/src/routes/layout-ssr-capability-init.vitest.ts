/**
 * Review 2026-07-10 K2 — capability-driven chrome (e.g. the /host admin
 * button in Navbar.svelte) initialized only in `onMount`, which never runs
 * during SSR, so the FIRST server-rendered HTML always showed the
 * capability-empty default — a flash of missing chrome on every full/hard
 * load. Pre-migration, the equivalent `featuresService.init(data.features)`
 * ran directly in the script body (`untrack()`-wrapped, not inside
 * `onMount`), so it executed during SSR too.
 *
 * Fix: split server-half init (env-derived, SSR-safe) from client-half init
 * (needs the browser to detect display mode) — the server half now runs in
 * the script body; only the client half stays in onMount.
 *
 * Source-level assertion (the real behavior needs the browser-project
 * vitest, which is unrunnable in this sandbox — chromium headless-shell is
 * unavailable).
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAYOUT_PATH = fileURLToPath(new URL('./+layout.svelte', import.meta.url));

describe('+layout.svelte initializes the server-half runtime context outside onMount (review 2026-07-10 K2)', () => {
  const source = readFileSync(LAYOUT_PATH, 'utf-8');

  test('initializeServerRuntimeContext is called in the script body, not inside onMount', () => {
    const onMountIndex = source.indexOf('onMount(() => {');
    const serverHalfIndex = source.indexOf('initializeServerRuntimeContext(');
    expect(serverHalfIndex, 'initializeServerRuntimeContext must be called').toBeGreaterThan(-1);
    expect(onMountIndex, 'onMount(...) must exist').toBeGreaterThan(-1);
    // The server-half call must appear BEFORE the onMount block starts, i.e.
    // it runs unconditionally at component-init time (SSR-safe), not gated
    // behind the client-only onMount lifecycle hook.
    expect(serverHalfIndex).toBeLessThan(onMountIndex);
  });

  test('the server-half call is untrack()-wrapped (one-time read, not a reactive subscription)', () => {
    expect(source).toMatch(/untrack\(\(\)\s*=>\s*initializeServerRuntimeContext\(/);
  });

  test('the browser-only client half (detectClientDisplayMode) still runs inside onMount', () => {
    const onMountBlock = source.slice(source.indexOf('onMount(() => {'));
    expect(onMountBlock).toMatch(/detectClientDisplayMode\(\)/);
    expect(onMountBlock).toMatch(/initializeRuntimeContext\(/);
  });
});
