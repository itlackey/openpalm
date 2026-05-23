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
import { getActiveEndpoint } from '$lib/server/endpoints.js';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	// Quick probe of the active OpenCode endpoint — non-blocking, best-effort.
	const endpoint = getActiveEndpoint();
	let opencode = false;
	try {
		const headers: Record<string, string> = {};
		if (endpoint.password) {
			const user = endpoint.username || 'openpalm';
			headers['authorization'] = `Basic ${btoa(`${user}:${endpoint.password}`)}`;
		}
		const res = await fetch(`${endpoint.url}/health`, {
			headers,
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
