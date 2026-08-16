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
 * Resolve the credential the assistant's OpenCode currently requires, from the
 * home's persisted state.
 *
 * UNCONDITIONAL: there is no posture flag to consult. The secret file is the
 * whole answer — setup generates one on every install, so in practice this
 * always yields a password. It returns none only when that file is missing or
 * blank, which is an operator emptying their own secret; callers treat that as
 * "no credential to send", matching the entrypoint's own reader.
 *
 * It used to be gated on `OPENCODE_AUTH`, which tracked whether the assistant
 * port was published. That made "is OpenCode password-protected?" depend on a
 * network toggle: the default install ran OpenCode with no password at all,
 * and turning the toggle off again silently removed the credential from a
 * running server. It also made every consumer — this resolver, the guardian,
 * the entrypoint, two healthchecks — carry the same gate, and disagreeing
 * about it produced a 401 storm rather than an error. There is one answer now:
 * the secret file, which `ensureSecrets` always materializes non-empty.
 *
 * It no longer takes a `persistedEnv`. That parameter existed so a caller
 * holding a `readStackEnv` could spare this one the parse while it consulted
 * `OPENCODE_AUTH`; with nothing to consult, the stack env is not an input to
 * the credential at all.
 *
 * Precedence: an explicit `OPENCODE_SERVER_PASSWORD` (what the operator told
 * the container to use), then the generated secret, then `OP_OPENCODE_PASSWORD`.
 * An undefined password is now only reachable on a home whose secret store is
 * unreadable, and every caller treats that as the failure it is rather than as
 * "auth is off".
 */
export function resolveOpenCodeCredential(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): OpenCodeCredential {
  const username = env.OPENCODE_SERVER_USERNAME || DEFAULT_OPENCODE_USERNAME;
  const raw = readSecret(homeDir, "op_opencode_password");
  const generatedKey = (raw ? stripTrailingNewlines(raw) : undefined) || env.OP_OPENCODE_PASSWORD;
  return { username, password: env.OPENCODE_SERVER_PASSWORD || generatedKey || undefined };
}
