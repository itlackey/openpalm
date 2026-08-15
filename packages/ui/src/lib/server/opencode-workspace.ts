/**
 * Serving OpenCode's web UI under a path on OpenPalm's OWN origin.
 *
 * ## Why a path and not a port
 *
 * `/advanced` used to frame OpenCode at its own origin — `http://<the host the
 * browser typed>:${OP_ASSISTANT_PORT}`. That address only exists for a browser
 * on the same machine as the published port, so the frame died in every
 * deployment that is not "laptop talking to its own loopback": behind a reverse
 * proxy (an https page cannot frame plain http), from a phone on the LAN when
 * the port is loopback-published, over a tailnet, and — whatever the topology —
 * whenever `OPENCODE_AUTH` is on, because a frame cannot answer a Basic
 * challenge.
 *
 * Every one of those disappears when the workspace rides the origin the browser
 * already loaded: one ordinary reverse proxy in front of OpenPalm carries the
 * workspace with it, with no provider-specific route for Caddy, Tailscale
 * Serve, Funnel, or anything else. The OpenPalm session is the credential and
 * the upstream Basic auth is attached server-side (see `opencode-proxy.ts`).
 *
 * ## Why the browser needs help
 *
 * OpenCode's web UI is a Vite SPA built with `base: "/"`, embedded in the
 * `opencode` binary. It has no base-path flag or env var (checked against the
 * pinned 1.18.9 build: `opencode serve --help`, and the `OPENCODE_*` string
 * table), and it resolves its API against `location.origin` with root-absolute
 * paths — `new URL("/api/session", server)` discards any path on `server`, so
 * pointing its stored server URL at `…/_opencode` does not work either. Three
 * classes of request therefore have to be retargeted in the browser:
 *
 *   1. **API + SSE + websockets** — `fetch`/`EventSource`/`WebSocket`/`XHR` to
 *      same-origin root paths (`/api/*`, `/global/*`, `/session`, `/config`,
 *      `/provider`, …). The {@link WORKSPACE_SHIM} below wraps those four
 *      constructors and prefixes the path. Generic: no endpoint allowlist to
 *      drift as OpenCode adds routes.
 *   2. **Static assets** — `<script src="/assets/…">`, Vite's `modulepreload`
 *      links, and `url(/assets/Inter.ttf)` inside its CSS. None of those go
 *      through a JS API the shim can wrap, so `/assets/*` is proxied at THIS
 *      origin's root instead (`routes/assets/[...path]`). OpenPalm's own build
 *      output lives under `/_app/*`, so the namespace is free.
 *   3. **The SPA's own router**, which reads `location.pathname`. The shim
 *      strips the prefix with `history.replaceState` before the app boots, so
 *      a session deep link (`/_opencode/<base64 dir>/session/<id>`) resolves to
 *      the route OpenCode expects. Without this the router matches nothing and
 *      renders a blank frame.
 *
 * That is the whole mechanism: one injected script, one asset namespace. No
 * upstream response body is rewritten, so an OpenCode upgrade that renames a
 * chunk, adds an endpoint, or reshapes its HTML needs no change here.
 */
import { createHash } from 'node:crypto';

/** Where the framed workspace lives on this origin. */
export const WORKSPACE_PREFIX = '/_opencode';

/**
 * OpenCode's static-asset namespace, proxied at THIS origin's root.
 *
 * Root-absolute because the SPA's asset base is baked in at `/` and reaches
 * the browser through `<link>`/`<script>`/CSS `url()` — none of which the shim
 * can intercept. Excluded from the shim's retargeting for the same reason.
 */
export const WORKSPACE_ASSET_PREFIX = '/assets/';

/**
 * The injected script. Runs in `<head>`, before OpenCode's own module script
 * (which is deferred), so the router sees the corrected path and the first
 * request already goes through the proxy.
 *
 * Written as plain ES5-era script, not a module: it must execute synchronously
 * and it is hashed verbatim into the CSP below, so it cannot be transpiled or
 * minified by anything downstream.
 */
export const WORKSPACE_SHIM = `;(function () {
  var PREFIX = ${JSON.stringify(WORKSPACE_PREFIX)};
  var ASSETS = ${JSON.stringify(WORKSPACE_ASSET_PREFIX)};

  function retarget(input) {
    var raw = String(input);
    try {
      var url = new URL(raw, location.href);
      if (url.origin !== location.origin) return raw;
      if (url.pathname === PREFIX || url.pathname.indexOf(PREFIX + '/') === 0) return raw;
      if (url.pathname.indexOf(ASSETS) === 0) return raw;
      url.pathname = PREFIX + url.pathname;
      return url.href;
    } catch (error) {
      return raw;
    }
  }

  if (location.pathname === PREFIX || location.pathname.indexOf(PREFIX + '/') === 0) {
    var routed = location.pathname.slice(PREFIX.length) || '/';
    try {
      history.replaceState(history.state, '', routed + location.search + location.hash);
    } catch (error) {}
  }

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return nativeFetch(new Request(retarget(input.url), input), init);
    }
    return nativeFetch(retarget(input), init);
  };

  var NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    var PrefixedEventSource = function (url, config) {
      return new NativeEventSource(retarget(url), config);
    };
    PrefixedEventSource.prototype = NativeEventSource.prototype;
    PrefixedEventSource.CONNECTING = 0;
    PrefixedEventSource.OPEN = 1;
    PrefixedEventSource.CLOSED = 2;
    window.EventSource = PrefixedEventSource;
  }

  var NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    var PrefixedWebSocket = function (url, protocols) {
      return new NativeWebSocket(retarget(url), protocols);
    };
    PrefixedWebSocket.prototype = NativeWebSocket.prototype;
    PrefixedWebSocket.CONNECTING = 0;
    PrefixedWebSocket.OPEN = 1;
    PrefixedWebSocket.CLOSING = 2;
    PrefixedWebSocket.CLOSED = 3;
    window.WebSocket = PrefixedWebSocket;
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = retarget(url);
    return nativeOpen.apply(this, arguments);
  };
})();`;

/** CSP source expression for the shim, computed once from its exact bytes. */
const WORKSPACE_SHIM_CSP_SOURCE = `'sha256-${createHash('sha256')
  .update(WORKSPACE_SHIM, 'utf8')
  .digest('base64')}'`;

/**
 * Insert the shim as the first thing in `<head>`.
 *
 * A document with no `<head>` is not something OpenCode serves, but the proxy
 * must not silently drop the shim if that ever changes — prepending leaves a
 * working page either way (the browser hoists a leading `<script>` into an
 * implied head).
 */
export function injectWorkspaceShim(html: string): string {
  const tag = `<script>${WORKSPACE_SHIM}</script>`;
  const headIndex = html.indexOf('<head>');
  if (headIndex === -1) return `${tag}${html}`;
  const insertAt = headIndex + '<head>'.length;
  return `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`;
}

/**
 * Let the upstream's own Content-Security-Policy execute the shim.
 *
 * OpenCode serves `script-src 'self' 'wasm-unsafe-eval' 'sha256-…'` (the hash
 * covers its own inline theme-preload script), so the shim needs its hash
 * added or the browser refuses to run it and the frame loads a workspace that
 * talks to nothing. The `default-src` arm matters only if OpenCode ever drops
 * `script-src`: inline script would then fall back to `default-src` and break
 * in a way no test of ours would name. No CSP header at all needs no change.
 */
export function allowWorkspaceShimInCsp(headers: Headers): void {
  const policy = headers.get('content-security-policy');
  if (!policy) return;
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean);
  const scriptIndex = directives.findIndex((d) => /^script-src(\s|$)/i.test(d));
  if (scriptIndex !== -1) {
    directives[scriptIndex] = `${directives[scriptIndex]} ${WORKSPACE_SHIM_CSP_SOURCE}`;
    headers.set('content-security-policy', directives.join('; '));
    return;
  }
  const defaultDirective = directives.find((d) => /^default-src(\s|$)/i.test(d));
  if (!defaultDirective) return;
  const inherited = defaultDirective.replace(/^default-src/i, '').trim();
  directives.push(`script-src ${inherited} ${WORKSPACE_SHIM_CSP_SOURCE}`.trim());
  headers.set('content-security-policy', directives.join('; '));
}
