import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

describe('host chat footer responsive contract', () => {
  test('accounts for safe areas, narrow screens, and reduced keyboard viewports without effects', () => {
    const source = readFileSync(CHAT_PAGE, 'utf-8');

    expect(source).toContain('env(safe-area-inset-bottom)');
    expect(source).toContain('env(safe-area-inset-left)');
    expect(source).toContain('env(safe-area-inset-right)');
    expect(source).toMatch(/\.s-base\s*\{[\s\S]*?padding-bottom:[^;]*5\.25rem[^;]*safe-area-inset-bottom/);
    expect(source).toMatch(/@media \(min-width: 901px\)[\s\S]*?\.s-base\s*\{[\s\S]*?left: clamp\(220px, 23vw, 300px\)/);
    expect(source).toMatch(/@media \(max-width: 520px\)/);
    expect(source).toMatch(/@media \(max-height: 34rem\)/);
    expect(source).toMatch(/\.s-glyph-btn\s*\{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/);
    expect(source).not.toMatch(/\$effect(?:\.pre)?\s*\(/);
  });
});
