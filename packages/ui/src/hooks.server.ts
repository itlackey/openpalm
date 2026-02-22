import type { Handle } from '@sveltejs/kit';
import { verifyAdminToken } from '$lib/server/auth';
import { ensureInitialized } from '$lib/server/init';

export const handle: Handle = async ({ event, resolve }) => {
	// Run one-time startup logic (no-op after first call, skipped during build)
	await ensureInitialized();

	// OPTIONS preflight
	if (event.request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-origin': '*',
				'access-control-allow-headers': 'content-type, x-admin-token, x-request-id',
				'access-control-allow-methods': 'GET, POST, OPTIONS'
			}
		});
	}

	// Parse auth token
	const token = event.request.headers.get('x-admin-token') ?? '';
	event.locals.authenticated = verifyAdminToken(token);

	// Resolve request
	const response = await resolve(event);

	// CORS headers on all responses
	response.headers.set('access-control-allow-origin', '*');
	response.headers.set(
		'access-control-allow-headers',
		'content-type, x-admin-token, x-request-id'
	);
	response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');

	return response;
};
