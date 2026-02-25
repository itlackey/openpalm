import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import { setCoreReadinessPhase, applyReadinessResult } from '$lib/server/core-readiness-state';
import { ensureCoreServicesReady } from '@openpalm/lib/admin/core-readiness';
import { SetupStartupServices } from '@openpalm/lib/admin/compose-runner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();

	// Allow unauthenticated access during initial setup (local only)
	if (state.completed === true && !locals.authenticated) return unauthorizedJson();
	if (!state.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	setCoreReadinessPhase('checking');

	try {
		const result = await ensureCoreServicesReady({
			targetServices: SetupStartupServices,
			maxAttempts: 6,
			pollIntervalMs: 2_000
		});
		const snapshot = applyReadinessResult(result);
		return json(200, { ok: true, ...snapshot });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		setCoreReadinessPhase('failed');
		return errorJson(500, 'readiness_check_failed', message);
	}
};
