import { clearRollbackPins } from '@openpalm/lib';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { errorResponse, getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

/**
 * POST-only, dedicated action for #639: unlike PATCH /api/host/versions
 * (writeVersions — the OPERATOR-PIN API, which blanks OP_MANAGED_* markers),
 * this calls the same clearRollbackPins() the `openpalm unpin` CLI command
 * uses, so both surfaces share one implementation and one distinguishing
 * rule for what counts as a rollback pin vs. an operator pin.
 */
export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:updates', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const state = getState();
	if (!state.stackDir) {
		return errorResponse(503, 'not_initialized', 'Stack directory not configured', {}, requestId);
	}

	return withAdminUpdateLock(state, requestId, () => {
		try {
			const { cleared } = clearRollbackPins(state);
			return jsonResponse(200, { ok: true, cleared }, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResponse(500, 'clear_rollback_pin_failed', message, {}, requestId);
		}
	});
};
