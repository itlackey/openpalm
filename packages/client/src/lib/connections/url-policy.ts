/**
 * #557 D1/D6 — client-local connection URL policy. A leaf module with zero
 * imports (purity-safe by construction: this package never depends on the
 * host control-plane library and never holds host credentials, §8.10) so
 * both the transport (`probeHealth()` short-circuit) and the connections
 * form can consult it without pulling in the IndexedDB store module.
 *
 * D1 — the ONLY refusal trigger: a plain-http, non-loopback connection URL
 * is refused iff the app itself runs on an https: origin. This is exactly
 * the platform mixed-content rule (an https origin cannot `fetch()` a
 * plain-http cross-origin target — the request would never leave the
 * browser), not a broader "https or non-loopback origin" check. Preserves:
 *   - loopback TARGETS from any origin (mixed-content loopback exemption —
 *     `http://127.0.0.1`/`localhost`/`::1` are "potentially trustworthy"),
 *   - plain-http LAN targets from a loopback-origin client (the zero-TLS
 *     desktop default — a `http://127.0.0.1` origin is a secure context),
 *   - plain-http LAN targets from a non-loopback http ORIGIN (the LAN-served
 *     client tier: `rewriteLoopbackUrlForBrowserHost` in `./index.ts`).
 */

/** Canonical deep link to the TLS integration guide (D4). Pinned by a test
 * that the path segment names a real file, so a docs rename breaks CI
 * instead of shipping a dead link. */
export const TLS_GUIDE_URL =
  'https://github.com/itlackey/openpalm/blob/main/docs/remote-access-tls.md';

/** Canonical deep link to the remote-client provisioning walkthrough (#486
 * D3: enable GUARDIAN_DIRECT_INGRESS, add the client origin to
 * GUARDIAN_CORS_ALLOWED_ORIGINS, mint a `direct` principal). Same pinning
 * idiom as {@link TLS_GUIDE_URL} — a test asserts the path segment names a
 * real file, so a docs rename breaks CI instead of shipping a dead link. */
export const REMOTE_CLIENT_GUIDE_URL =
  'https://github.com/itlackey/openpalm/blob/main/docs/managing-openpalm.md';

/** Moved verbatim from `./index.ts` (D6) — not duplicated. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export type ConnectionUrlVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid-url'; message: string }
  | { ok: false; reason: 'insecure-remote'; message: string; guideUrl: string };

type BrowserOrigin = { protocol: string; hostname: string };

/**
 * D1: refuse a plain-http non-loopback connection URL iff the app's own
 * origin is https: (mixed content — the request could never succeed, so
 * refuse up front with guidance instead of a generic fetch failure).
 *
 * `origin` defaults to `globalThis.location`; a null/undefined origin
 * (non-browser context — tests, SSR) always allows, since there is no
 * browser mixed-content policy to enforce there.
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

/**
 * #486 D2: normalize a guardian ('openpalm-client-api'-kind) connection URL
 * so it always ends in `/oc` — the guardian's direct-ingress base path
 * (`GUARDIAN_DIRECT_INGRESS`). Once stored with the `/oc` suffix, the
 * transport's baseUrl already routes every call correctly with no further
 * rewriting. Pure string-in/string-out: never throws (validation — rejecting
 * garbage input — is {@link validateConnectionUrl}'s job), and unparseable
 * input is returned unchanged.
 *
 * `packages/ui/src/lib/server/endpoints.ts` carries a deliberate SERVER-side
 * twin (`normalizeGuardianOcUrl`) with the same rule — the client may not
 * import host code and vice versa (this package never depends on the shared
 * host control-plane library or any other host modules), so this is the same
 * accepted duplication as `validateConnectionUrl`/`validateEndpointUrl`.
 * Both are pinned by their own tests.
 */
export function normalizeGuardianUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/oc') ? pathname : `${pathname}/oc`;
  return url.toString().replace(/\/+$/, '');
}
