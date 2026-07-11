/**
 * Review 2026-07-10 K2 — AkmTab captured `hostMaintenance` as a plain
 * `const` at component-init time (`hasCapability('host:containers')`
 * evaluated once), so it never updated if `runtimeContext.effectiveCapabilities`
 * changed after mount (e.g. the K2 server-half init landing later in the
 * same tick, or a future capability re-resolution) — latent staleness.
 *
 * Fix: `$derived` re-reads `hasCapability()` on every runtimeContext change.
 *
 * Source-level assertion (a real reactivity test needs the browser-project
 * vitest, unrunnable here — chromium headless-shell unavailable).
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AKM_TAB_PATH = fileURLToPath(new URL('./AkmTab.svelte', import.meta.url));

describe('AkmTab hostMaintenance is reactive (review 2026-07-10 K2)', () => {
  const source = readFileSync(AKM_TAB_PATH, 'utf-8');

  test("hostMaintenance is declared with $derived, not a plain const", () => {
    expect(source).toMatch(/const hostMaintenance = \$derived\(hasCapability\('host:containers'\)\)/);
  });

  test('the stale plain-const form is gone', () => {
    expect(source).not.toMatch(/const hostMaintenance = hasCapability\('host:containers'\);/);
  });
});
