/**
 * GET /admin/registry — List all registry items (channels + automations) with install status.
 *
 * Tries the cloned registry repo first (STATE_HOME/registry-repo/registry/).
 * Falls back to build-time bundled assets if the clone is unavailable or empty.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import {
  jsonResponse,
  requireAuth,
  getRequestId,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import {
  appendAudit,
  REGISTRY_CHANNEL_YML,
  REGISTRY_CHANNEL_CADDY,
  REGISTRY_CHANNEL_NAMES,
  REGISTRY_AUTOMATION_YML,
  REGISTRY_AUTOMATION_NAMES
} from "$lib/server/control-plane.js";
import {
  ensureRegistryClone,
  discoverRegistryChannels,
  discoverRegistryAutomations
} from "$lib/server/registry-sync.js";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAuth(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Try cloned registry first
  let remoteChannels: ReturnType<typeof discoverRegistryChannels> = [];
  let remoteAutomations: ReturnType<typeof discoverRegistryAutomations> = [];
  let source: "remote" | "bundled" = "bundled";

  try {
    ensureRegistryClone();
    remoteChannels = discoverRegistryChannels();
    remoteAutomations = discoverRegistryAutomations();
  } catch {
    // Clone failed — will fall back to bundled
  }

  if (remoteChannels.length > 0 || remoteAutomations.length > 0) {
    // Use remote registry
    source = "remote";

    const channels = remoteChannels.map((ch) => {
      const installedPath = `${state.configDir}/channels/${ch.name}.yml`;
      return {
        name: ch.name,
        type: "channel" as const,
        installed: existsSync(installedPath),
        hasRoute: ch.hasRoute,
        description: ch.description
      };
    });

    const automations = remoteAutomations.map((auto) => {
      const installedPath = `${state.configDir}/automations/${auto.name}.yml`;
      return {
        name: auto.name,
        type: "automation" as const,
        installed: existsSync(installedPath),
        description: auto.description,
        schedule: auto.schedule
      };
    });

    appendAudit(state, actor, "registry.list", { source }, true, requestId, callerType);
    return jsonResponse(200, { channels, automations, source }, requestId);
  }

  // Fallback: use bundled registry assets
  const channels = REGISTRY_CHANNEL_NAMES.map((name) => {
    const installedPath = `${state.configDir}/channels/${name}.yml`;
    return {
      name,
      type: "channel" as const,
      installed: existsSync(installedPath),
      hasRoute: name in REGISTRY_CHANNEL_CADDY,
      description: `Docker compose service for the ${name} channel`
    };
  });

  const automations = REGISTRY_AUTOMATION_NAMES.map((name) => {
    const installedPath = `${state.configDir}/automations/${name}.yml`;
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
      installed: existsSync(installedPath),
      description,
      schedule
    };
  });

  appendAudit(state, actor, "registry.list", { source }, true, requestId, callerType);
  return jsonResponse(200, { channels, automations, source }, requestId);
};
