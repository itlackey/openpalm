import type { RequestHandler } from './$types';
import { requireAdmin, jsonResponse, getRequestId } from '$lib/server/helpers.js';
import {
  getOpenCodeProviders,
  getOpenCodeProviderAuth,
} from '$lib/opencode/client.server.js';
import { sanitizeOpenCodeModels } from '$lib/opencode/provider-models.js';

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const [providers, authMethods] = await Promise.all([
    getOpenCodeProviders(),
    getOpenCodeProviderAuth(),
  ]);

  const result = providers.map((p) => {
    const models = sanitizeOpenCodeModels(p.models, p.id);
    return {
      id: p.id,
      name: p.name ?? p.id,
      env: Array.isArray(p.env) ? p.env : [],
      // Provider is "connected" if it has auth methods configured for it
      // Never reference p.key directly — it may contain a resolved secret
      connected: Boolean(authMethods[p.id as string]?.length),
      modelCount: models.length,
      models,
      authMethods: authMethods[p.id as string] ?? (Array.isArray(p.env) && p.env.length > 0 ? [{ type: 'api', label: 'API Key' }] : []),
    };
  });

  return jsonResponse(200, { providers: result }, requestId);
};
