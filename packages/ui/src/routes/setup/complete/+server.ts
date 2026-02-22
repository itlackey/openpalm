import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const current = setupManager.getState();
	if (current.completed === true && !locals.authenticated) return unauthorizedJson();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!current.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}
	const state = setupManager.completeSetup();
	return json(200, { ok: true, state });
};
