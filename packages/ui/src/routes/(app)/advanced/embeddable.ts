/**
 * Which connections can host the OpenCode web UI inside /advanced's iframe.
 *
 * Extracted from the page so the classification is testable on its own: it is
 * the difference between the real workspace and a dead frame, and it depends on
 * three browser rules that are easy to get wrong (credentials, mixed content,
 * and what our own origin actually serves).
 */
import { isAppOriginUrl, isLoopbackHost } from '$lib/connections/url-policy.js';

export type EmbeddableConnection = { baseUrl: string; hasPassword: boolean };

/** The page's own location, narrowed to what this decision reads. */
export type EmbeddingPage = { origin: string; protocol: string };

/**
 * Can this connection's OpenCode web UI ride in an iframe?
 *
 * Only when all of the following hold:
 *
 *  - **It is not this app's own origin.** The locked default connection points
 *    at the same-origin `/oc` pass-through, which proxies the OpenCode *API*.
 *    OpenCode's web UI is a root-mounted SPA — it resolves `/assets/*`,
 *    `/api/*`, `/global/*` and its bare API paths against `location.origin`
 *    regardless of the path its document was served under — so framing `/oc`
 *    loads an index.html whose every following request lands on OpenPalm. (The
 *    app's own `X-Frame-Options: DENY` refuses that frame first, which is how
 *    it surfaced: "refused to connect".) These connections get the native chat
 *    surface, which speaks to the same OpenCode through the same proxy.
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
