import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import { asStringOrEmpty } from '../../_helpers.js';
import type { ProviderActionResult } from '$lib/types/providers.js';

/**
 * POST /admin/providers/oauth/finish — Complete an OAuth code-mode
 * sign-in by exchanging the operator-pasted authorization code with the
 * assistant OpenCode instance.
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		const methodIndex = Number(asStringOrEmpty(body.methodIndex));
		const code = asStringOrEmpty(body.code);

		if (!providerId || Number.isNaN(methodIndex) || !code) {
			return jsonResponse(
				200,
				{ ok: false, message: 'Paste the authorization code before finishing sign-in.', selectedProviderId: providerId } satisfies ProviderActionResult,
				requestId,
			);
		}

		await opencodeFetch(
			`/provider/${encodeURIComponent(providerId)}/oauth/callback`,
			{
				method: 'POST',
				body: JSON.stringify({ method: methodIndex, code }),
			},
		);

		return jsonResponse(200, { ok: true, message: 'OAuth connection completed.', selectedProviderId: providerId } satisfies ProviderActionResult, requestId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, { ok: false, message, selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
	}
});
