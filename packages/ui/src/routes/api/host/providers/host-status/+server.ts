/**
 * GET /api/host/providers/host-status
 *
 * Detects whether the host has an existing OpenCode installation and returns
 * provider + credential counts. Never returns credential values.
 *
 * Auth: admin session cookie required (there is no admin token).
 */
import type { RequestHandler } from './$types';
import { requireAdmin, requireCapability, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import { detectHostOpenCode } from '@openpalm/lib';

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:secrets', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const status = detectHostOpenCode();

	return jsonResponse(
		200,
		{
			detected: status.providerCount > 0 || status.credentialCount > 0,
			providerCount: status.providerCount,
			credentialCount: status.credentialCount,
			// Paths are returned for display in the import modal (no secrets, just file paths)
			configPath: status.configPath ?? null,
			authPath: status.authPath ?? null,
		},
		requestId
	);
};
