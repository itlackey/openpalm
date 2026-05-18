import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId, parseJsonBody, jsonBodyError, getOpenCodeClient } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { createLogger } from '@openpalm/lib';
import { asStringOrEmpty, buildModelConfig, parseHeaders, parseModels } from '../_helpers.js';

const logger = createLogger('admin.providers.custom');

/** Allowed format for a custom provider id: lowercase letters, digits, hyphens, underscores. */
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9_-]+$/;

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
		const providerId = asStringOrEmpty(body.providerId);
		const displayName = asStringOrEmpty(body.displayName);
		const baseURL = asStringOrEmpty(body.baseURL);
		const apiKey = asStringOrEmpty(body.apiKey);
		const confirmOverwrite = asStringOrEmpty(body.confirmOverwrite) === 'true';

		if (!providerId || !CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
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

		const models = parseModels(asStringOrEmpty(body.modelsJson));
		const headers = parseHeaders(asStringOrEmpty(body.headersJson));
		const config = await getCurrentConfig();
		const providerConfig = { ...(config.provider ?? {}) };

		if (providerConfig[providerId] && !confirmOverwrite) {
			return jsonResponse(
				200,
				actionFailure('A provider with this ID already exists. Enable overwrite to replace it.', providerId),
				requestId,
			);
		}

		// Register the provider shell (npm, name, baseURL, headers, models)
		// in opencode.json. The apiKey is NOT stored here — credentials go
		// through OpenCode's auth endpoint so auth.json is the single
		// source of truth.
		const entry: Record<string, unknown> = {
			npm: '@ai-sdk/openai-compatible',
			name: displayName,
			options: {
				baseURL,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			},
		};
		if (models.length > 0) {
			entry.models = Object.fromEntries(models.map((m) => [m.id, buildModelConfig(m)]));
		}
		providerConfig[providerId] = entry;

		config.provider = providerConfig;
		await patchConfig(config);

		// If the operator supplied an API key, route it to auth.json via
		// OpenCode. Best-effort — the provider shell write is the primary
		// success path; auth.json can be set later via the Connections tab.
		if (apiKey) {
			try {
				const result = await getOpenCodeClient().setProviderApiKey(providerId, apiKey);
				if (!result.ok) {
					logger.warn('custom provider apiKey save failed', { providerId, code: result.code, message: result.message, requestId });
				}
			} catch (err) {
				logger.warn('custom provider apiKey threw', { providerId, error: String(err), requestId });
			}
		}

		return jsonResponse(
			200,
			actionSuccess('Custom provider saved.', providerId),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
};
