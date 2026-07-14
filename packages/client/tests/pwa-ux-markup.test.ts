/**
 * #511 — source-pin tests for the pairing paste field, ?pair= deep link,
 * runtime-contract skew notice, and the browser-only install hint on
 * routes/connections/+page.svelte, plus the display-mode stamp on
 * routes/+layout.svelte.
 *
 * Idiom: connections-https-refusal.test.ts (readFileSync + regex source
 * pins — packages/client has no component-render harness).
 *
 * RED reason (every row): marker absent from the .svelte source.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONNECTIONS_PAGE = fileURLToPath(new URL('../src/routes/connections/+page.svelte', import.meta.url));
const LAYOUT = fileURLToPath(new URL('../src/routes/+layout.svelte', import.meta.url));

function connectionsPageSource(): string {
  return readFileSync(CONNECTIONS_PAGE, 'utf8');
}

function layoutSource(): string {
  return readFileSync(LAYOUT, 'utf8');
}

describe('connections +page.svelte — pairing + handshake + install-hint wiring (#511)', () => {
  test('wires the pairing parser into the add form', () => {
    const src = connectionsPageSource();
    expect(src).toMatch(/parsePairingCode\(/);
    expect(src).toMatch(/from\s+['"]\$lib\/connections\/pairing\.js['"]/);
  });

  test('consumes ?pair= and strips it from history', () => {
    const src = connectionsPageSource();
    expect(src).toMatch(/searchParams\.get\(\s*['"]pair['"]\s*\)/);
    expect(src).toMatch(/replaceState\(/);
  });

  test('probes the runtime contract for guardian-kind entries and renders a version-skew notice', () => {
    const src = connectionsPageSource();
    expect(src).toMatch(/checkRuntimeContract\(/);
    expect(src).toMatch(/from\s+['"]\$lib\/runtime-handshake\.js['"]/);
    expect(src).toMatch(/newer OpenPalm protocol/i);
  });

  test('shows the install hint only in browser display mode', () => {
    const src = connectionsPageSource();
    expect(src).toMatch(/displayMode\s*===\s*['"]browser['"]/);
    expect(src).toMatch(/install/i);
    expect(src).toMatch(/from\s+['"]\$lib\/client-context\.js['"]/);
  });
});

describe('+layout.svelte — display-mode stamp (#511)', () => {
  test('stamps the detected display mode on the document root', () => {
    const src = layoutSource();
    expect(src).toMatch(/detectClientDisplayMode\(/);
    expect(src).toMatch(/dataset\.displayMode/);
  });
});
