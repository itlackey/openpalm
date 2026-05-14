import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	normalizeProviderConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode-providers.js';
import {
	asRecord,
	asString,
	updateBooleanOption,
	updateNumberOption,
	updateStringOption,
} from '../_helpers.js';

/**
 * POST /admin/providers/save — Save connection settings (apiKey/baseURL/timeouts/cache)
 * for a single provider into the user's local OpenCode config.
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
		if (!providerId) {
			return jsonResponse(200, actionFailure('Pick a provider before saving changes.'), requestId);
		}

		const config = await getCurrentConfig();
		const providerConfig = { ...(config.provider ?? {}) };
		const currentEntry = asRecord(providerConfig[providerId]);
		const currentOptions = asRecord(currentEntry?.options) ?? {};
		const nextOptions = { ...currentOptions };

		updateStringOption(nextOptions, 'apiKey', asString(body.apiKey));
		updateStringOption(nextOptions, 'baseURL', asString(body.baseURL));
		updateNumberOption(nextOptions, 'timeout', asString(body.timeout));
		updateNumberOption(nextOptions, 'chunkTimeout', asString(body.chunkTimeout));
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
};
