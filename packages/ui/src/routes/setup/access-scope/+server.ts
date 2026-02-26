import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager, getStackManager } from '$lib/server/init';
import { setRuntimeBindScope } from '$lib/server/env-helpers';
import { isLocalRequest } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { scope: 'host' | 'lan' | 'public' };
	if (!['host', 'lan', 'public'].includes(body.scope))
		return json(400, { error: 'invalid scope' });

	const current = setupManager.getState();
	if (current.completed && !locals.authenticated) return unauthorizedJson();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!current.completed && !isLocalRequest(request, locals.clientAddress)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	stackManager.setAccessScope(body.scope);
	await setRuntimeBindScope(body.scope);
	const state = setupManager.setAccessScope(body.scope);
	return json(200, { ok: true, state });
};
