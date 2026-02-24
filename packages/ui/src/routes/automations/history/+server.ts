import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { readHistory } from '@openpalm/lib/admin/automation-history';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const id = (url.searchParams.get('id') ?? '').trim();
	const limitRaw = Number(url.searchParams.get('limit') ?? '20');
	const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 20;
	if (!id) return json(400, { error: 'id is required' });
	const stackManager = await getStackManager();
	if (!stackManager.getAutomation(id)) return json(404, { error: 'automation not found' });
	return json(200, { id, logs: readHistory(id, limit) });
};
