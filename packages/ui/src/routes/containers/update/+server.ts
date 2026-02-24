import { json, unauthorizedJson } from '$lib/server/json';
import { knownServices } from '$lib/server/init';
import { composeAction, composePull } from '@openpalm/lib/admin/compose-runner';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const body = (await request.json()) as { service: string };
	if (!body.service || !(await knownServices()).has(body.service))
		return json(400, { error: 'unknown service name' });
	const pullResult = await composePull(body.service);
	if (!pullResult.ok) throw new Error(pullResult.stderr || 'service_pull_failed');
	await composeAction('up', body.service);
	return json(200, { ok: true, action: 'update', service: body.service });
};
