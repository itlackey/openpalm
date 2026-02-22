import { json, unauthorizedJson } from '$lib/server/json';
import { getSetupManager } from '$lib/server/init';
import { sanitizeEnvScalar } from '@openpalm/lib/admin/runtime-env';
import {
	updateRuntimeEnv,
	updateSecretsEnv,
	readSecretsEnv
} from '$lib/server/env-helpers';
import { applySmallModelToOpencodeConfig } from '$lib/server/opencode-config';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const setupManager = await getSetupManager();
	const body = (await request.json()) as {
		openmemory?: string;
		psql?: string;
		qdrant?: string;
		openaiBaseUrl?: string;
		openaiApiKey?: string;
		anthropicApiKey?: string;
		smallModelEndpoint?: string;
		smallModelApiKey?: string;
		smallModelId?: string;
	};

	const current = setupManager.getState();
	if (current.completed && !locals.authenticated) return unauthorizedJson();

	const openmemory = sanitizeEnvScalar(body.openmemory);
	const psql = sanitizeEnvScalar(body.psql);
	const qdrant = sanitizeEnvScalar(body.qdrant);
	const openaiBaseUrl = sanitizeEnvScalar(body.openaiBaseUrl);
	const openaiApiKey = sanitizeEnvScalar(body.openaiApiKey);
	const anthropicApiKey = sanitizeEnvScalar(body.anthropicApiKey);
	const smallModelEndpoint = sanitizeEnvScalar(body.smallModelEndpoint);
	const smallModelApiKey = sanitizeEnvScalar(body.smallModelApiKey);
	const smallModelId = sanitizeEnvScalar(body.smallModelId);

	updateRuntimeEnv({
		OPENMEMORY_URL: openmemory || undefined,
		OPENMEMORY_POSTGRES_URL: psql || undefined,
		OPENMEMORY_QDRANT_URL: qdrant || undefined
	});

	const secretEntries: Record<string, string | undefined> = {
		OPENAI_BASE_URL: openaiBaseUrl || undefined
	};
	if (openaiApiKey.length > 0) secretEntries.OPENAI_API_KEY = openaiApiKey;
	if (anthropicApiKey.length > 0) secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
	if (smallModelApiKey.length > 0) secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
	updateSecretsEnv(secretEntries);

	const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });
	if (smallModelId) {
		setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
		applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
	}

	const secrets = readSecretsEnv();
	return json(200, {
		ok: true,
		state,
		openmemoryProvider: {
			openaiBaseUrl: secrets.OPENAI_BASE_URL ?? '',
			openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
		},
		smallModelProvider: {
			endpoint: state.smallModel.endpoint,
			modelId: state.smallModel.modelId,
			apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
		}
	});
};
