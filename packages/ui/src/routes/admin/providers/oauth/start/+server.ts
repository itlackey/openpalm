import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import { actionSuccess, actionFailure } from '$lib/server/opencode/index.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import { asStringOrEmpty, extractInputs } from '../../_helpers.js';

/**
 * POST /admin/providers/oauth/start — Begin an OpenCode-mediated OAuth
 * sign-in for a provider. Returns the authorization URL and any extra
 * inputs the operator needs to confirm in the UI.
 *
 * Forwards directly to the assistant container's OpenCode at
 * OP_OPENCODE_URL. (A fresh OpenCode subprocess used to be spawned here
 * for isolation, but it 500s on /provider/{id}/oauth/authorize — its
 * internal OAuth methods map never initializes.)
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		const methodIndex = Number(asStringOrEmpty(body.methodIndex));

		if (!providerId || Number.isNaN(methodIndex)) {
			return jsonResponse(
				200,
				actionFailure('Choose a provider sign-in method first.'),
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
			actionSuccess('OAuth flow prepared. Open the link below to continue.', providerId, {
				oauth: {
					providerId,
					methodIndex,
					url: oauth.url,
					mode: oauth.method,
					instructions: oauth.instructions,
					inputs,
				},
			}),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
});
