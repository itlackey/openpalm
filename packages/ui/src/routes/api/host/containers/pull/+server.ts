import {
	getRequestId,
	jsonResponse,
	errorResponse,
	requireAdmin,
	requireCapability
} from '$lib/server/helpers.js';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { getState } from '$lib/server/state.js';
import {
	buildComposeOptions,
	buildManagedServices,
	captureRunningImageIds,
	createLogger,
	restoreRunningImageIds
} from '@openpalm/lib';
import { activateStack, checkDocker } from '@openpalm/lib';
import type { RequestHandler } from './$types';

const logger = createLogger('containers-pull');

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:containers', requestId);
	if (capabilityError) return capabilityError;
	logger.info('pull request received', { requestId });
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const state = getState();
	return withAdminUpdateLock(state, requestId, async (lock) => {
		const dockerCheck = await checkDocker();
		if (!dockerCheck.ok) {
			return errorResponse(
				503,
				'docker_unavailable',
				'Docker is not available',
				{ stderr: dockerCheck.stderr },
				requestId
			);
		}

		const composeOpts = buildComposeOptions(state);
		const imageSnapshot = await captureRunningImageIds(composeOpts);

		logger.info('pulling and recreating containers', { requestId });
		const managedServices = await buildManagedServices(state);
		// The single compose driver (§4.3, plan 2.2). `pull: "always"` is what this
		// manual button is FOR: force a fresh pull even when the tag is unchanged
		// (an updated :latest, or a re-pulled :vX.Y.Z) — a plain `up` would keep the
		// OLD image (the akm-0.3.1 surprise). --force-recreate (always on in
		// applyStack) then swaps the running container onto the freshly pulled image.
		const result = await activateStack(
			state,
			{ kind: 'services', services: managedServices },
			{ pull: 'always' },
			{ lock, composeOptions: composeOpts }
		);
		if (!result.ok) {
			const generation = `manual-pull-${Date.now()}`;
			try {
				await restoreRunningImageIds(state, imageSnapshot, generation);
				await activateStack(
					state,
					{ kind: 'services', services: managedServices },
					{ pull: 'missing' },
					{ lock, composeOptions: buildComposeOptions(state) }
				);
			} catch (rollbackError) {
				logger.error('failed to restore images after pull failure', {
					requestId,
					error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
				});
			}
			logger.error('pull/recreate failed', { requestId, error: result.error });
			return errorResponse(
				502,
				'up_failed',
				'Failed to pull and recreate containers',
				{ stderr: result.rawStderr ?? result.error ?? '' },
				requestId
			);
		}

		logger.info('pull completed', { requestId, started: result.started });

		return jsonResponse(
			200,
			{
				ok: true,
				started: result.started
			},
			requestId
		);
	});
};
