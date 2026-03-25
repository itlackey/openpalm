/**
 * GET  /admin/capabilities — Return current capabilities and masked secrets.
 * POST /admin/capabilities — Update capabilities in stack.yml and/or secrets in stack.env.
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
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readStackEnv,
  patchSecretsEnvFile,
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  formatCapabilityString,
  maskSecretValue,
  readMemoryConfig,
  type CallerType,
  type StackSpec,
} from "@openpalm/lib";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
} from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("capabilities");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Read secrets (masked)
  const raw = readStackEnv(state.vaultDir);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    secrets[key] = maskSecretValue(key, value);
  }

  // Read capabilities from stack.yml
  const spec = readStackSpec(state.configDir);
  const capabilities = spec?.capabilities ?? null;

  appendAudit(state, actor, "capabilities.get", {}, true, requestId, callerType);
  return jsonResponse(200, {
    capabilities,
    secrets,
  }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;

  // ── Capabilities + secrets save ─────────────────────────────────────
  const provider = typeof body.provider === "string" ? body.provider : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const memoryUserId = typeof body.memoryUserId === "string" ? body.memoryUserId : "default_user";
  const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions : "";

  if (!provider) {
    return errorResponse(400, "bad_request", "provider is required", {}, requestId);
  }

  // 1. Write API key to stack.env (secrets only)
  const secretPatches: Record<string, string> = {};
  if (apiKey) {
    const envVarName = PROVIDER_KEY_MAP[provider] ?? "OPENAI_API_KEY";
    secretPatches[envVarName] = apiKey;
  }
  if (Object.keys(secretPatches).length > 0) {
    try {
      patchSecretsEnvFile(state.vaultDir, secretPatches);
    } catch (err) {
      appendAudit(state, actor, "capabilities.save", { provider, error: String(err) }, false, requestId, callerType);
      return errorResponse(500, "internal_error", "Failed to update vault/stack/stack.env", {}, requestId);
    }
  }

  // 2. Update stack.yml capabilities
  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, "internal_error", "stack.yml not found or invalid", {}, requestId);
  }

  spec.capabilities.llm = formatCapabilityString(provider, systemModel);
  spec.capabilities.embeddings = {
    provider,
    model: embeddingModel || "text-embedding-3-small",
    dims: resolvedDims,
  };
  spec.capabilities.memory = {
    ...spec.capabilities.memory,
    userId: memoryUserId,
    customInstructions,
  };

  try {
    writeStackSpec(state.configDir, spec);
    writeCapabilityVars(spec, state.vaultDir);
  } catch (err) {
    appendAudit(state, actor, "capabilities.save", { provider, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to update stack.yml", {}, requestId);
  }

  // 3. Check embedding dimension mismatch against persisted config
  let dimensionWarning: string | undefined;
  let dimensionMismatch = false;
  const persisted = readMemoryConfig(state.dataDir);
  const currentDims = persisted.mem0.vector_store.config.embedding_model_dims;
  if (currentDims !== resolvedDims) {
    dimensionMismatch = true;
    dimensionWarning = `Embedding dimensions changed: current ${currentDims}, config expects ${resolvedDims}. Reset the memory collection to apply.`;
  }

  appendAudit(state, actor, "capabilities.save", { provider, dimensionMismatch }, true, requestId, callerType);
  logger.info("capabilities save", { provider, dimensionMismatch, requestId });

  return jsonResponse(200, {
    ok: true,
    dimensionWarning,
    dimensionMismatch,
  }, requestId);
};
