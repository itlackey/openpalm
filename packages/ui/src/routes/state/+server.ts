import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	return json(200, {
		ok: true,
		data: {
			spec: stackManager.getSpec(),
			secrets: stackManager.listSecretManagerState(),
			channels: stackManager.listChannelNames().map((name) => ({
				name,
				exposure: stackManager.getChannelAccess(name),
				config: stackManager.getChannelConfig(name)
			})),
			services: stackManager.listServiceNames().map((name) => ({
				name,
				config: stackManager.getServiceConfig(name)
			}))
		}
	});
};
