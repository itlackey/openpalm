/**
 * B8 [MEDIUM->HIGH] (review 2026-07-10 §B8) — composer resilience, pure-logic
 * half. `ChatInput.svelte` had no `e.isComposing` guard: Enter during CJK/
 * Japanese/Korean IME composition submitted the half-composed message. The
 * host app added this guard deliberately in `71f1ebc7` with a regression
 * test (`ChatInput.svelte.vitest.ts` "Enter during IME composition does not
 * submit") — this ports the same case as a pure-function unit test, since
 * packages/client has no component-render test harness (bun:test only, no
 * vitest-browser-svelte). The keydown-decision logic is extracted into
 * `$lib/chat/composer.ts` so it is testable without mounting the component.
 *
 * RED until packages/client/src/lib/chat/composer.ts exists.
 */
import { describe, expect, test } from 'bun:test';

async function loadComposerModule() {
  return import('../src/lib/chat/composer.ts');
}

describe('shouldSubmitOnKeydown — IME guard (71f1ebc7)', () => {
  test('Enter during IME composition does NOT submit', async () => {
    const { shouldSubmitOnKeydown } = await loadComposerModule();
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  test('plain Enter (not composing) submits', async () => {
    const { shouldSubmitOnKeydown } = await loadComposerModule();
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });

  test('Shift+Enter never submits (newline), composing or not', async () => {
    const { shouldSubmitOnKeydown } = await loadComposerModule();
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitOnKeydown({ key: 'Enter', shiftKey: true, isComposing: true })).toBe(false);
  });

  test('non-Enter keys never submit', async () => {
    const { shouldSubmitOnKeydown } = await loadComposerModule();
    expect(shouldSubmitOnKeydown({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe('isSubmitBlocked — draft-while-sending (B8b)', () => {
  test('typing/drafting is never blocked by sending alone — only submission is', async () => {
    const { isSubmitBlocked } = await loadComposerModule();
    // Submission IS blocked while sending...
    expect(isSubmitBlocked({ sending: true })).toBe(true);
    // ...but this only gates the send action, not the textarea's disabled
    // state — the composer wiring (ChatInput.svelte) must not pass this
    // value (or `sending` directly) to the textarea's `disabled` prop.
    expect(isSubmitBlocked({ sending: false })).toBe(false);
  });
});
