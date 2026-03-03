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
  parseJsonBody
} from "$lib/server/helpers.js";
import {
  fetchProviderModels,
  LLM_PROVIDERS,
  EMBED_PROVIDERS
} from "$lib/server/control-plane.js";
import { isSetupComplete } from "$lib/server/setup-status.js";
import { timingSafeEqual } from "node:crypto";

function safeTokenCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

const VALID_PROVIDERS = new Set<string>([...LLM_PROVIDERS, ...EMBED_PROVIDERS]);

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const state = getState();
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  // Auth: accept either setup token (first-run) or admin token (post-setup)
  const token = event.request.headers.get("x-admin-token") ?? "";
  const validSetupToken = !setupComplete && safeTokenCompare(token, state.setupToken);
  const validAdminToken = setupComplete && safeTokenCompare(token, state.adminToken);
  if (!validSetupToken && !validAdminToken) {
    return errorResponse(401, "unauthorized", "Missing or invalid token", {}, requestId);
  }

  const body = await parseJsonBody(event.request);
  const provider = body.provider as string | undefined;
  const apiKey = (body.apiKey as string | undefined) ?? "";
  const baseUrl = (body.baseUrl as string | undefined) ?? "";

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return errorResponse(400, "bad_request", `Invalid provider: ${provider ?? "(none)"}`, {}, requestId);
  }

  // Pass raw API key directly (not an env: reference)
  const result = await fetchProviderModels(provider, apiKey, baseUrl, state.configDir);

  return jsonResponse(200, result, requestId);
};
