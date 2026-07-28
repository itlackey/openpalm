import { readFileSync } from 'node:fs';
import { opencodeFetch } from '$lib/server/opencode/http.js';

export type ProviderPushResult = {
  pushed: string[];
  errors: { provider: string; error: string }[];
};

export async function pushImportedAuth(authPath: string): Promise<ProviderPushResult> {
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
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider === 'anthropic') continue;
    try {
      await opencodeFetch(`/auth/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      });
      pushed.push(provider);
    } catch (err) {
      errors.push({ provider, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { pushed, errors };
}
