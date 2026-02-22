import { json, unauthorizedJson } from '$lib/server/json';
import { BUILTIN_CHANNELS } from '@openpalm/lib/assets/channels/index';
import { CORE_AUTOMATIONS } from '@openpalm/lib/assets/automations/index';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	return json(200, {
		ok: true,
		builtInChannels: Object.entries(BUILTIN_CHANNELS).map(([key, def]) => ({
			key,
			name: def.name,
			containerPort: def.containerPort,
			rewritePath: def.rewritePath,
			configKeys: def.configKeys
		})),
		coreAutomations: CORE_AUTOMATIONS.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description,
			schedule: a.schedule
		}))
	});
};
