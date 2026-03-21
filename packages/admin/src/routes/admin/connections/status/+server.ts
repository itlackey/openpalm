/**
 * GET /admin/connections/status — Check if capabilities are configured.
 *
 * Returns { complete: boolean, missing: string[] }.
 * "complete" is true when capabilities.llm and capabilities.embeddings are set.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  readStackSpec,
} from "$lib/server/control-plane.js";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const missing: string[] = [];
  const spec = readStackSpec(state.configDir);

  if (!spec) {
    missing.push("Stack configuration (stack.yaml)");
  } else {
    if (!spec.capabilities.llm) {
      missing.push("System LLM (capabilities.llm)");
    }
    if (!spec.capabilities.embeddings?.model) {
      missing.push("Embedding model (capabilities.embeddings)");
    }
  }

  const complete = missing.length === 0;

  appendAudit(
    state, actor, "connections.status",
    { complete, missing },
    true, requestId, callerType
  );

  return jsonResponse(200, { complete, missing }, requestId);
};
