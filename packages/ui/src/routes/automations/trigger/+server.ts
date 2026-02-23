import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { triggerAutomation } from '@openpalm/lib/admin/automations.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { id?: string };
	if (!body.id) return json(400, { error: 'id is required' });
	if (!stackManager.getAutomation(body.id))
		return json(404, { error: 'automation not found' });
	const result = await triggerAutomation(body.id);
	return json(200, { triggered: body.id, ...result });
};
