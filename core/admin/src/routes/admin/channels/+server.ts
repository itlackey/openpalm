/**
 * GET /admin/channels — List installed and available channels.
 *
 * Returns installed channels (from staged STATE_HOME) and available
 * registry channels not yet installed.
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
  discoverStagedChannelYmls,
  REGISTRY_CHANNEL_NAMES,
  REGISTRY_CHANNEL_CADDY
} from "$lib/server/control-plane.js";
import { existsSync, readdirSync } from "node:fs";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  // Report staged channels (source channels are inert until apply)
  const stagedYmls = discoverStagedChannelYmls(state.stateDir);

  // Check which channels have staged caddy routes (in public/ or lan/ subdirs)
  const stagedChannelsDir = `${state.stateDir}/artifacts/channels`;
  const routedChannels = new Set<string>();
  for (const sub of ["public", "lan"]) {
    const dir = `${stagedChannelsDir}/${sub}`;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".caddy")) routedChannels.add(f.replace(/\.caddy$/, ""));
      }
    }
  }

  const installedNames = new Set<string>();
  const installed = stagedYmls.map((ymlPath) => {
    const filename = ymlPath.split("/").pop() ?? "";
    const name = filename.replace(/\.yml$/, "");
    installedNames.add(name);
    return {
      name,
      hasRoute: routedChannels.has(name),
      service: `channel-${name}`,
      status: state.services[`channel-${name}`] ?? "stopped"
    };
  });

  // Available = registry channels not yet installed
  const available = REGISTRY_CHANNEL_NAMES
    .filter((name) => !installedNames.has(name))
    .map((name) => ({
      name,
      hasRoute: name in REGISTRY_CHANNEL_CADDY
    }));

  appendAudit(state, actor, "channels.list", {}, true, requestId, callerType);
  return jsonResponse(200, { installed, available }, requestId);
};
