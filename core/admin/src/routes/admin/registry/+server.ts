/**
 * GET /admin/registry — List all registry items (channels + automations) with install status.
 *
 * Reads from the cloned registry repo in STATE_HOME/registry-repo/registry/.
 * If the repo hasn't been cloned yet, triggers an initial clone.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { appendAudit } from "$lib/server/control-plane.js";
import {
  ensureRegistryClone,
  discoverRegistryChannels,
  discoverRegistryAutomations
} from "$lib/server/registry-sync.js";
import { existsSync } from "node:fs";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Ensure the registry repo is cloned
  try {
    ensureRegistryClone();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendAudit(state, actor, "registry.list", { error: msg }, false, requestId, callerType);
    return errorResponse(500, "registry_sync_error", msg, {}, requestId);
  }

  // Discover items from the cloned registry
  const registryChannels = discoverRegistryChannels();
  const registryAutomations = discoverRegistryAutomations();

  // Build channels list with install status
  const channels = registryChannels.map((ch) => {
    const installedPath = `${state.configDir}/channels/${ch.name}.yml`;
    return {
      name: ch.name,
      type: "channel" as const,
      installed: existsSync(installedPath),
      hasRoute: ch.hasRoute,
      description: ch.description
    };
  });

  // Build automations list with install status
  const automations = registryAutomations.map((auto) => {
    const installedPath = `${state.configDir}/automations/${auto.name}.yml`;
    return {
      name: auto.name,
      type: "automation" as const,
      installed: existsSync(installedPath),
      description: auto.description,
      schedule: auto.schedule
    };
  });

  appendAudit(state, actor, "registry.list", {}, true, requestId, callerType);
  return jsonResponse(200, { channels, automations }, requestId);
};
