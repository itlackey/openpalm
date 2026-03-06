/**
 * GET  /admin/connections — Return current connection config values (masked).
 * POST /admin/connections — Patch secrets.env with provided connection keys,
 *       or perform a unified system connection save when `provider` key is present.
 *
 * Only keys in ALLOWED_CONNECTION_KEYS are readable/writable via this endpoint.
 * API key values are masked (all but last 4 chars) in GET responses.
 * Non-secret config keys are returned as-is.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody,
  parseCanonicalConnectionProfile,
  parseCapabilityAssignments,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  readConnectionProfilesDocument,
  writePrimaryConnectionProfile,
  ALLOWED_CONNECTION_KEYS,
  maskConnectionValue,
  writeOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory,
  checkQdrantDimensions,
  type OpenMemoryConfig,
  type CallerType
} from "$lib/server/control-plane.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  mem0ProviderName,
  mem0BaseUrlConfig
} from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";
import {
  isWizardProviderInScope,
  validateWizardCapabilitiesInput,
} from '$lib/setup-wizard/scope.js';

const logger = createLogger("connections");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.configDir);
  const connections: Record<string, string> = {};
  for (const key of ALLOWED_CONNECTION_KEYS) {
    const value = raw[key] ?? "";
    connections[key] = maskConnectionValue(key, value);
  }

  const canonical = readConnectionProfilesDocument(state.configDir);

  appendAudit(state, actor, "connections.get", {}, true, requestId, callerType);
  return jsonResponse(200, {
    profiles: canonical.profiles,
    assignments: canonical.assignments,
    connections,
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  // ── Unified system connection save (has `provider` key) ───────────
  if (typeof body.provider === "string") {
    return handleUnifiedSave(body, state, actor, callerType, requestId);
  }

  // ── Canonical DTO payload (profiles + assignments) ─────────────────
  if (Array.isArray(body.profiles) && typeof body.assignments === 'object' && body.assignments !== null) {
    return handleCanonicalDtoSave(body, state, actor, callerType, requestId);
  }

  // ── Legacy: patch individual keys ──────────────────────────────────
  const patches: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_CONNECTION_KEYS.has(key) && typeof value === "string") {
      if (key === 'SYSTEM_LLM_PROVIDER' && value && !isWizardProviderInScope(value)) {
        return errorResponse(
          400,
          'bad_request',
          `Provider "${value}" is outside setup wizard v1 scope`,
          {},
          requestId
        );
      }
      patches[key] = value;
    }
  }

  if (Object.keys(patches).length === 0) {
    return errorResponse(400, "bad_request", "No valid connection keys provided", {}, requestId);
  }

  try {
    patchSecretsEnvFile(state.configDir, patches);
    readConnectionProfilesDocument(state.configDir);
  } catch (err) {
    appendAudit(
      state, actor, "connections.patch",
      { keys: Object.keys(patches), error: String(err) },
      false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to update secrets.env", {}, requestId);
  }

  appendAudit(
    state, actor, "connections.patch",
    { keys: Object.keys(patches) },
    true, requestId, callerType
  );
  return jsonResponse(200, { ok: true, updated: Object.keys(patches) }, requestId);
};

// ── Unified save handler ──────────────────────────────────────────────

async function handleUnifiedSave(
  body: Record<string, unknown>,
  state: ReturnType<typeof getState>,
  actor: string,
  callerType: CallerType,
  requestId: string
): Promise<Response> {
  const provider = body.provider as string; // already validated typeof === "string" by caller
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  const systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const openmemoryUserId = typeof body.openmemoryUserId === "string" ? body.openmemoryUserId : "default_user";
  const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions : "";

  if (!isWizardProviderInScope(provider)) {
    return errorResponse(
      400,
      'bad_request',
      `Provider \"${provider}\" is outside setup wizard v1 scope`,
      {},
      requestId
    );
  }

  const capabilitiesValidation = validateWizardCapabilitiesInput(body.capabilities);
  if (!capabilitiesValidation.ok) {
    return errorResponse(400, 'bad_request', capabilitiesValidation.message, {}, requestId);
  }

  // 1. Build secrets.env patches
  const patches: Record<string, string> = {};

  // Map provider → env var, patch API key
  if (apiKey) {
    const envVarName = PROVIDER_KEY_MAP[provider] ?? "OPENAI_API_KEY";
    patches[envVarName] = apiKey;
  }

  patches.SYSTEM_LLM_PROVIDER = provider;
  if (baseUrl) {
    patches.SYSTEM_LLM_BASE_URL = baseUrl;
    const mem0Url = mem0BaseUrlConfig(provider, baseUrl);
    if (mem0Url?.key === "openai_base_url") {
      // OPENAI_BASE_URL is read by the openmemory container as env var fallback
      // for OpenAI-protocol providers. Ollama reads ollama_base_url from config.
      patches.OPENAI_BASE_URL = mem0Url.value;
    }
  }
  if (systemModel) patches.SYSTEM_LLM_MODEL = systemModel;
  if (embeddingModel) patches.EMBEDDING_MODEL = embeddingModel;
  if (embeddingDims) patches.EMBEDDING_DIMS = String(embeddingDims);
  patches.OPENMEMORY_USER_ID = openmemoryUserId;

  try {
    patchSecretsEnvFile(state.configDir, patches);
  } catch (err) {
    appendAudit(
      state, actor, "connections.unified",
      { provider, error: String(err) },
      false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to update secrets.env", {}, requestId);
  }

  // 2. Build and write OpenMemory config
  const apiKeyEnvRef = PROVIDER_KEY_MAP[provider]
    ? `env:${PROVIDER_KEY_MAP[provider]}`
    : (apiKey || "not-needed");

  const llmConfig: Record<string, unknown> = {
    model: systemModel,
    temperature: 0.1,
    max_tokens: 2000,
    api_key: apiKeyEnvRef,
  };
  const mem0BaseUrl = mem0BaseUrlConfig(provider, baseUrl);
  if (mem0BaseUrl) llmConfig[mem0BaseUrl.key] = mem0BaseUrl.value;

  const embedConfig: Record<string, unknown> = {
    model: embeddingModel || "text-embedding-3-small",
    api_key: apiKeyEnvRef,
  };
  if (mem0BaseUrl) embedConfig[mem0BaseUrl.key] = mem0BaseUrl.value;

  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  const omConfig: OpenMemoryConfig = {
    mem0: {
      llm: { provider: mem0ProviderName(provider), config: llmConfig },
      embedder: { provider: mem0ProviderName(provider), config: embedConfig },
      vector_store: {
        provider: "qdrant",
        config: {
          collection_name: "openmemory",
          path: "/data/qdrant",
          embedding_model_dims: resolvedDims,
        },
      },
    },
    openmemory: { custom_instructions: customInstructions },
  };

  // 2b. Check embedding dimension change BEFORE writing (compare new vs previously-persisted)
  let dimensionWarning: string | undefined;
  let dimensionMismatch = false;
  const dimResult = checkQdrantDimensions(state.dataDir, omConfig);
  if (!dimResult.match) {
    dimensionMismatch = true;
    dimensionWarning = `Embedding dimensions changed: current ${dimResult.currentDims}, config expects ${dimResult.expectedDims}. Reset the memory collection to apply.`;
  }

  writeOpenMemoryConfig(state.dataDir, omConfig);

  writePrimaryConnectionProfile(state.configDir, {
    provider,
    baseUrl,
    systemModel,
    embeddingModel: embeddingModel || 'text-embedding-3-small',
    embeddingDims: resolvedDims,
  });

  // 3. Push resolved config to running container
  let pushed = false;
  let pushError: string | undefined;
  try {
    const resolved = resolveConfigForPush(omConfig, state.configDir);
    const pushResult = await pushConfigToOpenMemory(resolved);
    pushed = pushResult.ok;
    if (!pushResult.ok) pushError = pushResult.error;
  } catch (err) {
    pushError = String(err);
  }

  appendAudit(
    state, actor, "connections.unified",
    { provider, pushed, dimensionMismatch },
    true, requestId, callerType
  );

  logger.info("unified connection save", { provider, pushed, dimensionMismatch, requestId });

  return jsonResponse(200, {
    ok: true,
    pushed,
    pushError,
    dimensionWarning,
    dimensionMismatch,
  }, requestId);
}

async function handleCanonicalDtoSave(
  body: Record<string, unknown>,
  state: ReturnType<typeof getState>,
  actor: string,
  callerType: CallerType,
  requestId: string
): Promise<Response> {
  const profiles = body.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return errorResponse(400, 'bad_request', 'profiles must include at least one profile', {}, requestId);
  }

  const profileResult = parseCanonicalConnectionProfile(profiles[0]);
  if (!profileResult.ok) {
    return errorResponse(400, 'bad_request', profileResult.message, {}, requestId);
  }

  const assignmentsResult = parseCapabilityAssignments(body.assignments);
  if (!assignmentsResult.ok) {
    return errorResponse(400, 'bad_request', assignmentsResult.message, {}, requestId);
  }

  const providerValue = (profiles[0] as Record<string, unknown>).provider;
  const profileProvider = typeof providerValue === 'string' ? providerValue : '';
  if (!profileProvider || !isWizardProviderInScope(profileProvider)) {
    return errorResponse(400, 'bad_request', 'profiles[0].provider is required and must be in wizard scope', {}, requestId);
  }

  const profile = profileResult.value;
  const assignments = assignmentsResult.value;

  return handleUnifiedSave(
    {
      provider: profileProvider,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      baseUrl: profile.baseUrl,
      systemModel: assignments.llm.model,
      embeddingModel: assignments.embeddings.model,
      embeddingDims: assignments.embeddings.embeddingDims ?? 0,
      openmemoryUserId: typeof body.openmemoryUserId === 'string' ? body.openmemoryUserId : 'default_user',
      customInstructions: typeof body.customInstructions === 'string' ? body.customInstructions : '',
      capabilities: body.capabilities,
    },
    state,
    actor,
    callerType,
    requestId
  );
}
