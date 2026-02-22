import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	return json(200, { ok: true, ...stackManager.listSecretManagerState() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { name?: string; value?: string };
	try {
		const name = stackManager.upsertSecret(body.name, body.value);
		return json(200, { ok: true, name });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === 'invalid_secret_name') return errorJson(400, message);
		throw error;
	}
};
