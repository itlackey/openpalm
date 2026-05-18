import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireAdmin, jsonResponse, getRequestId, getOpenCodeClient } from '$lib/server/helpers.js';
import { sanitizeOpenCodeModels } from '$lib/opencode/provider-models.js';
import { getState } from '$lib/server/state.js';
import { parseEnvContent } from '@openpalm/lib';
import { PROVIDER_KEY_MAP } from '@openpalm/lib/provider-constants';

/**
 * Collect provider env-var names that are set (non-empty) in stack.env,
 * stash/vaults/user.env, or process.env. Used to mark providers as
 * "connected" when their key is supplied out-of-band — without this,
 * the dropdown filter excludes ~127 of the 134 OpenCode catalog
 * providers (only 7 have OpenCode-side authMethods).
 */
function collectSetEnvVars(stackDir: string, vaultDir: string): Set<string> {
  const out = new Set<string>();
  for (const path of [join(stackDir, 'stack.env'), join(vaultDir, 'user.env')]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseEnvContent(readFileSync(path, 'utf-8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.trim().length > 0) out.add(k);
      }
    } catch { /* ignore — best effort */ }
  }
  // Also accept anything currently in process.env (e.g. operator-exported vars).
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v.trim().length > 0) out.add(k);
  }
  return out;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const client = getOpenCodeClient();
  const [providers, authMethods] = await Promise.all([
    client.getProviders(),
    client.getProviderAuth(),
  ]);

  const state = getState();
  const setEnvVars = collectSetEnvVars(
    `${state.homeDir}/config/stack`,
    `${state.homeDir}/stash/vaults`,
  );

  const result = providers.map((p) => {
    const models = sanitizeOpenCodeModels(p.models, p.id);
    const hasAuthMethod = Boolean(authMethods[p.id as string]?.length);
    // A provider counts as "connected" if either:
    //   - OpenCode has an auth method registered for it (oauth/api-key), OR
    //   - its canonical env var is set in stack.env, user.env, or process.env.
    // The second case covers the common path where setup-wizard / Capabilities
    // tab seeded an API key into stack.env — OpenCode's /provider/auth doesn't
    // know about that, but ai-sdk picks it up at runtime.
    const envKey = PROVIDER_KEY_MAP[p.id as string];
    const hasEnvKey = Boolean(envKey && setEnvVars.has(envKey));
    return {
      id: p.id,
      name: p.name ?? p.id,
      env: Array.isArray(p.env) ? p.env : [],
      connected: hasAuthMethod || hasEnvKey,
      modelCount: models.length,
      models,
      authMethods: authMethods[p.id as string] ?? [],
    };
  });

  return jsonResponse(200, { providers: result }, requestId);
};
