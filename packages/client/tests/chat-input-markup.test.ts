/**
 * B3/B8 [HIGH] (review 2026-07-10) — source "pin" test for ChatInput.svelte's
 * markup wiring, complementing the pure-logic tests in composer.test.ts
 * (packages/client has no component-render harness to assert this via
 * rendered DOM).
 *
 * RED until ChatInput.svelte:
 *   - never passes `sending` (or any sending-derived value) to the
 *     textarea's `disabled` — draft-while-sending / no focus destruction,
 *   - routes Enter through `shouldSubmitOnKeydown` (the ported IME guard),
 *   - renders a stop button wired to `onStop` while a turn is blocked.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATH = fileURLToPath(new URL('../src/lib/components/chat/ChatInput.svelte', import.meta.url));

function source(): string {
  return readFileSync(PATH, 'utf8');
}

describe('ChatInput.svelte — B8(b) never disables the textarea', () => {
  test('the <textarea> element has no disabled attribute at all', () => {
    const src = source();
    const textareaMatch = src.match(/<textarea[\s\S]*?>/);
    expect(textareaMatch).not.toBeNull();
    expect(textareaMatch![0]).not.toMatch(/disabled/);
  });
});

describe('ChatInput.svelte — B8(a) IME guard', () => {
  test('keydown handling goes through the ported shouldSubmitOnKeydown', () => {
    const src = source();
    expect(src).toContain("from '$lib/chat/composer.js'");
    expect(src).toContain('shouldSubmitOnKeydown');
    expect(src).toContain('e.isComposing');
  });
});

describe('ChatInput.svelte — B3 stop button', () => {
  test('renders a stop control wired to onStop while submission is blocked', () => {
    const src = source();
    expect(src).toContain('onStop');
    expect(src).toMatch(/aria-label="Stop generating"/);
    expect(src).toContain('IconStop');
  });
});
