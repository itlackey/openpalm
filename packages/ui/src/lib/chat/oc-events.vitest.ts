/**
 * Unit tests for extractSessionErrorDetail — F3: a session.error SSE event is
 * exactly what an invalid/revoked/quota-exhausted provider API key produces at
 * first-message time, and properties.error was previously never read.
 */
import { describe, expect, it } from 'vitest';
import { extractSessionErrorDetail, isSessionError, type RawEvent } from './oc-events.js';

const SID = 'ses_1';

function errorEvent(error: unknown, sessionID = SID): RawEvent {
	return { type: 'session.error', properties: { sessionID, error } };
}

describe('extractSessionErrorDetail', () => {
	it('returns undefined for a non session.error event', () => {
		expect(extractSessionErrorDetail({ type: 'session.idle', properties: { sessionID: SID } }, SID)).toBeUndefined();
	});

	it('returns undefined when the event is for a different session', () => {
		expect(extractSessionErrorDetail(errorEvent('boom', 'other-session'), SID)).toBeUndefined();
	});

	it('reads a plain string error', () => {
		expect(extractSessionErrorDetail(errorEvent('Invalid API key for provider "anthropic".'), SID)).toBe(
			'Invalid API key for provider "anthropic".'
		);
	});

	it('ignores a blank string error', () => {
		expect(extractSessionErrorDetail(errorEvent('   '), SID)).toBeUndefined();
	});

	it('reads {name, message} — the guardian synthetic upstream-reset shape', () => {
		expect(
			extractSessionErrorDetail(errorEvent({ name: 'UpstreamResetError', message: 'Connection to OpenCode was lost.' }), SID)
		).toBe('Connection to OpenCode was lost.');
	});

	it('falls back to a nested data.message when message is absent', () => {
		expect(
			extractSessionErrorDetail(
				errorEvent({ name: 'ProviderAuthError', data: { message: 'API key rejected by provider.' } }),
				SID
			)
		).toBe('API key rejected by provider.');
	});

	it('falls back to name when neither message nor data.message is present', () => {
		expect(extractSessionErrorDetail(errorEvent({ name: 'UnknownError' }), SID)).toBe('UnknownError');
	});

	it('returns undefined when error is absent entirely', () => {
		expect(extractSessionErrorDetail({ type: 'session.error', properties: { sessionID: SID } }, SID)).toBeUndefined();
	});

	it('returns undefined when error is an empty object with no usable field', () => {
		expect(extractSessionErrorDetail(errorEvent({}), SID)).toBeUndefined();
	});
});

describe('isSessionError (sanity)', () => {
	it('is true only for session.error scoped to the given session', () => {
		expect(isSessionError(errorEvent('x'), SID)).toBe(true);
		expect(isSessionError(errorEvent('x', 'other'), SID)).toBe(false);
	});
});
