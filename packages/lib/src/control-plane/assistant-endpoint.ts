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
 * Matches a wildcard ("any interface") bind host: 0.0.0.0, ::, or [::]. Kept
 * in sync with the URL-shaped pattern in {@link normalizeLoopbackUrl}, but
 * anchored on the whole (bare, non-URL) host string instead of a URL prefix.
 */
const WILDCARD_BIND_HOST = /^(0\.0\.0\.0|\[::\]|::)$/i;

/**
 * Resolve the assistant (OpenCode) URL the UI/client should target.
 *
 * Precedence (first non-empty wins):
 *   1. OP_CLIENT_DEFAULT_ASSISTANT_URL
 *   2. OP_OPENCODE_URL
 *   3. OP_ASSISTANT_URL
 *   4. `http://${host}:${OP_ASSISTANT_PORT ?? 3800}`, where `host` is:
 *      - `127.0.0.1` when OP_ASSISTANT_BIND_ADDRESS is unset, loopback, or a
 *        wildcard (0.0.0.0 / :: / [::]) — a wildcard bind still gets
 *        collapsed to loopback below by {@link normalizeLoopbackUrl}, but a
 *        wildcard publish also maps the port onto 127.0.0.1 itself, so this
 *        is always reachable.
 *      - the CONFIGURED bind address itself when it is a concrete
 *        non-loopback host (e.g. a LAN IP the admin LAN-exposure toggle set).
 *        Docker's `bind:port:containerport` publish syntax maps the port
 *        ONLY onto the interface named by `bind` — a concrete non-wildcard,
 *        non-loopback bind address is NOT also reachable via 127.0.0.1, so
 *        collapsing it to loopback here would seed an unreachable URL. (E1
 *        follow-up — the original E1 fix over-corrected: it fixed the
 *        wildcard case but dropped a legitimate specific bind address that
 *        the pre-migration Electron code used to honor.)
 *
 * `env` is layered as `{ ...readStackEnv(homeDir), ...env }` — the persisted,
 * operator-managed stack config is the base, and the live process env (which
 * may carry a per-launch override) wins. Defaults to `process.env` so callers
 * can invoke this with just a homeDir in the common case.
 *
 * The result is always passed through {@link normalizeLoopbackUrl}: even an
 * explicit override (OP_ASSISTANT_URL etc.) may carry a wildcard host if it
 * was itself derived from a bind-address setting upstream, and a
 * browser-facing URL must never contain one. Note this means a wildcard
 * OP_ASSISTANT_BIND_ADDRESS is normalized to loopback exactly as before —
 * only a CONCRETE bind address is now preserved instead of discarded.
 */
export function resolveAssistantEndpoint(homeDir: string, env: EnvLike = process.env): string {
  const merged = { ...readStackEnv(homeDir), ...env };
  const override = merged.OP_CLIENT_DEFAULT_ASSISTANT_URL || merged.OP_OPENCODE_URL || merged.OP_ASSISTANT_URL;
  const port = merged.OP_ASSISTANT_PORT || String(STACK_DEFAULTS.ports.assistant);
  const bindAddress = merged.OP_ASSISTANT_BIND_ADDRESS?.trim();
  const host = bindAddress && !WILDCARD_BIND_HOST.test(bindAddress) ? bindAddress : '127.0.0.1';
  const raw = override || `http://${host}:${port}`;
  return normalizeLoopbackUrl(raw);
}
