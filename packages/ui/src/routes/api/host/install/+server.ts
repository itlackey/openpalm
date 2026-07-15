import {
	errorResponse,
	getRequestId,
	jsonResponse,
	requireAdmin,
	requireCapability
} from '$lib/server/helpers.js';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { getState } from '$lib/server/state.js';
import {
	applyInstall,
	createLogger,
	buildComposeOptions,
	checkDocker,
	applyStack,
	restoreSnapshot,
	restoreSnapshotAndApplyStack,
	teardownRenamedProject
} from '@openpalm/lib';
import type { RequestHandler } from './$types';

const logger = createLogger('install');

export const POST: RequestHandler = async (event) => {
	const requestId = getRequestId(event);
	const capabilityError = requireCapability(event, 'host:setup', requestId);
	if (capabilityError) return capabilityError;
	logger.info('install request received', { requestId });
	const authError = requireAdmin(event, requestId);
	if (authError) return authError;

	const state = getState();
	return withAdminUpdateLock(state, requestId, async (lock) => {
		try {
			// Apply OP_HOME: dir tree, secrets, overwrite the managed system/ tree, seed
			// the user/data trees once, OpenCode config — all idempotent. Does NOT compose.
			await applyInstall(state, { lock });

			const dockerCheck = await checkDocker();
			if (!dockerCheck.ok) {
				logger.info('install completed (Docker unavailable — stack not started)', { requestId });
				return jsonResponse(
					200,
					{
						ok: true,
						started: [],
						failed: [],
						dockerAvailable: false,
						overallSuccess: true
					},
					requestId
				);
			}

			const composeOpts = buildComposeOptions(state);
			const renameTeardown = await teardownRenamedProject(state);
			if (renameTeardown.blocked) {
				restoreSnapshot(state);
				return errorResponse(
					409,
					'project_rename_blocked',
					renameTeardown.warning ?? 'Project rename teardown failed',
					{},
					requestId
				);
			}
			const stackResult = await applyStack({ kind: 'all' }, composeOpts);
			if (!stackResult.ok) {
				try {
					await restoreSnapshotAndApplyStack(state);
				} catch (rollbackError) {
					logger.error('failed to restore install snapshot', {
						requestId,
						error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					});
				}
			}

			const overallSuccess = stackResult.ok;
			const status = stackResult.ok ? 200 : 502;

			logger.info('install completed', {
				requestId,
				dockerAvailable: true,
				overallSuccess,
				startedCount: stackResult.started.length,
				failedCount: stackResult.failed.length
			});

			return jsonResponse(
				status,
				{
					ok: overallSuccess,
					started: stackResult.started,
					failed: stackResult.failed,
					dockerAvailable: true,
					overallSuccess,
					...(stackResult.error ? { error: stackResult.error } : {})
				},
				requestId
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error('install failed', { requestId, error: msg });
			return errorResponse(500, 'install_failed', msg, {}, requestId);
		}
	});
};
