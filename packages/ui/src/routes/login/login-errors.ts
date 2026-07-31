/**
 * Pure mapping from a failed `POST /api/auth/login` response to the message
 * shown on the login form. Extracted so the mapping unit-tests without
 * mounting a Svelte component (mirrors chat/assistant-error.ts).
 *
 * Previously every non-503 status — including 429, once the server's login
 * throttle (login-throttle.ts) engages after repeated failures — was reported
 * as "Invalid password.", so a correctly-typed password during backoff read
 * as wrong rather than "wait and retry".
 */

export type LoginFailureBody = {
	error?: string;
	message?: string;
	retryAfterSec?: number;
};

export function describeLoginFailure(status: number, body: LoginFailureBody | null): string {
	if (status === 429) {
		const wait =
			typeof body?.retryAfterSec === 'number' && body.retryAfterSec > 0
				? Math.ceil(body.retryAfterSec)
				: undefined;
		return wait
			? `Too many failed sign-in attempts. Try again in ${wait}s.`
			: 'Too many failed sign-in attempts. Try again shortly.';
	}
	if (status === 503) {
		return 'Admin password is not configured yet. Complete setup first.';
	}
	// 401 (the common case) already carries the message "Invalid password" from
	// the server; anything else unrecognized falls back to the same wording
	// rather than a raw status code.
	return body?.message ?? 'Invalid password.';
}
