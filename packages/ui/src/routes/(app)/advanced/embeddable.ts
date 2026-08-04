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
/** The server's `opencodeWorkspace` advertisement (see computeOpencodeWorkspace). */
export type OpencodeWorkspaceHint = { port: number; loopbackOnly: boolean };
export type WorkspaceConnection = { isDefault: boolean; hasPassword: boolean };

/**
 * The address of OpenCode's own web UI for THIS browser, or null when there
 * isn't one it can reach.
 *
 * Composed from the host the browser actually visited, because that is the
 * only party that knows it — the server publishes a port, not a URL. A
 * loopback-only publish is reachable only from the machine running the stack,
 * so a LAN or tailnet client gets null rather than an address that resolves to
 * its own device. The scheme is always http: OpenCode serves plain HTTP, and
 * any TLS in front of it is a proxy this hint knows nothing about.
 *
 * This is for opening the workspace as a top-level page, NOT for framing —
 * top-level navigation is exempt from X-Frame-Options, frame-src, and
 * mixed-content blocking, so it works in deployments where an iframe cannot.
 */
/**
 * Format a hostname for use in a URL authority.
 *
 * The WHATWG URL parser already returns an IPv6 host bracketed (`[::1]`), so
 * `page.url.hostname` needs nothing here. The bare spelling still has to be
 * handled, because this module's own reachability check (`isLoopbackHost`)
 * accepts `::1` as well — and interpolating that unbracketed produces
 * `http://::1:3810`, which is not a URL at all (RFC 3986 §3.2.2).
 */
function formatHostForUrl(hostname: string): string {
  if (!hostname.includes(':')) return hostname;
  return hostname.startsWith('[') ? hostname : `[${hostname}]`;
}

export function resolveWorkspaceUrl(
  hint: OpencodeWorkspaceHint | undefined,
  embeddingPage: { hostname: string },
  activeConnection: WorkspaceConnection | null | undefined,
): string | null {
  // The server hint describes only this install's local OpenCode listener. It
  // is not a workspace URL for an arbitrary browser-owned connection.
  if (!activeConnection?.isDefault || activeConnection.hasPassword) return null;
  if (!hint) return null;
  const { hostname } = embeddingPage;
  if (!hostname) return null;
  if (hint.loopbackOnly && !isLoopbackHost(hostname)) return null;
  return `http://${formatHostForUrl(hostname)}:${hint.port}`;
}

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
