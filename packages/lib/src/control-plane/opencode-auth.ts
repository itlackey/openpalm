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
import { readFileSync } from 'node:fs';
import { isEnabledFlag } from "./bind-warning.js";
import { readSecret } from "./secrets-files.js";
import { readStackEnv } from "./secrets.js";

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
 * Gated on the operator's REQUESTED posture (`OPENCODE_AUTH`), never on the
 * secret file's existence: `ensureSecrets` always materializes the file, so
 * presence says nothing about whether OpenCode authenticates. Read fresh —
 * an operator toggling `assistantDirect` changes this at runtime, and a value
 * frozen at process start 401s (or silently omits auth) until a restart.
 *
 * `persistedEnv` defaults to a fresh `readStackEnv(homeDir)`, so the common
 * caller passes only a homeDir. A caller that already holds that read — the
 * `/oc` proxy resolves the URL and the credential for the same request — passes
 * it in, so "fresh per call" costs one parse rather than one per resolver.
 *
 * EVERY password source sits behind the gate, including the explicit
 * `OPENCODE_SERVER_PASSWORD` override. That override used to short-circuit it,
 * which produced a credential for a server that requires none: core.compose.yml
 * never passes a raw `OPENCODE_SERVER_PASSWORD` to the assistant (secret-audit
 * forbids the key, and the comment there is explicit that the password is
 * "never a password the operator invents"), so an ambient value in a host shell
 * describes nothing the container knows about. The visible cost was
 * `/api/host/assistant-key` reporting `available: true` and printing that
 * invented key as if it were the assistant's. The username override stays
 * ungated — compose's own healthcheck honours `OPENCODE_SERVER_USERNAME`.
 */
export function resolveOpenCodeCredential(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
  persistedEnv?: Record<string, string | undefined>,
): OpenCodeCredential {
  const persisted = persistedEnv ?? readStackEnv(homeDir);
  const username = env.OPENCODE_SERVER_USERNAME || DEFAULT_OPENCODE_USERNAME;
  const authEnabled = isEnabledFlag(persisted.OPENCODE_AUTH ?? env.OPENCODE_AUTH);
  if (!authEnabled) return { username, password: undefined };
  let filePassword: string | undefined;
  if (env.OPENCODE_SERVER_PASSWORD_FILE) {
    try {
      filePassword = stripTrailingNewlines(readFileSync(env.OPENCODE_SERVER_PASSWORD_FILE, 'utf8')) || undefined;
    } catch {
      filePassword = undefined;
    }
  }
  const raw = readSecret(homeDir, "op_opencode_password");
  const generatedKey = (raw ? stripTrailingNewlines(raw) : undefined) || env.OP_OPENCODE_PASSWORD;
  return { username, password: env.OPENCODE_SERVER_PASSWORD || filePassword || generatedKey || undefined };
}
