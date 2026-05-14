import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	finishOauthFlowAtBase,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode-providers.js';
import { ensureAuthServer } from '$lib/server/opencode-auth-subprocess.js';
import { asString } from '../../_helpers.js';

/**
 * POST /admin/providers/oauth/finish — Complete an OAuth sign-in by
 * exchanging the operator-pasted authorization code with the local
 * OpenCode auth subprocess.
 */
export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const parsed = await parseJsonBody(event.request);
	if ('error' in parsed) return jsonBodyError(parsed, requestId);

	const body = parsed.data;

	try {
		const providerId = asString(body.providerId);
		const methodIndex = Number(asString(body.methodIndex));
		const code = asString(body.code);

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
};
