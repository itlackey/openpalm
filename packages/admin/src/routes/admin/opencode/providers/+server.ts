import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import {
  getOpenCodeProviders,
  getOpenCodeProviderAuth,
} from '$lib/opencode/client.server.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const [providers, authMethods] = await Promise.all([
    getOpenCodeProviders(),
    getOpenCodeProviderAuth(),
  ]);

  const result = providers.map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    env: Array.isArray(p.env) ? p.env : [],
    // Provider is "connected" if it has auth methods configured for it
    // Never reference p.key directly — it may contain a resolved secret
    connected: Boolean(authMethods[p.id as string]?.length),
    modelCount: p.models && typeof p.models === 'object' ? Object.keys(p.models as object).length : 0,
    authMethods: authMethods[p.id as string] ?? [],
  }));

  return jsonResponse(200, { providers: result }, requestId);
};
