import {
	buildComposeOptions,
	probeRunningImages,
	readVersionPins,
	resolveVersions,
	SERVICE_VERSION_KEYS,
	writeVersions
} from '@openpalm/lib';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import {
	errorResponse,
	getRequestId,
	jsonBodyError,
	jsonResponse,
	parseJsonBody,
	requireAdmin,
	requireCapability,
  requireInstalledHome
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

const VERSION_KEYS = new Set<string>(SERVICE_VERSION_KEYS);

/** Never throws and never fails the request: a down daemon reports as null. */
async function readRunningImages(
	state: Parameters<typeof buildComposeOptions>[0]
): Promise<Record<string, string> | null> {
	try {
		const probe = await probeRunningImages(buildComposeOptions(state));
		return probe.ok ? probe.images : null;
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:updates', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const state = getState();
	const notInstalled = requireInstalledHome(state.homeDir, requestId);
	if (notInstalled) return notInstalled;
	if (!state.stackDir) {
		return errorResponse(503, 'not_initialized', 'Stack directory not configured', {}, requestId);
	}

	return jsonResponse(
		200,
		{
			// The rows literally present in state/stack.env — i.e. the pins. A key
			// is absent when nothing is pinned; absence is never filled in with a
			// default, because a filled-in value cannot be told from a pin (#679).
			pins: readVersionPins(state),
			// What each image resolves to today: the pin, or the release default
			// the compose file carries.
			resolved: resolveVersions(state),
			// What is ACTUALLY running, from the daemon — the only report that
			// cannot agree with a deploy that never happened. `null` when docker
			// could not be asked; this route never fails on a down daemon.
			running: await readRunningImages(state)
		},
		requestId
	);
};

export const PATCH: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:updates', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const parsedBody = await parseJsonBody(event.request);
	if ('error' in parsedBody) return jsonBodyError(parsedBody, requestId);

	const unknownKey = Object.keys(parsedBody.data).find((key) => key !== 'versions');
	if (unknownKey) {
		return errorResponse(
			400,
			'unknown_versions_field',
			`Unknown field: ${unknownKey}`,
			{},
			requestId
		);
	}

	// An empty tag CLEARS the pin — writeVersions removes the row and the image
	// goes back to the release default. That is the unpin path; before #679
	// there was none, from any surface.
	const versions: Record<string, string> = {};
	if (parsedBody.data.versions !== undefined) {
		const value = parsedBody.data.versions;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return errorResponse(400, 'invalid_versions', 'versions must be an object', {}, requestId);
		}
		for (const [key, tag] of Object.entries(value as Record<string, unknown>)) {
			if (!VERSION_KEYS.has(key)) {
				return errorResponse(
					400,
					'unknown_version_key',
					`Unknown version key: ${key}`,
					{},
					requestId
				);
			}
			if (typeof tag !== 'string') {
				return errorResponse(
					400,
					'invalid_version_value',
					`${key} must be a string`,
					{},
					requestId
				);
			}
			versions[key] = tag.trim();
		}
	}

	if (Object.keys(versions).length === 0) {
		return errorResponse(400, 'invalid_body', 'Provide versions', {}, requestId);
	}

	const state = getState();
	return withAdminUpdateLock(state, requestId, () => {
		try {
			writeVersions(state, versions);
			return jsonResponse(200, { ok: true }, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResponse(500, 'versions_write_failed', message, {}, requestId);
		}
	});
};
