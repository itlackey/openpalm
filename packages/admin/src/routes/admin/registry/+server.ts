/**
 * GET /admin/registry — List available registry items (components + automations).
 *
 * Components are listed by ID. Automations include install status and metadata.
 * Tries the cloned registry repo first; falls back to build-time bundled assets.
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
  REGISTRY_AUTOMATION_YML,
  REGISTRY_AUTOMATION_NAMES
} from "$lib/server/control-plane.js";
import { viteRegistry } from "$lib/server/vite-registry-provider.js";
import {
  ensureRegistryClone,
  discoverRegistryComponents,
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
  let remoteComponents: Record<string, { compose: string; schema: string }> = {};
  let remoteAutomations: ReturnType<typeof discoverRegistryAutomations> = [];
  let source: "remote" | "bundled" = "bundled";

  try {
    ensureRegistryClone();
    remoteComponents = discoverRegistryComponents();
    remoteAutomations = discoverRegistryAutomations();
  } catch {
    // Clone failed — will fall back to bundled
  }

  const remoteComponentIds = Object.keys(remoteComponents);

  if (remoteComponentIds.length > 0 || remoteAutomations.length > 0) {
    // Use remote registry
    source = "remote";

    const components = remoteComponentIds.map((id) => {
      return {
        id,
        type: "component" as const,
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
    return jsonResponse(200, { components, automations, source }, requestId);
  }

  // Fallback: use bundled registry assets
  const components = viteRegistry.componentIds().map((id) => ({
    id,
    type: "component" as const,
  }));

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
  return jsonResponse(200, { components, automations, source }, requestId);
};
