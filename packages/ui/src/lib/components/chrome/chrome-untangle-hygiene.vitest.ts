/**
 * Phase 3 hygiene — the admin-surface chrome must not import chat
 * components/stores (issue #555: "Navbar must stop importing chat components/stores into the admin
 * surface — split chrome so admin surface uses a chrome without chat state;
 * chat surface gets its own chrome composition").
 *
 * RED until Phase 3 lands: the admin surface (routes/admin/+page.svelte)
 * mounts chrome/Navbar.svelte, which imports EndpointSwitcher, SessionPicker
 * and VoiceControl from $lib/components/chat/ plus $lib/chat/navigation.js.
 *
 * Source-level test, same rationale as endpoints-state-hygiene.vitest.ts:
 * the invariant is about the module graph — after the Phase 5 extraction the
 * admin surface must not drag chat modules into the host bundle, so the
 * coupling has to be gone BEFORE the move. The test follows the files rather
 * than pinning names: it resolves whichever module(s) under
 * $lib/components/chrome/ the admin surface imports (routes/admin today,
 * routes/host after Phase 4; +page.svelte or +layout.svelte) and inspects
 * THOSE modules' import specifiers. Type-only imports count too.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Admin-surface entry files, in both pre- and post-Phase-4 locations. */
const ADMIN_SURFACE_CANDIDATES = [
  'routes/admin/+layout.svelte',
  'routes/admin/+page.svelte',
  'routes/host/+layout.svelte',
  'routes/host/+page.svelte',
] as const;

function adminSurfaceFiles(): string[] {
  return ADMIN_SURFACE_CANDIDATES.map((rel) => join(SRC_ROOT, rel)).filter((abs) =>
    existsSync(abs),
  );
}

/** Collect every static, side-effect, re-export, and dynamic import specifier. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // import ... from '...'; / export ... from '...'; (incl. `import type`)
    /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    // side-effect import: import '...';
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    // dynamic import: import('...')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Resolve a $lib/ or relative specifier to an absolute file path. */
function resolveImportPath(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('$lib/')) return join(SRC_ROOT, 'lib', specifier.slice('$lib/'.length));
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  return null;
}

function isChromeSpecifier(specifier: string): boolean {
  return specifier.includes('components/chrome/') && specifier.endsWith('.svelte');
}

/** True for chat state or anything under a chat/ module directory —
 *  $lib/chat/* (stores/navigation) and $lib/components/chat/* alike. */
function isChatModuleSpecifier(specifier: string): boolean {
  return /chat-state/.test(specifier) || /(?:^|\/)chat\//.test(specifier);
}

/** The chrome modules the admin surface actually mounts. */
function adminChromeModules(): string[] {
  const files = new Set<string>();
  for (const surfaceFile of adminSurfaceFiles()) {
    const source = readFileSync(surfaceFile, 'utf-8');
    for (const specifier of importSpecifiers(source).filter(isChromeSpecifier)) {
      const abs = resolveImportPath(surfaceFile, specifier);
      if (abs && existsSync(abs)) files.add(abs);
    }
  }
  return [...files];
}

describe('admin-surface chrome ↔ chat untangling (#555)', () => {
  test('the admin surface exists and mounts a chrome module from $lib/components/chrome/', () => {
    // CHARACTERIZATION (green today): guards the resolver — if the admin
    // surface stopped importing any chrome module, the hygiene assertion
    // below would pass vacuously.
    expect(adminSurfaceFiles().length).toBeGreaterThan(0);
    expect(adminChromeModules().length).toBeGreaterThan(0);
  });

  test('the admin-surface chrome imports no chat components or chat stores', () => {
    const offenders: string[] = [];
    for (const chromeFile of adminChromeModules()) {
      const source = readFileSync(chromeFile, 'utf-8');
      for (const specifier of importSpecifiers(source).filter(isChatModuleSpecifier)) {
        offenders.push(`${basename(chromeFile)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
