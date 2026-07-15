import {
	applyStack,
	buildComposeOptions,
	checkDocker,
	composeConfigServices,
	createLogger,
	performUpgrade
} from '@openpalm/lib';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import {
	getRequestId,
	errorResponse,
	jsonBodyError,
	jsonResponse,
	parseJsonBody,
	requireAdmin,
	requireCapability
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

const logger = createLogger('update');

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:updates', requestId);
	if (capabilityError) return capabilityError;
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const parsedBody = await parseJsonBody(event.request);
	if ('error' in parsedBody) return jsonBodyError(parsedBody, requestId);

	const unknownKey = Object.keys(parsedBody.data).find((key) => key !== 'service');
	if (unknownKey) {
		return errorResponse(400, 'unknown_update_field', `Unknown update field: ${unknownKey}`, {}, requestId);
	}

	let service: string | undefined;
	if (parsedBody.data.service !== undefined) {
		if (typeof parsedBody.data.service !== 'string' || !parsedBody.data.service.trim()) {
			return errorResponse(400, 'invalid_service', 'service must be a non-empty string', {}, requestId);
		}
		service = parsedBody.data.service.trim();
	}

	const state = getState();
	return withAdminUpdateLock(state, requestId, async (lock) => {
		try {
			const docker = await checkDocker();
			if (!docker.ok) {
				return errorResponse(503, 'docker_unavailable', 'Docker is unavailable', {}, requestId);
			}

			if (service) {
				const composeOptions = buildComposeOptions(state);
				const configured = await composeConfigServices(composeOptions);
				if (!configured.ok) {
					return errorResponse(
						502,
						'compose_config_failed',
						'Could not read configured Compose services',
						{},
						requestId
					);
				}
				if (!configured.services.includes(service)) {
					return errorResponse(
						400,
						'unknown_service',
						`Unknown Compose service: ${service}`,
						{},
						requestId
					);
				}
				const result = await applyStack({ kind: 'service', service }, composeOptions, undefined, {
					pull: 'always'
				});
				if (!result.ok) {
					return errorResponse(502, 'update_failed', result.error || 'Update failed', {}, requestId);
				}
				logger.info('service update completed', { requestId, service });
				return jsonResponse(200, { ok: true }, requestId);
			}

			await performUpgrade(state, { lock });
			logger.info('stack update completed', { requestId });
			return jsonResponse(200, { ok: true }, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error('update failed', { requestId, service, error: message });
			return errorResponse(502, 'update_failed', message, {}, requestId);
		}
	});
};
