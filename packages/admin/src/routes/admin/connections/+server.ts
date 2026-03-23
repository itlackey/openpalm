/**
 * GET  /admin/connections — Return current capabilities and masked secrets.
 * POST /admin/connections — Update capabilities in stack.yaml and/or secrets in user.env.
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
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  readStackSpec,
  writeStackSpec,
  writeManagedEnvFiles,
  formatCapabilityString,
  maskConnectionValue,
  readMemoryConfig,
  type CallerType,
  type StackSpec,
} from "@openpalm/lib";
import {
  PROVIDER_KEY_MAP,
  EMBEDDING_DIMS,
  mem0BaseUrlConfig
} from "$lib/provider-constants.js";
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("connections");

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Read secrets (masked)
  const raw = readSecretsEnvFile(state.vaultDir);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    secrets[key] = maskConnectionValue(key, value);
  }

  // Read capabilities from stack.yaml
  const spec = readStackSpec(state.configDir);
  const capabilities = spec?.capabilities ?? null;

  appendAudit(state, actor, "connections.get", {}, true, requestId, callerType);
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

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }

  // ── Capabilities + secrets save ─────────────────────────────────────
  const provider = typeof body.provider === "string" ? body.provider : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  const systemModel = typeof body.systemModel === "string" ? body.systemModel : "";
  const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel : "";
  const embeddingDims = typeof body.embeddingDims === "number" ? body.embeddingDims : 0;
  const memoryUserId = typeof body.memoryUserId === "string" ? body.memoryUserId : "default_user";
  const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions : "";

  if (!provider) {
    return errorResponse(400, "bad_request", "provider is required", {}, requestId);
  }

  // 1. Write API key to user.env (secrets only)
  const secretPatches: Record<string, string> = {};
  if (apiKey) {
    const envVarName = PROVIDER_KEY_MAP[provider] ?? "OPENAI_API_KEY";
    secretPatches[envVarName] = apiKey;
  }
  if (baseUrl) {
    const mem0Url = mem0BaseUrlConfig(provider, baseUrl);
    if (mem0Url?.key === "openai_base_url") {
      secretPatches.OPENAI_BASE_URL = mem0Url.value;
    }
  }

  if (Object.keys(secretPatches).length > 0) {
    try {
      patchSecretsEnvFile(state.vaultDir, secretPatches);
    } catch (err) {
      appendAudit(state, actor, "connections.save", { provider, error: String(err) }, false, requestId, callerType);
      return errorResponse(500, "internal_error", "Failed to update vault/user/user.env", {}, requestId);
    }
  }

  // 2. Update stack.yaml capabilities
  const lookupKey = `${provider}/${embeddingModel}`;
  const resolvedDims = embeddingDims || EMBEDDING_DIMS[lookupKey] || 1536;

  const spec = readStackSpec(state.configDir);
  if (!spec) {
    return errorResponse(500, "internal_error", "stack.yaml not found or invalid", {}, requestId);
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
    writeManagedEnvFiles(spec, state.vaultDir);
  } catch (err) {
    appendAudit(state, actor, "connections.save", { provider, error: String(err) }, false, requestId, callerType);
    return errorResponse(500, "internal_error", "Failed to update stack.yaml", {}, requestId);
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

  appendAudit(state, actor, "connections.save", { provider, dimensionMismatch }, true, requestId, callerType);
  logger.info("connections save", { provider, dimensionMismatch, requestId });

  return jsonResponse(200, {
    ok: true,
    dimensionWarning,
    dimensionMismatch,
  }, requestId);
};
