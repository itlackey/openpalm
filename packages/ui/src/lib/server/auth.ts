import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADMIN_TOKEN, DEFAULT_INSECURE_TOKEN } from './config.ts';

const TOKEN_HMAC_KEY = 'openpalm-token-compare';

/**
 * Constant-time token comparison using HMAC to avoid timing side-channels.
 * Unlike length-check-then-compare, HMAC comparison does not leak token length.
 */
function hmacCompare(a: string, b: string): boolean {
	const hmacA = createHmac('sha256', TOKEN_HMAC_KEY).update(a).digest();
	const hmacB = createHmac('sha256', TOKEN_HMAC_KEY).update(b).digest();
	return timingSafeEqual(hmacA, hmacB);
}

export function verifyAdminToken(token: string): boolean {
	if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) return false;
	if (!ADMIN_TOKEN) return false;
	return hmacCompare(token, ADMIN_TOKEN);
}

/**
 * Check if a request is authenticated via the x-admin-token header.
 */
export function isAuthenticated(request: Request): boolean {
	const token = request.headers.get('x-admin-token') ?? '';
	return verifyAdminToken(token);
}

/**
 * Check if a request originates from a local/private IP address.
 * Used to restrict unauthenticated setup endpoints to local network access only.
 *
 * SECURITY NOTE: This relies on x-forwarded-for which can be spoofed if not
 * behind a trusted proxy. In the OpenPalm architecture, Caddy sets this header
 * and is the only ingress point.
 */
export function isLocalRequest(request: Request): boolean {
	const forwarded = request.headers.get('x-forwarded-for');
	const ip = forwarded?.split(',')[0]?.trim() ?? '127.0.0.1';
	const localPatterns = [
		'127.0.0.1',
		'::1',
		'10.',
		'172.16.',
		'172.17.',
		'172.18.',
		'172.19.',
		'172.20.',
		'172.21.',
		'172.22.',
		'172.23.',
		'172.24.',
		'172.25.',
		'172.26.',
		'172.27.',
		'172.28.',
		'172.29.',
		'172.30.',
		'172.31.',
		'192.168.'
	];
	return localPatterns.some((p) => ip.startsWith(p));
}
