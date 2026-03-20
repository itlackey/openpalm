import {
  getRequestId,
  jsonResponse,
  requireAuth,
  getActor,
  getCallerType
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import { appendAudit } from "$lib/server/control-plane.js";
import type { RequestHandler } from "./$types";

type ServiceCheckResult = {
  status: "reachable" | "unreachable";
  latencyMs: number;
  error?: string;
};

/** Internal services to check connectivity against. */
const SERVICES: { name: string; url: string }[] = [
  { name: "guardian", url: "http://guardian:8080/health" },
  { name: "memory", url: "http://memory:8765/health" },
  { name: "assistant", url: "http://assistant:4096" },
];

async function checkService(url: string): Promise<ServiceCheckResult> {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000)
    });
    const latencyMs = Math.round(performance.now() - start);
    // Any response (even non-2xx) means the service is reachable at the network level
    return { status: "reachable", latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return { status: "unreachable", latencyMs, error: message };
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAuth(event, requestId);
  if (authError) return authError;

  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);

  const results: Record<string, ServiceCheckResult> = {};

  // Run all checks in parallel for faster response
  const checks = await Promise.all(
    SERVICES.map(async (svc) => ({
      name: svc.name,
      result: await checkService(svc.url)
    }))
  );

  for (const check of checks) {
    results[check.name] = check.result;
  }

  appendAudit(state, actor, "network.check", {}, true, requestId, callerType);

  return jsonResponse(200, { results }, requestId);
};
