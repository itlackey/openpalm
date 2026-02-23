import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getSetupManager, getStackManager } from '$lib/server/init';
import { isLocalRequest } from '$lib/server/auth';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine.ts';
import { composeAction } from '@openpalm/lib/admin/compose-runner.ts';
import { syncAutomations } from '@openpalm/lib/admin/automations.ts';
import type { RequestHandler } from './$types';

const CoreStartupServices = ['admin', 'caddy', 'assistant', 'gateway', 'openmemory', 'openmemory-ui', 'postgres', 'qdrant'] as const;

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
		const applyResult = await applyStack(stackManager);
		syncAutomations(stackManager.listAutomations());
		const startupResult = await composeAction('up', [...CoreStartupServices]);
		if (!startupResult.ok) throw new Error(`core_startup_failed:${startupResult.stderr}`);
		const state = setupManager.completeSetup();
		return json(200, { ok: true, state, apply: applyResult });
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
