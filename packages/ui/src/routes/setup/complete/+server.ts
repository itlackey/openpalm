import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getSetupManager, getStackManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import { completeSetupRouteResponse } from '$lib/server/setup-completion-response';
import { SECRETS_ENV_PATH } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	const current = setupManager.getState();
	if (current.completed === true && !locals.authenticated) return unauthorizedJson();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!current.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	try {
		return json(200, await completeSetupRouteResponse(setupManager, stackManager, SECRETS_ENV_PATH));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('secret_validation_failed:')) {
			return errorJson(
				400,
				'secret_reference_validation_failed',
				message.replace('secret_validation_failed:', '').split(',')
			);
		}
		return errorJson(500, 'setup_complete_failed', message);
	}
};
