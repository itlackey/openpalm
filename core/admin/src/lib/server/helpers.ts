/**
 * Shared helpers for SvelteKit API server routes.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { timingSafeEqual } from "node:crypto";
import { getState } from "./state.js";
import { normalizeCaller, type CallerType } from "./control-plane.js";

function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Standard JSON response with request ID header */
export function jsonResponse(
  status: number,
  body: unknown,
  requestId = ""
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {})
    }
  });
}

/** Standard error envelope */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId = ""
): Response {
  return jsonResponse(
    status,
    { error, message, details, requestId },
    requestId
  );
}

/** Extract or generate request ID */
export function getRequestId(event: RequestEvent): string {
  return event.request.headers.get("x-request-id") || crypto.randomUUID();
}

/** Check admin token — returns error Response or null if OK */
export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  const token = event.request.headers.get("x-admin-token");
  if (!safeTokenCompare(token ?? "", state.adminToken)) {
    return errorResponse(
      401,
      "unauthorized",
      "Missing or invalid x-admin-token",
      {},
      requestId
    );
  }
  return null;
}

/** Extract actor from request — derived from auth state, not caller-controlled */
export function getActor(event: RequestEvent): string {
  const token = event.request.headers.get("x-admin-token");
  if (token) return "admin";
  return "unauthenticated";
}

/** Extract caller type from request */
export function getCallerType(event: RequestEvent): CallerType {
  return normalizeCaller(event.request.headers.get("x-requested-by"));
}

/** Parse JSON body safely */
export async function parseJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
