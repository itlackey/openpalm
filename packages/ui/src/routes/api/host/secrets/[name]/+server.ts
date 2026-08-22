/**
 * Per-file access to the secret files, used by the Secrets admin tab as a plain
 * file editor. The directory is resolved from the NAME (OP_HOME/state/secrets
 * by default, OP_HOME/knowledge/secrets for the agent-readable names).
 *
 *   GET    /api/host/secrets/<name> — read the raw file contents { name, value }
 *   PUT    /api/host/secrets/<name> — write raw contents (body { value })
 *   DELETE /api/host/secrets/<name> — delete the file
 *
 * `name` is a basename only; the lib guards against path traversal and writes 0600.
 */
import type { RequestHandler } from './$types';
import { readSecretFile, writeSecretFile, removeSecretFile, assertSafeSecretFilename } from '@openpalm/lib';
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

function guardName(name: string, requestId: string): Response | null {
  try {
    assertSafeSecretFilename(name);
    return null;
  } catch (err) {
    return errorResponse(400, 'bad_request', (err as Error).message, {}, requestId);
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guardName(name, requestId);
  if (bad) return bad;

  const value = readSecretFile(getState().homeDir, name);
  if (value === null) return errorResponse(404, 'not_found', `Secret file not found: ${name}`, {}, requestId);
  return jsonResponse(200, { name, value }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guardName(name, requestId);
  if (bad) return bad;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const value = result.data.value;
  if (typeof value !== 'string') return errorResponse(400, 'bad_request', 'value must be a string', {}, requestId);

  writeSecretFile(getState().homeDir, name, value);
  return jsonResponse(200, { ok: true, name }, requestId);
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;
  const name = event.params.name;
  const bad = guardName(name, requestId);
  if (bad) return bad;

  removeSecretFile(getState().homeDir, name);
  return jsonResponse(200, { ok: true, name }, requestId);
};
