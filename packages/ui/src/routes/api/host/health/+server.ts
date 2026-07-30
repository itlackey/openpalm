/**
 * GET /api/host/health
 *
 * Returns the admin service status and whether the OpenCode (assistant)
 * server is reachable. Used as the session probe on the admin and chat pages.
 *
 * Returns 401 (not 503) when unauthenticated so the auth gate catches it.
 * Always returns 200 when authenticated, even if OpenCode is down — the
 * caller decides how to surface assistant unavailability.
 */
import { assistantAuthHeaders } from '$lib/server/basic-auth.js';
import type { RequestHandler } from './$types';
import { requireAdmin, requireCapability, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import { getAssistantOpencodeTarget } from '$lib/server/opencode-target.js';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:stack:read', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	// Quick probe of the host's own OpenCode target — non-blocking, best-effort.
	const endpoint = getAssistantOpencodeTarget();
	let opencode = false;
	try {
		const res = await fetch(`${endpoint.url}/health`, {
			headers: assistantAuthHeaders(endpoint),
			signal: AbortSignal.timeout(2000),
		});
		opencode = res.ok;
	} catch {
		/* unreachable — opencode stays false */
	}

	return jsonResponse(
		200,
		{
			ok: true,
			opencode,
			endpoint: { id: endpoint.id, label: endpoint.label, url: endpoint.url, isDefault: endpoint.isDefault },
		},
		requestId
	);
};
