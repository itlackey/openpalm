/**
 * POST /api/host/automations/:name/run — Manually trigger an automation.
 *
 * Executes `akm task run <id>` inside the Assistant container. `name` is the
 * exact `.yml` basename in ${stashDir}/tasks; AKM owns all task validation.
 */

import {
  assertSchedulableTaskFilename,
  executeAutomation,
} from '@openpalm/lib';
import {
  auditAutomationOperation,
  automationRuntimeErrorResponse,
} from '$lib/server/automation-runtime.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;

  const state = getState();
  const fileName = event.params.name ?? '';
  const auditContext = { fileName, operation: 'manual-run' } as const;
  try {
    assertSchedulableTaskFilename(fileName);
  } catch {
    auditAutomationOperation(requestId, auditContext, {
      outcome: 'failure',
      errorCode: 'invalid_name',
      errorMessage: 'Automation task filename is invalid',
    });
    return errorResponse(
      400,
      'invalid_input',
      'name must be a path-safe basename ending in .yml',
      {},
      requestId,
    );
  }

  try {
    const result = await executeAutomation(state, fileName);
    const successfulStatus = result.status === 'completed'
      || result.status === 'disabled'
      || result.status === 'active';
    auditAutomationOperation(
      requestId,
      auditContext,
      successfulStatus
        ? { outcome: 'success', runStatus: result.status }
        : {
            outcome: 'failure',
            runStatus: result.status,
            errorCode: result.status === 'blocked' ? 'blocked' : 'failed',
            errorMessage: result.status === 'blocked'
              ? 'Automation run was blocked'
              : 'Automation run failed',
          },
    );
    return jsonResponse(
      202,
      { ok: result.ok, fileName, status: result.status, error: result.error ?? null },
      requestId,
    );
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId, auditContext);
  }
};
