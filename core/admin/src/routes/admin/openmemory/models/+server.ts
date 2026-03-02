/**
 * POST /admin/openmemory/models — Proxy endpoint for listing provider models.
 *
 * Resolves API key references server-side and fetches available models
 * from the configured provider's API. Returns { models: string[], error?: string }.
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
  fetchProviderModels,
  LLM_PROVIDERS,
  EMBED_PROVIDERS
} from "$lib/server/control-plane.js";

const VALID_PROVIDERS = new Set<string>([...LLM_PROVIDERS, ...EMBED_PROVIDERS]);

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const body = await parseJsonBody(event.request);
  const provider = body.provider as string | undefined;
  const apiKeyRef = body.apiKeyRef as string | undefined;
  const baseUrl = (body.baseUrl as string | undefined) ?? "";

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return errorResponse(400, "bad_request", `Invalid provider: ${provider ?? "(none)"}`, {}, requestId);
  }

  const result = await fetchProviderModels(provider, apiKeyRef ?? "", baseUrl, state.configDir);

  appendAudit(
    state, actor, "openmemory.models.list",
    { provider, modelCount: result.models.length, error: result.error },
    !result.error, requestId, callerType
  );

  return jsonResponse(200, result, requestId);
};
