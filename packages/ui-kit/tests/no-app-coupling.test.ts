/**
 * P5a (#555) HYGIENE — ui-kit is presentational only (plan
 * ui-runtime-modes-plan.md §6.11: "ui-kit contains no stores with server
 * assumptions — presentational components, icons, and theme only"; §8.10:
 * the client app never bundles @openpalm/lib).
 *
 * No source file under packages/ui-kit/src may import:
 *   - $lib/api (the ui app's API-client barrel or its submodules)
 *   - $lib/server (host-side server code)
 *   - @openpalm/lib (control-plane library — §8.10)
 *   - chat state (chat-state or anything under a chat/ module dir)
 *   - the connections store (endpoints-state / connections-state /
 *     connection-state, any rename the store has carried)
 *
 * CHARACTERIZATION NOTE: this test is GREEN before the P5a move lands
 * (src/ is empty, so the scan has nothing to flag). It is written ahead of
 * the move so the invariant is enforced from the first file that lands in
 * this package. The last test guards against a forever-vacuous pass: once
 * packages/ui/src/lib/components/{common,icons} are gone (the P5a move),
 * the moved sources MUST exist here for the scan to see.
 *
 * Source-level test (reads files and inspects import specifiers) because
 * the invariant is about the module graph, not runtime behavior: ui-kit is
 * consumed as raw source by both apps, so any app-coupled import would drag
 * host/server modules into the client artifact (§8 rules 5 and 10).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const UI_COMMON_DIR = fileURLToPath(
  new URL('../../ui/src/lib/components/common/', import.meta.url)
);
const UI_ICONS_DIR = fileURLToPath(
  new URL('../../ui/src/lib/components/icons/', import.meta.url)
);

/** Every scannable source file under src/ ([] until sources land). */
function sourceFiles(): string[] {
  if (!existsSync(SRC_ROOT)) return [];
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

/** App-coupled module specifiers that must never appear in ui-kit source. */
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: '$lib/api', pattern: /^\$lib\/api(\.js|\.ts)?(\/|$)/ },
  { name: '$lib/server', pattern: /^\$lib\/server(\/|$)/ },
  { name: '@openpalm/lib', pattern: /^@openpalm\/lib(\/|$)/ },
  { name: 'chat state', pattern: /chat-state|(^|\/)chat\// },
  {
    name: 'connections store',
    pattern: /endpoints-state|connections-state|connection-state/
  }
];

describe('ui-kit source has no app coupling (plan §6.11, §8.10)', () => {
  test('no source file imports $lib/api, $lib/server, @openpalm/lib, chat state, or the connections store', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf-8');
      for (const specifier of importSpecifiers(source)) {
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(specifier)) {
            offenders.push(`${file.slice(SRC_ROOT.length)} imports ${specifier} (${name})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('once the P5a move lands, the scan sees the moved sources (guards vacuous pass)', () => {
    const moveLanded = !existsSync(UI_COMMON_DIR) && !existsSync(UI_ICONS_DIR);
    if (!moveLanded) {
      // Pre-move: ui still owns common/ and icons/; src/ here may be empty.
      // The scan above is vacuously green — that is the expected pre-move state.
      expect(sourceFiles().length).toBeGreaterThanOrEqual(0);
      return;
    }
    // Post-move: ~21 common components + ~64 icons (+ index/theme files) must
    // live here, or the hygiene scan above is inspecting an empty package.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(60);
  });
});
