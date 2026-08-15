/**
 * Which connections can host the OpenCode web UI inside /advanced's iframe.
 *
 * Extracted from the page so the classification is testable on its own: it is
 * the difference between the real workspace and a dead frame, and it depends on
 * three browser rules that are easy to get wrong (credentials, mixed content,
 * and what our own origin actually serves).
 */
import { isAppOriginUrl, isLoopbackHost } from '$lib/connections/url-policy.js';

/**
 * This app's own OpenCode workspace proxy — the frame target for a connection
 * that points back at this origin.
 *
 * Duplicated as a literal rather than imported from
 * `$lib/server/opencode-workspace.ts`: that module is server-only (it hashes
 * the injected shim with `node:crypto`) and importing it here would pull it
 * into the client bundle. `workspace-path.vitest.ts` pins the two together.
 */
export const OPENCODE_WORKSPACE_PATH = '/_opencode';

export type EmbeddableConnection = { baseUrl: string; hasPassword: boolean };

/** The page's own location, narrowed to what this decision reads. */
export type EmbeddingPage = { origin: string; protocol: string };

/** The server's `opencodeWorkspace` advertisement (see computeOpencodeWorkspace). */
export type OpencodeWorkspaceHint = {
  port: number;
  loopbackOnly: boolean;
  requiresAuth: boolean;
};
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
 * This is OpenCode at its own origin root, so it serves both of `/advanced`'s
 * uses: the iframe (which cannot point at the locked `/oc` connection — see
 * {@link isEmbeddableOpencodeUi}) and the new-tab escape hatch for deployments
 * where framing is refused.
 *
 * `canAuthenticate` says whether the CLIENT can satisfy OpenCode's Basic auth.
 * Only the desktop shell's FRAME can: the Electron main process answers the
 * challenge, where the credential already lives. Everywhere else — including
 * that same shell's new-tab link, which `shell.openExternal`s into the system
 * browser — a credentialed workspace is a password prompt nobody can answer.
 */
export function resolveWorkspaceUrl(
  hint: OpencodeWorkspaceHint | undefined,
  embeddingPage: { hostname: string },
  activeConnection: WorkspaceConnection | null | undefined,
  canAuthenticate = false,
): string | null {
  // The server hint describes only this install's local OpenCode listener. It
  // is not a workspace URL for an arbitrary browser-owned connection.
  if (!activeConnection?.isDefault || activeConnection.hasPassword) return null;
  if (!hint) return null;
  if (hint.requiresAuth && !canAuthenticate) return null;
  const { hostname } = embeddingPage;
  if (!hostname) return null;
  if (hint.loopbackOnly && !isLoopbackHost(hostname)) return null;
  return `http://${formatHostForUrl(hostname)}:${hint.port}`;
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
 *    loads an index.html whose every following request lands on OpenPalm.
 *    Those connections frame {@link OPENCODE_WORKSPACE_PATH} instead, which is
 *    the same origin with the retargeting the SPA needs; this predicate only
 *    ever answers for a connection pointing SOMEWHERE ELSE. See
 *    {@link resolveFrameBase}.
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
 * The URL `/advanced` should frame for `connection`, or null for the native
 * chat surface.
 *
 * Three cases, in the order they are decided:
 *
 *  1. **This install's own assistant** — the locked default connection, whose
 *     `baseUrl` is this origin's `/oc`. It frames
 *     {@link OPENCODE_WORKSPACE_PATH}: the same origin the browser already
 *     loaded, authenticated by the session it already holds, with OpenCode's
 *     Basic auth attached server-side. That is what makes the workspace
 *     survive a reverse proxy, a phone on the LAN, a tailnet, and
 *     `OPENCODE_AUTH=true` — all four of which the direct-port frame below
 *     cannot reach.
 *  2. **Another OpenCode the browser can frame directly** — a user-added
 *     connection naming its own origin ({@link isEmbeddableOpencodeUi}). The
 *     workspace proxy is deliberately NOT used: it forwards to THIS process's
 *     assistant, not to whatever server that connection names.
 *  3. **`directWorkspaceUrl`** — the pre-existing direct-port frame, kept as
 *     the fallback for a connection this app cannot serve from its own origin
 *     (in practice the desktop shell's credentialed workspace, which the
 *     Electron main process can authenticate). Null when there is none, and
 *     the caller falls back to the native surface.
 */
export function resolveFrameBase(
  connection: EmbeddableConnection & { isDefault: boolean },
  embeddingPage: EmbeddingPage,
  directWorkspaceUrl: string | null,
): string | null {
  // `isDefault` and `hasPassword` narrow "points at this origin" to "IS this
  // install's locked assistant connection". A user-added entry that happens to
  // name this origin is not something the workspace proxy can serve, so it
  // falls through rather than framing an assistant it never asked for.
  if (
    connection.isDefault &&
    !connection.hasPassword &&
    isAppOriginUrl(connection.baseUrl, embeddingPage.origin)
  ) {
    return OPENCODE_WORKSPACE_PATH;
  }
  if (isEmbeddableOpencodeUi(connection, embeddingPage)) return connection.baseUrl;
  return directWorkspaceUrl;
}
