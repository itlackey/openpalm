/**
 * POST /api/setup/import-host
 *
 * Setup-phase equivalent of POST /admin/providers/import-host.
 * No admin auth required — the admin token hasn't been written yet during setup.
 *
 * Copies host OpenCode config + auth into OP_HOME and live-pushes credentials
 * to the running OpenCode subprocess so providers appear connected immediately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { json } from '@sveltejs/kit';
import {
  importHostOpenCode,
  detectHostOpenCode,
  buildComposeOptions,
  checkDocker,
} from '@openpalm/lib';
import { composeRestart } from '$lib/server/docker.js';
import { getState } from '$lib/server/state.js';
import { opencodeFetch } from '$lib/server/opencode/http.js';
import type { RequestHandler } from './$types';

type PushResult = {
  pushed: string[];
  errors: { provider: string; error: string }[];
};

async function pushAuthToOpenCode(authPath: string): Promise<PushResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(authPath, 'utf-8'));
  } catch (err) {
    return {
      pushed: [],
      errors: [{ provider: '*', error: `Could not read auth.json: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { pushed: [], errors: [{ provider: '*', error: 'auth.json is not a JSON object' }] };
  }

  const pushed: string[] = [];
  const errors: { provider: string; error: string }[] = [];
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    try {
      await opencodeFetch(`/auth/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      });
      pushed.push(providerId);
    } catch (err) {
      errors.push({ provider: providerId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { pushed, errors };
}

/** Restart provider-consuming services so they re-read imported startup config. */
async function restartProviderConsumers(state: ReturnType<typeof getState>): Promise<{
  restarted: string[];
  failed: { service: string; error: string }[];
}> {
  const services = ['assistant'];
  const docker = await checkDocker();
  if (!docker.ok) {
    return { restarted: [], failed: services.map((s) => ({ service: s, error: 'docker unavailable' })) };
  }
  const opts = buildComposeOptions(state);
  const restarted: string[] = [];
  const failed: { service: string; error: string }[] = [];
  for (const service of services) {
    try {
      const r = await composeRestart([service], opts);
      if (r.ok) restarted.push(service);
      else failed.push({ service, error: r.stderr || `exit ${r.code}` });
    } catch (err) {
      failed.push({ service, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restarted, failed };
}

export const POST: RequestHandler = async () => {
  try {
    const state = getState();
    const result = importHostOpenCode(state, { overwriteConflicts: false });
    const hostStatus = detectHostOpenCode();
    let pushResult: PushResult = { pushed: [], errors: [] };
    const importedAuthPath = `${state.configDir}/auth.json`;
    if (existsSync(importedAuthPath)) {
      pushResult = await pushAuthToOpenCode(importedAuthPath);
    } else if (hostStatus.authPath) {
      pushResult = await pushAuthToOpenCode(hostStatus.authPath);
    }
    const restart = await restartProviderConsumers(state);
    return json({
      ok: true,
      imported: result.imported,
      conflicts: result.conflicts.length,
      livePushed: pushResult.pushed.length,
      pushedProviders: pushResult.pushed,
      errors: pushResult.errors,
      restarted: restart.restarted,
      restartFailed: restart.failed,
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'Import failed' }, { status: 500 });
  }
};
