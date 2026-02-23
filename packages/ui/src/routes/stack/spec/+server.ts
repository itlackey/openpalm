import { json, unauthorizedJson, errorJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { parseStackSpec, stringifyStackSpec } from '@openpalm/lib/admin/stack-spec';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const spec = stackManager.getSpec();
	return json(200, { ok: true, spec, yaml: stringifyStackSpec(spec) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const body = (await request.json()) as { spec?: unknown; yaml?: string };
	const raw = body.yaml ? (Bun.YAML.parse(body.yaml) as unknown) : body.spec;
	if (!raw) return json(400, { error: 'spec or yaml is required' });
	const parsed = parseStackSpec(raw);
	const secretErrors = stackManager.validateReferencedSecrets(parsed);
	if (secretErrors.length > 0) {
		return errorJson(400, 'secret_reference_validation_failed', secretErrors);
	}
	const spec = stackManager.setSpec(parsed);
	return json(200, { ok: true, spec, yaml: stringifyStackSpec(spec) });
};
