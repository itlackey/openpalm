import { json, unauthorizedJson } from '$lib/server/json';
import { knownServices } from '$lib/server/init';
import { composeAction } from '@openpalm/lib/admin/compose-runner.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const body = (await request.json()) as { service: string };
	if (!body.service || !(await knownServices()).has(body.service))
		return json(400, { error: 'unknown service name' });
	await composeAction('restart', body.service);
	return json(200, { ok: true, action: 'restart', service: body.service });
};
