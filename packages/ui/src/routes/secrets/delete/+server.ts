import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { name?: string };
	try {
		const deleted = stackManager.deleteSecret(body.name);
		return json(200, { ok: true, deleted });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === 'invalid_secret_name' || message === 'secret_in_use')
			return errorJson(400, message);
		throw error;
	}
};
