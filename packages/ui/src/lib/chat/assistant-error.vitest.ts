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

	// F3: a structured `detail` (extracted from the /oc proxy envelope,
	// OpenCode's own error JSON, or a session.error event) is more specific
	// than every generic ladder entry below it and must win.
	it('prefers a structured detail over the generic 503/502 copy', () => {
		expect(
			mapAssistantError({ status: 503, detail: 'The assistant is not responding — it may still be starting.' })
		).toBe('The assistant is not responding — it may still be starting.');
		expect(mapAssistantError({ status: 502, detail: 'Upstream provider rejected the request: invalid API key.' })).toBe(
			'Upstream provider rejected the request: invalid API key.'
		);
	});

	it('appends the reconnect hint after a structured detail', () => {
		expect(
			mapAssistantError(
				{ status: 503, detail: 'The assistant is not responding — it may still be starting.' },
				{ reconnectHint: true }
			)
		).toBe('The assistant is not responding — it may still be starting. Try reconnecting.');
	});

	it('falls back to the generic 503/502 copy when there is no detail', () => {
		expect(mapAssistantError({ status: 503, message: 'HTTP 503' })).toBe('Assistant is not reachable.');
	});

	it('ignores a structured detail for 401 — Sign-in required is a fixed app message', () => {
		expect(mapAssistantError({ status: 401, detail: 'irrelevant provider detail' })).toBe(
			'Sign-in required.'
		);
	});

	it('uses a structured detail for an unrecognized status even when message is a generic placeholder', () => {
		expect(mapAssistantError({ status: 400, message: 'HTTP 400', detail: 'Unknown model "gpt-9".' })).toBe(
			'Unknown model "gpt-9".'
		);
	});

	it('ignores a blank/whitespace-only detail', () => {
		expect(mapAssistantError({ status: 500, detail: '   ', message: 'boom' })).toBe('boom');
	});
});
