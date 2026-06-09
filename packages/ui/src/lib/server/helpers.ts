/**
 * Shared helpers for SvelteKit API server routes.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { timingSafeEqual, createHash } from "node:crypto";
import { getState } from "./state.js";
import { getActiveEndpoint } from "./endpoints.js";
import { createOpenCodeClient } from "@openpalm/lib";
import { validateSession, getUiLoginPassword } from "./session-store.js";

/**
 * Lazy OpenCode client bound to the currently active endpoint. The client is
 * recreated whenever the active endpoint URL changes so user switches in the
 * UI take effect on the next call.
 */
let _openCodeClient: ReturnType<typeof createOpenCodeClient> | undefined;
let _openCodeClientUrl: string | undefined;
export function getOpenCodeClient(): ReturnType<typeof createOpenCodeClient> {
  const { url } = getActiveEndpoint();
  if (!_openCodeClient || url !== _openCodeClientUrl) {
    _openCodeClient = createOpenCodeClient({ baseUrl: url });
    _openCodeClientUrl = url;
  }
  return _openCodeClient;
}

export function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
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

// getUiLoginPassword lives in session-store.ts (single source of truth shared
// with token signing). Re-exported here because every auth route imports it
// from helpers.
export { getUiLoginPassword };

/**
 * Extract raw session token from the `op_session` cookie.
 *
 * Phase 2 of the auth/proxy refactor (docs/technical/auth-and-proxy-refactor-plan.md)
 * removed the legacy `x-admin-token` / `Authorization: Bearer` header fallbacks.
 * The cookie is HttpOnly + SameSite=Strict and is the ONLY credential the browser
 * holds; XSS cannot read it and out-of-process callers must obtain a session via
 * `POST /admin/auth/login` (or `/session`) and present the cookie on subsequent
 * requests.
 */
function extractToken(event: RequestEvent): string {
  const cookieHeader = event.request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)op_session=([^;]+)/);
  if (match) return match[1];
  return "";
}

/** Check admin auth — returns error Response or null if OK */
export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const password = getUiLoginPassword();
  if (!password) {
    return errorResponse(
      503,
      'admin_not_configured',
      'OP_UI_LOGIN_PASSWORD has not been set. Complete setup first.',
      {},
      requestId,
    );
  }
  const token = extractToken(event);
  if (!validateSession(token)) {
    return errorResponse(
      401,
      "unauthorized",
      "Missing or invalid credentials",
      {},
      requestId
    );
  }
  return null;
}

/**
 * Identify caller by the presented `op_session` cookie.
 *
 * Returns "admin" when the cookie holds a valid session token.
 */
export function identifyCallerByToken(event: RequestEvent): "admin" | null {
  const password = getUiLoginPassword();
  if (!password) return null;
  const token = extractToken(event);
  if (validateSession(token)) return "admin";
  return null;
}


/** Discriminated result from parseJsonBody */
export type ParseJsonBodyError = { error: "too_large" | "invalid_json" };
export type ParseJsonBodyResult = { data: Record<string, unknown> } | ParseJsonBodyError;

/** Parse JSON body safely — returns discriminated result with error type */
export async function parseJsonBody(
  request: Request,
  maxBytes = 1_048_576
): Promise<ParseJsonBodyResult> {
  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return { error: "too_large" };
    }
    return { data: (await request.json()) as Record<string, unknown> };
  } catch (e) {
    console.warn('[helpers] Failed to parse JSON request body', e);
    return { error: "invalid_json" };
  }
}

/** Convert a ParseJsonBodyError to an appropriate HTTP error response */
export function jsonBodyError(err: ParseJsonBodyError, requestId: string): Response {
  if (err.error === "too_large") {
    return errorResponse(413, "too_large", "Request body too large", {}, requestId);
  }
  return errorResponse(400, "invalid_json", "Request body must be valid JSON", {}, requestId);
}

/**
 * Auth + JSON body wrapper for admin POST/DELETE handlers.
 *
 * Replaces the 4-line boilerplate copy-pasted across 30+ routes:
 *   const requestId = getRequestId(event);
 *   const authError = requireAdmin(event, requestId);
 *   if (authError) return authError;
 *   const result = await parseJsonBody(event.request);
 *   if ('error' in result) return jsonBodyError(result, requestId);
 *
 * Use for routes that need both auth and a JSON body. For auth-only or
 * GET routes, call `requireAdmin` directly.
 */
export async function withAdminBody(
  event: RequestEvent,
  handler: (ctx: { requestId: string; body: Record<string, unknown> }) => Promise<Response>
): Promise<Response> {
  const requestId = getRequestId(event);
  const originError = checkOriginHeader(event.request, UI_PORT);
  if (originError) return originError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  return handler({ requestId, body: result.data });
}

// ── SEC-1: Host header allowlist ─────────────────────────────────────────
/**
 * Reject requests whose Host header does not match localhost or 127.0.0.1
 * on the configured admin port.
 *
 * @param request  Incoming Request (or SvelteKit RequestEvent.request)
 * @param port     The port this server is bound to (e.g. 3880 or 8100)
 * @returns        A 400 Response if the host is rejected; null if allowed
 */
export function checkHostHeader(request: Request, port: number): Response | null {
  const host = request.headers.get("host") ?? "";
  // Strip any trailing dot or extra whitespace
  const normalized = host.trim().replace(/\.$/, "");
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (allowed.includes(normalized)) return null;
  return new Response(
    JSON.stringify({
      error: "invalid_host",
      host: normalized,
      message: "Request rejected: Host header does not match allowed hosts. The admin UI binds to loopback (127.0.0.1) only; reach it via localhost or front it with a reverse proxy/tunnel for remote access.",
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

// ── SEC-2: Origin check for state-mutating requests ──────────────────────
/**
 * Reject POST/PUT/DELETE requests whose Origin header does not match
 * localhost or 127.0.0.1. Requests with no Origin (non-browser clients)
 * are always allowed.
 *
 * @param request  Incoming Request
 * @param port     The port this server is bound to
 * @returns        A 403 Response if the origin is rejected; null if allowed
 */
export function checkOriginHeader(request: Request, port: number): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = request.headers.get("origin");
  if (!origin) return null; // non-browser clients have no Origin

  try {
    const u = new URL(origin);
    const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (allowed.includes(u.host)) return null;
  } catch {
    // Unparseable Origin is treated as hostile
  }
  return new Response(
    JSON.stringify({ error: "forbidden_origin", origin }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}

// UI_PORT is exported so hooks.server.ts and other modules can import it.
export const UI_PORT = Number(process.env.PORT ?? 3880);
