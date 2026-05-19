/**
 * GET  /admin/opencode/model — Return OpenCode's current default + small models.
 * POST /admin/opencode/model — Set OpenCode's default and/or small model.
 *
 * These are OpenCode's own settings — the same fields its desktop UI's
 * Settings → Models tab manages. We only touch opencode.json (via
 * setMainModel / unsetMainModel). stack.yml `capabilities.llm` is a
 * separate OpenPalm-side concept managed by the Capabilities tab.
 */
import type { RequestHandler } from './$types';
import {
	requireAdmin,
	jsonResponse,
	errorResponse,
	getRequestId,
	parseJsonBody,
	jsonBodyError,
	getOpenCodeClient,
} from '$lib/server/helpers.js';
import { setMainModel, unsetMainModel } from '$lib/server/opencode/config.js';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const config = await getOpenCodeClient().getConfig();
	if (!config) {
		return errorResponse(503, 'opencode_unavailable', 'OpenCode is not reachable', {}, requestId);
	}

	return jsonResponse(
		200,
		{
			model: (config.model as string | undefined) ?? '',
			small_model: (config.small_model as string | undefined) ?? '',
		},
		requestId,
	);
};

/** Parse a "provider/model" string. Returns null if the input is empty or malformed. */
function parseProviderModel(raw: unknown): { provider: string; model: string } | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const result = await parseJsonBody(event.request);
	if ('error' in result) return jsonBodyError(result, requestId);
	const body = result.data;

	const hasModel = 'model' in body;
	const hasSmallModel = 'small_model' in body;
	if (!hasModel && !hasSmallModel) {
		return errorResponse(400, 'bad_request', 'model or small_model is required', {}, requestId);
	}

	try {
		if (hasModel) {
			if (body.model === null || body.model === '') {
				await unsetMainModel('model');
			} else {
				const parsed = parseProviderModel(body.model);
				if (!parsed) {
					return errorResponse(400, 'bad_request', 'model must be in "provider/model" format', {}, requestId);
				}
				await setMainModel(parsed.provider, parsed.model, 'model');
			}
		}
		if (hasSmallModel) {
			if (body.small_model === null || body.small_model === '') {
				await unsetMainModel('small_model');
			} else {
				const parsed = parseProviderModel(body.small_model);
				if (!parsed) {
					return errorResponse(400, 'bad_request', 'small_model must be in "provider/model" format', {}, requestId);
				}
				await setMainModel(parsed.provider, parsed.model, 'small_model');
			}
		}
	} catch (e) {
		console.warn('[opencode.model] Failed to persist model selection', e);
		return errorResponse(500, 'internal_error', 'Failed to persist model selection', {}, requestId);
	}

	return jsonResponse(200, { ok: true }, requestId);
};
