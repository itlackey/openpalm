import { json } from "@sveltejs/kit";
import { getOpenCodeClient, errorResponse, getRequestId } from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const PUT: RequestHandler = async (event) => {
  const { params, request } = event;
  const requestId = getRequestId(event);
  if (!PROVIDER_ID_RE.test(params.provider)) {
    return errorResponse(400, "invalid_provider", "Invalid provider", {}, requestId);
  }
  try {
    const { key } = await request.json();
    const client = getOpenCodeClient();
    const result = await client.setProviderApiKey(params.provider, typeof key === "string" ? key : "");
    if (!result.ok) return errorResponse(400, "provider_credentials_failed", "Failed to set provider credentials", {}, requestId);
    return json({ ok: true });
  } catch {
    return errorResponse(500, "provider_credentials_failed", "Failed to set provider credentials", {}, requestId);
  }
};
