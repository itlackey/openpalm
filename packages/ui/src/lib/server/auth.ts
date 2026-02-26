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

