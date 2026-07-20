/**
 * Phase 3 hygiene — the chat page must not import the $lib/api.js barrel
 * (issue #555: "Chat stops
 * importing the $lib/api.js barrel (direct domain-client imports only)").
 *
 * RED until Phase 3 lands: chat/+page.svelte still does
 *   import { probeChatBackend } from '$lib/api.js';
 *
 * Source-level test because the invariant is about the module graph: the
 * barrel re-exports every admin domain client (containers, versions,
 * backups, secrets, akm, …), so one barrel import drags the entire admin API
 * surface into the chat chunk — exactly what the Phase 5 client extraction
 * (and the "chat chunk imports no admin API clients" acceptance) forbids.
 * Direct domain-client imports (e.g. $lib/api/chat.js) remain allowed.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHAT_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

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

/** The $lib/api barrel, in alias or relative form — NOT the $lib/api/ domain
 *  modules, which stay allowed. */
function isApiBarrelSpecifier(specifier: string): boolean {
  return (
    /^\$lib\/api(?:\.(?:js|ts))?$/.test(specifier) ||
    /^(?:\.\.?\/)+lib\/api(?:\.(?:js|ts))?$/.test(specifier)
  );
}

describe('chat page ↔ admin API barrel untangling (#555)', () => {
  test('the chat page exists (sanity)', () => {
    // CHARACTERIZATION (green today): guards the path this hygiene scan pins.
    expect(existsSync(CHAT_PAGE)).toBe(true);
  });

  test('chat/+page.svelte does not import the $lib/api.js barrel', () => {
    const offenders = importSpecifiers(readFileSync(CHAT_PAGE, 'utf-8')).filter(
      isApiBarrelSpecifier,
    );
    expect(offenders).toEqual([]);
  });

  test('leaving chat stops conversation and single-shot microphone capture', () => {
    const source = readFileSync(CHAT_PAGE, 'utf-8');
    const teardown = source.match(/return \(\) => \{([\s\S]*?)\n\s*\};\n\s*\}\);/);
    expect(teardown?.[1]).toMatch(/stopConversation\(\)/);
    expect(teardown?.[1]).toMatch(/stopListening\(\)/);
  });

  test('prepares Electron microphone permission before editable dictation starts', () => {
    const source = readFileSync(CHAT_PAGE, 'utf-8');
    expect(source).toMatch(/requestMicPermission/);
    expect(source.match(/await prepareMicrophoneAccess\(\)/g)).toHaveLength(2);
    expect(source).toMatch(/if \(await prepareMicrophoneAccess\(\)\)[\s\S]*?startListening\(/);
    expect(source).toMatch(/startConversation\(\(transcript\) => void chat\.sendUtterance\(transcript\)\)/);
  });
});
