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
    const env = Array.isArray(p.env) ? p.env : [];

    // Use auth methods from /provider/auth if available; otherwise synthesize
    // defaults from the provider's env array (API key support) so the connect
    // sheet always has at least one option to offer.
    let methods = authMethods[p.id as string] ?? [];
    if (methods.length === 0 && env.length > 0) {
      methods = [{ type: 'api', label: 'API Key' }];
    }

    // Provider is "connected" if /provider/auth reported auth methods for it,
    // OR the provider object itself carries a truthy `key` (already resolved).
    const connected = Boolean(authMethods[p.id as string]?.length) || Boolean(p.key);

    return {
      id: p.id,
      name: p.name ?? p.id,
      env,
      connected,
      modelCount: models.length,
      models,
      authMethods: methods,
    };
  });

  return jsonResponse(200, { providers: result }, requestId);
};
