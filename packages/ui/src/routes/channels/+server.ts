import { json, unauthorizedJson } from '$lib/server/json';
import { getStackManager } from '$lib/server/init';
import { isBuiltInChannel } from '@openpalm/lib/admin/stack-spec';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.authenticated) return unauthorizedJson();
	const stackManager = await getStackManager();
	const spec = stackManager.getSpec();
	const channelNames = stackManager.listChannelNames();
	return json(200, {
		channels: channelNames.map((channelName) => ({
			service: `channel-${channelName}`,
			label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
			builtIn: isBuiltInChannel(channelName),
			access: stackManager.getChannelAccess(channelName),
			config: { ...spec.channels[channelName].config },
			channelSpec: spec.channels[channelName]
		}))
	});
};
