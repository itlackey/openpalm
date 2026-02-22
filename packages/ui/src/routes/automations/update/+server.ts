import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { validateCron } from '@openpalm/lib/admin/cron';
import { syncAutomations } from '@openpalm/lib/admin/automations';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as {
		id?: string;
		name?: string;
		schedule?: string;
		script?: string;
		enabled?: boolean;
	};
	if (!body.id) return json(400, { error: 'id is required' });
	const existing = stackManager.getAutomation(body.id);
	if (!existing) return json(404, { error: 'automation not found' });
	const updated = { ...existing, ...body, id: existing.id };
	const cronError = validateCron(updated.schedule);
	if (cronError) return json(400, { error: `invalid cron expression: ${cronError}` });
	const automation = stackManager.upsertAutomation(updated);
	syncAutomations(stackManager.listAutomations());
	return json(200, { ok: true, automation });
};
