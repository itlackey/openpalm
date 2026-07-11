/**
 * Pure follow-state logic for the chat-thread autoscroll (review 2026-07-10
 * §B13 — ported verbatim from `packages/ui/src/lib/chat/autoscroll.ts`).
 *
 * The chat page pins the viewport to the newest content only while the user
 * is "following" the stream. Following stops on an upward scroll and resumes
 * whenever the viewport comes back within NEAR_BOTTOM_PX of the bottom.
 * A growing scrollHeight alone (streamed text pushing the bottom away while
 * a smooth scroll is still in flight) must NOT stop following — only the
 * user moving up does. Keeping it non-reactive is deliberate — no runes,
 * no DOM, so it unit-tests without mounting a Svelte component.
 */

/** Distance from the bottom (px) inside which the viewport counts as at-bottom. */
export const NEAR_BOTTOM_PX = 120;

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - (scrollTop + clientHeight) < NEAR_BOTTOM_PX;
}

/**
 * Next follow-state after a scroll event.
 *
 * - near the bottom -> following (arriving at the bottom always re-attaches).
 * - scrolled up (scrollTop decreased) -> not following.
 * - otherwise -> unchanged (content growth or a downward scroll that hasn't
 *   reached the bottom yet keeps the current state).
 */
export function nextFollowState(
  following: boolean,
  prevScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  if (isNearBottom(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < prevScrollTop) return false;
  return following;
}
