import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode-providers.js';
import { asString } from '../_helpers.js';

/**
 * POST /admin/providers/model — Pick a model for either the main `model`
 * slot or the `small_model` slot in the user's OpenCode config.
 * Body: { providerId, modelId, target: 'model' | 'small_model' }.
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
		const modelId = asString(body.modelId);
		const target = asString(body.target);

		if (!providerId || !modelId || (target !== 'model' && target !== 'small_model')) {
			return jsonResponse(
				200,
				actionFailure('Choose a provider model before saving it.'),
				requestId,
			);
		}

		const config = await getCurrentConfig();
		config[target] = `${providerId}/${modelId}`;
		await patchConfig(config);

		return jsonResponse(
			200,
			actionSuccess(
				target === 'model'
					? 'Main model updated for this project.'
					: 'Small model updated for lightweight tasks.',
				providerId,
			),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
};
