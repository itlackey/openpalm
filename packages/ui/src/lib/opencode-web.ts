/**
 * The static OpenCode web-UI bundle — where it lives on this origin and how to
 * deep-link into it.
 *
 * `/advanced` frames OpenCode's own web app, built from source pinned to the
 * same version as the `opencode` runtime, with a real base path
 * (`scripts/opencode-web/build.sh` — the script's header documents the how and
 * why). The bundle is plain static files under `static/opencode-ui/`; every
 * API call it makes goes to the same-origin `/oc` proxy, which enforces the
 * OpenPalm session and attaches OpenCode's credential server-side. There is no
 * runtime rewriting of any kind.
 *
 * Client-safe module: shared by the browser (frame URLs in `/advanced`) and
 * the server (hooks exemptions, the SPA-fallback route), so nothing here may
 * import Node builtins.
 */

/** Where the bundle is served. Must match the build script's `--base`. */
export const OPENCODE_WEB_PREFIX = '/opencode-ui';

/**
 * The server URL the bundle is BUILT to talk to (`VITE_OPENCODE_SERVER_URL` in
 * the build script), which is also the identity OpenCode's app uses for its
 * server-scoped routes: its "server key" is the resolved URL string.
 */
export const OPENCODE_WEB_SERVER_PATH = '/oc';

/**
 * URL-safe base64 without padding — the exact encoding OpenCode's app uses for
 * route segments (`base64Encode` in their `core/util/encode`). The two must
 * match byte-for-byte or deep links open the project list instead of the
 * session.
 */
function base64EncodeUrlSafe(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** The framed workspace root. */
export function opencodeWebShellUrl(): string {
  return `${OPENCODE_WEB_PREFIX}/`;
}

/**
 * Deep link to a session inside the framed workspace.
 *
 * OpenCode's session route is `/server/<base64(server key)>/session/<id>`,
 * where the server key is the app's resolved server URL — for this bundle,
 * `<origin>/oc` (see `entry.tsx`'s patched `getCurrentUrl`). Only the browser
 * knows the origin it visited, so the caller passes `location.origin`.
 *
 * These paths are not files; the SPA-fallback route serves the shell for them
 * (`routes/opencode-ui/[...path]/+server.ts`) and the app's router — built
 * with `base=/opencode-ui/` — takes it from there.
 */
export function opencodeWebSessionUrl(origin: string, sessionId: string): string {
  const serverKey = base64EncodeUrlSafe(`${origin}${OPENCODE_WEB_SERVER_PATH}`);
  return `${OPENCODE_WEB_PREFIX}/server/${serverKey}/session/${encodeURIComponent(sessionId)}`;
}
