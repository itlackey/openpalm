import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getAkmStats } from '@openpalm/lib';
import { errorResponse, getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';

const CACHE_TTL_MS = 15_000;

let cachedStats: Awaited<ReturnType<typeof getAkmStats>> | null = null;
let cachedAt = 0;

export function _resetStatsCacheForTests(): void {
  cachedStats = null;
  cachedAt = 0;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  if (cachedStats && Date.now() - cachedAt < CACHE_TTL_MS) {
    return jsonResponse(200, cachedStats, requestId);
  }

  try {
    const stats = await getAkmStats(getState());
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
