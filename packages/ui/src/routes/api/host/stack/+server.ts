/**
 * GET/PUT /api/host/stack — host stack settings.
 *
 * The HOST-SCOPED half of the old /admin/assistant endpoint: compose project
 * name (OP_PROJECT_NAME) and the network access toggles. Persona is
 * assistant-owned and lives at /api/assistant/persona — deliberately absent.
 *
 * The toggles replace a raw `lanExposureEnabled` boolean that wrote
 * OP_ASSISTANT_BIND_ADDRESS directly. That knob published OpenCode while
 * leaving the UI — the thing a person actually opens — on loopback, so the
 * one switch labelled "LAN exposure" did not expose the front door.
 *
 * Guarded by the host:stack capabilities in addition to requireAdmin (plan
 * §8.5): a valid admin session in a non-admin process (host:* absent) is
 * still refused with 403.
 */
import type { RequestHandler } from './$types';
import {
  patchSecretsEnvFile,
  readStackEnv,
  recordProjectRename,
  reconcileMdnsResponder,
  resolveMdnsStatus,
  coerceAccessToggles,
  readAccessToggles,
  resolveAccessEnv,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';

const DEFAULT_PROJECT_NAME = 'openpalm';
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function normalizeProjectName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim() || DEFAULT_PROJECT_NAME;
  if (value.length > 63) return null;
  return PROJECT_NAME_RE.test(value) ? value : null;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:read', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  const env = readStackEnv(state.homeDir);

  return jsonResponse(
    200,
    {
      projectName: env.OP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME,
      stackEnvPath: 'knowledge/env/stack.env',
      mdns: resolveMdnsStatus(env),
      // A direct read of the generated binds. Unlike preset detection this can
      // never report "custom": every combination is representable.
      access: readAccessToggles(env),
    },
    requestId,
  );
};

export const PUT: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:stack:write', requestId);
  if (capabilityError) return capabilityError;

  return withAdminBody(event, async ({ requestId, body }) => {
    const projectName = normalizeProjectName(body.projectName);
    if (!projectName) {
      return errorResponse(
        400,
        'bad_request',
        'projectName must be 1-63 chars of lowercase letters, numbers, dashes, or underscores.',
        {},
        requestId,
      );
    }

    if (body.access !== undefined && (typeof body.access !== 'object' || body.access === null)) {
      return errorResponse(400, 'bad_request', 'access must be an object if provided', {}, requestId);
    }

    const state = getState();
    return withAdminUpdateLock(state, requestId, () => {
      // Capture the outgoing project name BEFORE the patch overwrites it — a
      // rename must be recorded so the next locked apply (deploy/update/start)
      // tears the old compose project down instead of leaving it running
      // unaddressed beside the new one (#540).
      const currentEnv = readStackEnv(state.homeDir);
      const previousProjectName = currentEnv.OP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME;
      // Omitted `access` leaves exposure exactly as it is — renaming the
      // project must never move a bind as a side effect.
      const toggles = coerceAccessToggles(body.access ?? readAccessToggles(currentEnv));
      patchSecretsEnvFile(state.homeDir, {
        OP_PROJECT_NAME: projectName,
        ...resolveAccessEnv(toggles),
      });
      const projectRenamed = previousProjectName !== projectName;
      if (projectRenamed) {
        recordProjectRename(state.homeDir, previousProjectName, projectName);
      }

      // Synchronous, non-throwing, and gated — with LAN exposure just enabled
      // this starts advertising immediately (no restart of the host process).
      const mdns = reconcileMdnsResponder(state.homeDir);
      // Read back AFTER the patch so the response reflects what was written.
      const access = readAccessToggles(readStackEnv(state.homeDir));

      return jsonResponse(
        200,
        {
          ok: true,
          projectName,
          projectRenamed,
          stackEnvPath: 'knowledge/env/stack.env',
          mdns,
          access,
        },
        requestId,
      );
    });
  });
};
