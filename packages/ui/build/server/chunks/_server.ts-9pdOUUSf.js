import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { g as getSetupManager } from './init-C6nnJEAN.js';
import { c as readSecretsEnv, e as readRuntimeEnv, r as readDataEnv } from './env-helpers-B-Cb62vD.js';
import { i as isLocalRequest } from './auth-0WRDks2O.js';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:fs';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './runtime-env-BS_YlF-D.js';
import 'node:crypto';

const GET = async ({ locals, request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (state.completed === true && !locals.authenticated)
    return unauthorizedJson();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const secrets = readSecretsEnv();
  const runtime = readRuntimeEnv();
  const dataEnv = readDataEnv();
  return json(200, {
    ...state,
    serviceInstances: {
      openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? "",
      psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? "",
      qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ""
    },
    profile: {
      name: dataEnv.OPENPALM_PROFILE_NAME ?? state.profile?.name ?? "",
      email: dataEnv.OPENPALM_PROFILE_EMAIL ?? state.profile?.email ?? ""
    },
    openmemoryProvider: {
      openaiBaseUrl: secrets.OPENAI_BASE_URL ?? "",
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

export { GET };
//# sourceMappingURL=_server.ts-9pdOUUSf.js.map
