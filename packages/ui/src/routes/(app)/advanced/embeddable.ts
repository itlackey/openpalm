/**
 * What `/advanced` frames for a given connection.
 *
 * Two real cases, in order:
 *
 *  1. **This install's own assistant** — the locked default connection, whose
 *     `baseUrl` is this origin's `/oc` API proxy. It frames the static
 *     OpenCode web-UI bundle at {@link OPENCODE_WEB_PREFIX} (`$lib/opencode-web.ts`):
 *     same origin the browser already loaded, so it works identically on
 *     loopback, LAN, and behind any reverse proxy, and the app's API calls ride
 *     the session-gated `/oc`.
 *  2. **Another OpenCode the browser can frame directly** — a user-added
 *     connection naming its own origin ({@link isEmbeddableOpencodeUi}). The
 *     local bundle is deliberately NOT used for these: it is built to talk to
 *     THIS process's `/oc`, not to whatever server that connection names.
 *
 * Anything else returns null and the page renders a notice pointing at /chat —
 * a credentialed or Guardian connection (OpenPalm keeps Basic auth out of
 * iframe URLs, so an embedded UI could not authenticate), or a remote target
 * the browser refuses (mixed content).
 */
import { isAppOriginUrl, isLoopbackHost } from '$lib/connections/url-policy.js';
import { opencodeWebShellUrl } from '$lib/opencode-web.js';

export type EmbeddableConnection = { baseUrl: string; hasPassword: boolean };

/** The page's own location, narrowed to what this decision reads. */
export type EmbeddingPage = { origin: string; protocol: string };

/**
 * Can this connection's OpenCode web UI ride in an iframe at its OWN origin?
 *
 * Only when all of the following hold:
 *
 *  - **It is not this app's own origin.** The locked default connection points
 *    at the same-origin `/oc` pass-through, which proxies the OpenCode *API*,
 *    not a framable UI — that case frames the local bundle instead (see
 *    {@link resolveFrameBase}).
 *  - **It needs no credentials.** OpenPalm keeps Basic auth out of iframe URLs,
 *    so a credentialed (or userinfo-carrying) target could not authenticate.
 *  - **The browser won't block it as mixed content.** A loopback target is
 *    always allowed; otherwise an https page cannot frame a plain-http target.
 */
export function isEmbeddableOpencodeUi(
  connection: EmbeddableConnection,
  embeddingPage: EmbeddingPage,
): boolean {
  if (connection.hasPassword) return false;
  if (isAppOriginUrl(connection.baseUrl, embeddingPage.origin)) return false;
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (isLoopbackHost(url.hostname)) return true;
  return !(embeddingPage.protocol === 'https:' && url.protocol === 'http:');
}

/**
 * The URL `/advanced` should frame for `connection`, or null for the
 * not-embeddable notice. See the module header for the two cases.
 */
export function resolveFrameBase(
  connection: EmbeddableConnection & { isDefault: boolean },
  embeddingPage: EmbeddingPage,
): string | null {
  // `isDefault` and `hasPassword` narrow "points at this origin" to "IS this
  // install's locked assistant connection". A user-added entry that happens to
  // name this origin is not something the local bundle can serve — it talks to
  // THIS process's assistant, which is not what that connection asked for.
  if (
    connection.isDefault &&
    !connection.hasPassword &&
    isAppOriginUrl(connection.baseUrl, embeddingPage.origin)
  ) {
    return opencodeWebShellUrl();
  }
  if (isEmbeddableOpencodeUi(connection, embeddingPage)) return connection.baseUrl;
  return null;
}
