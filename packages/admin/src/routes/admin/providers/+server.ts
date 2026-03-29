import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import { loadProviderPage } from '$lib/server/opencode-providers.js';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const pageState = await loadProviderPage();
	return jsonResponse(200, pageState, requestId);
};
