/**
 * /assets/* — OpenCode's static bundle, proxied at this origin's ROOT.
 *
 * Not an arbitrary namespace grab: OpenCode's web UI is a Vite build with
 * `base: "/"` compiled into the `opencode` binary, and it reaches for its own
 * assets through three channels that no injected script can intercept — the
 * `<script>`/`<link>` tags in its HTML, the `modulepreload` links Vite creates
 * for lazily-imported routes, and `url(/assets/…)` inside its stylesheets. A
 * missed preload is not cosmetic: Vite AWAITS the stylesheet link for a lazy
 * chunk and fails the import when it 404s, so the dialogs in the framed
 * workspace would stop opening.
 *
 * Serving them here instead of rewriting them means no upstream response body
 * is ever parsed or patched. OpenPalm's own build output lives under `/_app/*`
 * and its static files are enumerated in `static/`, so `/assets` is free.
 *
 * See `$lib/server/opencode-workspace.ts` for the rest of the mechanism.
 */
import type { RequestHandler } from './$types';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { proxyToAssistantOpencode } from '$lib/server/opencode-proxy.js';
import { WORKSPACE_ASSET_PREFIX } from '$lib/server/opencode-workspace.js';

// GET only. These are immutable, content-hashed build artifacts; every other
// method against them is a client bug and should surface as 405, not reach
// OpenCode.
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const path = `${WORKSPACE_ASSET_PREFIX.replace(/^\//, '')}${event.params.path ?? ''}`;
  const result = await proxyToAssistantOpencode(event, path, requestId);
  if (!result.ok) return result.error;
  return new Response(result.upstream.body, {
    status: result.upstream.status,
    headers: result.headers,
  });
};
