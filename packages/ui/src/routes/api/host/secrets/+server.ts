/**
 * GET /api/host/secrets — list the secret files, name-routed: OP_HOME/state/
 * secrets by default, plus the agent-readable OP_HOME/knowledge/secrets names
 * (auth.json). Returns names + byte sizes only, never values. Per-file
 * read/write/delete is handled by /api/host/secrets/[name].
 */
import type { RequestHandler } from './$types';
import { listSecretFiles } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:secrets', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, { files: listSecretFiles(getState().homeDir) }, requestId);
};
