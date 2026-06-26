/**
 * GET /admin/secrets — list the files in the assistant secrets dir (/stash/secrets
 * = OP_HOME/knowledge/secrets). Returns names + byte sizes only, never values.
 * Per-file read/write/delete is handled by /admin/secrets/[name].
 */
import type { RequestHandler } from './$types';
import { listSecretFiles } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, { files: listSecretFiles(getState().homeDir) }, requestId);
};
