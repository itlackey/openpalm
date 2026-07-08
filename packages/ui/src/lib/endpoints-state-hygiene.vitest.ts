/**
 * Phase 2 (#486) hygiene — the connections store must not import chat state
 * (plan ui-runtime-modes-plan.md Phase 2 step 6: "break the endpoints-state ↔
 * chat-state bidirectional import (connection activation emits an event; chat
 * subscribes)"; §6.11: the coupling is untangled BEFORE the Phase 5 client
 * extraction, so the later move is file relocation, not surgery).
 *
 * RED until Phase 2 lands: lib/endpoints-state.svelte.ts currently does
 *   import { chat } from './chat/chat-state.svelte.js';
 *
 * This is a source-level test (it reads the store's source and inspects its
 * import specifiers) because the invariant is about the module graph, not
 * runtime behavior: connection activation must reach chat through an
 * event/callback that the chat side subscribes to — never through a direct
 * import from the connections side. Type-only imports count too: after
 * extraction they would still drag chat modules into the client package.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The store's current file name, plus the names the Phase 2 internal
 * endpoint→connection rename could plausibly move it to. The hygiene
 * invariant must keep holding after the rename, so the test follows the
 * file rather than pinning one path.
 */
const CANDIDATE_STORE_FILES = [
  'endpoints-state.svelte.ts',
  'connections-state.svelte.ts',
  'connection-state.svelte.ts',
] as const;

function resolveStoreFile(): string | null {
  for (const name of CANDIDATE_STORE_FILES) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
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

/** True for chat-state or anything under a chat/ module directory. */
function isChatModuleSpecifier(specifier: string): boolean {
  return /chat-state/.test(specifier) || /(?:^|\/)chat\//.test(specifier);
}

describe('endpoints-state ↔ chat-state untangling (plan Phase 2 step 6)', () => {
  test('the connections store module exists in $lib', () => {
    expect(resolveStoreFile()).not.toBeNull();
  });

  test('the store has no static, type, or dynamic import from chat-state or chat/*', () => {
    const path = resolveStoreFile();
    expect(path).not.toBeNull();
    const source = readFileSync(path as string, 'utf-8');
    const chatImports = importSpecifiers(source).filter(isChatModuleSpecifier);
    expect(chatImports).toEqual([]);
  });
});
