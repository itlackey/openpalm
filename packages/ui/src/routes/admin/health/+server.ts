/**
 * GET /admin/health
 *
 * Returns the admin service status and whether the OpenCode (assistant)
 * server is reachable. Used as the session probe on the admin and chat pages.
 *
 * Returns 401 (not 503) when unauthenticated so the auth gate catches it.
 * Always returns 200 when authenticated, even if OpenCode is down — the
 * caller decides how to surface assistant unavailability.
 */
import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';

const OPENCODE_URL =
	process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? 'http://localhost:4096';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	// Quick probe of the OpenCode server — non-blocking, best-effort.
	let opencode = false;
	try {
		const res = await fetch(`${OPENCODE_URL}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		opencode = res.ok;
	} catch {
		/* unreachable — opencode stays false */
	}

	return jsonResponse(200, { ok: true, opencode }, requestId);
};
