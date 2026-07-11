/**
 * Shared assistant (OpenCode) endpoint resolver (review finding E1).
 *
 * Before this module, Electron, the CLI, and the container entrypoint each
 * read a slightly different env view to build the assistant URL:
 *   - Electron derived it from the persisted stack.env's
 *     OP_ASSISTANT_BIND_ADDRESS + OP_ASSISTANT_PORT, which bakes a wildcard
 *     bind address (e.g. 0.0.0.0, set by the admin LAN-exposure toggle)
 *     directly into a browser-facing URL — http://0.0.0.0:3800 cannot be
 *     fetched from a browser.
 *   - The CLI honored OP_CLIENT_DEFAULT_ASSISTANT_URL but ignored
 *     OP_OPENCODE_URL/OP_ASSISTANT_URL that the host UI honors.
 *   - The container entrypoint had its own inline precedence.
 *
 * `resolveAssistantEndpoint` is the ONE place this precedence is decided.
 * Callers (Electron main.ts, the CLI client-server, the container
 * entrypoint's config generation) should all resolve through this instead of
 * re-deriving it locally.
 */
import { readStackEnv } from './secrets.js';
import { STACK_DEFAULTS } from './defaults.js';
import { normalizeLoopbackUrl } from './url-normalize.js';

/** A plain env-like record — accepts NodeJS.ProcessEnv (values may be undefined) too. */
type EnvLike = Record<string, string | undefined>;

/**
 * Resolve the assistant (OpenCode) URL the UI/client should target.
 *
 * Precedence (first non-empty wins):
 *   1. OP_CLIENT_DEFAULT_ASSISTANT_URL
 *   2. OP_OPENCODE_URL
 *   3. OP_ASSISTANT_URL
 *   4. `http://127.0.0.1:${OP_ASSISTANT_PORT ?? 3800}` — note the fallback is
 *      ALWAYS the loopback address, never a configured bind address: this
 *      resolver is for browser-facing URLs, and a non-loopback bind address
 *      is not something a remote browser can dial via 127.0.0.1 anyway (LAN
 *      exposure is the assistant container's job, not this URL's).
 *
 * `env` is layered as `{ ...readStackEnv(homeDir), ...env }` — the persisted,
 * operator-managed stack config is the base, and the live process env (which
 * may carry a per-launch override) wins. Defaults to `process.env` so callers
 * can invoke this with just a homeDir in the common case.
 *
 * The result is always passed through {@link normalizeLoopbackUrl}: even an
 * explicit override (OP_ASSISTANT_URL etc.) may carry a wildcard host if it
 * was itself derived from a bind-address setting upstream, and a
 * browser-facing URL must never contain one.
 */
export function resolveAssistantEndpoint(homeDir: string, env: EnvLike = process.env): string {
  const merged = { ...readStackEnv(homeDir), ...env };
  const override = merged.OP_CLIENT_DEFAULT_ASSISTANT_URL || merged.OP_OPENCODE_URL || merged.OP_ASSISTANT_URL;
  const port = merged.OP_ASSISTANT_PORT || String(STACK_DEFAULTS.ports.assistant);
  const raw = override || `http://127.0.0.1:${port}`;
  return normalizeLoopbackUrl(raw);
}
