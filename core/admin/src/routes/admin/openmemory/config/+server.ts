/**
 * GET  /admin/openmemory/config — Return persisted + runtime OpenMemory config.
 * POST /admin/openmemory/config — Save config to file and push to runtime API.
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
  readOpenMemoryConfig,
  writeOpenMemoryConfig,
  pushConfigToOpenMemory,
  fetchConfigFromOpenMemory,
  resolveConfigForPush,
  checkQdrantDimensions,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  type OpenMemoryConfig
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const config = readOpenMemoryConfig(state.dataDir);
  const runtimeConfig = await fetchConfigFromOpenMemory();

  appendAudit(state, actor, "openmemory.config.get", {}, true, requestId, callerType);

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
  const config = body as unknown as OpenMemoryConfig;

  if (!config?.mem0?.llm || !config?.mem0?.embedder || !config?.mem0?.vector_store) {
    return errorResponse(400, "bad_request", "Invalid OpenMemory config structure", {}, requestId);
  }

  // Check embedding dimension mismatch BEFORE writing (compare new vs previously-persisted)
  const dimCheck = checkQdrantDimensions(state.dataDir, config);
  const dimensionMismatch = !dimCheck.match;
  const dimensionWarning = dimensionMismatch
    ? `Embedding dimensions changed (current: ${dimCheck.currentDims}, config: ${dimCheck.expectedDims}). Reset the memory collection to apply.`
    : undefined;

  try {
    writeOpenMemoryConfig(state.dataDir, config);
  } catch (err) {
    appendAudit(
      state, actor, "openmemory.config.set",
      { error: String(err) }, false, requestId, callerType
    );
    return errorResponse(500, "internal_error", "Failed to write config file", {}, requestId);
  }

  // Resolve env: references before pushing to container
  const resolved = resolveConfigForPush(config, state.configDir);
  const pushResult = await pushConfigToOpenMemory(resolved);

  appendAudit(
    state, actor, "openmemory.config.set",
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
