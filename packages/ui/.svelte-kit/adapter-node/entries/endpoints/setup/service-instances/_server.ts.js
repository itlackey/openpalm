import { u as unauthorizedJson, j as json } from "../../../../chunks/json.js";
import { a as getSetupManager } from "../../../../chunks/init.js";
import { s as sanitizeEnvScalar } from "../../../../chunks/runtime-env.js";
import { a as updateRuntimeEnv, b as updateSecretsEnv, c as readSecretsEnv } from "../../../../chunks/env-helpers.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
import { a as applySmallModelToOpencodeConfig } from "../../../../chunks/opencode-config.js";
const POST = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const body = await request.json();
  const current = setupManager.getState();
  if (current.completed && !locals.authenticated) return unauthorizedJson();
  if (!current.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const openmemory = sanitizeEnvScalar(body.openmemory);
  const psql = sanitizeEnvScalar(body.psql);
  const qdrant = sanitizeEnvScalar(body.qdrant);
  const openaiBaseUrl = sanitizeEnvScalar(body.openaiBaseUrl);
  const openaiApiKey = sanitizeEnvScalar(body.openaiApiKey);
  const anthropicApiKey = sanitizeEnvScalar(body.anthropicApiKey);
  const smallModelEndpoint = sanitizeEnvScalar(body.smallModelEndpoint);
  const smallModelApiKey = sanitizeEnvScalar(body.smallModelApiKey);
  const smallModelId = sanitizeEnvScalar(body.smallModelId);
  await updateRuntimeEnv({
    OPENMEMORY_URL: openmemory || void 0,
    OPENMEMORY_POSTGRES_URL: psql || void 0,
    OPENMEMORY_QDRANT_URL: qdrant || void 0
  });
  const secretEntries = {
    OPENAI_BASE_URL: openaiBaseUrl || void 0
  };
  if (openaiApiKey.length > 0) secretEntries.OPENAI_API_KEY = openaiApiKey;
  if (anthropicApiKey.length > 0) secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
  if (smallModelApiKey.length > 0) secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
  await updateSecretsEnv(secretEntries);
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
      openaiBaseUrl: secrets.OPENAI_BASE_URL ?? "",
      openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
    },
    smallModelProvider: {
      endpoint: state.smallModel.endpoint,
      modelId: state.smallModel.modelId,
      apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
    }
  });
};
export {
  POST
};
