/**
 * GET /api/host/automations — List task files from knowledge/tasks/.
 *
 * Read-only endpoint. Automations are AKM task files at
 * ${stashDir}/tasks/*.yml. The scheduler runs as a co-process inside the
 * assistant; `akm task run <id>` handles execution.
 */

import { listAutomationTaskFiles } from '@openpalm/lib';
import { automationRuntimeErrorResponse } from '$lib/server/automation-runtime.js';
import {
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
} from '$lib/server/helpers.js';
import { getState } from '$lib/server/state.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;

  try {
    const automations = await listAutomationTaskFiles(getState());
    return jsonResponse(200, { automations }, requestId);
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId);
  }
};
