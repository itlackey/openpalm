/**
 * GET /admin/providers/local — probe Docker Model Runner / Ollama / LM Studio.
 *
 * Registration (POST) has moved to PATCH /admin/providers/:id with kind="register-local".
 */
import { getRequestId, jsonResponse, requireAdmin } from "$lib/server/helpers.js";
import { detectLocalProviders } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const providers = await detectLocalProviders();
  return jsonResponse(200, { providers }, requestId);
};
