/**
 * POST /admin/providers/oauth/:providerId/callback
 *
 * Forwards an OAuth callback (auto-mode completion) to the assistant
 * container's OpenCode. The previous implementation spawned a separate
 * OpenCode subprocess, but a fresh OpenCode instance's OAuth methods map
 * fails to initialize (TypeError on .methods lookup), so we route the
 * call directly to the running assistant.
 */
import type { RequestHandler } from './$types';
import { requireAdmin, getRequestId, errorResponse } from '$lib/server/helpers.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';

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
		await opencodeFetch(
			`/provider/${encodeURIComponent(providerId)}/oauth/callback`,
			{ method: 'POST', body },
		);
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/json',
				...(requestId ? { 'x-request-id': requestId } : {}),
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'OAuth callback failed';
		return errorResponse(502, 'oauth_callback_failed', message, {}, requestId);
	}
};
