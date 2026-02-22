import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const setupManager = await getSetupManager();
	const current = setupManager.getState();
	if (current.completed === true && !locals.authenticated) return unauthorizedJson();
	const state = setupManager.completeSetup();
	return json(200, { ok: true, state });
};
