import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager, getStackManager, log } from '$lib/server/init';
import { discoverAllSnippets } from '@openpalm/lib/admin/snippet-discovery';
import type { ResolvedSnippet } from '@openpalm/lib/shared/snippet-types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	let snippets: ResolvedSnippet[] = [];
	try {
		snippets = await discoverAllSnippets();
	} catch (error) {
		log.warn('Snippet discovery failed for /state', { error: String(error) });
		snippets = [];
	}
	return json(200, {
		ok: true,
		data: {
			setup: setupManager.getState(),
			spec: stackManager.getSpec(),
			secrets: stackManager.listSecretManagerState(),
			catalog: stackManager.listStackCatalogItems(snippets),
			channels: stackManager.listChannelNames().map((name) => ({
				name,
				exposure: stackManager.getChannelAccess(name),
				config: stackManager.getChannelConfig(name)
			})),
			services: stackManager.listServiceNames().map((name) => ({
				name,
				config: stackManager.getServiceConfig(name)
			})),
			automations: stackManager.listAutomations()
		}
	});
};
