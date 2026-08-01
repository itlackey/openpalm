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
  applyAccessToggles,
  patchSecretsEnvFile,
  readStackEnv,
  recordProjectRename,
  resolveMdnsStatus,
  coerceAccessToggles,
  readAccessToggles,
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
      stackEnvPath: 'state/stack.env',
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
    return withAdminUpdateLock(state, requestId, async (lock) => {
      // Capture the outgoing project name BEFORE the patch overwrites it — a
      // rename must be recorded so the next locked apply (deploy/update/start)
      // tears the old compose project down instead of leaving it running
      // unaddressed beside the new one (#540).
      const currentEnv = readStackEnv(state.homeDir);
      const previousProjectName = currentEnv.OP_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME;
      /** Both branches below rename identically; only the write before it differs. */
      const recordRenameIfChanged = (): boolean => {
        const renamed = previousProjectName !== projectName;
        if (renamed) recordProjectRename(state.homeDir, previousProjectName, projectName);
        return renamed;
      };

      // Omitted `access` touches NOTHING about exposure — not even a
      // round-trip through the generated row. The endpoint used to
      // read-then-rewrite it on every PUT, which turned a project rename into
      // a silent widening: a hand-set single-interface bind
      // (OP_UI_BIND_ADDRESS=192.168.1.50) reads as "open" and regenerates to
      // 0.0.0.0, moving a deliberately narrowed listener onto every interface.
      if (body.access === undefined) {
        patchSecretsEnvFile(state.homeDir, { OP_PROJECT_NAME: projectName });
        const projectRenamed = recordRenameIfChanged();
        // One read for both views of the row the patch just wrote.
        const freshEnv = readStackEnv(state.homeDir);
        return jsonResponse(
          200,
          {
            ok: true,
            projectName,
            projectRenamed,
            stackEnvPath: 'state/stack.env',
            mdns: resolveMdnsStatus(freshEnv),
            access: readAccessToggles(freshEnv),
            recreated: [],
            autoEnabledAddons: [],
          },
          requestId,
        );
      }

      // Saving IS applying (lib's applyAccessToggles): write intent + the row it
      // generates, enable an addon if a guardian port would otherwise have
      // nothing behind it, recreate exactly the affected containers so Compose
      // republishes the ports, and advertise over mDNS only once that
      // succeeded. Compose interpolation is the sole consumer of these values,
      // so a write alone changed nothing — and every "restart" the product
      // offers runs `compose restart`, which cannot republish a port.
      const applied = await applyAccessToggles(state, coerceAccessToggles(body.access), {
        extraEnv: { OP_PROJECT_NAME: projectName },
        lock,
      });

      const projectRenamed = recordRenameIfChanged();

      if (!applied.ok) {
        return errorResponse(
          500,
          'access_apply_failed',
          `Settings were saved but could not be applied: ${applied.error ?? 'compose apply failed'}. `
            + 'Run `openpalm start` to retry.',
          { changedKeys: applied.changedKeys, access: applied.access },
          requestId,
        );
      }

      return jsonResponse(
        200,
        {
          ok: true,
          projectName,
          projectRenamed,
          stackEnvPath: 'state/stack.env',
          mdns: applied.mdns,
          access: applied.access,
          /** Services recreated so the new binds are actually published. */
          recreated: applied.recreated,
          /** Addons turned on so a published guardian port has a service behind it. */
          autoEnabledAddons: applied.autoEnabledAddons,
        },
        requestId,
      );
    });
  });
};
