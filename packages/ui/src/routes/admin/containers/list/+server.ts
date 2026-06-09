import {
  getRequestId,
  jsonResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { buildComposeOptions, buildManagedServices } from "@openpalm/lib";
import { composePs, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  // Try to get real Docker status
  const dockerCheck = await checkDocker();
  let dockerContainers = null;
  if (dockerCheck.ok) {
    const ps = await composePs(buildComposeOptions(state));
    if (ps.ok && ps.stdout.trim()) {
      try {
        // docker compose ps --format json returns one JSON object per line
        dockerContainers = ps.stdout
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .map((l) => JSON.parse(l));
      } catch (e) {
        console.warn('[containers.list] Failed to parse docker compose ps output', e);
        dockerContainers = null;
      }
    }
  }

  // Sync state.services from live Docker data so the in-memory map
  // reflects actual container state instead of optimistic assumptions
  if (dockerContainers) {
    const dockerStateByService = new Map<string, string>();
    for (const c of dockerContainers) {
      if (c.Service && c.State) {
        dockerStateByService.set(c.Service, c.State);
      }
    }
    for (const service of Object.keys(state.services)) {
      const dockerState = dockerStateByService.get(service);
      if (dockerState) {
        state.services[service] = dockerState === "running" ? "running" : "stopped";
      }
    }
  }

  // The authoritative set of services this stack actually deploys, resolved
  // from the compose model with the active profiles (or static addon inference
  // when Docker is down). This is what the UI reports on — NOT the optimistic
  // state.services seed, which can list a service the stack never deploys (e.g.
  // guardian on a no-channel install) and so render it as a perpetually-stopped
  // container that does not exist in Docker.
  let managedServices: string[];
  try {
    managedServices = await buildManagedServices(state);
  } catch {
    // Fall back to the seeded expected set rather than reporting nothing.
    managedServices = Object.keys(state.services);
  }

  // Only report seeded services the stack actually manages. A live Docker
  // container that isn't managed (a true orphan) still surfaces via
  // dockerContainers below, so nothing real is hidden — we just stop inventing
  // a stopped row for a service compose never deploys.
  const managedSet = new Set(managedServices);
  const containers: Record<string, "running" | "stopped"> = {};
  for (const [name, status] of Object.entries(state.services)) {
    if (managedSet.has(name)) containers[name] = status;
  }

  return jsonResponse(
    200,
    {
      containers,
      dockerContainers,
      dockerAvailable: dockerCheck.ok,
      managedServices
    },
    requestId
  );
};
