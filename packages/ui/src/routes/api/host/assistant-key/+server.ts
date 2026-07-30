/**
 * GET /api/host/assistant-key — the generated OpenCode Basic-auth key for
 * direct (non-guardian) assistant connections.
 *
 * `assistantDirect`'s own copy (`ACCESS_TOGGLE_DESCRIPTIONS.assistantDirect`
 * in `@openpalm/lib`) promises this key is "shown in the dashboard", but
 * before this route existed nothing served it — its only reader was the
 * server-side proxy that attaches it to outgoing OpenCode calls
 * (`resolveOpenCodeCredential`). Completing the toggle (pointing a
 * third-party OpenCode client, or the Connections page, at the published
 * assistant) required shelling into the host to `cat` the secret file.
 *
 * Guarded exactly like GET /api/host/stack: `host:stack:read` capability
 * then `requireAdmin` — this is the same "host stack settings" surface, just
 * a value the stack route itself deliberately never inlines (unlike the rest
 * of that payload, this one is a live credential).
 *
 * Two safety properties beyond the auth guard:
 *  - Only returned while `assistantDirect` is actually ON. When it is off,
 *    OpenCode requires no auth at all (see `resolveAccessEnv` — `OPENCODE_AUTH`
 *    tracks `assistantDirect` exactly), so the stored value is meaningless
 *    and returning it would suggest a protection that is not in effect.
 *  - `Cache-Control: no-store` — this is the one host-stack response that
 *    carries a live secret; nothing downstream (browser cache, a proxy) may
 *    retain it.
 * The value is never logged.
 */
import type { RequestHandler } from './$types';
import { resolveOpenCodeCredential } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, requireAdmin, requireCapability } from '$lib/server/helpers.js';

/** Every response from this route is `Cache-Control: no-store` (see header comment). */
function jsonNoStore(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
  });
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  // The SAME resolver `/oc` and getAssistantOpencodeTarget authenticate with —
  // this route must show the credential that actually works, and it cannot do
  // that by re-deriving one. Resolving it here independently (read the toggle,
  // read the secret file, strip the newline) reproduced the happy path but
  // dropped the OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD /
  // OP_OPENCODE_PASSWORD overrides the resolver honours, so an operator using
  // any of them would have been shown a key the assistant rejects.
  //
  // Its `password` is also the availability answer: it is populated only when
  // OPENCODE_AUTH is on, which `resolveAccessEnv` derives from `assistantDirect`
  // on every apply. Gating on it directly means the dashboard cannot disagree
  // with the server about whether auth is in effect — where reading the toggle
  // separately made that agreement a convention between two implementations.
  // An install that has never deployed reports the same "nothing to show".
  const { username, password } = resolveOpenCodeCredential(getState().homeDir);
  if (!password) {
    return jsonNoStore(200, { available: false }, requestId);
  }

  return jsonNoStore(200, { available: true, username, password }, requestId);
};
