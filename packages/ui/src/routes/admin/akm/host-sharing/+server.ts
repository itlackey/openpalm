/**
 * Host AKM sharing control surface.
 *
 *   GET    /admin/akm/host-sharing  — report current sharing status
 *   PUT    /admin/akm/host-sharing  — enable sharing (overlay + both source entries
 *                                     + optional read-only profile import)
 *   DELETE /admin/akm/host-sharing  — disable sharing (removes overlay + source
 *                                     entries; NEVER deletes any stash content)
 *
 * All orchestration lives in @openpalm/lib (enable/disableHostAkmSharing) so the
 * wizard and this endpoint share one implementation. The personal-config writes
 * are fail-closed in lib (a missing/corrupt ~/.config/akm/config.json throws and
 * is surfaced here as a 409, never silently overwriting the user's file).
 */
import type { RequestHandler } from './$types';
import { homedir } from 'node:os';
import {
  enableHostAkmSharing,
  disableHostAkmSharing,
  getHostAkmSharingStatus,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  parseJsonBody,
  jsonBodyError,
  requireAdmin,
} from '$lib/server/helpers.js';

/** Resolve the operator's personal akm paths from HOME (UI runs as the host user). */
function hostPaths(): { hostStashPath: string; hostConfigPath: string } {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return {
    hostStashPath: `${home}/akm`,
    hostConfigPath: `${home}/.config/akm/config.json`,
  };
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  return jsonResponse(200, { sharing: getHostAkmSharingStatus(state), ...hostPaths() }, requestId);
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const opts = result.data;
  const writable = opts.writable === undefined ? true : opts.writable === true;
  const importProfiles = opts.importProfiles === true;

  const state = getState();
  const { hostStashPath, hostConfigPath } = hostPaths();
  try {
    const { profilesImported } = enableHostAkmSharing(state, {
      hostStashPath,
      hostConfigPath,
      writable,
      importProfiles,
    });
    return jsonResponse(
      200,
      { sharing: getHostAkmSharingStatus(state), profilesImported, hostStashPath },
      requestId,
    );
  } catch (err) {
    // Fail-closed personal-config write (missing/corrupt ~/.config/akm) → 409.
    return errorResponse(409, (err as Error).message, requestId);
  }
};

export const DELETE: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const { hostConfigPath } = hostPaths();
  disableHostAkmSharing(state, hostConfigPath);
  return jsonResponse(200, { sharing: getHostAkmSharingStatus(state) }, requestId);
};
