/**
 * Single source of truth for the `op_session` cookie's Set-Cookie attributes.
 *
 * Every issuer (login, session, setup/complete) and the sliding-renewal path in
 * hooks.server.ts builds the cookie through these helpers so the attributes can
 * never drift apart. Logout uses `clearSessionCookie()` with the SAME path so
 * the browser actually drops the cookie.
 *
 * Attribute rationale:
 *  - HttpOnly       — the cookie is the only credential the browser holds; XSS
 *                     must not be able to read it.
 *  - SameSite=Lax   — the cookie must ride along on top-level GET navigations
 *                     (typing the admin URL, following a bookmark) so a valid
 *                     session loads admin with no prompt. SameSite=Strict drops
 *                     the cookie on cross-site top-level GETs (e.g. opening the
 *                     console from a link in another app on the LAN), which
 *                     would force a needless re-prompt. State-mutating requests
 *                     are independently CSRF-guarded by the Origin check
 *                     (SEC-2) in hooks.server.ts, so Lax is safe here.
 *  - Secure         — set ONLY when the request arrived over HTTPS. LAN installs
 *                     are commonly plain HTTP; hardcoding Secure would make the
 *                     browser refuse to send the cookie and break login entirely
 *                     on those deployments. We honour `x-forwarded-proto` first
 *                     (reverse-proxy TLS termination) then the request URL.
 *  - Path=/         — valid for the whole app; matched by the clear on logout.
 *  - Max-Age        — SESSION_TTL_SECONDS (14 days), in lockstep with the token expiry.
 */
import { SESSION_TTL_SECONDS } from "./session-store.js";

export const SESSION_COOKIE_NAME = "op_session";

/** True when the request reached us over HTTPS (direct or via TLS-terminating proxy). */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    // May be a comma-separated list (proxy chain); the left-most is the client.
    return forwarded.split(",")[0].trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the `Set-Cookie` value that issues/renews the session cookie.
 * `secure` is derived from the request so LAN-over-HTTP installs still work.
 */
export function sessionCookieHeader(token: string, request: Request): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build the `Set-Cookie` value that clears the session cookie (logout).
 * Must mirror name/path/attributes of the issued cookie so the browser deletes it.
 */
export function clearSessionCookieHeader(request: Request): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}
