import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { readDataEnv, readSecretsEnv, readRuntimeEnv } from '$lib/server/env-helpers';
import { isLocalRequest } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();
	if (state.completed === true && !locals.authenticated)
		return unauthorizedJson();

	// SECURITY: During initial setup, restrict to local/private IPs only.
	if (!state.completed && !isLocalRequest(request)) {
		return json(403, { error: 'setup endpoints are restricted to local network access' });
	}

	const secrets = readSecretsEnv();
	const runtime = readRuntimeEnv();
	const dataEnv = readDataEnv();

	return json(200, {
		...state,
		serviceInstances: {
			openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? '',
			psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? '',
			qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ''
		},
		profile: {
			name: dataEnv.OPENPALM_PROFILE_NAME ?? state.profile?.name ?? '',
			email: dataEnv.OPENPALM_PROFILE_EMAIL ?? state.profile?.email ?? ''
		},
		openmemoryProvider: {
			openaiBaseUrl: secrets.OPENAI_BASE_URL ?? '',
			openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
		},
		smallModelProvider: {
			endpoint: state.smallModel.endpoint,
			modelId: state.smallModel.modelId,
			apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
		},
		anthropicKeyConfigured: Boolean(secrets.ANTHROPIC_API_KEY),
		firstBoot: setupManager.isFirstBoot()
	});
};
