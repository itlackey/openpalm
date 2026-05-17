import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import {
	startOauthFlowAtBase,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { ensureAuthServer } from '$lib/server/opencode-auth-subprocess.js';
import { asStringOrEmpty, extractInputs } from '../../_helpers.js';

/**
 * POST /admin/providers/oauth/start — Begin an OpenCode-mediated OAuth
 * sign-in for a provider. Returns the authorization URL and any extra
 * inputs the operator needs to confirm in the UI.
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
		const authBaseUrl = await ensureAuthServer();
		const oauth = await startOauthFlowAtBase(authBaseUrl, providerId, methodIndex, inputs);

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
