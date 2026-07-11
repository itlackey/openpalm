/**
 * Rewrite a wildcard bind host (0.0.0.0, ::, [::]) at the front of a URL to
 * the loopback address. A server can legitimately BIND to a wildcard address
 * (accept connections on every interface), but a URL with a wildcard host is
 * never something a client — least of all a browser — can actually connect
 * to. Any code that turns a bind-address setting into a URL a browser will
 * fetch (runtime-config.json, a locked default connection, a proxy target)
 * must run the result through this first.
 *
 * Relocated from packages/electron/src/local-opencode.ts (review finding E1)
 * so it is shared by every writer instead of re-implemented per surface.
 */
export function normalizeLoopbackUrl(raw: string): string {
  return raw.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\]|::)(?=[:/]|$)/i, '$1127.0.0.1');
}
