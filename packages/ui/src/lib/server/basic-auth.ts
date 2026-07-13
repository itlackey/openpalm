/**
 * Shared HTTP Basic-auth encoding for host-UI → OpenCode/guardian calls.
 *
 * PR #564 P2-1: every host forwarder MUST send the exact same UTF-8 byte
 * sequence the assistant and guardian expect. Two divergences caused correct
 * passwords to 401 from the host:
 *  - `btoa()` is Latin-1-only and throws / corrupts on non-Latin-1 bytes
 *    (accents, CJK, emoji). Encode UTF-8 first (matches the guardian's
 *    `Buffer.from(..., 'utf-8')`).
 *  - the file-backed password was `.trim()`-ed, stripping surrounding spaces,
 *    while the assistant entrypoint (`$(cat)`) and the guardian strip only
 *    trailing newlines. Use `stripTrailingNewlines` so a password like
 *    `"päss 🔒 "` authenticates identically everywhere.
 */

/** OpenCode's server default Basic-auth username (the shipped assistant compose never overrides it). */
export const DEFAULT_OPENCODE_USERNAME = 'opencode';

/** UTF-8-safe Basic auth header — identical byte sequence to the guardian's encoder. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}

/**
 * Strip only trailing newlines from a file-backed secret, matching the
 * assistant entrypoint's `$(cat file)` and the guardian's reader. Surrounding
 * spaces/tabs are preserved so the bytes match across every consumer.
 */
export function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, '');
}
