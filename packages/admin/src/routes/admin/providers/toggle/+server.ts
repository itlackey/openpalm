import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	setProviderEnabled,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { asStringOrEmpty } from '../_helpers.js';

/**
 * POST /admin/providers/toggle — Enable or disable a provider for OpenCode
 * model selection. Body: { providerId, enabled: 'true' | 'false' }.
 */
export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const parsed = await parseJsonBody(event.request);
	if ('error' in parsed) return jsonBodyError(parsed, requestId);

	const body = parsed.data;

	try {
		const providerId = asStringOrEmpty(body.providerId);
		const nextState = asStringOrEmpty(body.enabled) === 'true';
		if (!providerId) {
			return jsonResponse(
				200,
				actionFailure('Pick a provider before changing its availability.'),
				requestId,
			);
		}

		const config = await getCurrentConfig();
		await patchConfig(setProviderEnabled(config, providerId, nextState));

		return jsonResponse(
			200,
			actionSuccess(
				nextState
					? 'Provider enabled for model selection.'
					: 'Provider disabled for this workspace.',
				providerId,
			),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
};
