/**
 * Pure composer-resilience logic (review 2026-07-10 §B8), extracted out of
 * ChatInput.svelte so it unit-tests without mounting a Svelte component
 * (packages/client has no vitest-browser-svelte harness, only bun:test).
 */

export type KeydownLike = {
  key: string;
  shiftKey: boolean;
  /**
   * True while an IME (CJK/Japanese/Korean input method, etc.) composition
   * is in progress. The composing Enter commits a candidate, not the
   * message — the host app added this guard deliberately in `71f1ebc7`.
   */
  isComposing: boolean;
};

/** Whether this keydown should submit the composer. Enter (no Shift), not mid-IME-composition. */
export function shouldSubmitOnKeydown(event: KeydownLike): boolean {
  if (event.isComposing) return false;
  return event.key === 'Enter' && !event.shiftKey;
}

export type SubmitBlockState = {
  sending: boolean;
};

/**
 * Whether SUBMITTING a turn is blocked right now. Drafting the next message
 * is always allowed — this must gate only the submit action (send button +
 * Enter), never the textarea's `disabled` state (B8b: the old
 * `disabled={sending}` destroyed keyboard focus to `<body>` on every send,
 * WCAG 2.4.3, and blocked draft-while-sending).
 */
export function isSubmitBlocked(state: SubmitBlockState): boolean {
  return state.sending;
}
