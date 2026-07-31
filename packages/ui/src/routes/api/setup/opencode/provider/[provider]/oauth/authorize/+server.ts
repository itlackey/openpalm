import { json } from "@sveltejs/kit";
import { createOpenCodeClient } from "@openpalm/lib";
import { resolveSetupOpencodeTarget } from "$lib/server/opencode/setup-target.js";
import { errorResponse, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const POST: RequestHandler = async (event) => {
  const { params, request } = event;
  const requestId = getRequestId(event);
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return errorResponse(400, "invalid_provider", "Invalid provider", {}, requestId);
  }
  // W1: target the wizard-spawned OpenCode when the deployed assistant isn't
  // reachable yet, instead of hardcoding the deployed-assistant target.
  const target = await resolveSetupOpencodeTarget();
  if (!target) {
    return errorResponse(503, "opencode_unavailable", "OpenCode is not reachable yet. Wait a moment and try again.", {}, requestId);
  }
  try {
    const body = await request.json();
    const method = Number.isInteger(body.method) ? (body.method as number) : 0;
    const client = createOpenCodeClient({ baseUrl: target.url, username: target.username, password: target.password });
    const result = await client.startProviderOAuth(params.provider, method);
    if (!result.ok) return errorResponse(400, "oauth_authorize_failed", "OAuth authorization failed", {}, requestId);
    return json({ ok: true, ...(result.data as object) });
  } catch {
    return errorResponse(500, "oauth_authorize_failed", "OAuth authorization failed", {}, requestId);
  }
};
