/**
 * Phase 3 hygiene — no component reads `features.admin` (plan
 * ui-runtime-modes-plan.md Phase 3 step 3, §8.6: "hasCapability(cap) is the
 * only check components call. No `if (features.admin)` anywhere").
 *
 * RED until Phase 3 lands: chrome/Navbar.svelte still branches on
 * `featuresService.admin`.
 *
 * Source-level test (scans every .svelte file under src/ for the read
 * pattern) because the invariant is about where capability logic lives, not
 * runtime behavior: components must consult runtimeContext.routes +
 * hasCapability() so that adding a capability rule stays a one-function
 * change (plan §11). The legacy alias may survive Phase 3 only in
 * hooks.server.ts (computeFeatureFlags) pending Phase 4 — that is server
 * code, deliberately outside this scan.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

function svelteFiles(): string[] {
  return (readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .filter((rel) => rel.endsWith('.svelte'))
    .map((rel) => join(SRC_ROOT, rel));
}

/** Matches reads of the legacy admin flag: `features.admin`,
 *  `featuresService.admin`, `data.features.admin`, optional-chained forms. */
const FEATURES_ADMIN_READ = /\bfeatures(?:Service)?\??\.admin\b/;

describe('no features.admin reads in .svelte components (plan §8.6, Phase 3 step 3)', () => {
  test('the scan sees the component tree (sanity)', () => {
    // Guards the walker itself: if this ever returns [], the hygiene
    // assertion below would pass vacuously.
    expect(svelteFiles().length).toBeGreaterThan(50);
  });

  test('no .svelte file reads features.admin / featuresService.admin', () => {
    const offenders: string[] = [];
    for (const file of svelteFiles()) {
      const source = readFileSync(file, 'utf-8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (FEATURES_ADMIN_READ.test(lines[i])) {
          offenders.push(`${file.slice(SRC_ROOT.length)}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
