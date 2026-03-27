import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

/** Internal URL used by the admin server to reach OpenCode (same as client.server.ts). */
const OPENCODE_BASE_URL = process.env.OP_OPENCODE_URL ?? "http://localhost:4096";

/** Host-facing URL shown to the browser so it can reach OpenCode directly. */
const ADMIN_OPENCODE_HOST_PORT = process.env.OP_ADMIN_OPENCODE_PORT ?? '3881';
const ADMIN_OPENCODE_PUBLIC_URL = `http://localhost:${ADMIN_OPENCODE_HOST_PORT}/`;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    // Probe the same /provider endpoint the shared client uses for availability
    const response = await fetch(`${OPENCODE_BASE_URL}/provider`, {
      signal: AbortSignal.timeout(3000),
    });

    return jsonResponse(
      200,
      {
        status: response.status < 500 ? 'ready' : 'unavailable',
        url: ADMIN_OPENCODE_PUBLIC_URL,
      },
      requestId
    );
  } catch {
    return jsonResponse(
      200,
      {
        status: 'unavailable',
        url: ADMIN_OPENCODE_PUBLIC_URL,
      },
      requestId
    );
  }
};
