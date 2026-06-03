import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import { asStringOrEmpty, extractInputs } from '../../_helpers.js';
import type { ProviderActionResult } from '$lib/types/providers.js';

/**
 * POST /admin/providers/oauth/start — Begin an OpenCode-mediated OAuth
 * sign-in for a provider. Returns the authorization URL and any extra
 * inputs the operator needs to confirm in the UI.
 *
 * Forwards directly to the running assistant's OpenCode at
 * OP_OPENCODE_URL, which holds the OAuth methods map needed to issue
 * the authorize request.
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		const methodIndex = Number(asStringOrEmpty(body.methodIndex));

		if (!providerId || Number.isNaN(methodIndex)) {
			return jsonResponse(
				200,
				{ ok: false, message: 'Choose a provider sign-in method first.', selectedProviderId: undefined } satisfies ProviderActionResult,
				requestId,
			);
		}

		const inputs = extractInputs(body);
		const oauth = await opencodeFetch<{ url: string; method: 'auto' | 'code'; instructions?: string }>(
			`/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
			{
				method: 'POST',
				body: JSON.stringify({ method: methodIndex, ...(inputs ? { inputs } : {}) }),
			},
		);

		return jsonResponse(
			200,
			{ ok: true, message: 'OAuth flow prepared. Open the link below to continue.', selectedProviderId: providerId, oauth: { providerId, methodIndex, url: oauth.url, mode: oauth.method, instructions: oauth.instructions, inputs } } satisfies ProviderActionResult,
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, { ok: false, message, selectedProviderId: undefined } satisfies ProviderActionResult, requestId);
	}
});
