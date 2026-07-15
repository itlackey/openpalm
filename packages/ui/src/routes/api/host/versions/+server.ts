import {
	type ChannelPreference,
	isChannelPreference,
	readChannelPreference,
	readVersions,
	SERVICE_VERSION_KEYS,
	writeChannelPreference,
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
	requireCapability
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

const VERSION_KEYS = new Set<string>(SERVICE_VERSION_KEYS);

export const GET: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:updates', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const state = getState();
	if (!state.stackDir) {
		return errorResponse(503, 'not_initialized', 'Stack directory not configured', {}, requestId);
	}

	return jsonResponse(
		200,
		{
			configured: readVersions(state),
			channel: readChannelPreference(state)
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

	const unknownKey = Object.keys(parsedBody.data).find(
		(key) => key !== 'versions' && key !== 'channel'
	);
	if (unknownKey) {
		return errorResponse(
			400,
			'unknown_versions_field',
			`Unknown field: ${unknownKey}`,
			{},
			requestId
		);
	}

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
			if (typeof tag !== 'string' || !tag.trim()) {
				return errorResponse(
					400,
					'invalid_version_value',
					`${key} must be a non-empty string`,
					{},
					requestId
				);
			}
			versions[key] = tag.trim();
		}
	}

	let channel: ChannelPreference | undefined;
	if (parsedBody.data.channel !== undefined) {
		if (
			typeof parsedBody.data.channel !== 'string' ||
			!isChannelPreference(parsedBody.data.channel)
		) {
			return errorResponse(
				400,
				'invalid_channel',
				'channel must be "latest" or "next"',
				{},
				requestId
			);
		}
		channel = parsedBody.data.channel;
	}

	if (Object.keys(versions).length === 0 && channel === undefined) {
		return errorResponse(400, 'invalid_body', 'Provide versions or channel', {}, requestId);
	}

	const state = getState();
	return withAdminUpdateLock(state, requestId, () => {
		try {
			if (Object.keys(versions).length > 0) writeVersions(state, versions);
			if (channel !== undefined) writeChannelPreference(state, channel);
			return jsonResponse(200, { ok: true }, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResponse(500, 'versions_write_failed', message, {}, requestId);
		}
	});
};
