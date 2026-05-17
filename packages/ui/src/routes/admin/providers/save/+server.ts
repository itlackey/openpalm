import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	normalizeProviderConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import {
	asRecord,
	asStringOrEmpty,
	updateBooleanOption,
	updateNumberOption,
	updateStringOption,
} from '../_helpers.js';

/**
 * POST /admin/providers/save — Save connection settings (apiKey/baseURL/timeouts/cache)
 * for a single provider into the user's local OpenCode config.
 */
export const POST: RequestHandler = (event) => withAdminBody(event, async ({ requestId, body }) => {
	try {
		const providerId = asStringOrEmpty(body.providerId);
		if (!providerId) {
			return jsonResponse(200, actionFailure('Pick a provider before saving changes.'), requestId);
		}

		const config = await getCurrentConfig();
		const providerConfig = { ...(config.provider ?? {}) };
		const currentEntry = asRecord(providerConfig[providerId]);
		const currentOptions = asRecord(currentEntry?.options) ?? {};
		const nextOptions = { ...currentOptions };

		updateStringOption(nextOptions, 'apiKey', asStringOrEmpty(body.apiKey));
		updateStringOption(nextOptions, 'baseURL', asStringOrEmpty(body.baseURL));
		updateNumberOption(nextOptions, 'timeout', asStringOrEmpty(body.timeout));
		updateNumberOption(nextOptions, 'chunkTimeout', asStringOrEmpty(body.chunkTimeout));
		updateBooleanOption(nextOptions, 'setCacheKey', body.setCacheKey === 'on' || body.setCacheKey === true);

		const nextEntry = normalizeProviderConfig({ ...currentEntry, options: nextOptions });
		if (nextEntry) providerConfig[providerId] = nextEntry;
		else delete providerConfig[providerId];

		config.provider = providerConfig;
		await patchConfig(config);

		return jsonResponse(
			200,
			actionSuccess('Provider settings saved to your local OpenCode config.', providerId),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
});
