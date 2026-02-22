import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { parseStackSpec } from '@openpalm/lib/admin/stack-spec';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const spec = stackManager.getSpec();
	return json(200, { ok: true, spec });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { spec?: unknown };
	if (!body.spec) return json(400, { error: 'spec is required' });
	const parsed = parseStackSpec(body.spec);
	const secretErrors = stackManager.validateReferencedSecrets(parsed);
	if (secretErrors.length > 0) {
		return errorJson(400, 'secret_reference_validation_failed', secretErrors);
	}
	// Save the parsed/validated result, not the raw input
	const spec = stackManager.setSpec(parsed);
	return json(200, { ok: true, spec });
};
