/**
 * Unit tests for describeLoginFailure — F6: a 429 (login-throttle backoff)
 * was previously reported as "Invalid password.", so the CORRECT password
 * looked wrong to the user during backoff.
 */
import { describe, expect, test } from 'vitest';
import { describeLoginFailure } from './login-errors.js';

describe('describeLoginFailure', () => {
	test('surfaces the throttle wait time on 429', () => {
		expect(describeLoginFailure(429, { error: 'too_many_attempts', retryAfterSec: 42 })).toBe(
			'Too many failed sign-in attempts. Try again in 42s.'
		);
	});

	test('rounds a fractional retryAfterSec up', () => {
		expect(describeLoginFailure(429, { retryAfterSec: 1.2 })).toBe(
			'Too many failed sign-in attempts. Try again in 2s.'
		);
	});

	test('falls back to a generic wait message when 429 carries no retryAfterSec', () => {
		expect(describeLoginFailure(429, {})).toBe('Too many failed sign-in attempts. Try again shortly.');
		expect(describeLoginFailure(429, null)).toBe('Too many failed sign-in attempts. Try again shortly.');
	});

	test('ignores a zero or negative retryAfterSec', () => {
		expect(describeLoginFailure(429, { retryAfterSec: 0 })).toBe(
			'Too many failed sign-in attempts. Try again shortly.'
		);
		expect(describeLoginFailure(429, { retryAfterSec: -5 })).toBe(
			'Too many failed sign-in attempts. Try again shortly.'
		);
	});

	test('503 reports setup is incomplete regardless of body', () => {
		expect(describeLoginFailure(503, null)).toBe('Admin password is not configured yet. Complete setup first.');
	});

	test('401 uses the server message', () => {
		expect(describeLoginFailure(401, { error: 'unauthorized', message: 'Invalid password' })).toBe(
			'Invalid password'
		);
	});

	test('falls back to "Invalid password." when the body has no message', () => {
		expect(describeLoginFailure(401, null)).toBe('Invalid password.');
		expect(describeLoginFailure(400, {})).toBe('Invalid password.');
	});
});
