/**
 * B13 [MEDIUM] (review 2026-07-10 §B13) — autoscroll/follow-state logic,
 * ported from `packages/ui/src/lib/chat/autoscroll.vitest.ts`. The client
 * chat currently force-scrolls to the bottom on every turn
 * (`packages/client/src/routes/chat/+page.svelte` `scrollToEnd()`), yanking
 * the viewport out from under a user who scrolled up to read earlier
 * messages. This pins the pure follow-state module the chat page's
 * autoscroll action is built on.
 *
 * RED until packages/client/src/lib/chat/autoscroll.ts exists.
 */
import { describe, expect, test } from 'bun:test';

async function loadAutoscrollModule() {
  return import('../src/lib/chat/autoscroll.ts');
}

describe('isNearBottom', () => {
  test('is true at the exact bottom', async () => {
    const { isNearBottom } = await loadAutoscrollModule();
    expect(isNearBottom(1400, 600, 2000)).toBe(true);
  });

  test('is true just inside the threshold', async () => {
    const { isNearBottom, NEAR_BOTTOM_PX } = await loadAutoscrollModule();
    expect(isNearBottom(1400 - (NEAR_BOTTOM_PX - 1), 600, 2000)).toBe(true);
  });

  test('is false at and beyond the threshold', async () => {
    const { isNearBottom, NEAR_BOTTOM_PX } = await loadAutoscrollModule();
    expect(isNearBottom(1400 - NEAR_BOTTOM_PX, 600, 2000)).toBe(false);
    expect(isNearBottom(0, 600, 2000)).toBe(false);
  });

  test('is true when the content is shorter than the viewport', async () => {
    const { isNearBottom } = await loadAutoscrollModule();
    expect(isNearBottom(0, 600, 400)).toBe(true);
  });
});

describe('nextFollowState', () => {
  test('re-attaches on arriving near the bottom regardless of prior state', async () => {
    const { nextFollowState } = await loadAutoscrollModule();
    expect(nextFollowState(false, 0, 1400, 600, 2000)).toBe(true);
    expect(nextFollowState(true, 1300, 1400, 600, 2000)).toBe(true);
  });

  test('detaches on an upward scroll away from the bottom', async () => {
    const { nextFollowState } = await loadAutoscrollModule();
    expect(nextFollowState(true, 1400, 800, 600, 2000)).toBe(false);
  });

  test('stays attached when streamed content grows the scrollHeight in place', async () => {
    const { nextFollowState } = await loadAutoscrollModule();
    // scrollTop unchanged, bottom pushed away by a large appended chunk —
    // the in-flight smooth scroll must keep following.
    expect(nextFollowState(true, 1400, 1400, 600, 2400)).toBe(true);
  });

  test('stays detached on a downward scroll that has not reached the bottom', async () => {
    const { nextFollowState } = await loadAutoscrollModule();
    expect(nextFollowState(false, 200, 600, 600, 2000)).toBe(false);
  });
});
