import {
  checkAndUpdateUiBuild,
  createLogger,
  PLATFORM_VERSION,
  readChannelPreference,
  recordPendingUiBackup,
  restoreUiBackup,
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
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

const logger = createLogger('ui-version');

function harnessContractVersion(): number | null | undefined {
  const raw = process.env.OP_HARNESS_CONTRACT_VERSION?.trim();
  if (!raw) return process.env.OP_UI_SUPERVISOR === 'electron' ? null : undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:updates', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const parsedBody = await parseJsonBody(event.request);
  if ('error' in parsedBody) return jsonBodyError(parsedBody, requestId);
  if (Object.keys(parsedBody.data).length > 0) {
    return errorResponse(400, 'unknown_update_key', 'UI update does not accept request fields', {}, requestId);
  }

  const state = getState();
  return withAdminUpdateLock(state, requestId, async () => {
    const harnessContract = harnessContractVersion();
    if (harnessContract === null) {
      return errorResponse(
        500,
        'invalid_harness_contract',
        'Electron did not provide a valid OP_HARNESS_CONTRACT_VERSION; refusing an unchecked UI update',
        {},
        requestId,
      );
    }

    const channel = readChannelPreference(state);
    const result = await checkAndUpdateUiBuild(
      PLATFORM_VERSION,
      state.dataDir,
      channel,
      harnessContract,
    );

    if (result.error) {
      if (result.backupDir) restoreUiBackup(state.dataDir, result.backupDir);
      logger.error('UI update failed', { requestId, channel, error: result.error });
      return errorResponse(502, 'update_failed', result.error, {}, requestId);
    }

    if (result.redownloadRequired) {
      return jsonResponse(200, {
        ok: true,
        updated: false,
        latestVersion: result.latestVersion,
        restarting: false,
        pendingRestart: false,
        redownloadRequired: true,
        requiredHarnessContract: result.requiredHarnessContract,
      }, requestId);
    }

    if (!result.updated) {
      return jsonResponse(200, {
        ok: true,
        updated: false,
        latestVersion: result.latestVersion,
        restarting: false,
        pendingRestart: false,
        redownloadRequired: false,
      }, requestId);
    }

    if (result.backupDir) recordPendingUiBackup(state.dataDir, result.backupDir);

    const supervisor = process.env.OP_UI_SUPERVISOR ?? '';
    let restarting = false;
    const pendingRestart = supervisor === 'electron';
    if (supervisor && !pendingRestart && process.ppid > 1) {
      try {
        process.kill(process.ppid, 'SIGUSR2');
        restarting = true;
      } catch (error) {
        logger.warn('UI restart signal failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('UI update completed', {
      requestId,
      channel,
      latestVersion: result.latestVersion,
      restarting,
      pendingRestart,
    });
    return jsonResponse(200, {
      ok: true,
      updated: true,
      latestVersion: result.latestVersion,
      restarting,
      pendingRestart,
      redownloadRequired: false,
    }, requestId);
  });
};
