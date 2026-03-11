/**
 * POST /admin/setup/models — Fetch provider models during setup wizard.
 *
 * Accepts the ephemeral setup token (or admin token if setup is complete).
 * The request body includes { provider, apiKey, baseUrl } with the raw API key
 * (not an env: reference) since secrets.env doesn't exist yet during setup.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  parseJsonBody,
  requireAdminOrSetupToken,
} from "$lib/server/helpers.js";
import {
  fetchProviderModels,
  LLM_PROVIDERS,
  EMBED_PROVIDERS
} from "$lib/server/control-plane.js";
import {
  isWizardCapability,
  isWizardProviderInScope,
} from '$lib/setup-wizard/scope.js';
import { createLogger } from "$lib/server/logger.js";

const logger = createLogger("setup-models");
const VALID_PROVIDERS = new Set<string>([...LLM_PROVIDERS, ...EMBED_PROVIDERS]);

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  logger.info("model discovery request received", { requestId });
  const state = getState();
  const authError = requireAdminOrSetupToken(event, requestId);
  if (authError) return authError;

  const body = await parseJsonBody(event.request);
  if (!body) {
    return errorResponse(400, "invalid_input", "Request body must be valid JSON", {}, requestId);
  }
  const provider = body.provider as string | undefined;
  const capability = typeof body.capability === 'string' ? body.capability : undefined;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return errorResponse(400, "bad_request", `Invalid provider: ${provider ?? "(none)"}`, {}, requestId);
  }
  if (!isWizardProviderInScope(provider)) {
    return errorResponse(
      400,
      'bad_request',
      `Provider \"${provider}\" is outside setup wizard v1 scope`,
      {},
      requestId
    );
  }
  if (capability && !isWizardCapability(capability)) {
    return errorResponse(400, 'bad_request', `Invalid capability: ${capability}`, {}, requestId);
  }

  // Pass raw API key directly (not an env: reference)
  logger.info("fetching models from provider", { requestId, provider, baseUrl: baseUrl || "(default)" });
  const result = await fetchProviderModels(provider, apiKey, baseUrl, state.configDir);
  logger.info("model discovery completed", { requestId, provider, modelCount: result.models?.length ?? 0 });

  return jsonResponse(200, result, requestId);
};
