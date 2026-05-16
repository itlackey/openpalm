/**
 * Helpers for the Bun.serve API server.
 *
 * These adapt the SvelteKit helper functions (which take RequestEvent)
 * to work with plain Request objects by wrapping them in a minimal
 * RequestEvent-compatible shim.
 */
import type { RequestEvent } from "@sveltejs/kit";
import {
  requireAdmin as skRequireAdmin,
  requireAuth as skRequireAuth,
  getRequestId as skGetRequestId,
  getActor as skGetActor,
  getCallerType as skGetCallerType,
  parseJsonBody as skParseJsonBody,
  jsonResponse,
  errorResponse,
} from "$lib/server/helpers.js";

export { jsonResponse, errorResponse };

/** Wrap a plain Request in a minimal RequestEvent-compatible shim. */
function wrapRequest(req: Request, params: Record<string, string> = {}): RequestEvent {
  return {
    request: req,
    params,
    url: new URL(req.url),
    route: { id: null },
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as RequestEvent;
}

export function getRequestId(req: Request): string {
  return skGetRequestId(wrapRequest(req));
}

export function requireAdmin(req: Request, requestId: string): Response | null {
  return skRequireAdmin(wrapRequest(req), requestId);
}

export function requireAuth(req: Request, requestId: string): Response | null {
  return skRequireAuth(wrapRequest(req), requestId);
}

export function getActor(req: Request): string {
  return skGetActor(wrapRequest(req));
}

export function getCallerType(req: Request) {
  return skGetCallerType(wrapRequest(req));
}

export async function parseJsonBody(req: Request) {
  return skParseJsonBody(req);
}
