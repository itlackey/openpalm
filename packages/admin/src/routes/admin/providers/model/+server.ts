import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { asStringOrEmpty } from '../_helpers.js';

/**
 * POST /admin/providers/model — Pick a model for either the main `model`
 * slot or the `small_model` slot in the user's OpenCode config.
 * Body: { providerId, modelId, target: 'model' | 'small_model' }.
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		const modelId = asStringOrEmpty(body.modelId);
		const target = asStringOrEmpty(body.target);

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
});
