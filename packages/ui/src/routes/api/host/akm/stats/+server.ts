import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getAkmStats } from '@openpalm/lib';
import { errorResponse, getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';

const CACHE_TTL_MS = 15_000;

let cachedStats: Awaited<ReturnType<typeof getAkmStats>> | null = null;
let cachedAt = 0;
// Single in-flight promise guards concurrent refreshes so parallel requests
// don't each spin up their own CLI subprocess.
let inFlight: Promise<Awaited<ReturnType<typeof getAkmStats>>> | null = null;

export function _resetStatsCacheForTests(): void {
  cachedStats = null;
  cachedAt = 0;
  inFlight = null;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:containers', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  if (cachedStats && Date.now() - cachedAt < CACHE_TTL_MS) {
    return jsonResponse(200, cachedStats, requestId);
  }

  try {
    if (!inFlight) {
      inFlight = getAkmStats(getState()).finally(() => {
        inFlight = null;
      });
    }
    const stats = await inFlight;
    cachedStats = stats;
    cachedAt = Date.now();
    return jsonResponse(200, stats, requestId);
  } catch (error) {
    return errorResponse(
      500,
      'akm_stats_failed',
      error instanceof Error ? error.message : 'Failed to load AKM stats.',
      {},
      requestId,
    );
  }
};
