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

function isLocalOrPrivateIp(ip: string): boolean {
	const normalized = ip.trim().toLowerCase();
	if (!normalized) return false;
	if (normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]') return true;
	if (normalized.startsWith('::ffff:')) return isLocalOrPrivateIp(normalized.slice(7));
	if (normalized.startsWith('10.') || normalized.startsWith('192.168.')) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
	return false;
}

function getForwardedClientIp(request: Request): string | null {
	const forwarded = request.headers.get('x-forwarded-for');
	if (!forwarded) return null;
	const first = forwarded
		.split(',')[0]
		?.trim();
	return first || null;
}

/**
 * Check if a request originates from a local/private IP address.
 * Used to restrict unauthenticated setup endpoints to local network access only.
 */
export function isLocalRequest(request: Request, clientAddress = ''): boolean {
	if (clientAddress && !isLocalOrPrivateIp(clientAddress)) return false;

	const forwardedClientIp = getForwardedClientIp(request);
	if (forwardedClientIp) return isLocalOrPrivateIp(forwardedClientIp);

	return Boolean(clientAddress) && isLocalOrPrivateIp(clientAddress);
}
