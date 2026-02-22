import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager, getStackManager } from '$lib/server/init';
import { setRuntimeBindScope } from '$lib/server/env-helpers';
import { composeAction } from '@openpalm/lib/admin/compose-runner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { scope: 'host' | 'lan' | 'public' };
	if (!['host', 'lan', 'public'].includes(body.scope))
		return json(400, { error: 'invalid scope' });

	const current = setupManager.getState();
	if (current.completed && !locals.authenticated) return unauthorizedJson();

	stackManager.setAccessScope(body.scope);
	setRuntimeBindScope(body.scope);
	if (current.completed) {
		await Promise.all([
			composeAction('up', 'caddy'),
			composeAction('up', 'openmemory'),
			composeAction('up', 'assistant')
		]);
	} else {
		await composeAction('up', 'caddy').catch(() => {});
	}
	const state = setupManager.setAccessScope(body.scope);
	return json(200, { ok: true, state });
};
