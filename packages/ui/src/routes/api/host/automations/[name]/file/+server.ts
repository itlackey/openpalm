/**
 * Raw editor access to an akm task file in the assistant tasks dir
 * (/stash/tasks = knowledge/tasks), used by the Automations admin tab.
 *
 *   GET    /api/host/automations/<name>/file — read raw contents and revision
 *   PUT    /api/host/automations/<name>/file — conditional create/update
 *   DELETE /api/host/automations/<name>/file — conditional delete
 *
 * `name` is a transport-safe .yml basename. Content remains opaque; AKM is the
 * syntax, task-schema, and task-ID authority during reconciliation and runs.
 */

import {
  AUTOMATION_RUNTIME_MAX_STDIN_BYTES,
  assertPortableTaskFilename,
  deleteAutomationTaskFile,
  readAutomationTaskFile,
  writeAutomationTaskFile,
} from '@openpalm/lib';
import {
  auditAutomationOperation,
  automationRuntimeErrorResponse,
} from '$lib/server/automation-runtime.js';
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

function guard(name: string, requestId: string): Response | null {
  try {
    assertPortableTaskFilename(name);
    return null;
  } catch (error) {
    return errorResponse(
      400,
      'bad_request',
      error instanceof Error ? error.message : String(error),
      {},
      requestId,
    );
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const fileName = event.params.name;
  const bad = guard(fileName, requestId);
  if (bad) return bad;

  try {
    const snapshot = await readAutomationTaskFile(getState(), fileName);
    return jsonResponse(200, { fileName, ...snapshot }, requestId);
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId);
  }
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
  const fileName = event.params.name;
  const bad = guard(fileName, requestId);
  if (bad) return bad;

  const result = await parseJsonBody(event.request, AUTOMATION_RUNTIME_MAX_STDIN_BYTES);
  if ('error' in result) return jsonBodyError(result, requestId);
  const content = result.data.content;
  if (typeof content !== 'string')
    return errorResponse(400, 'bad_request', 'content must be a string', {}, requestId);
  const expectedRevision = result.data.expectedRevision;
  if (expectedRevision !== null && typeof expectedRevision !== 'string') {
    return errorResponse(
      400,
      'bad_request',
      'expectedRevision must be a string or null',
      {},
      requestId,
    );
  }
  const operation = expectedRevision === null ? 'create' : 'update';
  const auditContext = {
    fileName,
    operation,
  } as const;
  try {
    const revision = await writeAutomationTaskFile(
      getState(),
      fileName,
      content,
      expectedRevision,
    );
    auditAutomationOperation(requestId, auditContext, {
      outcome: 'success',
      newRevision: revision,
    });
    return jsonResponse(200, { ok: true, fileName, revision }, requestId);
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId, auditContext);
  }
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
  const fileName = event.params.name;
  const bad = guard(fileName, requestId);
  if (bad) return bad;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const expectedRevision = result.data.expectedRevision;
  if (typeof expectedRevision !== 'string') {
    return errorResponse(
      400,
      'bad_request',
      'expectedRevision must be a string',
      {},
      requestId,
    );
  }
  const auditContext = {
    fileName,
    operation: 'delete',
  } as const;
  try {
    await deleteAutomationTaskFile(getState(), fileName, expectedRevision);
  } catch (error) {
    return automationRuntimeErrorResponse(error, requestId, auditContext);
  }
  auditAutomationOperation(requestId, auditContext, { outcome: 'success' });
  return jsonResponse(200, { ok: true, fileName }, requestId);
};
