/**
 * GET /api/host/akm/health — AKM runtime health + index stats for the dashboard.
 *
 * Runs `akm` inside the live assistant container so the UI shows the same AKM
 * world the assistant actually sees. Fails soft: if the assistant runtime is
 * unavailable or errors, returns { available: false } so the dashboard can show
 * an "unavailable" state instead of breaking.
 */
import type { RequestHandler } from './$types';
import { runAssistantAkmCommand } from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin, requireCapability } from '$lib/server/helpers.js';
import { safeParseJsonObject } from '$lib/server/akm.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:containers', requestId);
  if (capabilityError) return capabilityError;
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();

  const [health, info] = await Promise.all([
    runAssistantAkmCommand(state, ['health', '--format', 'json', '--quiet'], 8000),
    runAssistantAkmCommand(state, ['info', '--format', 'json', '--quiet'], 8000),
  ]);

  const parsedHealth = safeParseJsonObject(health.stdout);
  const parsedInfo = safeParseJsonObject(info.stdout);

  if (!parsedHealth && !parsedInfo) {
    // Report what akm actually said. Its errors are precise and actionable
    // ("stashDir is retired in 0.9…"), and flattening them to a generic
    // string is what left an operator staring at "unavailable" with no route
    // to the cause. Same shape akm-health-report.ts and reindex already use.
    const detail = [health.stderr, info.stderr, health.stdout, info.stdout]
      .map((s) => s?.trim())
      .find((s) => s);
    return jsonResponse(
      200,
      { available: false, reason: detail || 'assistant AKM unavailable' },
      requestId,
    );
  }

  // Summarise the hard checks into pass/warn/fail counts.
  const checks = Array.isArray(parsedHealth?.hardChecks) ? (parsedHealth?.hardChecks as Array<{ status?: string }>) : [];
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
