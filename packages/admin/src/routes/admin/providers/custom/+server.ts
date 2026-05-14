import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode-providers.js';
import { asString, buildModelConfig, parseHeaders, parseModels } from '../_helpers.js';

/**
 * POST /admin/providers/custom — Save (or replace) a user-defined custom
 * OpenAI-compatible provider entry in the user's OpenCode config.
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
		const displayName = asString(body.displayName);
		const baseURL = asString(body.baseURL);
		const apiKey = asString(body.apiKey);
		const confirmOverwrite = asString(body.confirmOverwrite) === 'true';

		if (!providerId || !/^[a-z0-9_-]+$/.test(providerId)) {
			return jsonResponse(
				200,
				actionFailure('Use a lowercase provider id with letters, numbers, hyphens, or underscores.'),
				requestId,
			);
		}

		if (!displayName || !baseURL) {
			return jsonResponse(
				200,
				actionFailure('Display name and base URL are required for a custom provider.', providerId),
				requestId,
			);
		}

		const models = parseModels(asString(body.modelsJson));
		const headers = parseHeaders(asString(body.headersJson));
		const config = await getCurrentConfig();
		const providerConfig = { ...(config.provider ?? {}) };

		if (providerConfig[providerId] && !confirmOverwrite) {
			return jsonResponse(
				200,
				actionFailure('A provider with this ID already exists. Enable overwrite to replace it.', providerId),
				requestId,
			);
		}

		const entry: Record<string, unknown> = {
			npm: '@ai-sdk/openai-compatible',
			name: displayName,
			options: {
				baseURL,
				...(apiKey ? { apiKey } : {}),
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			},
		};
		if (models.length > 0) {
			entry.models = Object.fromEntries(models.map((m) => [m.id, buildModelConfig(m)]));
		}
		providerConfig[providerId] = entry;

		config.provider = providerConfig;
		await patchConfig(config);

		return jsonResponse(
			200,
			actionSuccess('Custom provider saved to your OpenCode config.', providerId),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
};
