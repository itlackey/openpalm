import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  parseJsonBody,
  jsonBodyError
} from "$lib/server/helpers.js";
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { getState } from "$lib/server/state.js";
import { isAllowedService, buildComposeOptions, createLogger, reconcileHostOwnership, HostSwapBlockedError } from "@openpalm/lib";
import { composeRestart, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-restart");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:containers', requestId);
  if (capabilityError) return capabilityError;
  logger.info("container restart request", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;
  const service = typeof body.service === "string" ? body.service : "";

  if (!isAllowedService(service, state.configDir)) {
    return errorResponse(400, "invalid_service", "Service is not in allowlist", { service }, requestId);
  }

  return withAdminUpdateLock(state, requestId, async () => {
    // Try real Docker — only update state based on actual result
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      // Shared host-ownership reconcile (swap detection + ownership repair)
      // before touching containers — same lib step the CLI runs. An un-adopted
      // host swap surfaces as an actionable error (the UI has no adopt flag).
      try {
        await reconcileHostOwnership(state, { services: [service] });
      } catch (err) {
        if (err instanceof HostSwapBlockedError) {
          return errorResponse(
            409,
            "host_swap_blocked",
            "OP_HOME appears to have moved from another host. Ownership must be adopted for this host before starting. Run `openpalm start --adopt-host` from the host CLI, then retry.",
            { service, previousHost: err.previousIdentity?.host ?? null, currentHost: err.currentIdentity.host },
            requestId,
          );
        }
        throw err;
      }
      const result = await composeRestart([service], buildComposeOptions(state));
      if (result.ok) {
        state.services[service] = "running";
      } else {
        return errorResponse(500, "docker_error", `Failed to restart service: ${result.stderr}`, { service }, requestId);
      }
    } else {
      state.services[service] = "running";
    }

    return jsonResponse(
      200,
      { ok: true, service, status: state.services[service] },
      requestId
    );
  });
};
