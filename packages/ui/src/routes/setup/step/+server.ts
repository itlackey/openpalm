import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const current = setupManager.getState();

	// If setup is already completed, require authentication
	if (current.completed && !locals.authenticated) return unauthorizedJson();

	// SECURITY: During initial setup (completed=false), restrict to local/private IPs only.
	// This mitigates the risk of unauthenticated network access to setup endpoints before
	// an admin token has been configured.
	if (!current.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	const body = (await request.json()) as { step: string };
	const validSteps = [
		'welcome',
		'accessScope',
		'serviceInstances',
		'healthCheck',
		'security',
		'channels'
	];
	if (!validSteps.includes(body.step)) return json(400, { error: 'invalid step' });
	const state = setupManager.completeStep(
		body.step as 'welcome' | 'accessScope' | 'serviceInstances' | 'healthCheck' | 'security' | 'channels'
	);
	return json(200, { ok: true, state });
};
