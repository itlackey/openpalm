import type { RequestHandler } from './$types';
import { requireAdmin, getRequestId, errorResponse } from '$lib/server/helpers.js';
import { ensureAuthServer } from '$lib/server/opencode-auth-subprocess.js';

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const { providerId } = event.params;
	if (!providerId) {
		return errorResponse(400, 'missing_provider', 'Provider ID is required.', {}, requestId);
	}

	try {
		const body = await event.request.text();
		const baseUrl = await ensureAuthServer();
		const response = await fetch(`${baseUrl}/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});

		return new Response(await response.text(), {
			status: response.status,
			headers: {
				'cache-control': 'no-store',
				'content-type': response.headers.get('content-type') ?? 'application/json',
				...(requestId ? { 'x-request-id': requestId } : {})
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'OAuth callback failed';
		return errorResponse(502, 'oauth_callback_failed', message, {}, requestId);
	}
};
