/**
 * Shared helpers for SvelteKit API server routes.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { timingSafeEqual, createHash } from "node:crypto";
import { getState } from "./state.js";
import { normalizeCaller } from "./control-plane.js";
import {
  type CallerType,
} from "./types.js";

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

/** Guard: returns 503 if admin token has not been configured yet. */
export function requireNonEmptyAdminToken(state: { adminToken: string }, requestId: string): Response | null {
  if (!state.adminToken) {
    return errorResponse(503, 'admin_not_configured', 'Admin token has not been set. Complete setup first.', {}, requestId);
  }
  return null;
}

/** Check admin token — returns error Response or null if OK */
export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  const notConfigured = requireNonEmptyAdminToken(state, requestId);
  if (notConfigured) return notConfigured;
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

/** Identify caller by presented token. */
export function identifyCallerByToken(event: RequestEvent): "admin" | "assistant" | null {
  const state = getState();
  const token = event.request.headers.get("x-admin-token") ?? "";
  if (state.adminToken && safeTokenCompare(token, state.adminToken)) return "admin";
  if (state.assistantToken && safeTokenCompare(token, state.assistantToken)) return "assistant";
  return null;
}

/** Check for either admin or assistant token — returns error Response or null if OK. */
export function requireAuth(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  if (!state.adminToken && !state.assistantToken) {
    return errorResponse(503, 'admin_not_configured', 'Authentication tokens have not been set. Complete setup first.', {}, requestId);
  }

  if (identifyCallerByToken(event)) {
    return null;
  }

  return errorResponse(
    401,
    "unauthorized",
    "Missing or invalid x-admin-token (admin or assistant token accepted)",
    {},
    requestId
  );
}

/** Extract actor from request — derived from auth state, not caller-controlled. */
export function getActor(event: RequestEvent): string {
  return identifyCallerByToken(event) ?? "unauthenticated";
}

/** Extract caller type from request */
export function getCallerType(event: RequestEvent): CallerType {
  return normalizeCaller(event.request.headers.get("x-requested-by"));
}

// ── SSRF Protection ────────────────────────────────────────────────────

/**
 * Known Docker Compose service names from stack/core.compose.yml.
 * These are the internal service hostnames that must never be probed
 * via user-supplied connection URLs.
 */
const DOCKER_SERVICE_NAMES = new Set([
  "memory",
  "assistant",
  "guardian",
  "admin",
  "docker-socket-proxy",
]);

/**
 * Validate a URL is safe for external HTTP requests (SSRF protection).
 *
 * Blocks:
 * - Cloud metadata IPs (169.254.x.x link-local range)
 * - Loopback addresses (127.x, ::1) — wrong target from inside Docker
 * - Known Docker Compose service names (memory, admin, etc.)
 * - Non-http(s) schemes
 *
 * Allows:
 * - LAN IPs (192.168.x, 10.x, 172.16-31.x) — LAN-first design
 * - `host.docker.internal` — host services (Ollama, LM Studio)
 * - Custom hostnames (gpu-server, my-nas.local, etc.)
 *
 * Returns null if valid, or an error message string if blocked.
 */
export function validateExternalUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  // Only http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked scheme: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known Docker service names
  if (DOCKER_SERVICE_NAMES.has(hostname)) {
    return `Blocked internal service: ${hostname}`;
  }

  // Block localhost (resolves to loopback)
  if (hostname === 'localhost') {
    return `Blocked address: ${hostname}`;
  }

  // Block loopback and dangerous IPs (but allow LAN IPs)
  if (isDangerousIp(hostname)) {
    return `Blocked address: ${hostname}`;
  }

  return null;
}

/**
 * Check if a hostname is a dangerous IP that should never be a connection target.
 *
 * Blocks loopback (127.x — points at the container itself, never what the user
 * intends) and link-local/metadata IPs (169.254.x — cloud metadata SSRF).
 *
 * Deliberately allows private LAN ranges (10.x, 172.16-31.x, 192.168.x)
 * because OpenPalm is LAN-first and users commonly run AI services on
 * other machines in their network.
 */
function isDangerousIp(hostname: string): boolean {
  // IPv4 patterns
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const octets = parts.map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;

    // 127.0.0.0/8 — loopback (inside Docker, this is the container itself)
    if (octets[0] === 127) return true;
    // 169.254.0.0/16 — link-local / cloud metadata endpoint
    if (octets[0] === 169 && octets[1] === 254) return true;
    // 0.0.0.0
    if (octets.every((o) => o === 0)) return true;
  }

  // IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") return true;

  return false;
}

/** Parse JSON body safely — returns null on parse failure or if body exceeds maxBytes */
export async function parseJsonBody(
  request: Request,
  maxBytes = 1_048_576
): Promise<Record<string, unknown> | null> {
  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return null;
    }
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}


