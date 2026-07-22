import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('/start motion preferences', () => {
  test('stops the loading animation when reduced motion is requested', () => {
    const reducedMotion = source.slice(source.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toMatch(/\.loading-mark\s*\{\s*animation:\s*none;/);
  });
});
