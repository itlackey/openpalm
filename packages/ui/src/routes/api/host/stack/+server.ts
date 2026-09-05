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
  reconcileMdnsResponder,
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
            stopped: [],
          },
          requestId,
        );
      }

      // Saving IS applying (lib's applyAccessToggles): write intent + the row it
      // generates (a guardian toggle activates the guardian's own compose
      // profile — no addon is enabled on its behalf), recreate exactly the
      // affected containers so Compose republishes the ports, and advertise
      // over mDNS only once that succeeded. Compose interpolation is the sole consumer of these values,
      // so a write alone changed nothing — and every "restart" the product
      // offers runs `compose restart`, which cannot republish a port.
      //
      // ORDER: the toggle apply runs against the CURRENT project name, and the
      // rename is written after it. OP_PROJECT_NAME used to ride along in this
      // call's `extraEnv`, which landed in stack.env before the apply's own
      // `compose ps`/`up` — and those resolve `--project-name` from the env
      // file (buildComposeCommandArgs -> collectComposeEnvOverrides). So a
      // save that renamed the project AND flipped a toggle addressed a project
      // that did not exist yet: `ps` returned nothing, the recreate scope came
      // out empty, no container was touched, and the response still advertised
      // over mDNS. The toggle read back as applied while the running stack
      // kept its old ports. Applying first keeps the apply pointed at the
      // containers it must actually change; the rename then lands in its own
      // write and is torn down by the next locked apply (#540).
      const applied = await applyAccessToggles(state, coerceAccessToggles(body.access), { lock });

      // The rename write is unconditional (it must land even when the toggle
      // apply failed — the operator asked for both, and the failure path below
      // reports the toggle half). recordProjectRename is what makes the next
      // apply tear the outgoing project down.
      patchSecretsEnvFile(state.homeDir, { OP_PROJECT_NAME: projectName });
      const projectRenamed = recordRenameIfChanged();

      // mDNS names derive from OP_PROJECT_NAME (mdns-responder.ts), so the
      // reconcile inside the apply above saw the OLD name. Re-reconcile after
      // the rename write so the advertised `<name>.local` matches the project
      // the operator just named — still after the containers, never before.
      const mdns = projectRenamed ? reconcileMdnsResponder(state.homeDir) : applied.mdns;

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
          mdns,
          access: applied.access,
          /** Services recreated so the new binds are actually published. */
          recreated: applied.recreated,
          /** Services stopped because this save removed their last reason to run. */
          stopped: applied.stopped,
        },
        requestId,
      );
    });
  });
};
