/**
 * Unit tests for the pure autoscroll follow-state logic. Runs in the node
 * (server) vitest project — no runes, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { NEAR_BOTTOM_PX, isNearBottom, nextFollowState } from './autoscroll.js';

describe('isNearBottom', () => {
	it('is true at the exact bottom', () => {
		expect(isNearBottom(1400, 600, 2000)).toBe(true);
	});

	it('is true just inside the threshold', () => {
		expect(isNearBottom(1400 - (NEAR_BOTTOM_PX - 1), 600, 2000)).toBe(true);
	});

	it('is false at and beyond the threshold', () => {
		expect(isNearBottom(1400 - NEAR_BOTTOM_PX, 600, 2000)).toBe(false);
		expect(isNearBottom(0, 600, 2000)).toBe(false);
	});

	it('is true when the content is shorter than the viewport', () => {
		expect(isNearBottom(0, 600, 400)).toBe(true);
	});
});

describe('nextFollowState', () => {
	it('re-attaches on arriving near the bottom regardless of prior state', () => {
		expect(nextFollowState(false, 0, 1400, 600, 2000)).toBe(true);
		expect(nextFollowState(true, 1300, 1400, 600, 2000)).toBe(true);
	});

	it('detaches on an upward scroll away from the bottom', () => {
		expect(nextFollowState(true, 1400, 800, 600, 2000)).toBe(false);
	});

	it('stays attached when streamed content grows the scrollHeight in place', () => {
		// scrollTop unchanged, bottom pushed away by a large appended chunk —
		// the in-flight smooth scroll must keep following.
		expect(nextFollowState(true, 1400, 1400, 600, 2400)).toBe(true);
	});

	it('stays detached on a downward scroll that has not reached the bottom', () => {
		expect(nextFollowState(false, 200, 600, 600, 2000)).toBe(false);
	});
});
