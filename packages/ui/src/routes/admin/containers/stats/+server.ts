import {
  getRequestId,
  jsonResponse,
  errorResponse,
  requireAdmin,
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { buildComposeOptions } from "@openpalm/lib";
import { composeStats, checkDocker } from "@openpalm/lib";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();

  const dockerCheck = await checkDocker();
  if (!dockerCheck.ok) {
    return errorResponse(503, "docker_unavailable", "Docker is not available", {}, requestId);
  }

  const result = await composeStats(buildComposeOptions(state));

  if (!result.ok) {
    return errorResponse(500, "docker_error", `Failed to get container stats: ${result.stderr}`, {}, requestId);
  }

  let stats: unknown[] = [];
  if (result.stdout.trim()) {
    try {
      stats = result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l));
    } catch (e) {
      console.warn('[containers.stats] Failed to parse Docker stats output', e);
      return errorResponse(500, "parse_error", "Failed to parse Docker stats output", {}, requestId);
    }
  }

  return jsonResponse(200, { stats }, requestId);
};
