import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_TOKEN } from '$lib/server/env';
import { getSetupManager } from '$lib/server/stores';
import {
  normalizeServiceInstanceUrl,
  sanitizeEnvScalar,
  updateRuntimeEnv,
  updateSecretsEnv,
  getConfiguredOpenmemoryProvider,
  getConfiguredSmallModel,
  applySmallModelToOpencodeConfig,
} from '$lib/server/helpers';

export const POST: RequestHandler = async ({ request }) => {
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

  const setupManager = getSetupManager();
  const current = setupManager.getState();

  if (current.completed && request.headers.get('x-admin-token') !== ADMIN_TOKEN) {
    return json({ error: "admin token required" }, { status: 401 });
  }

  const openmemory = normalizeServiceInstanceUrl(body.openmemory);
  const psql = normalizeServiceInstanceUrl(body.psql);
  const qdrant = normalizeServiceInstanceUrl(body.qdrant);
  const openaiBaseUrl = sanitizeEnvScalar(body.openaiBaseUrl);
  const openaiApiKey = sanitizeEnvScalar(body.openaiApiKey);
  const anthropicApiKey = sanitizeEnvScalar(body.anthropicApiKey);
  const smallModelEndpoint = sanitizeEnvScalar(body.smallModelEndpoint);
  const smallModelApiKey = sanitizeEnvScalar(body.smallModelApiKey);
  const smallModelId = sanitizeEnvScalar(body.smallModelId);

  updateRuntimeEnv({
    OPENMEMORY_URL: openmemory || undefined,
    OPENMEMORY_POSTGRES_URL: psql || undefined,
    OPENMEMORY_QDRANT_URL: qdrant || undefined,
  });

  const secretEntries: Record<string, string | undefined> = {
    OPENAI_BASE_URL: openaiBaseUrl || undefined,
  };

  // Allow clearing keys by setting to undefined when explicitly provided as empty
  if (body.openaiApiKey !== undefined) {
    secretEntries.OPENAI_API_KEY = openaiApiKey || undefined;
  }
  if (body.anthropicApiKey !== undefined) {
    secretEntries.ANTHROPIC_API_KEY = anthropicApiKey || undefined;
  }
  if (body.smallModelApiKey !== undefined) {
    secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey || undefined;
  }

  updateSecretsEnv(secretEntries);

  const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });

  if (smallModelId) {
    setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
    applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
  }

  return json({
    ok: true,
    state,
    openmemoryProvider: getConfiguredOpenmemoryProvider(),
    smallModelProvider: getConfiguredSmallModel(),
  });
};
