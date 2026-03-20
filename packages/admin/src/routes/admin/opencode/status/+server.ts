import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import type { RequestHandler } from "./$types";

const ADMIN_OPENCODE_CONTAINER_PORT = process.env.OPENCODE_PORT ?? '4097';
const ADMIN_OPENCODE_HOST_PORT = process.env.OP_ADMIN_OPENCODE_PORT ?? '3881';
const ADMIN_OPENCODE_PUBLIC_URL = `http://localhost:${ADMIN_OPENCODE_HOST_PORT}/`;

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  try {
    const response = await fetch(`http://127.0.0.1:${ADMIN_OPENCODE_CONTAINER_PORT}`, {
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
