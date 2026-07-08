/**
 * GET/PUT /api/host/stack — host stack settings (plan ui-runtime-modes-plan.md
 * Phase 4 step 2, §5.F, §6.4).
 *
 * The HOST-SCOPED half of the old /admin/assistant endpoint: compose project
 * name (OP_PROJECT_NAME) and assistant bind address (OP_ASSISTANT_BIND_ADDRESS,
 * surfaced as `lanExposureEnabled`). Persona is assistant-owned and lives at
 * /api/assistant/persona — it is deliberately absent from this payload.
 *
 * Guarded by the host:stack capabilities in addition to requireAdmin (plan
 * §8.5): a valid admin session in a mode without host:* (assistant-container,
 * pwa-static) is still refused with 403.
 */
import type { RequestHandler } from './$types';
import { patchSecretsEnvFile, readStackEnv, recordProjectRename } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  withAdminBody,
} from '$lib/server/helpers.js';

const DEFAULT_PROJECT_NAME = 'openpalm';
const DEFAULT_ASSISTANT_BIND_ADDRESS = '127.0.0.1';
const LAN_ASSISTANT_BIND_ADDRESS = '0.0.0.0';
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
      lanExposureEnabled: (env.OP_ASSISTANT_BIND_ADDRESS?.trim() || DEFAULT_ASSISTANT_BIND_ADDRESS) === LAN_ASSISTANT_BIND_ADDRESS,
      stackEnvPath: 'knowledge/env/stack.env',
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

    if (typeof body.lanExposureEnabled !== 'boolean') {
      return errorResponse(400, 'bad_request', 'lanExposureEnabled must be a boolean', {}, requestId);
    }

    const state = getState();
    // Capture the outgoing project name BEFORE the patch overwrites it — a
    // rename must be recorded so the next locked apply (deploy/update/start)
    // tears the old compose project down instead of leaving it running
    // unaddressed beside the new one (#540).
    const previousProjectName = readStackEnv(state.homeDir).OP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME;
    patchSecretsEnvFile(state.homeDir, {
      OP_PROJECT_NAME: projectName,
      OP_ASSISTANT_BIND_ADDRESS: body.lanExposureEnabled ? LAN_ASSISTANT_BIND_ADDRESS : DEFAULT_ASSISTANT_BIND_ADDRESS,
    });
    const projectRenamed = previousProjectName !== projectName;
    if (projectRenamed) {
      recordProjectRename(state.homeDir, previousProjectName, projectName);
    }

    return jsonResponse(
      200,
      {
        ok: true,
        projectName,
        projectRenamed,
        lanExposureEnabled: body.lanExposureEnabled,
        stackEnvPath: 'knowledge/env/stack.env',
      },
      requestId,
    );
  });
};
