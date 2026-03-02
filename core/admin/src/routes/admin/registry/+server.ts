/**
 * GET /admin/registry — List all registry items (channels + automations) with install status.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAdmin,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  REGISTRY_CHANNEL_NAMES,
  REGISTRY_CHANNEL_CADDY,
  REGISTRY_CHANNEL_YML,
  REGISTRY_AUTOMATION_NAMES,
  REGISTRY_AUTOMATION_YML
} from "$lib/server/control-plane.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Build channels list
  const channels = REGISTRY_CHANNEL_NAMES.map((name) => {
    const installedPath = `${state.configDir}/channels/${name}.yml`;
    const installed = existsSync(installedPath);
    return {
      name,
      type: "channel" as const,
      installed,
      hasRoute: name in REGISTRY_CHANNEL_CADDY,
      description: `Docker compose service for the ${name} channel`
    };
  });

  // Build automations list
  const automations = REGISTRY_AUTOMATION_NAMES.map((name) => {
    const installedPath = `${state.configDir}/automations/${name}.yml`;
    const installed = existsSync(installedPath);

    // Parse description from the bundled YAML
    let description = "";
    let schedule = "";
    try {
      const parsed = parseYaml(REGISTRY_AUTOMATION_YML[name]);
      if (parsed && typeof parsed === "object") {
        description = parsed.description ?? "";
        schedule = parsed.schedule ?? "";
      }
    } catch {
      // best-effort
    }

    return {
      name,
      type: "automation" as const,
      installed,
      description,
      schedule
    };
  });

  appendAudit(state, actor, "registry.list", {}, true, requestId, callerType);
  return jsonResponse(200, { channels, automations }, requestId);
};
