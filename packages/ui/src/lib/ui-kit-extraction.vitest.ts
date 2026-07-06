/**
 * P5a (#555) acceptance — components/common and components/icons move out of
 * packages/ui into the @openpalm/ui-kit workspace package (plan
 * ui-runtime-modes-plan.md §6.11 + Phase 5 step 1: "Create packages/ui-kit
 * (raw-source workspace package); move components/common/, icons/, theme
 * tokens"; §9 change map: "packages/ui/src/lib/components/{common,icons} →
 * Move to packages/ui-kit").
 *
 * RED until P5a lands:
 *   - src/lib/components/{common,icons} still exist here,
 *   - ui source still imports $lib/components/{common,icons},
 *   - nothing imports @openpalm/ui-kit yet.
 *
 * Source-level test (checks directories and import specifiers) because the
 * acceptance is about the module graph, not runtime behavior: the move is
 * "pure file moves + import rewrites; zero behavior change", so the only
 * observable contract is WHERE the shared components live and HOW ui
 * reaches them.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
const COMMON_DIR = join(SRC_ROOT, 'lib', 'components', 'common');
const ICONS_DIR = join(SRC_ROOT, 'lib', 'components', 'icons');

/** Every scannable source file under packages/ui/src. */
function sourceFiles(): string[] {
  return (readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .filter((rel) => /\.(svelte|ts|js)$/.test(rel))
    .map((rel) => join(SRC_ROOT, rel));
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
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * True when the specifier still reaches into the OLD in-app location — either
 * via the $lib alias or via a relative path that resolves under
 * src/lib/components/{common,icons}. Specifiers into @openpalm/ui-kit (the
 * NEW location) deliberately do not match, even when they contain
 * "components/common" as a subpath.
 */
function targetsOldLocation(specifier: string, importingFile: string): boolean {
  if (/^\$lib\/components\/(common|icons)(\/|$)/.test(specifier)) return true;
  if (specifier.startsWith('.')) {
    const resolved = resolve(dirname(importingFile), specifier);
    return (
      resolved.startsWith(COMMON_DIR + sep) ||
      resolved.startsWith(ICONS_DIR + sep) ||
      resolved === COMMON_DIR ||
      resolved === ICONS_DIR
    );
  }
  return false;
}

describe('P5a — components/{common,icons} extracted to @openpalm/ui-kit (plan §6.11)', () => {
  test('src/lib/components/common no longer exists in packages/ui', () => {
    expect(existsSync(COMMON_DIR)).toBe(false);
  });

  test('src/lib/components/icons no longer exists in packages/ui', () => {
    expect(existsSync(ICONS_DIR)).toBe(false);
  });

  test('no ui source file imports the old $lib/components/{common,icons} paths', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf-8');
      for (const specifier of importSpecifiers(source)) {
        if (targetsOldLocation(specifier, file)) {
          offenders.push(`${file.slice(SRC_ROOT.length)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('ui consumes the shared components from @openpalm/ui-kit', () => {
    // The host UI keeps using common/ + icons/ (navbar, host pages, setup),
    // so after the rewrite at least one import must point at the new package.
    const uiKitImports = sourceFiles().flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf-8')).filter(
        (s) => s === '@openpalm/ui-kit' || s.startsWith('@openpalm/ui-kit/')
      )
    );
    expect(uiKitImports.length).toBeGreaterThan(0);
  });
});
