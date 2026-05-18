import type { RequestHandler } from './$types';
import { jsonResponse, withAdminBody } from '$lib/server/helpers.js';
import {
	getCurrentConfig,
	patchConfig,
	normalizeProviderConfig,
	actionSuccess,
	actionFailure,
} from '$lib/server/opencode/index.js';
import { getState } from '$lib/server/state.js';
import { createLogger, writeAkmVaultKey } from '@openpalm/lib';
import { PROVIDER_KEY_MAP } from '@openpalm/lib/provider-constants';
import {
	asRecord,
	asStringOrEmpty,
	updateBooleanOption,
	updateNumberOption,
	updateStringOption,
} from '../_helpers.js';

const logger = createLogger('admin.providers.save');

/**
 * Parse a `headers` payload into a flat string→string record. Accepts either:
 *   - an object (already in shape), or
 *   - a newline-separated `KEY=VALUE` text blob (form-friendly).
 * Returns null for empty input.
 */
function parseHeaders(raw: unknown): Record<string, string> | null {
	if (!raw) return null;
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			const key = k.trim();
			if (key && typeof v === 'string' && v.trim()) out[key] = v.trim();
		}
		return Object.keys(out).length ? out : null;
	}
	if (typeof raw !== 'string') return null;
	const out: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf('=');
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key && value) out[key] = value;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * POST /admin/providers/save — Save connection settings for a provider.
 *
 * Writes the provider config to the user's local OpenCode config
 * (apiKey/baseURL/timeout/headers/setCacheKey/enterpriseUrl). When an
 * apiKey is supplied AND we know the canonical env var name for the
 * provider (PROVIDER_KEY_MAP), we ALSO mirror the key into the akm
 * user vault so the assistant container picks it up via the standard
 * env injection — without this mirror, Connections-tab saves only
 * affect the local `opencode` CLI, not the chat assistant.
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

		const apiKey = asStringOrEmpty(body.apiKey);
		updateStringOption(nextOptions, 'apiKey', apiKey);
		updateStringOption(nextOptions, 'baseURL', asStringOrEmpty(body.baseURL));
		updateStringOption(nextOptions, 'enterpriseUrl', asStringOrEmpty(body.enterpriseUrl));
		updateNumberOption(nextOptions, 'timeout', asStringOrEmpty(body.timeout));
		updateBooleanOption(nextOptions, 'setCacheKey', body.setCacheKey === 'on' || body.setCacheKey === true);

		const headers = parseHeaders(body.headers);
		if (headers) nextOptions.headers = headers;
		else delete nextOptions.headers;

		const nextEntry = normalizeProviderConfig({ ...currentEntry, options: nextOptions });
		if (nextEntry) providerConfig[providerId] = nextEntry;
		else delete providerConfig[providerId];

		config.provider = providerConfig;
		await patchConfig(config);

		// Mirror the apiKey into the akm user vault so the assistant
		// container receives it via env injection. Best-effort: failure
		// here doesn't fail the save (the opencode.json write succeeded).
		let mirrored: string | null = null;
		const envVar = PROVIDER_KEY_MAP[providerId];
		if (apiKey && envVar) {
			try {
				const state = getState();
				const ok = await writeAkmVaultKey(state, envVar, apiKey);
				if (ok) mirrored = envVar;
				else logger.warn('vault mirror skipped (akm unavailable)', { providerId, envVar, requestId });
			} catch (err) {
				logger.warn('vault mirror failed', { providerId, envVar, reason: String(err), requestId });
			}
		}

		const message = mirrored
			? `Provider settings saved. API key mirrored to akm user vault (${mirrored}) — recreate the assistant to apply.`
			: 'Provider settings saved to your local OpenCode config.';

		return jsonResponse(
			200,
			actionSuccess(message, providerId),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
});
