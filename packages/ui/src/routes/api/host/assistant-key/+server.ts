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
import {
  DEFAULT_OPENCODE_USERNAME,
  readAccessToggles,
  readSecret,
  readStackEnv,
  stripTrailingNewlines,
} from '@openpalm/lib';
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

  const state = getState();
  const toggles = readAccessToggles(readStackEnv(state.homeDir));
  if (!toggles.assistantDirect) {
    return jsonNoStore(200, { available: false }, requestId);
  }

  // `ensureSecrets` always materializes this file (both the assistant's and
  // guardian's compose `secrets:` grants reference it unconditionally), so a
  // null read here means an install that has never deployed rather than a
  // real absence — report the same "nothing to show" shape either way.
  const raw = readSecret(state.homeDir, 'op_opencode_password');
  const password = raw ? stripTrailingNewlines(raw) : '';
  if (!password) {
    return jsonNoStore(200, { available: false }, requestId);
  }

  return jsonNoStore(
    200,
    { available: true, username: DEFAULT_OPENCODE_USERNAME, password },
    requestId,
  );
};
