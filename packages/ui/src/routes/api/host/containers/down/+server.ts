import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  parseJsonBody,
  jsonBodyError,
  requireInstalledHome
} from "$lib/server/helpers.js";
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import { getState } from "$lib/server/state.js";
import { isAllowedService, activateComposeCommand, createLogger, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

const logger = createLogger("containers-down");

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:containers', requestId);
  if (capabilityError) return capabilityError;
  logger.info("container stop request", { requestId });
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const notInstalled = requireInstalledHome(state.homeDir, requestId);
  if (notInstalled) return notInstalled;
  const result = await parseJsonBody(event.request);
  if ('error' in result) return jsonBodyError(result, requestId);
  const body = result.data;
  const service = typeof body.service === "string" ? body.service : "";

  if (!isAllowedService(service, state.configDir)) {
    return errorResponse(400, "invalid_service", "Service is not in allowlist", { service }, requestId);
  }

  return withAdminUpdateLock(state, requestId, async (lock) => {
    // Try real Docker — only update state based on actual result
    const dockerCheck = await checkDocker();
    if (dockerCheck.ok) {
      try {
        await activateComposeCommand(state, ['stop', service], { lock });
        state.services[service] = "stopped";
      } catch (error) {
        return errorResponse(500, "docker_error", `Failed to stop service: ${error instanceof Error ? error.message : String(error)}`, { service }, requestId);
      }
    } else {
      state.services[service] = "stopped";
    }

    return jsonResponse(
      200,
      { ok: true, service, status: state.services[service] },
      requestId
    );
  });
};
