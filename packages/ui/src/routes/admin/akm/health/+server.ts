/**
 * GET /admin/akm/health — AKM runtime health + index stats for the dashboard.
 *
 * Runs the `akm` CLI (health + info) against the STACK's stash/state by pointing
 * AKM_* env at this OP_HOME, NOT the operator's personal ~/akm. Fails soft:
 * if the CLI is missing or errors, returns { available: false } so the dashboard
 * can show an "unavailable" state instead of breaking.
 */
import { execFile } from 'node:child_process';
import type { RequestHandler } from './$types';
import { getState } from '$lib/server/state.js';
import { getRequestId, jsonResponse, requireAdmin } from '$lib/server/helpers.js';

function runAkm(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('akm', args, { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: stdout?.toString() ?? '' });
    });
  });
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const denied = requireAdmin(event, requestId);
  if (denied) return denied;

  const state = getState();
  // Point akm at the stack's stash + durable data + config (matches the
  // assistant container's AKM_* wiring), not the host operator's personal stash.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AKM_STASH_DIR: state.stashDir,
    AKM_DATA_DIR: `${state.dataDir}/akm/data`,
    AKM_CONFIG_DIR: `${state.configDir}/akm`,
  };

  const [health, info] = await Promise.all([
    runAkm(['health', '--json', '--quiet'], env, 8000),
    runAkm(['info', '--json', '--quiet'], env, 8000),
  ]);

  const parsedHealth = safeParse(health.stdout);
  const parsedInfo = safeParse(info.stdout);

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
