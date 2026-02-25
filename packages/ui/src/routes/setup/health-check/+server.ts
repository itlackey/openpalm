import { json } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { readRuntimeEnv } from '$lib/server/env-helpers';
import { isLocalRequest } from '$lib/server/auth';
import { checkServiceHealth } from '$lib/server/health';
import {
	GATEWAY_URL,
	OPENPALM_ASSISTANT_URL,
	OPENMEMORY_URL as DEFAULT_OPENMEMORY_URL
} from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!state.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	const runtime = readRuntimeEnv();
	const serviceInstances = {
		openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? '',
		psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? '',
		qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ''
	};
	const openmemoryBaseUrl = serviceInstances.openmemory || DEFAULT_OPENMEMORY_URL;
	const [gateway, assistant, openmemory] = await Promise.all([
		checkServiceHealth(`${GATEWAY_URL}/health`),
		checkServiceHealth(`${OPENPALM_ASSISTANT_URL}/`, false),
		checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`)
	]);
	return json(200, {
		services: {
			gateway,
			assistant,
			openmemory,
			admin: { ok: true, time: new Date().toISOString() }
		},
		serviceInstances
	});
};
