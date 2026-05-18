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
} from '../_helpers.js';

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
 * POST /admin/providers/save — Save non-credential connection settings
 * for a provider into opencode.json (baseURL, headers, timeout,
 * setCacheKey, enterpriseUrl). Credentials are NOT handled here —
 * the apiKey field POSTs separately to /admin/opencode/providers/:id/auth
 * which calls OpenCode's `PUT /auth/{providerID}` and lets OpenCode
 * persist the credential to its own auth.json store.
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

		// Strip any apiKey that may still be present in the existing
		// options blob — Phase D moved credentials out of opencode.json.
		// Leaving them here would shadow auth.json and re-introduce the
		// split-source-of-truth bug.
		delete nextOptions.apiKey;

		const baseURL = asStringOrEmpty(body.baseURL);
		const enterpriseUrl = asStringOrEmpty(body.enterpriseUrl);
		if (baseURL) nextOptions.baseURL = baseURL; else delete nextOptions.baseURL;
		if (enterpriseUrl) nextOptions.enterpriseUrl = enterpriseUrl; else delete nextOptions.enterpriseUrl;
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

		return jsonResponse(
			200,
			actionSuccess('Provider settings saved.', providerId),
			requestId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse(200, actionFailure(message), requestId);
	}
});
