/**
 * The header policy shared by this process's two OpenCode proxies.
 *
 * There are two, deliberately, and they will stay two: `/oc/[...path]` is a
 * SvelteKit route serving the API on this app's own origin, and
 * `workspace-listener.ts` is a bare `http.Server` serving OpenCode's web UI at
 * an origin root (that SPA resolves `/assets` and `/api` against
 * `location.origin`, so it cannot live under a path here). Their plumbing has
 * nothing in common — one moves a `Request`/`Response` pair, the other moves
 * `IncomingMessage`/`ServerResponse` plus a raw socket splice.
 *
 * What they DO share is which headers may cross, and that is the part worth
 * having in one place: both talk to the same upstream, with the same
 * credential, under the same cookie scope. Keeping a private copy each is how
 * `set-cookie` came to be dropped on one lane and forwarded on the other.
 */

/**
 * Request headers that must not reach OpenCode.
 *
 * Node lowercases `IncomingMessage.headers` keys and the WHATWG `Headers`
 * iterator yields lowercase names, so membership can be tested directly — no
 * caller needs to `toLowerCase()` first.
 */
export const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  // The upstream's own host is substituted by the caller.
  'host',
  // Hop-by-hop (RFC 9110 §7.6.1) — meaningful only to the previous hop.
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  // Never forward the browser's cookie to OpenCode: it is this app's session,
  // not an upstream credential, and OpenCode has no use for it.
  'cookie',
  // Replaced with the resolved upstream credential by the caller, if any.
  'authorization',
  // Recomputed from the body actually sent.
  'content-length',
]);

/**
 * Response headers that must not reach the browser.
 *
 * `set-cookie` is the one with teeth. Cookies are scoped by HOST and not by
 * port, so a cookie OpenCode set through EITHER proxy would land in the same
 * jar as `op_session` on this app's own origin. That is the same property the
 * workspace listener relies on to authenticate a browser with one login, which
 * is exactly why the upstream must not be able to write into it.
 */
export const STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  // Hop-by-hop.
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'trailer',
  // Deliberately dropped: node's fetch transparently decompresses a gzip/br
  // upstream while still exposing the ORIGINAL compressed length and encoding,
  // so forwarding either truncates the stream the browser actually receives.
  // Letting the transport re-chunk is correct for buffered JSON and SSE alike.
  'content-length',
  'content-encoding',
  // This process owns its own cookie scope; OpenCode must not set cookies on it.
  'set-cookie',
]);
