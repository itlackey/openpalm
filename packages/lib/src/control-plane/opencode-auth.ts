/**
 * Shared HTTP Basic-auth encoding for every OpenPalm → OpenCode/guardian call.
 *
 * PR #564 P2-1: every forwarder MUST send the exact same UTF-8 byte sequence
 * the assistant and guardian expect. Two divergences caused correct passwords
 * to 401:
 *  - `btoa()` is Latin-1-only and throws / corrupts on non-Latin-1 bytes
 *    (accents, CJK, emoji). Encode UTF-8 first (matches the guardian's
 *    `Buffer.from(..., 'utf-8')`).
 *  - the file-backed password was `.trim()`-ed, stripping surrounding spaces,
 *    while the assistant entrypoint (`$(cat)`) and the guardian strip only
 *    trailing newlines. Use `stripTrailingNewlines` so a password like
 *    `"päss 🔒 "` authenticates identically everywhere.
 *
 * This lives in lib, not in a consumer: the UI's server routes, the UI's
 * OpenCode client factory, and the CLI all need it, and a credential encoder
 * duplicated per consumer is exactly how the 401/rotation regression family
 * kept reappearing. Consumers import it; nobody re-implements it.
 */
import { readSecret } from "./secrets-files.js";

/** OpenCode's server default Basic-auth username (the shipped assistant compose never overrides it). */
export const DEFAULT_OPENCODE_USERNAME = "opencode";

/** UTF-8-safe Basic auth header — identical byte sequence to the guardian's encoder. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf-8").toString("base64")}`;
}

/**
 * Strip only trailing newlines from a file-backed secret, matching the
 * assistant entrypoint's `$(cat file)` and the guardian's reader. Surrounding
 * spaces/tabs are preserved so the bytes match across every consumer.
 */
export function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, "");
}

/** The credential half of a resolved OpenCode target. */
export type OpenCodeCredential = {
  username?: string;
  password?: string;
};

/**
 * The Authorization header for a resolved OpenCode target, or `{}` when that
 * target needs none.
 *
 * THE single place a target becomes a request credential. Attachment used to be
 * re-implemented at each call site, and the site that forgot —
 * `createOpenCodeClient`, which accepted only a baseUrl — 401'd every provider,
 * model and setup route the moment `assistantDirect` turned OpenCode's auth on.
 * Spread this into request headers rather than encoding per call site, so a
 * forwarder cannot be written without one.
 */
export function assistantAuthHeaders(target: OpenCodeCredential): Record<string, string> {
  if (!target.password) return {};
  return {
    authorization: basicAuthHeader(target.username || DEFAULT_OPENCODE_USERNAME, target.password),
  };
}

/**
 * Resolve the credential for the assistant's OpenCode.
 *
 * OpenCode's Basic auth is ALWAYS on: the entrypoint unconditionally exports
 * the system-generated `op_opencode_password` (which `ensureSecrets` always
 * materializes), so this resolver always answers with a credential. The
 * retired `OPENCODE_AUTH` flag made this conditional — an operator toggle
 * that meant every consumer (proxy, healthcheck, guardian, desktop shell)
 * had to agree with the container about whether a password applied. Now the
 * only question is *which* value, in precedence order: an explicit
 * `OPENCODE_SERVER_PASSWORD` env (a bare `docker run` supplying it directly),
 * the secret file, then the `OP_OPENCODE_PASSWORD` env fallback.
 *
 * Read fresh per call so a rotated secret applies without a process restart.
 * `persistedEnv` is accepted (and ignored) for signature compatibility with
 * callers that batch their `readStackEnv` — the credential no longer reads
 * the stack env at all.
 *
 * `password` is undefined only when NOTHING resolves — a home with no secret
 * file, i.e. not an installed OpenPalm. The containers are the fail-closed
 * layer for that state (the entrypoint refuses to boot without a password).
 */
export function resolveOpenCodeCredential(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
  _persistedEnv?: Record<string, string | undefined>,
): OpenCodeCredential {
  const username = env.OPENCODE_SERVER_USERNAME || DEFAULT_OPENCODE_USERNAME;
  const raw = readSecret(homeDir, "op_opencode_password");
  const generatedKey = (raw ? stripTrailingNewlines(raw) : undefined) || env.OP_OPENCODE_PASSWORD;
  return { username, password: env.OPENCODE_SERVER_PASSWORD || generatedKey || undefined };
}
