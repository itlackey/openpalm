/**
 * Browser-owned connection URL policy (Phase 3a — "One UI, delete the split").
 *
 * A leaf module with zero imports so both the direct transport
 * (`probeHealth()` short-circuit) and the connections form can consult it
 * without pulling in the IndexedDB store module. There is no guardian
 * `/oc`-appending helper — Guardian is a transparent OpenCode proxy now, so
 * the user provides the exact baseUrl and no path inference is performed.
 *
 * The ONLY refusal trigger: a plain-http, non-loopback connection URL is
 * refused iff the app itself runs on an https: origin. This is exactly the
 * platform mixed-content rule (an https origin cannot `fetch()` a plain-http
 * cross-origin target — the request would never leave the browser), not a
 * broader "https or non-loopback origin" check. Preserves:
 *   - loopback TARGETS from any origin (mixed-content loopback exemption —
 *     `http://127.0.0.1`/`localhost`/`::1` are "potentially trustworthy"),
 *   - plain-http LAN targets from a loopback-origin client (the zero-TLS
 *     desktop default — a `http://127.0.0.1` origin is a secure context),
 *   - plain-http LAN targets from a non-loopback http ORIGIN (the LAN-served
 *     tier: `rewriteLoopbackUrlForBrowserHost` in `./store.ts`).
 */

/** Canonical deep link to the TLS integration guide. Pinned by a test that
 * the path segment names a real file, so a docs rename breaks CI instead of
 * shipping a dead link. */
export const TLS_GUIDE_URL =
  'https://github.com/itlackey/openpalm/blob/main/docs/remote-access-tls.md';

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === 'http:') return '80';
  if (url.protocol === 'https:') return '443';
  return '';
}

/** Loopback host spellings identify the same local listener when their ports match. */
export function hasSameLoopbackPort(first: string, second: string): boolean {
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    return (
      isLoopbackHost(firstUrl.hostname) &&
      isLoopbackHost(secondUrl.hostname) &&
      effectivePort(firstUrl) === effectivePort(secondUrl)
    );
  } catch {
    return false;
  }
}

/**
 * True when `rawUrl` resolves back to the app's own origin — which, for the
 * locked default connection, means the same-origin `/oc` pass-through.
 *
 * That path is an OpenCode **API** proxy, never its web UI. OpenCode's web UI
 * is a root-mounted SPA: it resolves `/assets/*`, `/api/*`, `/global/*` and its
 * bare API paths against `location.origin`, ignoring any prefix the document
 * was served under (its stored server URL is normalized to an origin too). So
 * a connection pointing at this origin cannot be embedded as a UI — the frame
 * would load an index.html whose every subsequent request lands on OpenPalm.
 *
 * `pageOrigin` is `location.origin`-shaped; a null/empty origin (SSR, tests)
 * answers false, since there is no app origin to collide with.
 */
export function isAppOriginUrl(rawUrl: string, pageOrigin: string | null | undefined): boolean {
  if (!pageOrigin) return false;
  try {
    return new URL(rawUrl, pageOrigin).origin === pageOrigin;
  } catch {
    return false;
  }
}

export type ConnectionUrlVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid-url'; message: string }
  | { ok: false; reason: 'userinfo-not-allowed'; message: string }
  | { ok: false; reason: 'query-or-fragment-not-allowed'; message: string }
  | { ok: false; reason: 'insecure-remote'; message: string; guideUrl: string };

export type BrowserOrigin = { protocol: string; hostname: string };

/** Remove legacy URL-embedded credentials before a URL reaches UI or storage. */
export function redactUrlUserinfo(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, url.pathname === '/' && !rawUrl.endsWith('/') ? '' : '/');
  } catch {
    return rawUrl;
  }
}

/**
 * Refuse a plain-http non-loopback connection URL iff the app's own origin is
 * https: (mixed content — the request could never succeed, so refuse up front
 * with guidance instead of a generic fetch failure).
 *
 * `origin` defaults to `globalThis.location`; a null/undefined origin
 * (non-browser context — tests, SSR) always allows, since there is no browser
 * mixed-content policy to enforce there.
 */
export function validateConnectionUrl(
  rawUrl: string,
  origin: BrowserOrigin | null = globalThis.location ?? null
): ConnectionUrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url', message: 'Enter a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid-url', message: 'The URL must use http:// or https://.' };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'userinfo-not-allowed',
      message: 'Do not put credentials in the URL. Use the Authentication fields instead.',
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      reason: 'query-or-fragment-not-allowed',
      message: 'The connection address cannot include a query string or fragment.',
    };
  }
  if (url.protocol === 'https:') return { ok: true };
  if (isLoopbackHost(url.hostname)) return { ok: true };
  if (origin?.protocol !== 'https:') return { ok: true };

  return {
    ok: false,
    reason: 'insecure-remote',
    message:
      'This app runs on a secure (https) origin, so browsers block plain-HTTP connections to ' +
      'remote servers. Use an https:// URL — see the TLS setup guide.',
    guideUrl: TLS_GUIDE_URL,
  };
}
