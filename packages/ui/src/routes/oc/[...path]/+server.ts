/**
 * /oc/* — transparent same-origin pass-through to this process's OpenCode API.
 *
 * The last leg of the same-origin migration. `/voice` already works this way
 * (see `routes/voice/[...path]/+server.ts`, whose header comment states the
 * thesis); OpenCode was the only service still talking to the browser
 * directly, and every artifact that looked like independent complexity was a
 * consequence of that one gap:
 *
 *   - a CORS allowlist the container cannot compute, because only the host can
 *     enumerate its own LAN addresses;
 *   - a client-side rewrite of the seeded `127.0.0.1` connection URL to
 *     whatever host the browser actually visited;
 *   - a mixed-content policy, because the UI and OpenCode were two origins
 *     with two independent TLS decisions;
 *   - a second password, because a LAN-published OpenCode needs its own auth.
 *
 * None of those exist for a same-origin path. The browser calls `/oc/...` on
 * the origin it already loaded, carrying the session cookie it already has,
 * and this process makes the local hop.
 *
 * `/_opencode/*` is the same hop for OpenCode's WEB UI, which `/advanced`
 * frames; the request half of both lives in `$lib/server/opencode-proxy.ts`,
 * including the upstream resolution and the reason there is no timeout on it.
 *
 * Remote/third-party assistants are unaffected: they keep the browser-direct
 * transport and their own credentials. The split is now meaningful rather than
 * incidental — *this* assistant is same-origin, *other* assistants are direct.
 */
import type { RequestHandler } from './$types';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { proxyToAssistantOpencode } from '$lib/server/opencode-proxy.js';

const handle: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  // The session IS the credential for the local assistant. Same check as every
  // other authenticated route, so a served non-admin process works too —
  // reaching your own assistant is not a privileged host operation.
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await proxyToAssistantOpencode(event, event.params.path ?? '', requestId);
  if (!result.ok) return result.error;
  return new Response(result.upstream.body, {
    status: result.upstream.status,
    headers: result.headers,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
// No OPTIONS handler: this route is same-origin by construction, and browsers
// never preflight a same-origin request. Exporting one would add an
// unreachable authenticated surface.
