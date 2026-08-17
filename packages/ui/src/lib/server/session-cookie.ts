/**
 * Single source of truth for the `op_session` cookie's name and Set-Cookie
 * attributes.
 *
 * Every issuer (login, setup/complete) and the sliding-renewal path in
 * hooks.server.ts builds the cookie through these helpers so the attributes can
 * never drift apart. Logout uses `clearSessionCookie()` with the SAME path so
 * the browser actually drops the cookie.
 *
 * Cookie NAME is per-surface, not a fixed string (see SESSION_COOKIE_NAME
 * below) — the host admin process (:3880) and the assistant container's UI
 * co-process (:3800) both answer on 127.0.0.1, so a shared cookie name is one
 * jar entry fought over by two processes whose signed tokens are mutually
 * invalid (each signs with its own key — see session-store.ts). Whichever
 * surface issues the cookie last silently signs the other one out.
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

/**
 * Resolve the per-surface cookie name. Exported (rather than inlined below)
 * purely so tests can drive both branches without needing a fresh module
 * instance — production always calls it with the ambient `process.env`.
 *
 * `OP_UI_SERVED_IN_CONTAINER` is the existing, entrypoint-only marker for
 * "this process is the assistant container's UI co-process" (see
 * session-store.ts's `getUiLoginPassword` and helpers.ts's
 * `isPublishedContainerUi`); it is set before the process — and therefore
 * this module — ever starts, so resolving it once at import time (below) is
 * safe: the two surfaces are always separate OS processes, never one process
 * switching surfaces mid-run.
 *
 * The host surface keeps the original name so upgrading an existing host
 * install needs no re-login; only the container surface's cookie (and any
 * session held there) is invalidated by this change — one re-login, on the
 * surface where the clash was actually reported.
 *
 * IMPORTANT — companion fix needed outside this file's ownership:
 * `helpers.ts`'s `extractToken()` (which `requireAdmin()` /
 * `identifyCallerByToken()` use for every protected request, on BOTH
 * surfaces) currently matches the incoming cookie with a hardcoded
 * `op_session=` regex instead of importing SESSION_COOKIE_NAME from this
 * module. Until that regex is switched to use SESSION_COOKIE_NAME, the
 * container surface will mint a cookie under the new name but never be able
 * to read it back — i.e. this change must not ship without that one-line
 * companion edit, or the assistant UI (:3800) loses the ability to
 * authenticate entirely.
 */
export function resolveSessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OP_UI_SERVED_IN_CONTAINER === "1" ? "op_session_assistant" : "op_session";
}

export const SESSION_COOKIE_NAME = resolveSessionCookieName();

/**
 * This surface's session token out of a raw `Cookie` header, or `''`.
 *
 * Lives here because this module owns the cookie NAME, and the name is
 * per-surface (see above). Three callers had grown their own reader — the
 * SvelteKit auth helper, the sliding-renewal path, and the workspace listener
 * — which is the drift this file's own header warns about at length: a reader
 * that disagrees with the writer authenticates nothing.
 *
 * Takes the header string rather than a `Request` or a `RequestEvent` because
 * the workspace listener is a bare `http.Server` with neither.
 */
export function sessionTokenFromCookieHeader(header: string | undefined | null): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

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
 *
 * Host-only, with no `Domain`. The workspace is another PORT of this same
 * hostname and cookies ignore ports, so there is nothing to widen for.
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
