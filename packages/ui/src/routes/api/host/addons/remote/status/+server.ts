/**
 * GET /api/host/addons/remote/status — the observed state of the remote
 * addon's selected provider, in the normalized `RemoteAccessStatus`
 * vocabulary the provider card renders (lib remote-providers.ts; roadmap:
 * remote-access-providers.md §4/§5).
 *
 * Observation, not intent: the enable toggle and the credentials form
 * already report stored intent, and intent can outrun reality — a tunnel
 * that is still signing in, a container that is crash-looping. This
 * endpoint answers "what is actually happening", which is where the
 * interactive sign-in URL surfaces (until now it lived only in the
 * container's logs) and where the real tailnet URL appears once — and only
 * once — the tunnel reports up.
 *
 * A static route beside the `[name]` param routes: SvelteKit resolves
 * `/api/host/addons/remote/status` here and every other addon path through
 * `[name]` as before ([name] has no `status` child, so nothing is
 * shadowed).
 *
 * Guarded exactly like the neighbouring addon routes: `host:addons`
 * capability, then `requireAdmin`. Read-only — no update lock.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
} from '$lib/server/helpers.js';
import { createLogger, fetchRemoteProviderStatus } from '@openpalm/lib';

const logger = createLogger('addons.remote.status');

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  try {
    const status = await fetchRemoteProviderStatus(getState());
    return jsonResponse(200, status, requestId);
  } catch (err) {
    // fetchRemoteProviderStatus is written to never throw; this is the
    // belt-and-braces the card still deserves if that contract slips.
    logger.error('status read failed', { error: String(err), requestId });
    return errorResponse(
      500,
      'internal_error',
      err instanceof Error ? err.message : 'status read failed',
      {},
      requestId,
    );
  }
};
