/**
 * Browser-owned connection URL policy (Phase 3a — "One UI, delete the split").
 *
 * A leaf module with zero imports so both the direct transport
 * (`probeHealth()` short-circuit) and the connections form can consult it
 * without pulling in the IndexedDB store module. Ported from
 * packages/client/src/lib/connections/url-policy.ts, minus the guardian
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

export type ConnectionUrlVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid-url'; message: string }
  | { ok: false; reason: 'userinfo-not-allowed'; message: string }
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
