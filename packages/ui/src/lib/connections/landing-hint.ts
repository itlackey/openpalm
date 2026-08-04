/**
 * A one-bit breadcrumb so the server can stop sending returning users to /start.
 *
 * The launch landing is resolved SERVER-side, but connections are browser-owned
 * (IndexedDB). The server therefore could not tell "fresh machine, never
 * configured" apart from "has three remote assistants saved", and answered
 * /start for both whenever no local stack was installed. Every launch went
 * through the welcome screen and only then self-redirected — the whole reason
 * `resolveLanding` already accepts a `connections` list it could never populate
 * for this case.
 *
 * A cookie is the one piece of browser-owned state a server request carries, so
 * that is what closes the gap. It holds a boolean and nothing else: no URL, no
 * label, no credential, no count. It is deliberately readable and writable by
 * the page (the client is what knows the answer).
 *
 * TRUST BOUNDARY: this is a HINT, not an authorization. It is client-controlled
 * and must never gate anything that matters. The worst a forged value can do is
 * land a browser on /chat instead of /start — both are public usage routes in
 * this lane, and no capability, auth, or install decision reads it. Absent the
 * cookie, routing is exactly what it was before.
 */

/** Cookie name shared with `$lib/server/landing.ts`. */
export const CONNECTIONS_HINT_COOKIE = 'op_has_connections';

/** A year — the hint is refreshed on every load, so drift self-corrects. */
const MAX_AGE_SECONDS = 31_536_000;

/**
 * Record whether this browser has any saved connection.
 *
 * Best-effort and never throws: a browser that refuses cookies just keeps the
 * pre-existing /start behaviour, which is a slower landing, not a broken one.
 */
export function syncConnectionsLandingHint(hasConnections: boolean): void {
  try {
    if (typeof document === 'undefined') return;
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is still Chromium-only (no Firefox, no Safari), and this hint has to work in every browser that can run the client — including the ones most likely to be a second device connecting to a stack elsewhere. One boolean write needs no partial-update safety either.
    document.cookie = hasConnections
      ? `${CONNECTIONS_HINT_COOKIE}=1; Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`
      : `${CONNECTIONS_HINT_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
  } catch {
    // Cookies disabled or a sandboxed document — routing simply stays as it was.
  }
}
