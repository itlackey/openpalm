import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import { getCoreReadinessSnapshot } from '$lib/server/core-readiness-state';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();

	// Allow unauthenticated access during initial setup (local only)
	if (state.completed === true && !locals.authenticated) return unauthorizedJson();
	if (!state.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	const snapshot = getCoreReadinessSnapshot();
	if (!snapshot) {
		return json(200, { ok: true, phase: 'idle', snapshot: null });
	}

	return json(200, { ok: true, ...snapshot });
};
