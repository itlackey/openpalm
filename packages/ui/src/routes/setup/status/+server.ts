import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { readSecretsEnv, readRuntimeEnv } from '$lib/server/env-helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const setupManager = await getSetupManager();
	const state = setupManager.getState();
	if (state.completed === true && !locals.authenticated)
		return unauthorizedJson();

	const secrets = readSecretsEnv();
	const runtime = readRuntimeEnv();

	return json(200, {
		...state,
		serviceInstances: {
			openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? '',
			psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? '',
			qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ''
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
