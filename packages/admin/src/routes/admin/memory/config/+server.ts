/**
 * GET  /admin/memory/config — Return persisted + runtime memory config.
 * POST /admin/memory/config — Save config to file and push to runtime API.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType,
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readMemoryConfig,
  writeMemoryConfig,
  pushConfigToMemory,
  fetchConfigFromMemory,
  resolveConfigForPush,
  checkQdrantDimensions,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  type MemoryConfig
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const config = readMemoryConfig(state.dataDir);
  const runtimeConfig = await fetchConfigFromMemory();

  appendAudit(state, actor, "memory.config.get", {}, true, requestId, callerType);

  return jsonResponse(200, {
    config,
    runtimeConfig,
    providers: { llm: LLM_PROVIDERS, embed: EMBED_PROVIDERS },
    embeddingDims: EMBEDDING_DIMS,
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
  const config = body as unknown as MemoryConfig;

  if (!config?.mem0?.llm || !config?.mem0?.embedder || !config?.mem0?.vector_store) {
    return errorResponse(400, "bad_request", "Invalid memory config structure", {}, requestId);
  }

  // Check embedding dimension mismatch BEFORE writing (compare new vs previously-persisted)
  const dimCheck = checkQdrantDimensions(state.dataDir, config);
  const dimensionMismatch = !dimCheck.match;
  const dimensionWarning = dimensionMismatch
    ? `Embedding dimensions changed (current: ${dimCheck.currentDims}, config: ${dimCheck.expectedDims}). Reset the memory collection to apply.`
    : undefined;

  try {
    writeMemoryConfig(state.dataDir, config);
  } catch (err) {
    appendAudit(
      state, actor, "memory.config.set",
      { error: String(err) }, false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to write config file", {}, requestId);
  }

  // Resolve env: references before pushing to container
  const resolved = resolveConfigForPush(config, state.configDir);
  const pushResult = await pushConfigToMemory(resolved);

  appendAudit(
    state, actor, "memory.config.set",
    { pushed: pushResult.ok, dimensionMismatch }, true, requestId, callerType
  );

  return jsonResponse(200, {
    ok: true,
    persisted: true,
    pushed: pushResult.ok,
    pushError: pushResult.error,
    dimensionWarning,
    dimensionMismatch,
  }, requestId);
};
