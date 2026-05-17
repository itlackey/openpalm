import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import {
	finishOauthFlowAtBase,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { ensureAuthServer } from '$lib/server/opencode-auth-subprocess.js';
import { asStringOrEmpty } from '../../_helpers.js';

/**
 * POST /admin/providers/oauth/finish — Complete an OAuth sign-in by
 * exchanging the operator-pasted authorization code with the local
 * OpenCode auth subprocess.
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		const methodIndex = Number(asStringOrEmpty(body.methodIndex));
		const code = asStringOrEmpty(body.code);

		if (!providerId || Number.isNaN(methodIndex) || !code) {
			return jsonResponse(
				200,
				actionFailure('Paste the authorization code before finishing sign-in.', providerId),
				requestId,
			);
		}

		const authBaseUrl = await ensureAuthServer();
		await finishOauthFlowAtBase(authBaseUrl, providerId, methodIndex, code);

		return jsonResponse(200, actionSuccess('OAuth connection completed.', providerId), requestId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
});
