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
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  ALLOWED_CONNECTION_KEYS,
  maskConnectionValue,
  writeOpenMemoryConfig,
  resolveConfigForPush,
  pushConfigToOpenMemory,
  checkQdrantDimensions,
  type OpenMemoryConfig,
  type CallerType
} from "$lib/server/control-plane.js";
import { PROVIDER_KEY_MAP, EMBEDDING_DIMS } from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";

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

  appendAudit(state, actor, "connections.get", {}, true, requestId, callerType);
  return jsonResponse(200, { connections }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);

  // ── Unified system connection save (has `provider` key) ───────────
  if (typeof body.provider === "string") {
    return handleUnifiedSave(body, state, actor, callerType, requestId);
  }

  // ── Legacy: patch individual keys ──────────────────────────────────
  const patches: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_CONNECTION_KEYS.has(key) && typeof value === "string") {
      patches[key] = value;
    }
  }

  if (Object.keys(patches).length === 0) {
    return errorResponse(400, "bad_request", "No valid connection keys provided", {}, requestId);
  }

  try {
    patchSecretsEnvFile(state.configDir, patches);
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
  const provider = body.provider as string;
  const apiKey = (body.apiKey as string) ?? "";
  const baseUrl = (body.baseUrl as string) ?? "";
  const systemModel = (body.systemModel as string) ?? "";
  const embeddingModel = (body.embeddingModel as string) ?? "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const openmemoryUserId = (body.openmemoryUserId as string) ?? "default_user";
  const customInstructions = (body.customInstructions as string) ?? "";

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
    // OPENAI_BASE_URL is read by the openmemory container as env var fallback
    patches.OPENAI_BASE_URL = `${baseUrl.replace(/\/+$/, "")}/v1`;
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
  if (baseUrl.trim()) llmConfig.openai_base_url = `${baseUrl.trim().replace(/\/+$/, "")}/v1`;

  const embedConfig: Record<string, unknown> = {
    model: embeddingModel || "text-embedding-3-small",
    api_key: apiKeyEnvRef,
  };
  if (baseUrl.trim()) embedConfig.openai_base_url = `${baseUrl.trim().replace(/\/+$/, "")}/v1`;

  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  const omConfig: OpenMemoryConfig = {
    mem0: {
      llm: { provider, config: llmConfig },
      embedder: { provider, config: embedConfig },
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
