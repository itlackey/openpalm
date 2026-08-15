/**
 * /_opencode/* — the OpenCode WEB UI, on this app's own origin.
 *
 * Sibling of `/oc/*`, which carries the same OpenCode's API for the browser's
 * chat transport. The split is by consumer, not by upstream: `/oc` streams
 * every response through untouched, while this route serves an HTML document
 * that has to be taught it is not at the origin root. Everything that makes
 * the hop itself — auth, header hygiene, abort forwarding, upstream Basic auth
 * — is shared in `$lib/server/opencode-proxy.ts`.
 *
 * `$lib/server/opencode-workspace.ts` explains the browser-side mechanism and
 * why OpenCode's SPA cannot simply be pointed at a sub-path.
 */
import type { RequestHandler } from './$types';
import { getRequestId, requireAdmin } from '$lib/server/helpers.js';
import { proxyToAssistantOpencode } from '$lib/server/opencode-proxy.js';
import { allowWorkspaceShimInCsp, injectWorkspaceShim } from '$lib/server/opencode-workspace.js';

const handle: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  // The session IS the credential for the local assistant — the same check
  // `/oc` makes, so a served non-admin process works too. hooks.server.ts
  // deliberately does NOT bounce this path to /login: a redirect inside the
  // frame would render a login page that the app's own X-Frame-Options then
  // refuses, so an expired session must fail here as a plain 401 instead.
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await proxyToAssistantOpencode(event, event.params.path ?? '', requestId);
  if (!result.ok) return result.error;
  const { upstream, headers } = result;

  if (!(headers.get('content-type') ?? '').includes('text/html')) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // The document — and ONLY the document — is rewritten. OpenCode serves its
  // SPA shell for every unmatched path, so this covers both the workspace root
  // and a session deep link.
  allowWorkspaceShimInCsp(headers);
  return new Response(injectWorkspaceShim(await upstream.text()), {
    status: upstream.status,
    headers,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
// No OPTIONS handler, for the same reason as /oc: this route is same-origin by
// construction and browsers never preflight a same-origin request.
