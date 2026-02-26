import type { Handle } from '@sveltejs/kit';
import { verifyAdminToken } from '$lib/server/auth';
import { ensureInitialized, getStackManager } from '$lib/server/init';

function isPrivateOrigin(origin: string): boolean {
	try {
		const { hostname } = new URL(origin);
		return (
			hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname.startsWith('10.') ||
			hostname.startsWith('192.168.') ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
			hostname === '::1' ||
			hostname === '[::1]'
		);
	} catch {
		return false;
	}
}

function computeAllowedOrigin(scope: string, requestOrigin: string): string {
	// No origin header = same-origin request, reflect nothing
	if (!requestOrigin) return '';

	if (scope === 'public') return requestOrigin;

	if (scope === 'lan') {
		// Reflect the origin if it's a private/local IP
		if (isPrivateOrigin(requestOrigin)) return requestOrigin;
		return 'http://localhost';
	}

	// 'host' scope — only localhost
	if (requestOrigin.includes('localhost') || requestOrigin.includes('127.0.0.1')) {
		return requestOrigin;
	}
	return 'http://localhost';
}

export const handle: Handle = async ({ event, resolve: resolveEvent }) => {
	// Run one-time startup logic (no-op after first call, skipped during build)
	await ensureInitialized();

	const stackManager = await getStackManager();
	const { accessScope } = stackManager.getSpec();
	const requestOrigin = event.request.headers.get('origin') ?? '';
	const allowedOrigin = computeAllowedOrigin(accessScope ?? 'host', requestOrigin);

	// OPTIONS preflight
	if (event.request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...(allowedOrigin ? { 'access-control-allow-origin': allowedOrigin } : {}),
				'access-control-allow-headers': 'content-type, x-admin-token, x-request-id',
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				vary: 'Origin'
			}
		});
	}

	// Parse auth token
	const token = event.request.headers.get('x-admin-token') ?? '';
	event.locals.authenticated = verifyAdminToken(token);
	try {
		event.locals.clientAddress = event.getClientAddress();
	} catch {
		event.locals.clientAddress = '';
	}

	// Resolve request
	const response = await resolveEvent(event);

	// CORS headers on all responses
	if (allowedOrigin) {
		response.headers.set('access-control-allow-origin', allowedOrigin);
	}
	response.headers.set(
		'access-control-allow-headers',
		'content-type, x-admin-token, x-request-id'
	);
	response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
	response.headers.append('vary', 'Origin');

	return response;
};
