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

/** The server's `opencodeWorkspace` advertisement (see computeOpencodeWorkspace). */
export type OpencodeWorkspaceHint = { port: number };
export type WorkspaceConnection = { isDefault: boolean; hasPassword: boolean };

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

/**
 * The address of OpenCode's own web UI for THIS browser.
 *
 * Composed from the page the browser is already on — same host, same scheme,
 * the advertised port — because the browser is the only party that knows how
 * it reached this app. The server publishes a port, never a URL: it cannot
 * know whether a request arrived direct, over a tailnet, or through someone's
 * reverse proxy, and every one of those answers a different hostname.
 *
 * The SCHEME follows the page for a hard browser reason, not a stylistic one:
 * an https page may not embed a plain-http frame at all (mixed content), so
 * `http://` hardcoded here would silently blank the workspace for every
 * deployment behind TLS. Taking the page's scheme means the address is the
 * only one that could work, whatever fronts this app.
 *
 * Whether anything actually ANSWERS there is not decided here — the caller
 * probes it (see +page.svelte). Inferring reachability from the server's bind
 * address is what this used to do, and it got the two most common remote
 * deployments wrong in opposite directions: a loopback-published stack behind
 * Caddy or Tailscale Serve is perfectly reachable at the host the browser
 * typed, and was refused a workspace for it.
 *
 * This is OpenCode at its own origin root, so it serves both of `/advanced`'s
 * uses: the iframe (which cannot point at the locked `/oc` connection — see
 * {@link isEmbeddableOpencodeUi}) and the new-tab escape hatch.
 *
 * No credential is involved on this side. The listener behind this address
 * checks the `op_session` cookie the browser already holds (cookies are scoped
 * by host, not port, so it is sent there too) and attaches OpenCode's own
 * password upstream, server-side. That is what lets an ordinary browser — LAN,
 * tailnet, desktop shell alike — reach the workspace with nothing to type.
 */
export function resolveWorkspaceUrl(
  hint: OpencodeWorkspaceHint | undefined,
  embeddingPage: { hostname: string; protocol: string },
  activeConnection: WorkspaceConnection | null | undefined,
): string | null {
  // The server hint describes only this install's local workspace listener. It
  // is not a workspace URL for an arbitrary browser-owned connection.
  if (!activeConnection?.isDefault || activeConnection.hasPassword) return null;
  if (!hint) return null;
  const { hostname, protocol } = embeddingPage;
  if (!hostname) return null;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return `${protocol}//${formatHostForUrl(hostname)}:${hint.port}`;
}

/**
 * Does anything answer at the workspace address?
 *
 * `no-cors` because there is nothing to read: OpenCode sends no CORS headers
 * for this app's origin, so a normal fetch would be rejected by the browser
 * even when the server answered perfectly. An opaque response is still the
 * only fact needed — it resolves for ANY HTTP reply (the listener's own 401
 * included) and rejects only when the address does not answer at all, which is
 * exactly the distinction between "frame it" and "show the native surface".
 *
 * The timeout is what makes this safe to await before rendering: a refused
 * connection fails immediately, but a DROPPED one (a firewall between a remote
 * browser and a port nobody forwarded) hangs until the browser gives up
 * minutes later, and `/advanced` would sit on its spinner for all of it.
 */
export async function isWorkspaceReachable(url: string, timeoutMs = 2500): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'include',
      cache: 'no-store',
      signal: abort.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
 *    it surfaced: "refused to connect".) These connections frame the same
 *    OpenCode at its OWN origin instead — see {@link resolveWorkspaceUrl}.
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
