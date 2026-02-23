import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine.ts';
import { syncAutomations } from '@openpalm/lib/admin/automations.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	try {
		const result = await applyStack(stackManager);
		syncAutomations(stackManager.listAutomations());
		return json(200, result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('secret_validation_failed:')) {
			return errorJson(
				400,
				'secret_reference_validation_failed',
				message.replace('secret_validation_failed:', '').split(',')
			);
		}
		return errorJson(500, 'stack_apply_failed', message);
	}
};
