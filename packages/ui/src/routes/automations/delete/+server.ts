import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { syncAutomations } from '@openpalm/lib/admin/automations.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { id?: string };
	if (!body.id) return json(400, { error: 'id is required' });
	try {
		const deleted = stackManager.deleteAutomation(body.id);
		if (!deleted) return json(404, { error: 'automation not found' });
		syncAutomations(stackManager.listAutomations());
		return json(200, { ok: true, deleted: body.id });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === 'cannot_delete_core_automation')
			return json(400, { error: message });
		throw error;
	}
};
