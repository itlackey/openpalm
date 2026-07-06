import type { RequestHandler } from './$types';
import { requireAdmin, requireCapability, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import { loadProviderPage } from '$lib/server/opencode/catalog.js';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:secrets', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const pageState = await loadProviderPage();
	return jsonResponse(200, pageState, requestId);
};
