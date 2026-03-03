/**
 * POST /admin/openmemory/reset-collection — Delete the Qdrant collection
 * so OpenMemory recreates it with the correct embedding dimensions.
 *
 * Admin-only. This is a destructive operation that deletes all stored memories.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readOpenMemoryConfig,
  resetQdrantCollection
} from "$lib/server/control-plane.js";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const config = readOpenMemoryConfig(state.dataDir);
  const collectionName = config.mem0.vector_store.config.collection_name;

  const result = await resetQdrantCollection(collectionName);

  appendAudit(
    state, actor, "openmemory.qdrant.reset",
    { collection: collectionName, ok: result.ok, error: result.error },
    result.ok, requestId, callerType
  );

  if (!result.ok) {
    return errorResponse(
      502, "qdrant_reset_failed",
      `Failed to reset Qdrant collection: ${result.error}`,
      {}, requestId
    );
  }

  return jsonResponse(200, {
    ok: true,
    collection: collectionName,
  }, requestId);
};
