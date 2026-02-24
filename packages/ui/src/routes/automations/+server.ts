import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { getLatestRun } from '@openpalm/lib/admin/automation-history';
import { validateCron } from '@openpalm/lib/admin/cron';
import { syncAutomations } from '@openpalm/lib/admin/automations';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const automations = stackManager.listAutomations().map((automation) => ({
		...automation,
		lastRun: getLatestRun(automation.id)
	}));
	return json(200, { automations });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as {
		name?: string;
		schedule?: string;
		script?: string;
		enabled?: boolean;
	};
	if (!body.name || !body.schedule || !body.script) {
		return json(400, { error: 'name, schedule, and script are required' });
	}
	const cronError = validateCron(body.schedule);
	if (cronError) return json(400, { error: `invalid cron expression: ${cronError}` });
	const automation = stackManager.upsertAutomation({
		id: randomUUID(),
		name: body.name,
		schedule: body.schedule,
		script: body.script,
		enabled: body.enabled ?? true
	});
	syncAutomations(stackManager.listAutomations());
	return json(201, { ok: true, automation });
};
