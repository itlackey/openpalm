/**
 * Unit tests for the pure assistant-error status ladder. Runs in the node
 * (server) vitest project — no runes, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { mapAssistantError } from './assistant-error.js';

describe('mapAssistantError', () => {
	it('maps 503 to the unreachable message', () => {
		expect(mapAssistantError({ status: 503 })).toBe('Assistant is not reachable.');
	});

	it('maps 502 to the unreachable message', () => {
		expect(mapAssistantError({ status: 502 })).toBe('Assistant is not reachable.');
	});

	it('appends the reconnect hint when requested', () => {
		expect(mapAssistantError({ status: 503 }, { reconnectHint: true })).toBe(
			'Assistant is not reachable. Try reconnecting.'
		);
		expect(mapAssistantError({ status: 502 }, { reconnectHint: true })).toBe(
			'Assistant is not reachable. Try reconnecting.'
		);
	});

	it('maps 401 to the sign-in message regardless of reconnectHint', () => {
		expect(mapAssistantError({ status: 401 })).toBe('Sign-in required.');
		expect(mapAssistantError({ status: 401 }, { reconnectHint: true })).toBe(
			'Sign-in required.'
		);
	});

	it('uses the error message for an unrecognized status', () => {
		expect(mapAssistantError({ status: 500, message: 'boom' })).toBe('boom');
	});

	it('uses the error message when there is no status', () => {
		expect(mapAssistantError({ message: 'no status here' })).toBe('no status here');
	});

	it('falls back to the provided fallback when no status and no message', () => {
		expect(mapAssistantError({}, { fallback: 'Failed to load sessions.' })).toBe(
			'Failed to load sessions.'
		);
		expect(mapAssistantError(new Error('kaboom'), { fallback: 'Message failed.' })).toBe(
			'kaboom'
		);
	});

	it('falls back to the default message for a null/undefined throw', () => {
		expect(mapAssistantError(null)).toBe('Something went wrong.');
		expect(mapAssistantError(undefined)).toBe('Something went wrong.');
	});
});
