import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { g as getSetupManager } from './init-C6nnJEAN.js';
import { s as sanitizeEnvScalar } from './runtime-env-BS_YlF-D.js';
import { a as updateRuntimeEnv, b as updateSecretsEnv, c as readSecretsEnv } from './env-helpers-B-Cb62vD.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import { a as applySmallModelToOpencodeConfig } from './opencode-config-CEineNbb.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import 'node:crypto';

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

export { POST };
//# sourceMappingURL=_server.ts-B6wRnfXV.js.map
