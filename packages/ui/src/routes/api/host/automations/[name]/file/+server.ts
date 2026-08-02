/**
 * Raw editor access to an akm task file in the assistant tasks dir
 * (/stash/tasks = knowledge/tasks), used by the Automations admin tab.
 *
 *   GET    /api/host/automations/<name>/file — read raw contents { name, content }
 *   PUT    /api/host/automations/<name>/file — write raw contents (body { content })
 *   DELETE /api/host/automations/<name>/file — delete the task file
 *
 * `name` is a canonical .yml basename. The lib guards traversal and validates
 * YAML syntax; AKM remains the task-schema authority during reconciliation.
 */
import type { RequestHandler } from './$types';
import {
  readTaskFile,
  writeTaskFile,
  removeTaskFile,
  assertSafeTaskFilename,
  assertTaskYamlDocument,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
  requireCapability,
} from '$lib/server/helpers.js';

function guard(name: string, requestId: string): Response | null {
  try { assertSafeTaskFilename(name); return null; }
  catch (err) { return errorResponse(400, 'bad_request', (err as Error).message, {}, requestId); }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guard(name, requestId);
  if (bad) return bad;

  const content = readTaskFile(getState().stashDir, name);
  if (content === null) return errorResponse(404, 'not_found', `Task file not found: ${name}`, {}, requestId);
  return jsonResponse(200, { name, content }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guard(name, requestId);
  if (bad) return bad;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const content = result.data.content;
  if (typeof content !== 'string') return errorResponse(400, 'bad_request', 'content must be a string', {}, requestId);
  try {
    assertTaskYamlDocument(content);
  } catch (error) {
    return errorResponse(400, 'bad_request', error instanceof Error ? error.message : String(error), {}, requestId);
  }

  writeTaskFile(getState().stashDir, name, content);
  return jsonResponse(200, { ok: true, name }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guard(name, requestId);
  if (bad) return bad;

  removeTaskFile(getState().stashDir, name);
  return jsonResponse(200, { ok: true, name }, requestId);
};
