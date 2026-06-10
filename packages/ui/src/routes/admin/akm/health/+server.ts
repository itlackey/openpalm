/**
 * GET /admin/akm/health — AKM runtime health + index stats for the dashboard.
 *
 * Runs the `akm` CLI (health + info) against the STACK's stash/state by pointing
 * AKM_* env at this OP_HOME, NOT the operator's personal ~/akm. Fails soft:
 * if the CLI is missing or errors, returns { available: false } so the dashboard
 * can show an "unavailable" state instead of breaking.
 */
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';
import { runAkmCommand, safeParseJsonObject } from '$lib/server/akm.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();

  const [health, info] = await Promise.all([
    runAkmCommand(state, ['health', '--json', '--quiet'], 8000),
    runAkmCommand(state, ['info', '--json', '--quiet'], 8000),
  ]);

  const parsedHealth = safeParseJsonObject(health.stdout);
  const parsedInfo = safeParseJsonObject(info.stdout);

  if (!parsedHealth && !parsedInfo) {
    return jsonResponse(200, { available: false, reason: 'akm CLI unavailable' }, requestId);
  }

  // Summarise the hard checks into pass/warn/fail counts.
  const checks = Array.isArray(parsedHealth?.hardChecks) ? (parsedHealth!.hardChecks as Array<{ status?: string }>) : [];
  const checkCounts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) {
    if (c.status === 'pass') checkCounts.pass++;
    else if (c.status === 'warn') checkCounts.warn++;
    else checkCounts.fail++;
  }

  return jsonResponse(
    200,
    {
      available: true,
      status: (parsedHealth?.status as string) ?? 'unknown', // 'ok' | 'warn' | 'fail'
      ok: typeof parsedHealth?.ok === 'boolean' ? parsedHealth.ok : null,
      checks: checkCounts,
      metrics: (parsedHealth?.metrics as Record<string, number>) ?? null,
      index: (parsedInfo?.indexStats as Record<string, unknown>) ?? null,
    },
    requestId,
  );
};
