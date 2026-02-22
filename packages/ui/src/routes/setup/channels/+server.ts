import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager, getStackManager, allChannelServiceNames } from '$lib/server/init';
import { updateRuntimeEnv } from '$lib/server/env-helpers';
import type { RequestHandler } from './$types';

async function normalizeSelectedChannels(value: unknown): Promise<string[]> {
	if (!Array.isArray(value)) return [];
	const validServices = new Set(await allChannelServiceNames());
	const selected: string[] = [];
	for (const service of value) {
		if (typeof service !== 'string') continue;
		if (!validServices.has(service)) continue;
		if (selected.includes(service)) continue;
		selected.push(service);
	}
	return selected;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const stackManager = await getStackManager();
	const body = (await request.json()) as {
		channels?: unknown;
		channelConfigs?: Record<string, Record<string, string>>;
	};
	const current = setupManager.getState();
	if (current.completed && !locals.authenticated) return unauthorizedJson();

	const channels = await normalizeSelectedChannels(body.channels);
	updateRuntimeEnv({
		OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(',') : undefined
	});

	if (body.channelConfigs && typeof body.channelConfigs === 'object') {
		for (const [service, values] of Object.entries(body.channelConfigs)) {
			const channelName = service.replace('channel-', '');
			if (
				stackManager.listChannelNames().includes(channelName) &&
				values &&
				typeof values === 'object'
			) {
				stackManager.setChannelConfig(channelName, values);
			}
		}
	}

	const spec = stackManager.getSpec();
	for (const channelName of stackManager.listChannelNames()) {
		const service = `channel-${channelName}`;
		spec.channels[channelName].enabled = channels.includes(service);
	}
	stackManager.setSpec(spec);

	const state = setupManager.setEnabledChannels(channels);
	return json(200, { ok: true, state });
};
