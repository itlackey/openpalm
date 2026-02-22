import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { readSecretsRaw, writeSecretsRaw, validateSecretsRawContent } from '$lib/server/env-helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const content = readSecretsRaw();
	return new Response(content, {
		headers: {
			'content-type': 'text/plain',
			'access-control-allow-origin': '*'
		}
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { content?: string };
	if (typeof body.content !== 'string') return json(400, { error: 'content is required' });
	const validationError = validateSecretsRawContent(body.content);
	if (validationError) return json(400, { error: validationError });
	writeSecretsRaw(body.content);
	stackManager.renderArtifacts();
	return json(200, { ok: true });
};
