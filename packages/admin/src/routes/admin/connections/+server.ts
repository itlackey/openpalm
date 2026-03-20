/**
 * GET  /admin/connections — Return current connection config values (masked).
 * POST /admin/connections — Patch vault/user.env with provided connection keys,
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
  writeConnectionProfilesDocument,
  writeConnectionsDocument,
  ALLOWED_CONNECTION_KEYS,
  maskConnectionValue,
  writeMemoryConfig,
  resolveConfigForPush,
  pushConfigToMemory,
  checkQdrantDimensions,
  buildMem0Mapping,
  buildMem0MappingFromProfiles,
  buildOpenCodeMapping,
  writeOpenCodeProviderConfig,
  type MemoryConfig,
  type CallerType
} from "$lib/server/control-plane.js";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  mem0BaseUrlConfig
} from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";
import {
  isWizardProviderInScope,
  validateWizardCapabilitiesInput,
} from '$lib/wizard-scope.js';

const logger = createLogger("connections");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const raw = readSecretsEnvFile(state.vaultDir);
  const connections: Record<string, string> = {};
  for (const key of ALLOWED_CONNECTION_KEYS) {
    const value = raw[key] ?? "";
    connections[key] = maskConnectionValue(key, value);
  }

  let canonical;
  try {
    canonical = readConnectionProfilesDocument(state.configDir);
  } catch {
    // No profiles.json yet — return empty
    canonical = { profiles: [], assignments: { llm: { connectionId: '', model: '' }, embeddings: { connectionId: '', model: '' } } };
  }

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
    patchSecretsEnvFile(state.vaultDir, patches);
  } catch (err) {
    appendAudit(
      state, actor, "connections.patch",
      { keys: Object.keys(patches), error: String(err) },
      false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to update vault/user.env", {}, requestId);
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
  requestId: string,
): Promise<Response> {
  const provider = body.provider as string; // already validated typeof === "string" by caller
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  const systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const memoryUserId = typeof body.memoryUserId === "string" ? body.memoryUserId : "default_user";
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

  // 1. Build vault/user.env patches
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
      // OPENAI_BASE_URL is read by the memory container as env var fallback
      // for OpenAI-protocol providers (including Ollama via OpenAI-compat API).
      patches.OPENAI_BASE_URL = mem0Url.value;
    }
  }
  if (systemModel) patches.SYSTEM_LLM_MODEL = systemModel;
  if (embeddingModel) patches.EMBEDDING_MODEL = embeddingModel;
  if (embeddingDims) patches.EMBEDDING_DIMS = String(embeddingDims);
  patches.MEMORY_USER_ID = memoryUserId;

  try {
    patchSecretsEnvFile(state.vaultDir, patches);
  } catch (err) {
    appendAudit(
      state, actor, "connections.unified",
      { provider, error: String(err) },
      false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to update vault/user.env", {}, requestId);
  }

  // 2. Build and write Memory config
  const apiKeyEnvRef = PROVIDER_KEY_MAP[provider]
    ? `env:${PROVIDER_KEY_MAP[provider]}`
    : (apiKey || "not-needed");

  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  const omConfig: MemoryConfig = buildMem0Mapping({
    llm: {
      provider,
      baseUrl,
      model: systemModel,
      apiKeyRef: apiKeyEnvRef,
    },
    embedder: {
      provider,
      baseUrl,
      model: embeddingModel || 'text-embedding-3-small',
      apiKeyRef: apiKeyEnvRef,
    },
    embeddingDims: resolvedDims,
    customInstructions,
  });

  // 2b. Check embedding dimension change BEFORE writing (compare new vs previously-persisted)
  let dimensionWarning: string | undefined;
  let dimensionMismatch = false;
  const dimResult = checkQdrantDimensions(state.dataDir, omConfig);
  if (!dimResult.match) {
    dimensionMismatch = true;
    dimensionWarning = `Embedding dimensions changed: current ${dimResult.currentDims}, config expects ${dimResult.expectedDims}. Reset the memory collection to apply.`;
  }

  writeMemoryConfig(state.dataDir, omConfig);

  const envVarName = PROVIDER_KEY_MAP[provider] ?? "OPENAI_API_KEY";
  writeConnectionsDocument(state.configDir, {
    profiles: [{
      id: 'primary',
      name: provider,
      provider,
      baseUrl,
      hasApiKey: Boolean(apiKey),
      apiKeyEnvVar: envVarName,
    }],
    assignments: {
      llm: { connectionId: 'primary', model: systemModel },
      embeddings: {
        connectionId: 'primary',
        model: embeddingModel || 'text-embedding-3-small',
        embeddingDims: resolvedDims,
      },
    },
  });

  // 3. Push resolved config to running container
  let pushed = false;
  let pushError: string | undefined;
  try {
    const resolved = resolveConfigForPush(omConfig, state.configDir);
    const pushResult = await pushConfigToMemory(resolved);
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
  requestId: string,
): Promise<Response> {
  const profiles = body.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return errorResponse(400, 'bad_request', 'profiles must include at least one profile', {}, requestId);
  }

  const parsedProfiles = [];
  for (const profileInput of profiles) {
    const profileResult = parseCanonicalConnectionProfile(profileInput);
    if (!profileResult.ok) {
      return errorResponse(400, 'bad_request', profileResult.message, {}, requestId);
    }
    parsedProfiles.push(profileResult.value);
  }

  const assignmentsResult = parseCapabilityAssignments(body.assignments);
  if (!assignmentsResult.ok) {
    return errorResponse(400, 'bad_request', assignmentsResult.message, {}, requestId);
  }

  const assignments = assignmentsResult.value;
  const llmProfile = parsedProfiles.find((profile) => profile.id === assignments.llm.connectionId);
  if (!llmProfile) {
    return errorResponse(409, 'conflict', `assignments.llm.connectionId not found: ${assignments.llm.connectionId}`, {}, requestId);
  }

  const embedProfile = parsedProfiles.find((profile) => profile.id === assignments.embeddings.connectionId);
  if (!embedProfile) {
    return errorResponse(409, 'conflict', `assignments.embeddings.connectionId not found: ${assignments.embeddings.connectionId}`, {}, requestId);
  }

  const memoryUserId = typeof body.memoryUserId === 'string' ? body.memoryUserId : 'default_user';
  const customInstructions = typeof body.customInstructions === 'string' ? body.customInstructions : '';
  const memoryModel = typeof body.memoryModel === 'string' && body.memoryModel.trim()
    ? body.memoryModel.trim()
    : assignments.llm.model;
  const embeddingDims = assignments.embeddings.embeddingDims
    ?? EMBEDDING_DIMS[`${embedProfile.provider}/${assignments.embeddings.model}`]
    ?? 1536;

  const patches: Record<string, string> = {
    SYSTEM_LLM_PROVIDER: llmProfile.provider,
    SYSTEM_LLM_MODEL: assignments.llm.model,
    EMBEDDING_MODEL: assignments.embeddings.model,
    EMBEDDING_DIMS: String(embeddingDims),
    MEMORY_USER_ID: memoryUserId,
  };

  if (llmProfile.baseUrl.trim()) {
    patches.SYSTEM_LLM_BASE_URL = llmProfile.baseUrl;
    const mem0Url = mem0BaseUrlConfig(llmProfile.provider, llmProfile.baseUrl);
    if (mem0Url?.key === 'openai_base_url') {
      patches.OPENAI_BASE_URL = mem0Url.value;
    }
  }

  try {
    patchSecretsEnvFile(state.vaultDir, patches);
    writeConnectionProfilesDocument(state.configDir, {
      version: 1,
      profiles: parsedProfiles,
      assignments: {
        ...assignments,
        embeddings: {
          ...assignments.embeddings,
          embeddingDims,
        },
      },
    });
  } catch (err) {
    appendAudit(
      state,
      actor,
      'connections.dto.save',
      { error: String(err) },
      false,
      requestId,
      callerType,
    );
    return errorResponse(500, 'internal_error', 'Failed to persist connection settings', {}, requestId);
  }

  const omConfig = buildMem0MappingFromProfiles(
    llmProfile,
    embedProfile,
    memoryModel,
    assignments.embeddings.model,
    embeddingDims,
    customInstructions,
  );

  const dimResult = checkQdrantDimensions(state.dataDir, omConfig);
  const dimensionMismatch = !dimResult.match;
  const dimensionWarning = dimensionMismatch
    ? `Embedding dimensions changed: current ${dimResult.currentDims}, config expects ${dimResult.expectedDims}. Reset the memory collection to apply.`
    : undefined;

  writeMemoryConfig(state.dataDir, omConfig);

  try {
    const mapping = buildOpenCodeMapping({
      provider: llmProfile.provider,
      baseUrl: llmProfile.baseUrl,
      systemModel: assignments.llm.model,
      smallModel: assignments.llm.smallModel,
    });
    writeOpenCodeProviderConfig(state.configDir, mapping);
  } catch (err) {
    logger.warn('failed to write opencode config after DTO save', { error: String(err), requestId });
  }

  let pushed = false;
  let pushError: string | undefined;
  try {
    const resolved = resolveConfigForPush(omConfig, state.configDir);
    const pushResult = await pushConfigToMemory(resolved);
    pushed = pushResult.ok;
    if (!pushResult.ok) pushError = pushResult.error;
  } catch (err) {
    pushError = String(err);
  }

  appendAudit(
    state,
    actor,
    'connections.dto.save',
    { pushed, dimensionMismatch },
    true,
    requestId,
    callerType,
  );

  logger.info('canonical DTO save', {
    requestId,
    profileCount: parsedProfiles.length,
    pushed,
    dimensionMismatch,
  });

  return jsonResponse(200, {
    ok: true,
    pushed,
    pushError,
    dimensionWarning,
    dimensionMismatch,
  }, requestId);
}
